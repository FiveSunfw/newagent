"""Crash-safe, de-duplicated JSONL results for resumable Ragas runs."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from common import read_jsonl, write_jsonl_atomic


TERMINAL_STATUSES = {
    "complete",
    "empty_retrieval",
    "empty_answer",
    "incomplete_trace",
    "scoring_error",
    "tool_task_failed",
    "budget_refused",
    "usage_missing",
}


class ResultStore:
    def __init__(self, path: Path):
        self.path = path
        self.rows: dict[tuple[str, str], dict[str, Any]] = {}
        if path.exists():
            for row in read_jsonl(path):
                key = (str(row.get("sample_id", "")), str(row.get("metric", "")))
                if not all(key) or key in self.rows:
                    raise ValueError(f"invalid or duplicate result key in {path.name}: {key}")
                self.rows[key] = row

    def get(self, sample_id: str, metric: str) -> dict[str, Any] | None:
        return self.rows.get((sample_id, metric))

    def is_terminal(self, sample_id: str, metric: str) -> bool:
        row = self.get(sample_id, metric)
        return bool(row and row.get("status") in TERMINAL_STATUSES)

    def upsert(self, row: dict[str, Any]) -> None:
        if not row.get("sample_id") or not row.get("metric") or not row.get("status"):
            raise ValueError("result rows require sample_id, metric, and status")
        key = (str(row["sample_id"]), str(row["metric"]))
        previous = self.rows.get(key)
        if previous and previous.get("status") in TERMINAL_STATUSES:
            if previous.get("status") == row.get("status") == "complete":
                merged = {**previous, **row}
                self.rows[key] = merged
                self.flush()
                return
            if previous.get("status") != "budget_refused":
                return
        row.setdefault("updated_at", datetime.now(timezone.utc).isoformat(timespec="seconds"))
        if previous:
            history = list(previous.get("attempt_history", []))
            history.append(
                {
                    "status": previous.get("status"),
                    "error": previous.get("error"),
                    "updated_at": previous.get("updated_at"),
                }
            )
            row["attempt_history"] = history
        self.rows[key] = row
        self.flush()

    def flush(self) -> None:
        ordered = sorted(self.rows.values(), key=lambda row: (row.get("phase_order", 99), row.get("sample_id", ""), row.get("metric", "")))
        write_jsonl_atomic(self.path, ordered)

    def counts(self) -> dict[str, int]:
        output: dict[str, int] = {}
        for row in self.rows.values():
            status = str(row.get("status", "unknown"))
            output[status] = output.get(status, 0) + 1
        return output
