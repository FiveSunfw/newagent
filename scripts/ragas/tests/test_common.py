from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from common import APP_ROOT, REPO_DIRS, UPSTREAM_ROOT, sanitize_text, validate_sample


def valid_sample() -> dict:
    return {
        "schema_version": "newagent-ragas-jsonl-v1",
        "sample_id": "unit:sample",
        "kind": "retrieval_qa",
        "question": "What does the function do?",
        "retrieved_contexts": [],
        "reference_answer": "It returns a value.",
        "model_answer": None,
        "messages": [],
        "tool_messages": [],
        "task_id": None,
        "conversation_id": None,
        "role": "retriever",
        "source_revision": "fixed-sha",
        "config_hash": "config-hash",
        "reference_review_status": "ai_source_checked_unreviewed",
        "trace_status": "not_applicable",
    }


class CommonContractTests(unittest.TestCase):
    def test_missing_fields_are_rejected(self) -> None:
        sample = valid_sample()
        del sample["config_hash"]
        with self.assertRaisesRegex(ValueError, "config_hash"):
            validate_sample(sample)

    def test_invalid_context_rank_is_rejected(self) -> None:
        sample = valid_sample()
        sample["retrieved_contexts"] = [{"rank": 0}]
        with self.assertRaisesRegex(ValueError, "rank"):
            validate_sample(sample)

    def test_secret_and_machine_paths_are_redacted(self) -> None:
        text = "NEWAGENT_API_KEY=secret-value E:\\newagent\\private\\result.json Bearer abcdefghijklmnop"
        sanitized = sanitize_text(text)
        self.assertNotIn("secret-value", sanitized)
        self.assertNotIn("E:\\newagent", sanitized)
        self.assertNotIn("abcdefghijklmnop", sanitized)

    def test_all_reference_sources_exist_and_match_fixed_repository(self) -> None:
        reference_path = APP_ROOT / "scripts" / "ragas" / "reference-answers-v1.json"
        reference = json.loads(reference_path.read_text(encoding="utf-8"))["answers"]
        self.assertEqual(set(reference), {f"Q{number}" for number in range(1, 31)})
        for question_number, answer in enumerate(reference.values(), start=1):
            repository = "mitt" if question_number <= 10 else "fast-json-stable-stringify" if question_number <= 20 else "dlv"
            source = UPSTREAM_ROOT / REPO_DIRS[repository] / answer["sourceFile"]
            self.assertTrue(source.is_file(), f"missing fixed source for Q{question_number}: {source.name}")
            self.assertIn(answer["sourceSymbol"].casefold(), source.read_text(encoding="utf-8").casefold(), f"source symbol missing for Q{question_number}")
            self.assertTrue(answer["reference"].strip())


if __name__ == "__main__":
    unittest.main()
