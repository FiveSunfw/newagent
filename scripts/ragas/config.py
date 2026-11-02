"""Frozen evaluation configuration and source hashes."""

from __future__ import annotations

import importlib.metadata
from pathlib import Path
from typing import Any

from common import APP_ROOT, stable_json, sha256_text
from prompts import ANSWER_PROMPT_VERSION, answer_prompt_hash


RUNTIME_FILES = [
    "scripts/ragas/common.py",
    "scripts/ragas/config.py",
    "scripts/ragas/prompts.py",
    "scripts/ragas/budget.py",
    "scripts/ragas/results.py",
    "scripts/ragas/tool_tasks.py",
    "scripts/ragas/export.py",
    "scripts/ragas/export.mjs",
    "scripts/ragas/cli.mjs",
    "scripts/ragas/run.py",
    "scripts/ragas/lock_from_report.py",
    "scripts/ragas/setup.ps1",
    "scripts/ragas/start-local-embedding.ps1",
    "scripts/ragas/stop-local-embedding.ps1",
    "scripts/ragas/requirements.in",
    "scripts/ragas/reference-answers-v1.json",
    "scripts/ragas/agent-reference-answers-v1.json",
    "scripts/ragas/tool-cases-v1.json",
    "scripts/ragas/schema-v1.json",
    "scripts/ragas/requirements.lock",
    "src/eval/evaluate-retrieval.ts",
    "package.json",
]


def runtime_hash() -> str:
    pieces: list[str] = []
    for relative in RUNTIME_FILES:
        path = APP_ROOT / relative
        if not path.is_file():
            raise FileNotFoundError(f"Ragas runtime source is missing: {relative}")
        pieces.append(relative + "\0" + path.read_bytes().hex())
    return sha256_text("\n".join(pieces))


def current_config(model_config: dict[str, Any], retrieval_result_hash: str, dataset_hash: str, raw_question_count: int, batch: str) -> dict[str, Any]:
    ragas_version = importlib.metadata.version("ragas")
    requirements_hash = __import__("hashlib").sha256((APP_ROOT / "scripts/ragas/requirements.lock").read_bytes()).hexdigest()
    values = {
        "batch": batch,
        "schema_version": "newagent-ragas-jsonl-v1",
        "ragas_version": ragas_version,
        "requirements_lock_sha256": requirements_hash,
        "model": model_config,
        "retrieval_result_sha256": retrieval_result_hash,
        "dataset_sha256": dataset_hash,
        "question_count": raw_question_count,
        "ragas_context_top_k": 5,
        "metrics": [
            "ContextPrecision",
            "ContextRecall",
            "Faithfulness",
            "AgentGoalAccuracyWithReference",
            "ToolCallAccuracy",
        ],
        "answer_prompt_version": ANSWER_PROMPT_VERSION,
        "answer_prompt_sha256": answer_prompt_hash(),
        "answer_max_tokens": 512,
        "judge_max_tokens": 1024,
        "tool_agent_max_tokens": 512,
        "global_output_cap": 4096,
        "answer_sampling": {"temperature": 0.7, "top_p": 1.0, "presence_penalty": 1.5},
        "judge_sampling": {"temperature": 0.0, "top_p": 1.0, "presence_penalty": 0.0},
        "judge_repair_max_retries": 1,
        "budget_cap_cny": 3.0,
        "budget_prices_cny_per_million": {"input_no_cache_discount": 3.0, "output": 9.0},
        "price_source": "https://docs.siliconflow.cn/docs/release-notes/overview",
    }
    return {"config": values, "runtime_source_hash": runtime_hash(), "config_hash": sha256_text(stable_json({"config": values, "runtime_source_hash": runtime_hash()}))}
