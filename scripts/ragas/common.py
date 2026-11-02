"""Shared paths, versioned JSONL validation, redaction, and atomic output."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Iterable


APP_ROOT = Path(__file__).resolve().parents[2]
NEWAGENT_ROOT = Path(os.environ.get("NEWAGENT_HOME", r"E:\newagent")).resolve()
RAGAS_DATA_ROOT = NEWAGENT_ROOT / "data" / "ragas"
REPOSITORY_EVAL_ROOT = NEWAGENT_ROOT / "data" / "repository-eval-v2"
UPSTREAM_ROOT = NEWAGENT_ROOT / "upstream" / "eval"
SCHEMA_VERSION = "newagent-ragas-jsonl-v1"
REFERENCE_REVIEW_STATUS = "ai_source_checked_unreviewed"
REPO_DIRS = {
    "mitt": "mitt",
    "fast-json-stable-stringify": "fast-json-stable-stringify",
    "dlv": "dlv",
}

_WINDOWS_PATH = re.compile(r"(?i)\b[A-Z]:\\[^\s\r\n\"<>|]+")
_UNIX_WORKSPACE_PATH = re.compile(r"(?i)/(?:workspace|home|root)/[^\s\"'`]*")
_BEARER = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}")
_API_KEY_ASSIGNMENT = re.compile(
    r"(?i)\b((?:NEWAGENT_API_KEY|OPENAI_API_KEY|API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET)\s*[:=]\s*)[^\s,;\"']+"
)
_SK_TOKEN = re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b")
_SECRET_FIELD = re.compile(r"(?i)(?:api.?key|token|secret|password|credential)")
_REQUIRED_SAMPLE_FIELDS = {
    "schema_version",
    "sample_id",
    "kind",
    "question",
    "retrieved_contexts",
    "reference_answer",
    "model_answer",
    "messages",
    "tool_messages",
    "task_id",
    "conversation_id",
    "role",
    "source_revision",
    "config_hash",
    "reference_review_status",
}


def stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def sanitize_text(value: str) -> str:
    """Remove credentials and machine-local paths before persistence or model input."""
    text = _BEARER.sub("Bearer [REDACTED]", value)
    text = _API_KEY_ASSIGNMENT.sub(r"\1[REDACTED]", text)
    text = _SK_TOKEN.sub("[REDACTED_TOKEN]", text)
    text = _WINDOWS_PATH.sub("<local-path>", text)
    text = _UNIX_WORKSPACE_PATH.sub("<local-path>", text)
    return text


def sanitize_value(value: Any, key: str = "") -> Any:
    if _SECRET_FIELD.search(key):
        return "[REDACTED]"
    if isinstance(value, str):
        return sanitize_text(value)
    if isinstance(value, list):
        return [sanitize_value(item) for item in value]
    if isinstance(value, dict):
        return {str(k): sanitize_value(v, str(k)) for k, v in value.items()}
    return value


def validate_sample(sample: dict[str, Any]) -> None:
    missing = sorted(_REQUIRED_SAMPLE_FIELDS - set(sample))
    if missing:
        raise ValueError(f"sample {sample.get('sample_id', '<unknown>')} missing fields: {missing}")
    if sample["schema_version"] != SCHEMA_VERSION:
        raise ValueError(f"unsupported sample schema: {sample['schema_version']}")
    if not isinstance(sample["sample_id"], str) or not sample["sample_id"]:
        raise ValueError("sample_id must be a non-empty string")
    if sample["kind"] not in {"retrieval_qa", "agent_trajectory", "tool_task"}:
        raise ValueError(f"unknown sample kind: {sample['kind']}")
    if not isinstance(sample["retrieved_contexts"], list):
        raise ValueError("retrieved_contexts must be an array")
    if not isinstance(sample["messages"], list) or not isinstance(sample["tool_messages"], list):
        raise ValueError("messages and tool_messages must be arrays")
    if sample["reference_review_status"] not in {
        "ai_source_checked_unreviewed",
        "human_reviewed",
        "not_applicable",
    }:
        raise ValueError("reference_review_status is invalid")
    if sample.get("trace_status") not in {"complete", "incomplete", "not_applicable", "pending"}:
        raise ValueError("trace_status is invalid")
    for context in sample["retrieved_contexts"]:
        if not isinstance(context, dict) or "rank" not in context:
            raise ValueError("each retrieved context must include a rank")
        if context.get("rank", 0) < 1:
            raise ValueError("retrieved context rank must be positive")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, start=1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"invalid JSONL at {path.name}:{line_number}: {exc.msg}") from exc
            if not isinstance(record, dict):
                raise ValueError(f"JSONL row at {path.name}:{line_number} must be an object")
            records.append(record)
    return records


def write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    _atomic_write(path, content)


def write_jsonl_atomic(path: Path, records: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    content = "".join(stable_json(record) + "\n" for record in records)
    _atomic_write(path, content)


def _atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass


def ensure_e_drive() -> None:
    if os.name == "nt" and NEWAGENT_ROOT.drive.upper() != "E:":
        raise RuntimeError(f"NewAgent Ragas data must stay on E:, got drive {NEWAGENT_ROOT.drive!r}")


def current_siliconflow_config() -> dict[str, Any]:
    """Read the redacted provider/model settings from the latest corrected run."""
    run_root = (
        REPOSITORY_EVAL_ROOT
        / "single-case-holdout-diagnostic-v36"
        / "dlv-options-integration-adaptive-rag-1"
        / "data"
    )
    model_config = read_json(run_root / "model.json")
    provider_config = read_json(run_root / "pi" / "models.json")
    provider_name = model_config.get("provider")
    model_id = model_config.get("model")
    provider = (provider_config.get("providers") or {}).get(provider_name, {})
    models = provider.get("models") or []
    model = next((item for item in models if item.get("id") == model_id), None)
    if (
        provider_name != "siliconflow"
        or model_id != "deepseek-ai/DeepSeek-V4-Flash"
        or provider.get("baseUrl") != "https://api.siliconflow.cn/v1"
        or not model
    ):
        raise RuntimeError("The saved corrected-run SiliconFlow configuration is missing or changed")

    result_path = run_root.parent / "result.json"
    result = read_json(result_path)
    manifest_path = run_root.parents[1] / "manifest.json"
    manifest = read_json(manifest_path)
    return {
        "provider": provider_name,
        "base_url": provider["baseUrl"],
        "model": model_id,
        "client_context_cap": manifest.get("context"),
        "provider_context_window": manifest.get("providerContextWindow"),
        "prior_sampling": result.get("sampling"),
        "source_batch": "single-case-holdout-diagnostic-v36",
    }
