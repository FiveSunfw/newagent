"""Export fresh Top-5 retrieval passages and recoverable post-fix agent traces."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from common import (
    APP_ROOT,
    NEWAGENT_ROOT,
    RAGAS_DATA_ROOT,
    REPOSITORY_EVAL_ROOT,
    REFERENCE_REVIEW_STATUS,
    SCHEMA_VERSION,
    UPSTREAM_ROOT,
    ensure_e_drive,
    current_siliconflow_config,
    read_json,
    sanitize_text,
    sanitize_value,
    sha256_file,
    sha256_text,
    stable_json,
    validate_sample,
    write_json_atomic,
    write_jsonl_atomic,
)
from config import current_config
from prompts import ANSWER_PROMPT_VERSION, answer_prompt_hash


RAW_RETRIEVAL_VERSION = "ragas-retrieval-v1"
HOLDOUT_HARNESS_HASH = "d9ee93a0011302bc9843a08ee477bd618c963ef5366107a2d76ed41c636c34c9"
TARGET_DATASET_HASH = "9bc3860e3704ff084a28db50c7edf315cc088b8194734e3f499523cf90356f75"
HISTORICAL_MODE = "single-case-holdout-diagnostic"
REPO_DIRS = {
    "mitt": "mitt",
    "fast-json-stable-stringify": "fast-json-stable-stringify",
    "dlv": "dlv",
}
CALIBRATION_QUESTION_IDS = {"Q1", "Q11", "Q21"}
CALIBRATION_AGENT_CASE = "mitt-dispatch-snapshot"


def _relative_to_newagent(path: Path) -> str:
    try:
        return path.resolve().relative_to(NEWAGENT_ROOT.resolve()).as_posix()
    except ValueError:
        return "[external-artifact-redacted]"


def _find_text_lines(source: str, needle: str) -> tuple[int, int] | None:
    if not needle:
        return None
    normalized_source = source.replace("\r\n", "\n").replace("\r", "\n")
    normalized_needle = needle.replace("\r\n", "\n").replace("\r", "\n")
    index = normalized_source.find(normalized_needle)
    if index < 0:
        return None
    start = normalized_source.count("\n", 0, index) + 1
    end = start + normalized_needle.count("\n")
    return start, end


def _dataset_hash(dataset_path: Path) -> str:
    return sha256_file(dataset_path)


def _load_retrieval_export(raw_batch: str) -> tuple[dict[str, Any], Path]:
    path = REPOSITORY_EVAL_ROOT / raw_batch / "results.json"
    if not path.exists():
        raise FileNotFoundError(f"fresh retrieval results are missing: {path.name}")
    data = read_json(path)
    if not data.get("captureContent"):
        raise ValueError("retrieval batch has no captured raw passage text; do not reconstruct it from legacy labels")
    if int(data.get("ragasContextTopK", 0)) != 5:
        raise ValueError("retrieval batch did not record the required Top-5 Ragas context")
    if not data.get("realEmbedding"):
        raise ValueError("retrieval batch did not verify real local Dense embeddings")
    return data, path


def _retrieval_samples(
    raw: dict[str, Any],
    raw_path: Path,
    references: dict[str, Any],
    dataset: dict[str, Any],
    config_hash: str,
) -> list[dict[str, Any]]:
    questions = {question["id"]: question for question in raw["questions"]}
    expected_repo_sha = {}
    for case in dataset["cases"]:
        expected_repo_sha.setdefault(case["repository"], case.get("upstream", {}).get("sha"))
    records = raw["results"]
    if len(records) != 90:
        raise ValueError(f"expected 90 fresh retrieval records, found {len(records)}")
    samples: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in records:
        qid = row["questionId"]
        question = questions[qid]
        answer_def = references["answers"].get(qid)
        if not answer_def:
            raise ValueError(f"missing source-grounded reference answer for {qid}")
        target = row.get("referenceSource")
        if row.get("sourceRevision") != expected_repo_sha.get(row.get("repository")):
            raise ValueError(f"fresh retrieval source revision does not match the frozen dataset for {qid}")
        if not row.get("sourceContentHash"):
            raise ValueError(f"source content hash is missing for {qid}")
        if not isinstance(target, dict) or not target.get("startLine") or not target.get("endLine"):
            raise ValueError(f"fresh source line evidence is missing for {qid}")
        expected_symbols = set(question.get("acceptableSymbols") or [question["symbol"]])
        if target.get("path") != question["path"] or target.get("symbol") not in expected_symbols:
            raise ValueError(f"reference target for {qid} does not match its fixed file/symbol label")
        if answer_def["sourceFile"] != target["path"] or answer_def["sourceSymbol"] not in expected_symbols:
            raise ValueError(f"answer source for {qid} does not match the fixed target")

        hits = row.get("hits") or []
        contexts: list[dict[str, Any]] = []
        missing_content = 0
        for rank, hit in enumerate(hits[:5], start=1):
            content = hit.get("content")
            if not isinstance(content, str):
                missing_content += 1
                content = None
            context = {
                "rank": rank,
                "path": sanitize_text(str(hit.get("path", ""))).replace("\\", "/"),
                "symbol": sanitize_text(str(hit.get("symbol", ""))) or None,
                "start_line": hit.get("startLine"),
                "end_line": hit.get("endLine"),
                "index_version": hit.get("indexVersion"),
                "content": sanitize_text(content) if isinstance(content, str) else None,
                "content_sha256": sha256_text(content) if isinstance(content, str) else None,
            }
            contexts.append(context)

        reference_context = target.get("content")
        source_ref = {
            "path": target["path"],
            "symbol": target["symbol"],
            "start_line": target["startLine"],
            "end_line": target["endLine"],
            "source_revision": row.get("sourceRevision"),
            "source_kind": "fixed_public_repository_snapshot",
            "content_sha256": sha256_text(reference_context) if isinstance(reference_context, str) else None,
            "source_excerpt": sanitize_text(reference_context) if isinstance(reference_context, str) else None,
        }
        sample_id = f"retrieval:{qid}:{row['mode']}"
        if sample_id in seen:
            raise ValueError(f"duplicate retrieval sample {sample_id}")
        seen.add(sample_id)
        sample = {
            "schema_version": SCHEMA_VERSION,
            "sample_id": sample_id,
            "kind": "retrieval_qa",
            "phase": "calibration_retrieval" if qid in CALIBRATION_QUESTION_IDS else "remaining_retrieval",
            "phase_order": 0 if qid in CALIBRATION_QUESTION_IDS else 4,
            "question_id": qid,
            "repository": row["repository"],
            "retrieval_mode": row["mode"],
            "question": sanitize_text(question["query"]),
            "retrieved_contexts": contexts,
            "retrieval_context_status": "empty_retrieval" if not contexts else ("missing_context_text" if missing_content else "captured"),
            "missing_context_count": missing_content,
            "reference_answer": sanitize_text(answer_def["reference"]),
            "reference_sources": [source_ref],
            "reference_review_status": REFERENCE_REVIEW_STATUS,
            "model_answer": None,
            "messages": [],
            "tool_messages": [],
            "tool_call_reference": [],
            "task_id": None,
            "conversation_id": None,
            "role": "retriever",
            "roles": ["retriever"],
            "session_links": [],
            "source_revision": row.get("sourceRevision"),
            "source_revision_hashes": {
                "retrieval_index_version": row.get("indexVersion"),
                "source_content_hash": row.get("sourceContentHash"),
            },
            "config_hash": config_hash,
            "retrieval_metrics": {
                "recall_at_1": row.get("recallAt1"),
                "recall_at_5": row.get("recallAt5"),
                "recall_at_10": row.get("recallAt10"),
                "mrr_at_10": row.get("mrrAt10"),
                "latency_ms": row.get("latencyMs"),
                "latency_scope": row.get("latencyScope"),
                "candidate_top_k": raw.get("retrievalTopK"),
                "ragas_context_top_k": 5,
            },
            "labels_after_score": None,
            "trace_status": "not_applicable",
            "trace_notes": [],
            "export_provenance": {
                "fresh_retrieval_batch": raw_path.parent.name,
                "raw_result_sha256": sha256_file(raw_path),
                "passage_origin": "actual fresh retrieval result; no legacy context reconstruction",
            },
        }
        validate_sample(sample)
        samples.append(sample)
    if len(seen) != 90:
        raise ValueError("the fresh retrieval batch did not produce exactly 30 questions × 3 modes")
    return samples


def _read_session_file(path: Path, session_root: Path, run_dir: Path, checkpoint_at: datetime | None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    role = path.parent.name
    stem = path.stem
    session_id = stem.rsplit("_", 1)[-1]
    timestamp_match = re.match(r"^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_", path.name)
    started_at = None
    if timestamp_match:
        started_at = datetime.strptime(timestamp_match.group(1), "%Y-%m-%dT%H-%M-%S-%fZ").replace(tzinfo=timezone.utc)
    if checkpoint_at and started_at:
        phase = "pre_checkpoint" if started_at <= checkpoint_at else "post_checkpoint"
    else:
        phase = "single_phase"

    output: list[dict[str, Any]] = []
    call_ids: set[str] = set()
    result_ids: set[str] = set()
    missing_args = 0
    row_count = 0
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("type") != "message":
            continue
        message = row.get("message") or {}
        message_role = message.get("role")
        if message_role in {"system", "developer", "thinking"}:
            continue
        if message_role not in {"user", "assistant", "toolResult"}:
            continue
        row_count += 1
        content_parts = message.get("content") or []
        text_parts: list[str] = []
        tool_calls: list[dict[str, Any]] = []
        if isinstance(content_parts, str):
            text_parts.append(content_parts)
            content_parts = []
        for part in content_parts:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text" and isinstance(part.get("text"), str):
                text_parts.append(part["text"])
            elif message_role == "assistant" and part.get("type") == "toolCall":
                raw_args = part.get("arguments")
                args: dict[str, Any] | None = None
                if isinstance(raw_args, dict):
                    args = raw_args
                elif isinstance(raw_args, str):
                    try:
                        parsed_args = json.loads(raw_args)
                        if isinstance(parsed_args, dict):
                            args = parsed_args
                    except json.JSONDecodeError:
                        args = None
                call_id = str(part.get("id") or "")
                if not call_id or not isinstance(part.get("name"), str) or args is None:
                    missing_args += 1
                else:
                    call_ids.add(call_id)
                tool_calls.append(
                    {
                        "id": call_id or None,
                        "name": sanitize_text(str(part.get("name", ""))),
                        "args": sanitize_value(args) if args is not None else None,
                        "arguments_complete": bool(call_id and args is not None and part.get("name")),
                        "argument_source": "session_jsonl",
                    }
                )

        text = sanitize_text("\n".join(text_parts))
        timestamp = message.get("timestamp") or row.get("timestamp")
        record = {
            "type": {"user": "human", "assistant": "ai", "toolResult": "tool"}[message_role],
            "role": role,
            "content": text,
            "tool_calls": tool_calls,
            "tool_call_id": message.get("toolCallId"),
            "tool_name": sanitize_text(str(message.get("toolName", ""))) or None,
            "is_error": bool(message.get("isError", False)),
            "timestamp": timestamp,
            "session_started_at": started_at.isoformat() if started_at else None,
            "session_id": session_id,
            "session_phase": phase,
            "message_id": row.get("id"),
            "message_order": line_number,
        }
        if message_role == "toolResult":
            if message.get("toolCallId"):
                result_ids.add(str(message["toolCallId"]))
        output.append(record)

    link = {
        "role": role,
        "session_id": session_id,
        "started_at": started_at.isoformat() if started_at else None,
        "checkpoint_phase": phase,
        "artifact_ref": _relative_to_newagent(path),
        "sha256": sha256_file(path),
        "message_count": row_count,
        "tool_call_ids": sorted(call_ids),
        "tool_result_ids": sorted(result_ids),
        "arguments_missing": missing_args,
    }
    return output, link


def _reference_sources_for_case(case: dict[str, Any], dataset_path: Path) -> list[dict[str, Any]]:
    repo_name = REPO_DIRS[case["repository"]]
    repo_root = UPSTREAM_ROOT / repo_name
    references: list[dict[str, Any]] = []
    setup = case.get("setup") or {}
    for mutation in case.get("mutation", []):
        file_name = mutation["file"].replace("\\", "/")
        before = mutation.get("before", "")
        setup_text = setup.get(file_name) or setup.get(file_name.replace("/", "\\"))
        source_kind = "fixed_public_repository_snapshot"
        if setup_text is not None:
            source_text = setup_text
            source_kind = "frozen_fixture_setup"
        else:
            source_path = repo_root / file_name
            source_text = source_path.read_text(encoding="utf-8") if source_path.exists() else ""
        line_range = _find_text_lines(source_text, before)
        if line_range:
            start_line, end_line = line_range
            references.append(
                {
                    "path": file_name,
                    "start_line": start_line,
                    "end_line": end_line,
                    "source_revision": case.get("upstream", {}).get("sha"),
                    "source_kind": source_kind,
                    "source_excerpt": sanitize_text(before),
                }
            )
            continue

        # A new public export may exist only in the immutable case specification.
        dataset_lines = dataset_path.read_text(encoding="utf-8").splitlines()
        needle = before.strip().splitlines()[0].strip() if before.strip() else ""
        found_line = next((i + 1 for i, line in enumerate(dataset_lines) if needle and needle in line), None)
        references.append(
            {
                "path": file_name,
                "start_line": found_line,
                "end_line": found_line,
                "source_revision": case.get("referenceRevision"),
                "source_kind": "frozen_evaluation_fixture_spec",
                "source_excerpt": sanitize_text(before),
            }
        )
    return references


def _agent_reference(reference_map: dict[str, Any], case_id: str, sources: list[dict[str, Any]]) -> str:
    goal = reference_map["goals"][case_id]
    citations = [
        f"{source['path']}:{source['start_line']}-{source['end_line']}"
        for source in sources
        if source.get("start_line")
    ]
    citation_text = ", ".join(citations) if citations else "source locations not resolved"
    return f"Expected outcome: {goal}\nFixed-source/fixture citations: {citation_text}."


def _agent_samples(batch: str, dataset: dict[str, Any], dataset_path: Path, config_hash: str) -> list[dict[str, Any]]:
    samples: list[dict[str, Any]] = []
    cases = {case["id"]: case for case in dataset["cases"] if case.get("split") == "holdout"}
    reference_map = read_json(APP_ROOT / "scripts" / "ragas" / "agent-reference-answers-v1.json")
    run_dirs: list[tuple[Path, dict[str, Any], dict[str, Any]]] = []
    for batch_dir in sorted(REPOSITORY_EVAL_ROOT.glob("single-case-holdout-diagnostic-v*")):
        manifest_path = batch_dir / "manifest.json"
        if not manifest_path.exists():
            continue
        manifest = read_json(manifest_path)
        if manifest.get("mode") != HISTORICAL_MODE or manifest.get("evalHarnessHash") != HOLDOUT_HARNESS_HASH:
            continue
        for result_path in batch_dir.rglob("result.json"):
            result = read_json(result_path)
            if result.get("split") == "holdout":
                run_dirs.append((result_path.parent, manifest, result))

    seen: set[str] = set()
    for run_dir, run_manifest, result in sorted(run_dirs, key=lambda item: (item[2].get("caseId", ""), item[2].get("strategy", ""))):
        case_id = result["caseId"]
        if case_id not in cases:
            continue
        sample_id = f"agent:{case_id}:{result['strategy']}"
        if sample_id in seen:
            raise ValueError(f"duplicate fixed-holdout trace {sample_id}")
        seen.add(sample_id)
        case = cases[case_id]
        sources = _reference_sources_for_case(case, dataset_path)
        requirement = sanitize_text(case["requirement"])
        acceptance = sanitize_text(case["acceptance"])
        checkpoint_path = run_dir / "restart-checkpoint.json"
        checkpoint_at = None
        if checkpoint_path.exists():
            checkpoint = read_json(checkpoint_path)
            stamp = checkpoint.get("at")
            if stamp:
                try:
                    checkpoint_at = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
                except ValueError:
                    checkpoint_at = None

        sessions_root = run_dir / "data" / "sessions"
        session_files = sorted(sessions_root.glob("**/*.jsonl")) if sessions_root.exists() else []
        messages: list[dict[str, Any]] = []
        session_links: list[dict[str, Any]] = []
        session_tool_ids: set[str] = set()
        session_result_ids: set[str] = set()
        missing_args = 0
        roles: set[str] = set()
        conversation_ids: set[str] = set()
        for session_file in session_files:
            parsed, link = _read_session_file(session_file, sessions_root, run_dir, checkpoint_at)
            messages.extend(parsed)
            session_links.append(link)
            roles.add(link["role"])
            conversation_ids.add(session_file.parent.parent.name)
            session_tool_ids.update(link["tool_call_ids"])
            session_result_ids.update(link["tool_result_ids"])
            missing_args += int(link["arguments_missing"])
        phase_order = {"pre_checkpoint": 0, "single_phase": 1, "post_checkpoint": 2}
        messages.sort(
            key=lambda item: (
                item.get("timestamp") or item.get("session_started_at") or "",
                phase_order.get(item.get("session_phase"), 1),
                item.get("session_id") or "",
                item.get("message_order", 0),
            )
        )

        event_tool_ids = {
            str(event.get("body", {}).get("callId"))
            for event in result.get("events", [])
            if event.get("kind") == "agent_tool" and event.get("body", {}).get("callId")
        }
        missing_event_calls = sorted(event_tool_ids - session_tool_ids)
        missing_results = sorted(session_tool_ids - session_result_ids)
        trace_notes: list[str] = []
        if not session_files:
            trace_notes.append("no Pi session JSONL artifacts were found")
        if missing_args:
            trace_notes.append(f"{missing_args} tool calls lack parseable original arguments in session JSONL")
        if missing_event_calls:
            trace_notes.append(f"{len(missing_event_calls)} agent_tool call ids have no matching session JSONL call; HMAC inputs were not used to infer arguments")
        if missing_results:
            trace_notes.append(f"{len(missing_results)} session tool calls have no matching tool result")
        trace_complete = bool(session_files) and not missing_args and not missing_event_calls and not missing_results

        tool_messages = [item for item in messages if item["type"] == "tool"]
        retrieved_contexts = _extract_historical_contexts(tool_messages)
        developer_finals = [
            item["content"] for item in messages
            if item["type"] == "ai" and item.get("role") == "developer" and item["content"] and not item.get("tool_calls")
        ]
        model_answer = developer_finals[-1] if developer_finals else None
        diff = sanitize_text(result.get("diff") or "")
        artifact_refs = []
        for name in ("worker.log", "resume.log", "restart-checkpoint.json"):
            file_path = run_dir / name
            if file_path.exists():
                artifact_refs.append({"name": name, "path": _relative_to_newagent(file_path), "sha256": sha256_file(file_path)})

        labels = {
            "functional_acceptance": bool(result.get("functionalAcceptance")),
            "delivery_gate": bool(result.get("deliveryGate")),
            "outcome": sanitize_text(str(result.get("outcome", "unknown"))),
            "worker_exit_code": result.get("workerExitCode"),
            "final_worker_exit_code": result.get("finalWorkerExitCode"),
            "tool_attempts": result.get("toolAttempts"),
            "repair_rounds": result.get("repairs"),
            "recovery": result.get("recovery"),
        }
        recovery_group = f"{result.get('task', {}).get('id', sample_id)}:checkpoint" if result.get("recovery", {}).get("requested") else None
        sample = {
            "schema_version": SCHEMA_VERSION,
            "sample_id": sample_id,
            "kind": "agent_trajectory",
            "phase": "calibration_agent" if case_id == CALIBRATION_AGENT_CASE else "historical_agent",
            "phase_order": 1 if case_id == CALIBRATION_AGENT_CASE else 2,
            "question_id": None,
            "repository": case["repository"],
            "retrieval_mode": None,
            "question": requirement,
            "evaluation_context": {"task_requirement": requirement, "acceptance_spec": acceptance},
            "retrieved_contexts": retrieved_contexts,
            "retrieval_context_status": "captured_from_session_tool_results" if retrieved_contexts else "no_actual_passage_text_recoverable",
            "reference_answer": _agent_reference(reference_map, case_id, sources),
            "reference_sources": sources,
            "reference_review_status": REFERENCE_REVIEW_STATUS,
            "model_answer": model_answer,
            "messages": messages,
            "tool_messages": tool_messages,
            "tool_call_reference": [],
            "task_id": result.get("task", {}).get("id"),
            "conversation_id": sorted(conversation_ids)[0] if len(conversation_ids) == 1 else None,
            "role": "multi-role" if len(roles) > 1 else (next(iter(roles)) if roles else None),
            "roles": sorted(roles),
            "session_links": session_links,
            "source_revision": case.get("seededRevision"),
            "source_revision_hashes": {
                "seeded_revision": case.get("seededRevision"),
                "reference_revision": case.get("referenceRevision"),
                "upstream_revision": case.get("upstream", {}).get("sha"),
                "final_workspace_fingerprint": result.get("sourceFingerprint"),
            },
            "config_hash": sha256_text(stable_json({"batchConfig": run_manifest.get("evaluationConfigHash"), "harness": run_manifest.get("evalHarnessHash"), "ragasConfig": config_hash})),
            "historical_harness_hash": run_manifest.get("evalHarnessHash"),
            "historical_evaluation_config_hash": run_manifest.get("evaluationConfigHash"),
            "recovery_group_id": recovery_group,
            "recovery_session_link": {
                "checkpoint_at": checkpoint_at.isoformat() if checkpoint_at else None,
                "pre_checkpoint_session_ids": [item["session_id"] for item in session_links if item["checkpoint_phase"] == "pre_checkpoint"],
                "post_checkpoint_session_ids": [item["session_id"] for item in session_links if item["checkpoint_phase"] == "post_checkpoint"],
                "requested": bool(result.get("recovery", {}).get("requested")),
                "restarted": bool(result.get("recovery", {}).get("restarted")),
            },
            "artifact_evidence": {"final_diff": diff, "artifact_refs": artifact_refs},
            "trace_status": "complete" if trace_complete else "incomplete",
            "trace_notes": trace_notes,
            "labels_after_score": labels,
            "export_provenance": {
                "historical_batch": _relative_to_newagent(run_dir.parent.parent),
                "result_sha256": sha256_file(run_dir / "result.json"),
                "tool_arguments_source": "Pi session JSONL only; HMAC fingerprints are never decoded or treated as arguments",
            },
        }
        validate_sample(sample)
        samples.append(sample)

    return samples


def _session_content_text(content: Any) -> str:
    if isinstance(content, str):
        return sanitize_text(content)
    if isinstance(content, list):
        return sanitize_text("\n".join(part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text"))
    return ""


def _extract_historical_contexts(tool_messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    contexts: list[dict[str, Any]] = []
    for message in tool_messages:
        if message.get("tool_name") not in {"search_repository"}:
            continue
        text = message.get("content", "")
        try:
            payload = json.loads(text)
        except (TypeError, json.JSONDecodeError):
            continue

        def walk(value: Any) -> None:
            if isinstance(value, dict):
                if isinstance(value.get("path"), str) and isinstance(value.get("content"), str):
                    contexts.append({
                        "rank": len(contexts) + 1,
                        "path": sanitize_text(value["path"]).replace("\\", "/"),
                        "symbol": sanitize_text(str(value.get("symbol", ""))) or None,
                        "start_line": value.get("startLine"),
                        "end_line": value.get("endLine"),
                        "content": sanitize_text(value["content"]),
                        "content_sha256": sha256_text(value["content"]),
                        "origin": "captured_from_historical_tool_result",
                    })
                    return
                for child in value.values():
                    walk(child)
            elif isinstance(value, list):
                for child in value:
                    walk(child)

        walk(payload)
    return contexts


def _tool_task_samples(dataset: dict[str, Any], config_hash: str) -> list[dict[str, Any]]:
    task_data = read_json(APP_ROOT / "scripts" / "ragas" / "tool-cases-v1.json")
    cases = {case["repository"]: case for case in dataset["cases"]}
    samples: list[dict[str, Any]] = []
    for task in task_data["cases"]:
        repo_case = cases[task["repository"]]
        source_root = UPSTREAM_ROOT / REPO_DIRS[task["repository"]]
        source_file = source_root / task["source_file"]
        source_text = source_file.read_text(encoding="utf-8")
        match = re.search(re.escape(task["source_symbol"]), source_text)
        line = source_text.count("\n", 0, match.start()) + 1 if match else None
        sample = {
            "schema_version": SCHEMA_VERSION,
            "sample_id": f"tool:{task['id']}",
            "kind": "tool_task",
            "phase": "tool_accuracy",
            "phase_order": 3,
            "question_id": None,
            "repository": task["repository"],
            "retrieval_mode": None,
            "question": sanitize_text(task["question"]),
            "evaluation_context": {"task_requirement": sanitize_text(task["question"])},
            "retrieved_contexts": [],
            "retrieval_context_status": "not_applicable",
            "reference_answer": sanitize_text(task["reference_answer"]),
            "reference_sources": [{
                "path": task["source_file"],
                "start_line": line,
                "end_line": line,
                "source_revision": repo_case.get("upstream", {}).get("sha"),
                "source_kind": "fixed_public_repository_snapshot",
                "source_excerpt": None,
            }],
            "reference_review_status": REFERENCE_REVIEW_STATUS,
            "model_answer": None,
            "messages": [],
            "tool_messages": [],
            "tool_call_reference": sanitize_value(task["expected_tool_calls"]),
            "task_id": task["id"],
            "conversation_id": None,
            "role": "developer",
            "roles": ["developer"],
            "session_links": [],
            "source_revision": repo_case.get("upstream", {}).get("sha"),
            "source_revision_hashes": {"upstream_revision": repo_case.get("upstream", {}).get("sha")},
            "config_hash": config_hash,
            "trace_status": "pending",
            "trace_notes": [],
            "labels_after_score": None,
            "tool_task_spec": sanitize_value(task),
            "workspace_ref": f"data/ragas/tool-workspaces/{task['id']}",
        }
        validate_sample(sample)
        samples.append(sample)
    return samples


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch", default=os.environ.get("NEWAGENT_RAGAS_BATCH", "ragas-v1"))
    args = parser.parse_args()
    if not re.fullmatch(r"ragas-v[1-9][0-9]*", args.batch):
        parser.error("batch must look like ragas-v1")
    ensure_e_drive()

    output_dir = RAGAS_DATA_ROOT / args.batch
    if output_dir.exists():
        raise FileExistsError(f"Ragas batch already exists; choose a new version: {output_dir.name}")
    raw_batch = "ragas-retrieval-" + args.batch.removeprefix("ragas-")
    raw, raw_path = _load_retrieval_export(raw_batch)
    dataset_path = REPOSITORY_EVAL_ROOT / "dataset.json"
    dataset = read_json(dataset_path)
    if _dataset_hash(dataset_path) != TARGET_DATASET_HASH:
        raise ValueError("The frozen repository-eval-v2 dataset hash changed; create a new Ragas review/config before export")
    refs_path = APP_ROOT / "scripts" / "ragas" / "reference-answers-v1.json"
    refs = read_json(refs_path)
    tool_spec_path = APP_ROOT / "scripts" / "ragas" / "tool-cases-v1.json"
    agent_refs_path = APP_ROOT / "scripts" / "ragas" / "agent-reference-answers-v1.json"

    model_config = current_siliconflow_config()
    raw_result_hash = sha256_file(raw_path)
    config_info = current_config(
        model_config,
        raw_result_hash,
        _dataset_hash(dataset_path),
        len(raw.get("questions", [])),
        args.batch,
    )
    export_config = config_info["config"]
    ragas_version = export_config["ragas_version"]
    config_hash = config_info["config_hash"]

    retrieval_samples = _retrieval_samples(raw, raw_path, refs, dataset, config_hash)
    agent_samples = _agent_samples(args.batch, dataset, dataset_path, config_hash)
    if len(agent_samples) != 18:
        raise ValueError(f"expected 18 post-fix holdout trajectories, exported {len(agent_samples)}")
    tool_samples = _tool_task_samples(dataset, config_hash)
    samples = retrieval_samples + agent_samples + tool_samples
    ids = [sample["sample_id"] for sample in samples]
    if len(ids) != len(set(ids)):
        raise ValueError("sample IDs are not unique")
    for sample in samples:
        validate_sample(sample)

    output_dir.mkdir(parents=True, exist_ok=False)
    write_jsonl_atomic(output_dir / "samples.jsonl", samples)
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "batch": args.batch,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "ragas_version": ragas_version,
        "model_config": model_config,
        "model_provider": model_config["provider"],
        "model": model_config["model"],
        "base_url": model_config["base_url"],
        "client_context_cap": model_config["client_context_cap"],
        "provider_context_window": model_config["provider_context_window"],
        "provider_context_window_verified": model_config["provider_context_window"] is not None,
        "previous_sampling": model_config["prior_sampling"],
        "dataset_sha256": _dataset_hash(dataset_path),
        "reference_file_sha256": sha256_file(refs_path),
        "agent_reference_file_sha256": sha256_file(agent_refs_path),
        "tool_spec_sha256": sha256_file(tool_spec_path),
        "raw_retrieval_batch": _relative_to_newagent(raw_path.parent),
        "raw_retrieval_sha256": raw_result_hash,
        "post_fix_harness_hash": HOLDOUT_HARNESS_HASH,
        "config_hash": config_hash,
        "runtime_source_hash": config_info["runtime_source_hash"],
        "sample_count": len(samples),
        "counts_by_kind": {
            "retrieval_qa": len(retrieval_samples),
            "agent_trajectory": len(agent_samples),
            "tool_task": len(tool_samples),
        },
        "counts_by_trace_status": {
            status: sum(sample.get("trace_status") == status for sample in agent_samples)
            for status in ("complete", "incomplete")
        },
        "reference_review_status": REFERENCE_REVIEW_STATUS,
        "legacy_retrieval_context_reconstruction": False,
        "agent_tool_arguments_source": "Pi session JSONL only; HMAC fingerprints are not decoded",
        "independent_acceptance_label_policy": "stored in labels_after_score and excluded from the Ragas scoring payload",
        "model_generation_and_judgement_bias_note": "The same SiliconFlow model is used for answer generation and Ragas judgement.",
        "evaluation_config": export_config,
    }
    write_json_atomic(output_dir / "manifest.json", manifest)
    print(json.dumps({"batch": args.batch, "samples": len(samples), "retrieval": len(retrieval_samples), "agent": len(agent_samples), "tool_tasks": len(tool_samples), "incomplete_agent_traces": manifest["counts_by_trace_status"]["incomplete"], "paid_model_calls": 0}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
