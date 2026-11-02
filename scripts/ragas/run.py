"""Run sequential, budgeted Ragas answer, retrieval, and agent-trace evaluations."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from openai import AsyncOpenAI
from ragas.llms import llm_factory
from ragas.messages import AIMessage, HumanMessage, ToolCall, ToolMessage
from ragas.metrics.collections import (
    AgentGoalAccuracyWithReference,
    ContextPrecision,
    ContextRecall,
    Faithfulness,
    ToolCallAccuracy,
)

from budget import (
    BASE_URL,
    CAP_CNY,
    MODEL_ID,
    BudgetExceeded,
    BudgetHalted,
    BudgetLedger,
    BudgetedTransport,
    RunLock,
    request_context,
)
from common import (
    NEWAGENT_ROOT,
    RAGAS_DATA_ROOT,
    ensure_e_drive,
    current_siliconflow_config,
    read_json,
    read_jsonl,
    sanitize_text,
    sha256_text,
    stable_json,
    validate_sample,
    write_json_atomic,
)
from prompts import ANSWER_PROMPT_VERSION, build_answer_messages, answer_prompt_hash
from config import current_config
from results import ResultStore
from tool_tasks import ToolTaskRunner, to_ragas_messages


JUDGE_MAX_TOKENS = 1024
ANSWER_MAX_TOKENS = 512
TOOL_MAX_TOKENS = 512
SAMPLING = {"temperature": 0.7, "top_p": 1.0, "presence_penalty": 1.5}
JUDGE_SAMPLING = {"temperature": 0.0, "top_p": 1.0, "presence_penalty": 0.0}
CALIBRATION_QUERY_IDS = {"Q1", "Q11", "Q21"}


class RunStopped(RuntimeError):
    pass


def _call_ids(context: dict[str, Any]) -> list[str]:
    return list(dict.fromkeys(context.get("request_ids", [])))


def _matching_budget_refusal(ledger: BudgetLedger, sample: dict[str, Any], metric: str) -> dict[str, Any] | None:
    return next(
        (
            record
            for record in reversed(ledger.state.get("requests", []))
            if record.get("status") == "budget_refused"
            and record.get("sample_id") == sample["sample_id"]
            and record.get("metric") == metric
        ),
        None,
    )


def _result_base(sample: dict[str, Any], metric: str, status: str) -> dict[str, Any]:
    return {
        "schema_version": "newagent-ragas-result-v1",
        "sample_id": sample["sample_id"],
        "kind": sample["kind"],
        "phase": sample.get("phase"),
        "phase_order": sample.get("phase_order", 99),
        "metric": metric,
        "status": status,
        "question_id": sample.get("question_id"),
        "repository": sample.get("repository"),
        "retrieval_mode": sample.get("retrieval_mode"),
        "task_id": sample.get("task_id"),
        "conversation_id": sample.get("conversation_id"),
        "role": sample.get("role"),
        "source_revision": sample.get("source_revision"),
        "config_hash": sample.get("config_hash"),
        "reference_review_status": sample.get("reference_review_status"),
        "model": MODEL_ID,
    }


def _metric_value(metric_result: Any) -> tuple[float | None, str | None]:
    value = getattr(metric_result, "value", None)
    if not isinstance(value, (int, float)):
        return None, "Ragas metric returned no numeric value"
    numeric = float(value)
    if not 0.0 <= numeric <= 1.0:
        return None, f"Ragas score outside [0,1]: {numeric}"
    reason = getattr(metric_result, "reason", None)
    return numeric, sanitize_text(str(reason)) if reason is not None else None


def _ragas_messages(sample: dict[str, Any]) -> list[Any]:
    messages: list[Any] = []
    evaluation_context = sample.get("evaluation_context") or {}
    context_parts = []
    if evaluation_context.get("task_requirement"):
        context_parts.append("Task requirement:\n" + evaluation_context["task_requirement"])
    if evaluation_context.get("acceptance_spec"):
        context_parts.append("Acceptance specification (not the final test outcome):\n" + evaluation_context["acceptance_spec"])
    if context_parts:
        messages.append(HumanMessage(content="\n\n".join(context_parts)))

    for message in sample.get("messages", []):
        kind = message.get("type")
        role = message.get("role")
        prefix = f"[role={role}; phase={message.get('session_phase', 'live')}] " if role else ""
        content = prefix + str(message.get("content", ""))
        if kind == "human":
            messages.append(HumanMessage(content=content))
        elif kind == "ai":
            calls = []
            for call in message.get("tool_calls", []):
                if not call.get("arguments_complete") or not isinstance(call.get("args"), dict):
                    raise ValueError("incomplete tool arguments must not be inferred for Ragas")
                calls.append(ToolCall(name=call["name"], args=call["args"]))
            messages.append(AIMessage(content=content, tool_calls=calls or None))
        elif kind == "tool":
            metadata = {
                "tool_name": message.get("tool_name"),
                "tool_call_id": message.get("tool_call_id"),
                "role": role,
            }
            messages.append(
                ToolMessage(
                    content=content,
                    metadata=metadata,
                )
            )

    artifact_diff = (sample.get("artifact_evidence") or {}).get("final_diff")
    if artifact_diff:
        messages.append(
            ToolMessage(
                content="[Host-captured final diff artifact; not an independent acceptance label]\n" + sanitize_text(artifact_diff),
                metadata={"tool_name": "host_final_diff_artifact", "role": "host"},
            )
        )
    return messages


async def _generate_answer(
    sample: dict[str, Any],
    client: AsyncOpenAI,
    ledger: BudgetLedger,
    result_store: ResultStore,
    config_hash: str,
) -> dict[str, Any]:
    existing = result_store.get(sample["sample_id"], "answer_generation")
    if existing and existing.get("status") == "complete":
        return existing

    contexts = sample.get("retrieved_contexts") or []
    if not contexts:
        record = _result_base(sample, "answer_generation", "empty_retrieval")
        record.update({"model_answer": None, "request_ids": [], "reason": "no retrieval contexts; generation skipped"})
        result_store.upsert(record)
        return record
    if any(not isinstance(context.get("content"), str) for context in contexts):
        record = _result_base(sample, "answer_generation", "incomplete_context")
        record.update({"model_answer": None, "request_ids": [], "reason": "one or more captured passages lack source text"})
        result_store.upsert(record)
        return record

    messages = build_answer_messages(sample["question"], contexts)
    prompt_hash = sha256_text(stable_json(messages))
    call_context = request_context(
        sample_id=sample["sample_id"],
        phase="answer_generation",
        metric="model_answer",
        config_hash=config_hash,
        source_version=str(sample.get("source_revision") or "unknown"),
    )
    try:
        with call_context:
            response = await client.chat.completions.create(
                model=MODEL_ID,
                messages=messages,
                max_tokens=ANSWER_MAX_TOKENS,
                temperature=SAMPLING["temperature"],
                top_p=SAMPLING["top_p"],
                presence_penalty=SAMPLING["presence_penalty"],
            )
        content = response.choices[0].message.content if response.choices else None
        answer = sanitize_text(content or "")
        status = "usage_missing" if ledger.halted else ("complete" if answer.strip() else "empty_answer")
        record = _result_base(sample, "answer_generation", status)
        record.update(
            {
                "model_answer": answer or None,
                "prompt_hash": prompt_hash,
                "input_hash": prompt_hash,
                "request_ids": _call_ids(call_context.value),
                "usage": response.usage.model_dump() if response.usage else None,
                "reason": None if answer else "model returned empty content",
            }
        )
        result_store.upsert(record)
        return record
    except BudgetExceeded as exc:
        record = _result_base(sample, "answer_generation", "budget_refused")
        refusal = _matching_budget_refusal(ledger, sample, "model_answer")
        record.update(
            {
                "model_answer": None,
                "request_ids": [refusal["request_id"]] if refusal else [],
                "reason": sanitize_text(str(exc)),
            }
        )
        result_store.upsert(record)
        raise RunStopped(str(exc)) from exc
    except Exception as exc:
        refusal = _matching_budget_refusal(ledger, sample, "model_answer")
        budget_reason = str(ledger.state.get("halt_reason") or "") if refusal else ""
        status = "budget_refused" if refusal else ("usage_missing" if ledger.halted else "generation_error")
        request_ids = _call_ids(call_context.value)
        if refusal:
            request_ids.append(refusal["request_id"])
        detail = sanitize_text(type(exc).__name__ + ": " + str(exc))
        record = _result_base(sample, "answer_generation", status)
        record.update(
            {
                "model_answer": None,
                "prompt_hash": prompt_hash,
                "input_hash": prompt_hash,
                "request_ids": list(dict.fromkeys(request_ids)),
                "reason": sanitize_text(budget_reason) if refusal else detail,
                "wrapped_exception": detail if refusal else None,
            }
        )
        result_store.upsert(record)
        if ledger.halted:
            raise RunStopped(budget_reason or str(exc)) from exc
        return record


async def _score_metric(
    *,
    sample: dict[str, Any],
    metric_name: str,
    metric: Any,
    result_store: ResultStore,
    ledger: BudgetLedger,
    config_hash: str,
    kwargs: dict[str, Any],
) -> dict[str, Any]:
    existing = result_store.get(sample["sample_id"], metric_name)
    if existing and existing.get("status") in {"complete", "empty_retrieval", "empty_answer", "incomplete_trace", "scoring_error", "usage_missing"}:
        return existing
    call_context = request_context(
        sample_id=sample["sample_id"],
        phase=sample.get("phase", "unknown"),
        metric=metric_name,
        config_hash=config_hash,
        source_version=str(sample.get("source_revision") or "unknown"),
    )
    try:
        with call_context:
            metric_result = await metric.ascore(**kwargs)
        score, reason = _metric_value(metric_result)
        status = "usage_missing" if ledger.halted else ("complete" if score is not None else "scoring_error")
        record = _result_base(sample, metric_name, status)
        record.update(
            {
                "score": score,
                "reason": reason,
                "request_ids": _call_ids(call_context.value),
                "labels_after_score": sample.get("labels_after_score"),
                "label_joined_after_scoring": True,
                "model_generation_and_judgement_same": True,
            }
        )
        result_store.upsert(record)
        return record
    except BudgetExceeded as exc:
        refusal = _matching_budget_refusal(ledger, sample, metric_name)
        request_ids = _call_ids(call_context.value)
        if refusal:
            request_ids.append(refusal["request_id"])
        record = _result_base(sample, metric_name, "budget_refused")
        record.update({"score": None, "reason": sanitize_text(str(exc)), "request_ids": list(dict.fromkeys(request_ids))})
        result_store.upsert(record)
        raise RunStopped(str(exc)) from exc
    except Exception as exc:
        refusal = _matching_budget_refusal(ledger, sample, metric_name)
        budget_reason = str(ledger.state.get("halt_reason") or "") if refusal else ""
        status = "budget_refused" if refusal else ("usage_missing" if ledger.halted else "scoring_error")
        request_ids = _call_ids(call_context.value)
        if refusal:
            request_ids.append(refusal["request_id"])
        detail = sanitize_text(type(exc).__name__ + ": " + str(exc))
        record = _result_base(sample, metric_name, status)
        record.update(
            {
                "score": None,
                "reason": sanitize_text(budget_reason) if refusal else detail,
                "wrapped_exception": detail if refusal else None,
                "request_ids": list(dict.fromkeys(request_ids)),
                "labels_after_score": sample.get("labels_after_score"),
                "label_joined_after_scoring": True,
            }
        )
        result_store.upsert(record)
        if ledger.halted:
            raise RunStopped(budget_reason or str(exc)) from exc
        return record


async def _run_retrieval_sample(sample, *, client, llm, metrics, ledger, store, config_hash):
    contexts = sample.get("retrieved_contexts") or []
    if not contexts:
        for name in ("context_precision", "context_recall", "faithfulness"):
            existing = store.get(sample["sample_id"], name)
            if existing and existing.get("status") == "empty_retrieval":
                continue
            record = _result_base(sample, name, "empty_retrieval")
            record.update({"score": None, "reason": "no passages returned; metric was not called", "request_ids": []})
            store.upsert(record)
        return
    if any(not isinstance(context.get("content"), str) for context in contexts):
        for name in ("context_precision", "context_recall", "faithfulness"):
            record = _result_base(sample, name, "incomplete_context")
            record.update({"score": None, "reason": "actual retrieved text is missing; no context was reconstructed", "request_ids": []})
            store.upsert(record)
        return

    answer_record = await _generate_answer(sample, client, ledger, store, config_hash)
    if answer_record.get("status") in {"budget_refused", "usage_missing"}:
        raise RunStopped(answer_record.get("reason", "budget refused"))

    common_args = {
        "user_input": sample["question"],
        "reference": sample["reference_answer"],
        "retrieved_contexts": [context["content"] for context in contexts],
    }
    await _score_metric(
        sample=sample,
        metric_name="context_precision",
        metric=metrics["context_precision"],
        result_store=store,
        ledger=ledger,
        config_hash=config_hash,
        kwargs=common_args,
    )
    if ledger.halted:
        raise RunStopped(str(ledger.state.get("halt_reason") or "Usage missing"))
    await _score_metric(
        sample=sample,
        metric_name="context_recall",
        metric=metrics["context_recall"],
        result_store=store,
        ledger=ledger,
        config_hash=config_hash,
        kwargs=common_args,
    )
    if ledger.halted:
        raise RunStopped(str(ledger.state.get("halt_reason") or "Usage missing"))
    answer = answer_record.get("model_answer")
    if not answer:
        record = _result_base(sample, "faithfulness", "empty_answer")
        record.update({"score": None, "reason": "answer was empty; faithfulness was not called", "request_ids": []})
        store.upsert(record)
        return
    await _score_metric(
        sample=sample,
        metric_name="faithfulness",
        metric=metrics["faithfulness"],
        result_store=store,
        ledger=ledger,
        config_hash=config_hash,
        kwargs={
            "user_input": sample["question"],
            "response": answer,
            "retrieved_contexts": [context["content"] for context in contexts],
        },
    )
    if ledger.halted:
        raise RunStopped(str(ledger.state.get("halt_reason") or "Usage missing"))


async def _run_agent_sample(sample, *, metric, ledger, store, config_hash):
    if sample.get("trace_status") != "complete":
        record = _result_base(sample, "agent_goal_accuracy_with_reference", "incomplete_trace")
        record.update({"score": None, "reason": "; ".join(sample.get("trace_notes", [])) or "trace marked incomplete", "request_ids": []})
        store.upsert(record)
        return
    try:
        messages = _ragas_messages(sample)
    except Exception as exc:
        record = _result_base(sample, "agent_goal_accuracy_with_reference", "incomplete_trace")
        record.update({"score": None, "reason": sanitize_text(type(exc).__name__ + ": " + str(exc)), "request_ids": []})
        store.upsert(record)
        return
    await _score_metric(
        sample=sample,
        metric_name="agent_goal_accuracy_with_reference",
        metric=metric,
        result_store=store,
        ledger=ledger,
        config_hash=config_hash,
        kwargs={"user_input": messages, "reference": sample["reference_answer"]},
    )


async def _run_tool_sample(sample, *, client, metric, ledger, store, batch_dir, config_hash):
    trace_row = store.get(sample["sample_id"], "tool_trace")
    if trace_row and isinstance(trace_row.get("tool_trace"), dict):
        state = trace_row["tool_trace"]
    else:
        runner = ToolTaskRunner(
            client=client,
            sample=sample,
            batch_dir=batch_dir,
            config_hash=config_hash,
            ledger=ledger,
        )
        state = await runner.run()
        trace_complete = bool(state.get("trace_complete", True))
        status = "complete" if state.get("status") == "complete" and trace_complete else "incomplete_trace"
        trace_row = _result_base(sample, "tool_trace", status)
        trace_row.update(
            {
                "model_answer": state.get("final_answer"),
                "messages": state.get("ragas_messages", []),
                "tool_messages": state.get("tool_messages", []),
                "tool_calls": [call for message in state.get("ragas_messages", []) for call in message.get("tool_calls", [])],
                "tool_trace": state,
                "format_feedback_count": state.get("format_feedback_count", 0),
                "request_ids": state.get("request_ids", []),
                "task_state": state.get("status"),
                "independent_tool_task_check": runner.independent_check(state),
                "trace_status": "complete" if state.get("status") == "complete" and trace_complete else "incomplete",
            }
        )
        store.upsert(trace_row)

    if not state.get("trace_complete", True):
        incomplete = _result_base(sample, "tool_call_accuracy", "incomplete_trace")
        incomplete.update({"score": None, "reason": "original tool arguments or call/result association were incomplete", "request_ids": []})
        store.upsert(incomplete)
        return

    try:
        messages = to_ragas_messages(state.get("ragas_messages", []))
        expected_calls = [ToolCall(name=item["name"], args=item["args"]) for item in sample.get("tool_call_reference", [])]
    except Exception as exc:
        error = _result_base(sample, "tool_call_accuracy", "incomplete_trace")
        error.update({"score": None, "reason": sanitize_text(type(exc).__name__ + ": " + str(exc)), "request_ids": []})
        store.upsert(error)
        return

    score_row = await _score_metric(
        sample=sample,
        metric_name="tool_call_accuracy",
        metric=metric,
        result_store=store,
        ledger=ledger,
        config_hash=config_hash,
        kwargs={"user_input": messages, "reference_tool_calls": expected_calls},
    )
    score_row["tool_task_check"] = trace_row.get("independent_tool_task_check")
    score_row["label_joined_after_scoring"] = True
    store.upsert(score_row)


async def _run(args) -> int:
    if not os.environ.get("NEWAGENT_API_KEY", "").strip():
        raise RuntimeError("NEWAGENT_API_KEY is not visible; no model calls were started")
    batch_dir = RAGAS_DATA_ROOT / args.batch
    manifest_path = batch_dir / "manifest.json"
    samples_path = batch_dir / "samples.jsonl"
    if not manifest_path.exists() or not samples_path.exists():
        raise FileNotFoundError(f"Ragas export batch is incomplete: {args.batch}")
    manifest = read_json(manifest_path)
    samples = read_jsonl(samples_path)
    if not samples:
        raise ValueError("Ragas samples.jsonl is empty")
    for sample in samples:
        validate_sample(sample)

    export_config = manifest.get("evaluation_config", {})
    current_model = current_siliconflow_config()
    if current_model != manifest.get("model_config"):
        raise RuntimeError("The saved SiliconFlow model configuration changed; export a new Ragas batch")
    current = current_config(
        current_model,
        export_config.get("retrieval_result_sha256", ""),
        export_config.get("dataset_sha256", ""),
        int(export_config.get("question_count", 0)),
        args.batch,
    )
    if current["config_hash"] != manifest.get("config_hash") or current["runtime_source_hash"] != manifest.get("runtime_source_hash"):
        raise RuntimeError("Ragas code, dependency lock, prompt, or source configuration changed; export a new batch")

    config_hash = manifest["config_hash"]
    results_path = batch_dir / "results.jsonl"
    result_store = ResultStore(results_path)
    ledger_path = RAGAS_DATA_ROOT / "ledger-v1.json"
    cache_dir = NEWAGENT_ROOT / "cache" / "ragas" / "llm-responses-v1"
    call_log_path = batch_dir / "raw-llm-calls.jsonl"
    ledger = BudgetLedger(ledger_path, cache_dir, cap_cny=CAP_CNY)
    if ledger.halted:
        reason = str(ledger.state.get("halt_reason") or "budget ledger is halted")
        status = "paused_budget" if ("budget" in reason.lower() or "cap" in reason.lower()) else "paused_usage_unknown"
        write_json_atomic(batch_dir / "run-state.json", {"status": status, "reason": reason, "completed_result_rows": len(result_store.rows)})
        print("Run paused before model calls: " + sanitize_text(reason))
        return 0

    client = AsyncOpenAI(
        api_key=os.environ["NEWAGENT_API_KEY"].strip(),
        base_url=BASE_URL,
        max_retries=0,
        http_client=httpx.AsyncClient(transport=BudgetedTransport(ledger, call_log_path), timeout=90.0),
    )
    llm = llm_factory(
        MODEL_ID,
        provider="openai",
        adapter="instructor",
        client=client,
        max_tokens=JUDGE_MAX_TOKENS,
        max_retries=1,
        temperature=JUDGE_SAMPLING["temperature"],
        top_p=JUDGE_SAMPLING["top_p"],
        presence_penalty=JUDGE_SAMPLING["presence_penalty"],
    )
    metrics = {
        "context_precision": ContextPrecision(llm=llm),
        "context_recall": ContextRecall(llm=llm),
        "faithfulness": Faithfulness(llm=llm),
        "agent_goal": AgentGoalAccuracyWithReference(llm=llm),
        "tool_call_accuracy": ToolCallAccuracy(strict_order=True),
    }

    ordered = sorted(
        samples,
        key=lambda sample: (
            sample.get("phase_order", 99),
            sample.get("question_id") or sample.get("task_id") or sample["sample_id"],
            sample.get("retrieval_mode") or "",
        ),
    )
    completed_samples = 0
    stopped_reason = None
    try:
        with RunLock(RAGAS_DATA_ROOT / ".run.lock"):
            for sample in ordered:
                try:
                    if sample["kind"] == "retrieval_qa":
                        await _run_retrieval_sample(
                            sample,
                            client=client,
                            llm=llm,
                            metrics=metrics,
                            ledger=ledger,
                            store=result_store,
                            config_hash=config_hash,
                        )
                    elif sample["kind"] == "agent_trajectory":
                        await _run_agent_sample(
                            sample,
                            metric=metrics["agent_goal"],
                            ledger=ledger,
                            store=result_store,
                            config_hash=config_hash,
                        )
                    elif sample["kind"] == "tool_task":
                        await _run_tool_sample(
                            sample,
                            client=client,
                            metric=metrics["tool_call_accuracy"],
                            ledger=ledger,
                            store=result_store,
                            batch_dir=batch_dir,
                            config_hash=config_hash,
                        )
                    if ledger.halted:
                        stopped_reason = ledger.state.get("halt_reason") or "Usage missing"
                        break
                    completed_samples += 1
                    print(
                        json.dumps(
                            {
                                "event": "sample_complete",
                                "sample_id": sample["sample_id"],
                                "kind": sample["kind"],
                                "phase": sample.get("phase"),
                                "spent_estimate_cny": ledger.state.get("spent_cny"),
                                "reserved_cny": ledger.state.get("reserved_cny"),
                            },
                            ensure_ascii=False,
                        )
                    )
                except RunStopped as exc:
                    stopped_reason = str(exc)
                    break
                except BudgetExceeded as exc:
                    stopped_reason = str(exc)
                    print(json.dumps({"event": "budget_stop", "reason": sanitize_text(stopped_reason)}, ensure_ascii=False))
                    break
                except BudgetHalted as exc:
                    stopped_reason = str(exc)
                    print(json.dumps({"event": "budget_pause", "reason": sanitize_text(stopped_reason)}, ensure_ascii=False))
                    break
    finally:
        await client.close()

    remaining = len(samples) - completed_samples
    if ledger.halted:
        reason = str(ledger.state.get("halt_reason", ""))
        status = "paused_budget" if ("budget" in reason.lower() or "cap" in reason.lower()) else "paused_usage_unknown"
    else:
        status = "paused_budget" if stopped_reason else "complete"
    run_state = {
        "schema_version": "newagent-ragas-run-state-v1",
        "batch": args.batch,
        "status": status,
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "exported_samples": len(samples),
        "processed_samples_this_invocation": completed_samples,
        "result_rows": len(result_store.rows),
        "remaining_samples": remaining,
        "stop_reason": sanitize_text(stopped_reason) if stopped_reason else None,
        "budget_ledger": _relative_path(ledger_path),
        "spent_estimate_cny": ledger.state.get("spent_cny"),
        "reserved_cny": ledger.state.get("reserved_cny"),
        "cap_cny": str(CAP_CNY),
    }
    write_json_atomic(batch_dir / "run-state.json", run_state)
    print(json.dumps({"event": "run_end", **run_state}, ensure_ascii=False))
    return 0


def _relative_path(path: Path) -> str:
    try:
        return path.resolve().relative_to(NEWAGENT_ROOT.resolve()).as_posix()
    except ValueError:
        return "[path-redacted]"


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--batch", default=os.environ.get("NEWAGENT_RAGAS_BATCH", "ragas-v1"))
    args = parser.parse_args()
    ensure_e_drive()
    if not re.fullmatch(r"ragas-v[1-9][0-9]*", args.batch):
        parser.error("batch must look like ragas-v1")
    return asyncio.run(_run(args))


if __name__ == "__main__":
    raise SystemExit(main())
