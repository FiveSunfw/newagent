"""Write per-sample JSONL/CSV/Markdown summaries without a blended score."""

from __future__ import annotations

import argparse
import csv
import json
import os
import statistics
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

from common import NEWAGENT_ROOT, RAGAS_DATA_ROOT, ensure_e_drive, read_json, read_jsonl, sanitize_text, write_jsonl_atomic


METRICS = [
    "answer_generation",
    "context_precision",
    "context_recall",
    "faithfulness",
    "agent_goal_accuracy_with_reference",
    "tool_trace",
    "tool_call_accuracy",
]
JUDGE_METRICS = {
    "context_precision",
    "context_recall",
    "faithfulness",
    "agent_goal_accuracy_with_reference",
}


def _mean(values: list[float]) -> float | None:
    return statistics.fmean(values) if values else None


def _fmt(value: Any) -> str:
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:.4f}"
    return str(value)


def _result_index(rows: list[dict[str, Any]]) -> dict[tuple[str, str], dict[str, Any]]:
    indexed: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        key = (str(row.get("sample_id", "")), str(row.get("metric", "")))
        if all(key):
            indexed[key] = row
    return indexed


def build_rows(
    samples: list[dict[str, Any]],
    result_rows: list[dict[str, Any]],
    raw_calls: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    index = _result_index(result_rows)
    calls_by_id = {str(call.get("request_id")): call for call in raw_calls or [] if call.get("request_id")}
    output: list[dict[str, Any]] = []
    for sample in samples:
        sample_id = sample["sample_id"]
        row: dict[str, Any] = {
            "sample_id": sample_id,
            "kind": sample.get("kind"),
            "phase": sample.get("phase"),
            "repository": sample.get("repository"),
            "question_id": sample.get("question_id"),
            "retrieval_mode": sample.get("retrieval_mode"),
            "trace_status": sample.get("trace_status"),
            "reference_review_status": sample.get("reference_review_status"),
            "model_answer": None,
            "answer_generation_status": "not_run",
            "recall_at_5": (sample.get("retrieval_metrics") or {}).get("recall_at_5"),
            "mrr_at_10": (sample.get("retrieval_metrics") or {}).get("mrr_at_10"),
            "functional_acceptance": (sample.get("labels_after_score") or {}).get("functional_acceptance"),
            "delivery_gate": (sample.get("labels_after_score") or {}).get("delivery_gate"),
            "context_precision": None,
            "context_precision_status": "not_run",
            "context_recall": None,
            "context_recall_status": "not_run",
            "faithfulness": None,
            "faithfulness_status": "not_run",
            "agent_goal_accuracy_with_reference": None,
            "agent_goal_status": "not_run",
            "tool_trace_status": "not_run",
            "tool_call_accuracy": None,
            "tool_call_accuracy_status": "not_run",
            "tool_task_check": None,
            "false_positive_vs_functional_acceptance": None,
            "false_negative_vs_functional_acceptance": None,
            "false_positive_vs_delivery_gate": None,
            "result_notes": [],
            "request_ids": [],
            "judgement_evidence": {},
        }
        for metric_name in METRICS:
            result = index.get((sample_id, metric_name))
            if not result:
                continue
            if metric_name in JUDGE_METRICS:
                evidence = []
                for request_id in result.get("request_ids", []):
                    call = calls_by_id.get(str(request_id))
                    if call:
                        evidence.append(
                            {
                                "request_id": request_id,
                                "status": call.get("status"),
                                "usage": call.get("usage"),
                                "output": call.get("output"),
                            }
                        )
                if evidence:
                    row["judgement_evidence"][metric_name] = evidence
            if metric_name == "answer_generation":
                row["model_answer"] = result.get("model_answer")
                row["answer_generation_status"] = result.get("status")
                if result.get("reason"):
                    row["result_notes"].append("answer_generation: " + sanitize_text(str(result["reason"])))
            elif metric_name in {"context_precision", "context_recall", "faithfulness"}:
                row[metric_name] = result.get("score")
                row[f"{metric_name}_status"] = result.get("status")
                if result.get("reason"):
                    row["result_notes"].append(metric_name + ": " + sanitize_text(str(result["reason"])))
            elif metric_name == "agent_goal_accuracy_with_reference":
                row[metric_name] = result.get("score")
                row["agent_goal_status"] = result.get("status")
                score = result.get("score")
                functional = row["functional_acceptance"]
                gate = row["delivery_gate"]
                if isinstance(score, (int, float)) and functional is not None:
                    row["false_positive_vs_functional_acceptance"] = bool(score >= 0.5 and not functional)
                    row["false_negative_vs_functional_acceptance"] = bool(score < 0.5 and functional)
                    if gate is not None:
                        row["false_positive_vs_delivery_gate"] = bool(score >= 0.5 and not gate)
                if result.get("reason"):
                    row["result_notes"].append("agent_goal: " + sanitize_text(str(result["reason"])))
            elif metric_name == "tool_trace":
                row["tool_trace_status"] = result.get("status")
                row["model_answer"] = row["model_answer"] or result.get("model_answer")
                row["tool_task_check"] = result.get("independent_tool_task_check")
                if result.get("reason"):
                    row["result_notes"].append("tool_trace: " + sanitize_text(str(result["reason"])))
            elif metric_name == "tool_call_accuracy":
                row[metric_name] = result.get("score")
                row["tool_call_accuracy_status"] = result.get("status")
                row["tool_task_check"] = result.get("tool_task_check", row["tool_task_check"])
                if result.get("reason"):
                    row["result_notes"].append("tool_call_accuracy: " + sanitize_text(str(result["reason"])))
            row["request_ids"].extend(result.get("request_ids", []))
        if row["kind"] == "agent_trajectory":
            score = row["agent_goal_accuracy_with_reference"]
            functional = row["functional_acceptance"]
            gate = row["delivery_gate"]
            if isinstance(score, (int, float)) and functional is not None:
                row["false_positive_vs_functional_acceptance"] = bool(score >= 0.5 and not functional)
                row["false_negative_vs_functional_acceptance"] = bool(score < 0.5 and functional)
                if gate is not None:
                    row["false_positive_vs_delivery_gate"] = bool(score >= 0.5 and not gate)
        row["request_ids"] = sorted(set(row["request_ids"]))
        row["result_notes"] = "; ".join(row["result_notes"])
        output.append(row)
    return output


def _metric_summary(rows: list[dict[str, Any]], metric: str, status_key: str) -> tuple[int, int, float | None, int, int]:
    values = [float(row[metric]) for row in rows if isinstance(row.get(metric), (int, float))]
    total = sum(row.get(status_key) not in {"not_run", None} for row in rows)
    failed = sum(row.get(status_key) in {"scoring_error", "usage_missing", "budget_refused"} for row in rows)
    empty = sum(row.get(status_key) in {"empty_retrieval", "empty_answer", "incomplete_context", "incomplete_trace"} for row in rows)
    return len(values), total, _mean(values), failed, empty


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    fields = [
        "sample_id", "kind", "phase", "repository", "question_id", "retrieval_mode",
        "trace_status", "reference_review_status", "recall_at_5", "mrr_at_10", "answer_generation_status",
        "context_precision", "context_precision_status", "context_recall", "context_recall_status",
        "faithfulness", "faithfulness_status", "agent_goal_accuracy_with_reference", "agent_goal_status",
        "functional_acceptance", "delivery_gate", "false_positive_vs_functional_acceptance",
        "false_negative_vs_functional_acceptance", "false_positive_vs_delivery_gate",
        "tool_trace_status", "tool_call_accuracy", "tool_call_accuracy_status", "tool_task_check",
        "model_answer", "request_ids", "judgement_evidence", "result_notes",
    ]
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            cooked = dict(row)
            if isinstance(cooked.get("request_ids"), list):
                cooked["request_ids"] = ",".join(cooked["request_ids"])
            if isinstance(cooked.get("tool_task_check"), dict):
                cooked["tool_task_check"] = json.dumps(cooked["tool_task_check"], ensure_ascii=False)
            if isinstance(cooked.get("judgement_evidence"), dict):
                cooked["judgement_evidence"] = json.dumps(cooked["judgement_evidence"], ensure_ascii=False)
            writer.writerow(cooked)


def write_review_queue(path: Path, samples: list[dict[str, Any]], rows: list[dict[str, Any]]) -> None:
    row_map = {row["sample_id"]: row for row in rows}
    samples_by_question: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for sample in samples:
        if sample.get("kind") == "retrieval_qa" and sample.get("question_id"):
            samples_by_question[str(sample["question_id"])].append(sample)
    queue: list[dict[str, Any]] = []
    seen_questions: set[str] = set()
    for sample in samples:
        row = row_map.get(sample["sample_id"], {})
        if sample.get("kind") == "retrieval_qa":
            qid = sample.get("question_id")
            if qid in seen_questions:
                continue
            seen_questions.add(qid)
            modes = {}
            for retrieval_sample in samples_by_question.get(str(qid), []):
                mode_row = row_map.get(retrieval_sample["sample_id"], {})
                modes[retrieval_sample.get("retrieval_mode") or "unknown"] = {
                    "context_precision": mode_row.get("context_precision"),
                    "context_precision_status": mode_row.get("context_precision_status"),
                    "context_recall": mode_row.get("context_recall"),
                    "context_recall_status": mode_row.get("context_recall_status"),
                    "faithfulness": mode_row.get("faithfulness"),
                    "faithfulness_status": mode_row.get("faithfulness_status"),
                    "judgement_evidence": mode_row.get("judgement_evidence", {}),
                }
            queue.append({
                "review_id": f"reference:{qid}",
                "kind": "retrieval_reference",
                "sample_id": sample["sample_id"],
                "question_id": qid,
                "reference_review_status": sample.get("reference_review_status"),
                "question": sample.get("question"),
                "reference_answer": sample.get("reference_answer"),
                "reference_sources": sample.get("reference_sources"),
                "ragas_by_retrieval_mode": modes,
                "review_reasons": ["Confirm the source-grounded answer and exact line range; current status is not human reviewed."],
            })
        elif sample.get("kind") == "agent_trajectory":
            if sample.get("trace_status") != "complete" or row.get("agent_goal_status") not in {"not_run", "complete", "scoring_error", "incomplete_trace"}:
                reason = "Trace is incomplete or score is missing."
            else:
                reason = "Review both successful and failed trajectories; check possible false-positive/false-negative agent-goal judgements."
            queue.append({
                "review_id": f"trajectory:{sample['sample_id']}",
                "kind": "agent_trajectory",
                "sample_id": sample["sample_id"],
                "reference_review_status": sample.get("reference_review_status"),
                "trace_status": sample.get("trace_status"),
                "score": row.get("agent_goal_accuracy_with_reference"),
                "functional_acceptance": (sample.get("labels_after_score") or {}).get("functional_acceptance"),
                "delivery_gate": (sample.get("labels_after_score") or {}).get("delivery_gate"),
                "judgement_evidence": row.get("judgement_evidence", {}),
                "review_reasons": [reason],
            })
        elif sample.get("kind") == "tool_task":
            queue.append({
                "review_id": f"tool:{sample['sample_id']}",
                "kind": "tool_task",
                "sample_id": sample["sample_id"],
                "reference_review_status": sample.get("reference_review_status"),
                "tool_call_accuracy": row.get("tool_call_accuracy"),
                "tool_task_check": row.get("tool_task_check"),
                "review_reasons": ["Check the reference tool names/arguments against the saved real trace and verify the isolated file effect."],
            })
    write_jsonl_atomic(path, queue)


def render_report(manifest: dict[str, Any], samples: list[dict[str, Any]], rows: list[dict[str, Any]], ledger: dict[str, Any] | None) -> str:
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    evaluation_config = manifest.get("evaluation_config") or {}
    price_source = manifest.get("price_source") or evaluation_config.get("price_source")
    retrieval_config = manifest.get("retrieval_config") or {}
    embedding_config = retrieval_config.get("embedding") or {}
    repositories = sorted({str(sample.get("repository")) for sample in samples if sample.get("repository")})
    per_kind: dict[str, int] = defaultdict(int)
    for sample in samples:
        per_kind[sample["kind"]] += 1
    lines = [
        f"# NewAgent Ragas 分层评测 {manifest['batch']}",
        "",
        f"报告生成时间：{now}",
        "",
        "## 评测配置",
        "",
        f"- Ragas：`{manifest.get('ragas_version')}`；模型：`{manifest.get('model')}`（{manifest.get('model_provider')}）。",
        f"- 客户端上下文上限：{manifest.get('client_context_cap')}；provider 上下文长度核实：{manifest.get('provider_context_window_verified')}。",
        f"- 样本：检索问答 {per_kind.get('retrieval_qa', 0)} 条、Agent 轨迹 {per_kind.get('agent_trajectory', 0)} 条、ToolCall 窄任务 {per_kind.get('tool_task', 0)} 条。",
        f"- 仓库：{', '.join(repositories)}；检索使用 `{embedding_config.get('model', '未记录')}` / {embedding_config.get('dimensions', '未知')} 维，查询指令版 `{embedding_config.get('version', '未记录')}`，Embedding 在本机执行。",
        f"- 参考答案审核：`{manifest.get('reference_review_status')}`；Ragas 只作质量诊断，代码验收和交付 Gate 保持独立。",
        f"- 费用估算价格采集时间：`{(ledger or {}).get('price', {}).get('observed_at_asia_shanghai', '未记录')}`；来源：[SiliconFlow 官方公告]({price_source})。未对账平台实际账单。",
        *[
            f"- 评测后修正：{item.get('description')} 执行期源码哈希仍记录在 manifest；修正未重算分数。"
            for item in manifest.get("post_run_adjustments", [])
        ],
        "",
        "## 检索与回答指标",
        "",
        "|检索模式|样本数|Recall@5|MRR@10|ContextPrecision|有效 n|ContextRecall|有效 n|Faithfulness|有效 n|",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    retrieval_rows = [row for row in rows if row.get("kind") == "retrieval_qa"]
    for mode in ("keyword", "dense", "hybrid"):
        subset = [row for row in retrieval_rows if row.get("retrieval_mode") == mode]
        cp_values = [row["context_precision"] for row in subset if isinstance(row.get("context_precision"), (int, float))]
        cr_values = [row["context_recall"] for row in subset if isinstance(row.get("context_recall"), (int, float))]
        faith_values = [row["faithfulness"] for row in subset if isinstance(row.get("faithfulness"), (int, float))]
        recall_values = [row["recall_at_5"] for row in subset if isinstance(row.get("recall_at_5"), (int, float))]
        mrr_values = [row["mrr_at_10"] for row in subset if isinstance(row.get("mrr_at_10"), (int, float))]
        lines.append(
            f"|{mode}|{len(subset)}|{_fmt(_mean(recall_values))}|{_fmt(_mean(mrr_values))}|{_fmt(_mean(cp_values))}|{len(cp_values)}|{_fmt(_mean(cr_values))}|{len(cr_values)}|{_fmt(_mean(faith_values))}|{len(faith_values)}|"
        )
    lines.extend([
        "",
        "分数只对已完成且有效的样本求均值；空上下文、空回答、解析错误与预算停止均单独计数，不以 0 分替代。回答生成输入不包含参考答案。",
        "原始评判输出按请求 ID 保存在 `raw-llm-calls.jsonl`，已关联到 `scores.jsonl`、`scores.csv` 和人工复核队列。",
        "Q8 的历史目标标签指向 `mitt/README.md`，但 README 没说明省略 handler 时的行为；参考答案只记录文档未覆盖此点，该标签仍待人工复核。",
        "",
    ])

    lines.extend(["|模式|指标|已完成|评分错误|空/不完整|预算拒绝|Usage 缺失|未运行|", "|---|---|---:|---:|---:|---:|---:|---:|"])
    for mode in ("keyword", "dense", "hybrid"):
        subset = [row for row in retrieval_rows if row.get("retrieval_mode") == mode]
        for metric in ("answer_generation", "context_precision", "context_recall", "faithfulness"):
            status_key = "answer_generation_status" if metric == "answer_generation" else f"{metric}_status"
            statuses = [row.get(status_key, "not_run") for row in subset]
            completed = statuses.count("complete")
            errors = statuses.count("scoring_error") + statuses.count("generation_error")
            empty = sum(status in {"empty_retrieval", "empty_answer", "incomplete_context", "incomplete_trace"} for status in statuses)
            budget_refused = statuses.count("budget_refused")
            usage_missing = statuses.count("usage_missing")
            not_run = statuses.count("not_run")
            lines.append(f"|{mode}|{metric}|{completed}|{errors}|{empty}|{budget_refused}|{usage_missing}|{not_run}|")
    lines.append("")

    agent_rows = [row for row in rows if row.get("kind") == "agent_trajectory"]
    valid_agent = [row for row in agent_rows if isinstance(row.get("agent_goal_accuracy_with_reference"), (int, float))]
    false_positive = [row for row in valid_agent if row.get("false_positive_vs_functional_acceptance")]
    false_negative = [row for row in valid_agent if row.get("false_negative_vs_functional_acceptance")]
    lines.extend([
        "## Agent 轨迹与独立验收对照",
        "",
        f"- 导出的轨迹：{len(agent_rows)}；可评分完整轨迹：{len(valid_agent)}；平均 AgentGoalAccuracyWithReference：{_fmt(_mean([row['agent_goal_accuracy_with_reference'] for row in valid_agent]))}。",
        f"- 相对独立功能验收：潜在假阳性 {len(false_positive)} 条，潜在假阴性 {len(false_negative)} 条。分数阈值0.5只用于不一致队列，不等于模型预测已校准。",
        f"- 真实 code acceptance：{sum(bool(row.get('functional_acceptance')) for row in agent_rows if row.get('functional_acceptance') is not None)}/{sum(row.get('functional_acceptance') is not None for row in agent_rows)}；delivery Gate：{sum(bool(row.get('delivery_gate')) for row in agent_rows if row.get('delivery_gate') is not None)}/{sum(row.get('delivery_gate') is not None for row in agent_rows)}。Ragas 的 AgentGoalAccuracy 不能替代这两项程序标签。",
        "",
        "## 窄工具任务",
        "",
    ])
    tool_rows = [row for row in rows if row.get("kind") == "tool_task"]
    if tool_rows:
        lines.append("|任务|ToolCallAccuracy|轨迹状态|隔离文件检查|")
        lines.append("|---|---:|---|---|")
        for row in tool_rows:
            lines.append(f"|{row.get('sample_id')}|{_fmt(row.get('tool_call_accuracy'))}|{row.get('tool_trace_status')}|{row.get('tool_task_check')}|")
    else:
        lines.append("尚未运行。")
    lines.extend(["", "## 预算与完成情况", ""])
    if ledger:
        complete_requests = sum(item.get("status") in {"complete", "provider_error_with_usage"} for item in ledger.get("requests", []))
        unknown_usage = sum(item.get("status", "").startswith("usage_unknown") for item in ledger.get("requests", []))
        lines.append(f"- 模型请求记录 {len(ledger.get('requests', []))}；有 Usage {complete_requests}；Usage 缺失/不确定 {unknown_usage}。")
        prompt_tokens = sum(int((item.get("usage") or {}).get("prompt_tokens", 0)) for item in ledger.get("requests", []))
        completion_tokens = sum(int((item.get("usage") or {}).get("completion_tokens", 0)) for item in ledger.get("requests", []))
        cached_tokens = sum(int((item.get("usage") or {}).get("cached_prompt_tokens", 0) or 0) for item in ledger.get("requests", []))
        lines.append(f"- Usage 合计：输入 {prompt_tokens:,} tokens、输出 {completion_tokens:,} tokens、缓存输入 {cached_tokens:,} tokens。估算采用输入 ¥{ledger.get('price', {}).get('input_cny_per_million', '未知')}/百万、输出 ¥{ledger.get('price', {}).get('output_cny_per_million', '未知')}/百万，不使用缓存优惠。")
        lines.append(f"- 本地费用估算已结算 ¥{ledger.get('spent_cny', '0')}，保留 ¥{ledger.get('reserved_cny', '0')}，上限 ¥{ledger.get('cap_cny', '3.00')}；暂停状态：{ledger.get('halted')}（{ledger.get('halt_reason') or '无'}）。")
    scored_samples = sum(
        any(row.get(f"{metric}_status") not in {"not_run", None} for metric in (
            "answer_generation", "context_precision", "context_recall", "faithfulness",
            "agent_goal", "tool_trace", "tool_call_accuracy",
        ))
        for row in rows
    )
    lines.append(f"- 至少有一项结果的样本：{scored_samples}/{len(samples)}；每个指标的完成数、预算拒绝和未运行数见 scores.csv / scores.jsonl。")
    lines.append("- 同一 DeepSeek 模型用于回答和评判，存在自评偏差；30条问题已被使用过，属于迭代集，不是新的独立保留集。真人审核队列尚未自动视为已审核。")
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch", default=os.environ.get("NEWAGENT_RAGAS_BATCH", "ragas-v1"))
    args = parser.parse_args()
    ensure_e_drive()
    batch_dir = RAGAS_DATA_ROOT / args.batch
    manifest_path = batch_dir / "manifest.json"
    samples_path = batch_dir / "samples.jsonl"
    if not manifest_path.exists() or not samples_path.exists():
        raise FileNotFoundError(f"Ragas batch export is missing: {args.batch}")
    manifest = read_json(manifest_path)
    samples = read_jsonl(samples_path)
    raw_retrieval_relative = manifest.get("raw_retrieval_batch")
    if isinstance(raw_retrieval_relative, str):
        retrieval_config_path = NEWAGENT_ROOT / raw_retrieval_relative / "data" / "retrieval.json"
        if retrieval_config_path.is_file():
            manifest["retrieval_config"] = read_json(retrieval_config_path)
    result_path = batch_dir / "results.jsonl"
    result_rows = read_jsonl(result_path) if result_path.exists() else []
    calls_path = batch_dir / "raw-llm-calls.jsonl"
    raw_calls = read_jsonl(calls_path) if calls_path.exists() else []
    rows = build_rows(samples, result_rows, raw_calls)
    write_jsonl_atomic(batch_dir / "scores.jsonl", rows)
    write_csv(batch_dir / "scores.csv", rows)
    write_review_queue(batch_dir / "review_queue.jsonl", samples, rows)
    ledger_path = RAGAS_DATA_ROOT / "ledger-v1.json"
    ledger = read_json(ledger_path) if ledger_path.exists() else None
    report = render_report(manifest, samples, rows, ledger)
    (batch_dir / "report.md").write_text(report, encoding="utf-8", newline="\n")
    print(f"Wrote report.md, scores.jsonl, scores.csv, and review_queue.jsonl for {args.batch} ({len(samples)} exported samples).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
