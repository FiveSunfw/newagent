from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from common import NEWAGENT_ROOT
from tool_tasks import (
    ToolTaskError,
    ToolTaskRunner,
    _inside,
    _read_file,
    _replace_text,
    _search_repository,
    _tool_call_from_api,
    to_ragas_messages,
)


class ToolTaskTests(unittest.TestCase):
    def setUp(self) -> None:
        base = NEWAGENT_ROOT / "cache" / "ragas-tests"
        base.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="tools-", dir=base)
        self.root = Path(self.temp.name) / "repo"
        self.root.mkdir()
        self.source = self.root / "index.js"
        self.source.write_text("export function target(value) { return value; }\n", encoding="utf-8")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_read_then_exact_replace_is_atomic_and_idempotent(self) -> None:
        read_paths: set[str] = set()
        self.assertIn("target", _read_file(self.root, {"path": "index.js"}, read_paths))
        before = "export function target(value) { return value; }"
        after = "/** A fixture helper. */\n" + before
        self.assertIn("Replaced exactly one", _replace_text(self.root, {"path": "index.js", "before": before, "after": after}, read_paths))
        self.assertEqual(self.source.read_text(encoding="utf-8"), after + "\n")
        self.assertIn("already present", _replace_text(self.root, {"path": "index.js", "before": before, "after": after}, read_paths))

    def test_read_and_search_reject_escape_paths_and_skip_symlinks(self) -> None:
        with self.assertRaises(ToolTaskError):
            _inside(self.root, "../outside.js")
        outside = Path(self.temp.name) / "outside.js"
        outside.write_text("PRIVATE_SENTINEL", encoding="utf-8")
        link = self.root / "linked.js"
        try:
            link.symlink_to(outside)
        except (OSError, NotImplementedError):
            self.skipTest("symlink creation is unavailable in this environment")
        with self.assertRaises(ToolTaskError):
            _read_file(self.root, {"path": "linked.js"}, set())
        search = json.loads(_search_repository(self.root, {"query": "PRIVATE_SENTINEL"}))
        self.assertEqual(search["hits"], [])

    def test_call_arguments_are_taken_from_live_tool_call_and_redacted(self) -> None:
        call = SimpleNamespace(
            id="call-1",
            function=SimpleNamespace(name="read_file", arguments='{"path":"index.js","token":"secret-value"}'),
        )
        parsed = _tool_call_from_api(call)
        self.assertEqual(parsed["argument_source"], "live_model_tool_call")
        self.assertEqual(parsed["args"]["path"], "index.js")
        self.assertNotIn("secret-value", parsed["arguments_text"])

    def test_ragas_messages_keep_call_result_association(self) -> None:
        messages = to_ragas_messages(
            [
                {"type": "human", "content": "Read the file."},
                {"type": "ai", "content": "", "tool_calls": [{"name": "read_file", "args": {"path": "index.js"}, "arguments_complete": True}]},
                {"type": "tool", "tool_call_id": "call-1", "name": "read_file", "content": "source"},
            ]
        )
        self.assertEqual(messages[-1].metadata["tool_call_id"], "call-1")
        self.assertIn("tool=read_file", messages[-1].content)

    def test_pending_tool_call_is_replayed_before_new_model_turn(self) -> None:
        batch = Path(self.temp.name) / "batch"
        workspace = batch / "tool-workspaces" / "resume-case" / "repository"
        workspace.mkdir(parents=True)
        source = workspace / "index.js"
        source.write_text("export function target(value) { return value; }\n", encoding="utf-8")

        class FakeCompletions:
            calls = 0

            async def create(self, **kwargs):
                self.calls += 1
                return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="Done.", tool_calls=[]))])

        completions = FakeCompletions()
        client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
        sample = {
            "sample_id": "tool:resume",
            "source_revision": "fixed-sha",
            "workspace_ref": "isolated-fixture",
            "tool_task_spec": {
                "id": "resume-case",
                "repository": "dlv",
                "question": "Add a comment.",
                "source_file": "index.js",
                "expected_state": {"contains": "Added."},
            },
        }
        runner = ToolTaskRunner(client=client, sample=sample, batch_dir=batch, config_hash="config")
        runner.state_path.parent.mkdir(parents=True)
        before = "export function target(value) { return value; }"
        after = "// Added.\n" + before
        state = {
            "sample_id": sample["sample_id"],
            "messages": [{"role": "user", "content": "Add a comment."}, {"role": "assistant", "content": "", "tool_calls": []}],
            "ragas_messages": [
                {"type": "human", "content": "Add a comment."},
                {
                    "type": "ai",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call-pending",
                            "name": "replace_text",
                            "args": {"path": "index.js", "before": before, "after": after},
                            "arguments_complete": True,
                        }
                    ],
                },
            ],
            "tool_messages": [],
            "read_paths": ["index.js"],
            "completed_tool_call_ids": [],
            "pending_tool_calls": [
                {
                    "id": "call-pending",
                    "name": "replace_text",
                    "args": {"path": "index.js", "before": before, "after": after},
                    "arguments_complete": True,
                    "argument_source": "live_model_tool_call",
                }
            ],
            "format_feedback_count": 0,
            "trace_complete": True,
            "status": "running",
        }
        runner._save_state(state)
        import asyncio

        result = asyncio.run(runner.run())
        self.assertEqual(completions.calls, 1)
        self.assertEqual(result["status"], "complete")
        self.assertTrue(source.read_text(encoding="utf-8").startswith("// Added."))
        self.assertEqual(result["completed_tool_call_ids"], ["call-pending"])


if __name__ == "__main__":
    unittest.main()
