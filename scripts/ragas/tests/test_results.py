from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from common import NEWAGENT_ROOT
from results import ResultStore


class ResultStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        base = NEWAGENT_ROOT / "cache" / "ragas-tests"
        base.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="results-", dir=base)
        self.path = Path(self.temp.name) / "results.jsonl"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_completed_results_resume_without_duplicate_rows_and_allow_label_join(self) -> None:
        store = ResultStore(self.path)
        store.upsert({"sample_id": "agent:1", "metric": "goal", "status": "complete", "score": 0.8, "request_ids": ["r1"]})
        resumed = ResultStore(self.path)
        self.assertTrue(resumed.is_terminal("agent:1", "goal"))
        resumed.upsert({"sample_id": "agent:1", "metric": "goal", "status": "complete", "labels_after_score": {"functional_acceptance": False}, "label_joined_after_scoring": True})
        self.assertEqual(len(ResultStore(self.path).rows), 1)
        self.assertEqual(ResultStore(self.path).get("agent:1", "goal")["score"], 0.8)
        self.assertEqual(ResultStore(self.path).get("agent:1", "goal")["labels_after_score"], {"functional_acceptance": False})

    def test_duplicate_keys_in_saved_results_are_rejected(self) -> None:
        self.path.write_text('{"sample_id":"x","metric":"m"}\n{"sample_id":"x","metric":"m"}\n', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "duplicate"):
            ResultStore(self.path)


if __name__ == "__main__":
    unittest.main()
