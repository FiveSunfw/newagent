from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from common import NEWAGENT_ROOT
from report import build_rows, write_review_queue


class ReportEvidenceTests(unittest.TestCase):
    def setUp(self) -> None:
        base = NEWAGENT_ROOT / "cache" / "ragas-tests"
        base.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="report-", dir=base)
        self.queue_path = Path(self.temp.name) / "review-queue.jsonl"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_retrieval_review_contains_every_mode_and_raw_judge_reason(self) -> None:
        samples = [
            {
                "sample_id": f"retrieval:Q1:{mode}",
                "kind": "retrieval_qa",
                "phase": "calibration_retrieval",
                "question_id": "Q1",
                "repository": "mitt",
                "retrieval_mode": mode,
                "reference_review_status": "ai_source_checked_unreviewed",
                "question": "How does emit dispatch?",
                "reference_answer": "Handlers run in order.",
                "reference_sources": [{"path": "src/index.ts", "start_line": 1, "end_line": 2}],
                "retrieval_metrics": {"recall_at_5": 1, "mrr_at_10": 0.5},
            }
            for mode in ("keyword", "dense", "hybrid")
        ]
        results = []
        calls = []
        for index, mode in enumerate(("keyword", "dense", "hybrid")):
            request_id = f"request-{index}"
            metric = "context_precision"
            results.append(
                {
                    "sample_id": f"retrieval:Q1:{mode}",
                    "metric": metric,
                    "status": "complete",
                    "score": 0.5 + index / 10,
                    "request_ids": [request_id],
                }
            )
            calls.append(
                {
                    "request_id": request_id,
                    "status": "complete",
                    "usage": {"prompt_tokens": 10, "completion_tokens": 4},
                    "output": {"content": json.dumps({"reason": f"reason-{mode}"})},
                }
            )

        rows = build_rows(samples, results, calls)
        write_review_queue(self.queue_path, samples, rows)
        review = json.loads(self.queue_path.read_text(encoding="utf-8").splitlines()[0])
        self.assertEqual(set(review["ragas_by_retrieval_mode"]), {"keyword", "dense", "hybrid"})
        for mode in ("keyword", "dense", "hybrid"):
            evidence = review["ragas_by_retrieval_mode"][mode]["judgement_evidence"]["context_precision"][0]
            self.assertIn(f"reason-{mode}", evidence["output"]["content"])
            self.assertIn("request_id", evidence)

    def test_agent_judgement_is_compared_to_but_keeps_independent_labels(self) -> None:
        sample = {
            "sample_id": "agent:fixture:single",
            "kind": "agent_trajectory",
            "phase": "historical_agent",
            "trace_status": "complete",
            "reference_review_status": "ai_source_checked_unreviewed",
            "labels_after_score": {"functional_acceptance": False, "delivery_gate": False},
        }
        row = build_rows(
            [sample],
            [{"sample_id": sample["sample_id"], "metric": "agent_goal_accuracy_with_reference", "status": "complete", "score": 1.0, "request_ids": ["judge-id"]}],
            [{"request_id": "judge-id", "output": {"content": "{\"reason\":\"claimed success\"}"}}],
        )[0]
        self.assertTrue(row["false_positive_vs_functional_acceptance"])
        self.assertFalse(row["functional_acceptance"])
        self.assertFalse(row["delivery_gate"])
        self.assertIn("claimed success", row["judgement_evidence"]["agent_goal_accuracy_with_reference"][0]["output"]["content"])


if __name__ == "__main__":
    unittest.main()
