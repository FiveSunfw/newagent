from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from budget import BudgetExceeded, BudgetLedger
from common import NEWAGENT_ROOT
from results import ResultStore
from run import RunStopped, _metric_value, _score_metric


class ScoreErrorTests(unittest.TestCase):
    def test_non_numeric_score_is_an_explicit_scoring_error(self) -> None:
        value, reason = _metric_value(SimpleNamespace(value="not-a-score", reason=None))
        self.assertIsNone(value)
        self.assertIn("no numeric value", reason or "")

    def test_wrapped_budget_refusal_is_not_misreported_as_missing_usage(self) -> None:
        base = NEWAGENT_ROOT / "cache" / "ragas-tests"
        base.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="score-budget-", dir=base) as temporary:
            root = Path(temporary)
            ledger = BudgetLedger(root / "ledger.json", root / "cache")
            try:
                ledger.reserve(
                    request_id="refused-request",
                    context={
                        "sample_id": "agent:fixture",
                        "phase": "agent",
                        "metric": "agent_goal_accuracy_with_reference",
                        "config_hash": "config",
                        "source_version": "source",
                    },
                    input_bytes=2_000_000,
                    output_tokens=1024,
                    request_body_hash="hash",
                    model="deepseek-ai/DeepSeek-V4-Flash",
                )
            except BudgetExceeded:
                pass
            else:
                self.fail("the oversized score request was not refused")

            class WrappedBudgetFailure:
                async def ascore(self, **kwargs):
                    raise RuntimeError("InstructorRetryException: Connection error")

            sample = {
                "sample_id": "agent:fixture",
                "kind": "agent_trajectory",
                "phase": "historical_agent",
                "phase_order": 2,
                "task_id": "task-fixture",
                "conversation_id": "conversation-fixture",
                "role": "developer",
                "source_revision": "fixed-source",
                "config_hash": "config",
                "reference_review_status": "ai_source_checked_unreviewed",
                "labels_after_score": {"functional_acceptance": False, "delivery_gate": False},
            }
            store = ResultStore(root / "results.jsonl")
            with self.assertRaises(RunStopped) as stopped:
                asyncio.run(
                    _score_metric(
                        sample=sample,
                        metric_name="agent_goal_accuracy_with_reference",
                        metric=WrappedBudgetFailure(),
                        result_store=store,
                        ledger=ledger,
                        config_hash="config",
                        kwargs={"user_input": [], "reference": "expected"},
                    )
                )

            result = store.get(sample["sample_id"], "agent_goal_accuracy_with_reference")
            self.assertEqual(result["status"], "budget_refused")
            self.assertIn("budget cap reached before send", result["reason"])
            self.assertNotIn("Connection error", result["reason"])
            self.assertEqual(result["request_ids"], ["refused-request"])
            self.assertIn("budget cap reached before send", str(stopped.exception))


if __name__ == "__main__":
    unittest.main()
