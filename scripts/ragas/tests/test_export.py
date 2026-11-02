from __future__ import annotations

import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import export as ragas_export
from common import NEWAGENT_ROOT


class ExportTraceTests(unittest.TestCase):
    def setUp(self) -> None:
        base = NEWAGENT_ROOT / "cache" / "ragas-tests"
        base.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="export-", dir=base)
        self.root = Path(self.temp.name)
        self.eval_root = self.root / "repository-eval"
        self.batch_root = self.eval_root / "single-case-holdout-diagnostic-v-fixture"
        self.run_dir = self.batch_root / "case" / "run"
        self.run_dir.mkdir(parents=True)
        self.case_id = "mitt-dispatch-snapshot"
        self.dataset_path = self.root / "dataset.json"
        self.dataset = {
            "cases": [
                {
                    "id": self.case_id,
                    "split": "holdout",
                    "repository": "mitt",
                    "requirement": "Dispatch a snapshot.",
                    "acceptance": "Verify a fixed event sequence.",
                    "mutation": [{"file": "src/index.ts", "before": "export function emit() {"}],
                    "setup": {"src/index.ts": "export function emit() {\n  return;\n}"},
                    "upstream": {"sha": "fixed-source-sha"},
                    "seededRevision": "seeded-revision",
                    "referenceRevision": "reference-revision",
                }
            ]
        }
        self.dataset_path.write_text(json.dumps(self.dataset), encoding="utf-8")
        manifest = {"mode": ragas_export.HISTORICAL_MODE, "evalHarnessHash": ragas_export.HOLDOUT_HARNESS_HASH}
        (self.batch_root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        self.result = {
            "caseId": self.case_id,
            "strategy": "single",
            "split": "holdout",
            "task": {"id": "task-fixture"},
            "diff": "diff --git a/src/index.ts b/src/index.ts",
            "events": [],
            "recovery": {"requested": False, "restarted": False},
            "functionalAcceptance": False,
            "deliveryGate": False,
        }
        (self.run_dir / "result.json").write_text(json.dumps(self.result), encoding="utf-8")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _samples(self):
        with patch.object(ragas_export, "REPOSITORY_EVAL_ROOT", self.eval_root):
            return ragas_export._agent_samples("ragas-fixture", self.dataset, self.dataset_path, "config-hash")

    def _session(self, role: str, name: str, rows: list[dict]) -> Path:
        path = self.run_dir / "data" / "sessions" / "task-fixture" / role / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
        return path

    def test_recovers_call_result_and_links_pre_post_checkpoint_sessions(self) -> None:
        (self.run_dir / "restart-checkpoint.json").write_text(json.dumps({"at": "2026-10-05T12:00:00Z"}), encoding="utf-8")
        self.result["recovery"] = {"requested": True, "restarted": True}
        (self.run_dir / "result.json").write_text(json.dumps(self.result), encoding="utf-8")
        pre_rows = [
            {"type": "message", "id": "u1", "message": {"role": "user", "content": [{"type": "text", "text": "Please inspect."}]}},
            {"type": "message", "id": "a1", "message": {"role": "assistant", "content": [{"type": "toolCall", "id": "call-1", "name": "read_file", "arguments": {"path": "src/index.ts"}}]}},
        ]
        post_rows = [
            {"type": "message", "id": "t1", "message": {"role": "toolResult", "toolCallId": "call-1", "toolName": "read_file", "content": [{"type": "text", "text": "source line"}]}},
            {"type": "message", "id": "a2", "message": {"role": "assistant", "content": [{"type": "text", "text": "Done."}]}},
        ]
        self._session("developer", "2026-10-05T11-00-00-000Z_pre.jsonl", pre_rows)
        self._session("developer", "2026-10-05T13-00-00-000Z_post.jsonl", post_rows)
        self.result["events"] = [{"kind": "agent_tool", "body": {"callId": "call-1", "argumentsHmac": "do-not-decode"}}]
        (self.run_dir / "result.json").write_text(json.dumps(self.result), encoding="utf-8")

        sample = self._samples()[0]
        self.assertEqual(sample["trace_status"], "complete")
        self.assertEqual(sample["recovery_session_link"]["pre_checkpoint_session_ids"], ["pre"])
        self.assertEqual(sample["recovery_session_link"]["post_checkpoint_session_ids"], ["post"])
        call = sample["messages"][1]["tool_calls"][0]
        self.assertEqual(call["args"], {"path": "src/index.ts"})
        self.assertEqual(call["argument_source"], "session_jsonl")
        self.assertNotIn("do-not-decode", json.dumps(sample))

    def test_missing_session_artifact_marks_trace_incomplete(self) -> None:
        sample = self._samples()[0]
        self.assertEqual(sample["trace_status"], "incomplete")
        self.assertTrue(any("no Pi session" in note for note in sample["trace_notes"]))

    def test_unmatched_tool_result_or_unrecoverable_arguments_are_not_inferred(self) -> None:
        rows = [
            {"type": "message", "id": "a1", "message": {"role": "assistant", "content": [{"type": "toolCall", "id": "call-hmac", "name": "replace_text", "arguments": None}]}},
        ]
        self._session("developer", "2026-10-05T11-00-00-000Z_session.jsonl", rows)
        self.result["events"] = [{"kind": "agent_tool", "body": {"callId": "call-hmac", "argumentsHmac": "not-an-argument"}}]
        (self.run_dir / "result.json").write_text(json.dumps(self.result), encoding="utf-8")

        sample = self._samples()[0]
        self.assertEqual(sample["trace_status"], "incomplete")
        self.assertIsNone(sample["messages"][0]["tool_calls"][0]["args"])
        self.assertTrue(any("lack parseable original arguments" in note for note in sample["trace_notes"]))
        self.assertNotIn("not-an-argument", json.dumps(sample))


if __name__ == "__main__":
    unittest.main()
