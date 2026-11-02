from __future__ import annotations

import json
import sys
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from budget import BudgetExceeded, BudgetHalted, BudgetLedger, BudgetedTransport, request_cache_key, request_context
from common import NEWAGENT_ROOT


class MemoryTransport(httpx.AsyncBaseTransport):
    def __init__(self, handler):
        self.handler = handler
        self.calls = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        return await self.handler(request)


class BudgetTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        base = NEWAGENT_ROOT / "cache" / "ragas-tests"
        base.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="budget-", dir=base)
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _ledger(self, cap: Decimal = Decimal("3.00")) -> BudgetLedger:
        return BudgetLedger(self.root / "ledger.json", self.root / "cache", cap_cny=cap)

    async def _request(self, transport: BudgetedTransport, payload: dict, sample_id: str = "sample"):
        request = httpx.Request(
            "POST",
            "https://api.siliconflow.cn/v1/chat/completions",
            headers={"authorization": "Bearer never-persist-this-secret"},
            json=payload,
        )
        context = request_context(
            sample_id=sample_id,
            phase="unit_test",
            metric="budget_guard",
            config_hash="config",
            source_version="source",
        )
        with context:
            response = await transport.handle_async_request(request)
        body = json.loads(response.content)
        return response, body, context.value

    async def test_cached_replay_is_sanitized_and_does_not_resend(self) -> None:
        response_content = {
            "id": "response",
            "choices": [{"message": {"role": "assistant", "content": "echo NEWAGENT_API_KEY=sk-abcdefghijklmnopqrstuvwxyz"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 12, "completion_tokens": 3, "total_tokens": 15},
        }

        async def handler(request: httpx.Request) -> httpx.Response:
            sent = json.loads(request.content)
            self.assertEqual(sent["max_tokens"], 4096)
            return httpx.Response(200, json=response_content, request=request)

        inner = MemoryTransport(handler)
        ledger = self._ledger()
        transport = BudgetedTransport(ledger, self.root / "calls.jsonl", inner=inner)
        payload = {"model": "deepseek-ai/DeepSeek-V4-Flash", "messages": [{"role": "user", "content": "test"}], "max_tokens": 5000}
        first, first_body, first_context = await self._request(transport, payload)
        second, second_body, second_context = await self._request(transport, payload)
        self.assertIn("sk-abcdefghijklmnopqrstuvwxyz", first_body["choices"][0]["message"]["content"])
        self.assertNotIn("sk-abcdefghijklmnopqrstuvwxyz", second_body["choices"][0]["message"]["content"])
        self.assertEqual(inner.calls, 1)
        self.assertEqual(len(ledger.state["requests"]), 1)
        self.assertEqual(ledger.state["cache_replays"], 1)
        self.assertEqual(first_context["request_ids"], second_context["request_ids"])
        saved = (self.root / "ledger.json").read_text(encoding="utf-8") + (self.root / "calls.jsonl").read_text(encoding="utf-8")
        self.assertNotIn("never-persist-this-secret", saved)
        self.assertNotIn("sk-abcdefghijklmnopqrstuvwxyz", (self.root / "cache" / f"{first_context['request_ids'][0]}.json").read_text(encoding="utf-8"))
        await transport.aclose()

    async def test_budget_refusal_happens_before_transport(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            raise AssertionError("a refused call reached the transport")

        inner = MemoryTransport(handler)
        ledger = self._ledger(Decimal("0.00000001"))
        transport = BudgetedTransport(ledger, self.root / "calls.jsonl", inner=inner)
        request = httpx.Request("POST", "https://api.siliconflow.cn/v1/chat/completions", json={"model": "deepseek-ai/DeepSeek-V4-Flash", "messages": [], "max_tokens": 1})
        with request_context(sample_id="refused", phase="test", metric="test", config_hash="c", source_version="s"):
            with self.assertRaises(BudgetExceeded):
                await transport.handle_async_request(request)
        self.assertEqual(inner.calls, 0)
        self.assertTrue(ledger.halted)
        self.assertEqual(ledger.state["requests"][0]["status"], "budget_refused")
        await transport.aclose()

    async def test_missing_usage_halts_all_later_requests(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"choices": [{"message": {"content": "answer"}}]}, request=request)

        inner = MemoryTransport(handler)
        ledger = self._ledger()
        transport = BudgetedTransport(ledger, self.root / "calls.jsonl", inner=inner)
        payload = {"model": "deepseek-ai/DeepSeek-V4-Flash", "messages": [], "max_tokens": 2}
        await self._request(transport, payload, "first")
        self.assertTrue(ledger.halted)
        self.assertEqual(ledger.state["requests"][0]["status"], "usage_unknown")
        with self.assertRaises(BudgetHalted):
            await self._request(transport, payload, "second")
        self.assertEqual(inner.calls, 1)
        await transport.aclose()

    async def test_restart_keeps_pending_reservation_and_pauses(self) -> None:
        ledger = self._ledger()
        ledger.reserve(
            request_id="pending-id",
            context={"sample_id": "sample", "phase": "test", "metric": "metric", "config_hash": "c", "source_version": "s"},
            input_bytes=10,
            output_tokens=50,
            request_body_hash="body",
            model="deepseek-ai/DeepSeek-V4-Flash",
        )
        restarted = BudgetLedger(self.root / "ledger.json", self.root / "cache", cap_cny=Decimal("3.00"))
        self.assertTrue(restarted.halted)
        self.assertEqual(restarted.state["requests"][0]["status"], "usage_unknown_after_restart")
        self.assertGreater(Decimal(restarted.state["reserved_cny"]), 0)

    def test_cache_key_changes_with_model_metric_prompt_config_and_source(self) -> None:
        context = {
            "sample_id": "sample",
            "phase": "score",
            "metric": "faithfulness",
            "config_hash": "config-a",
            "source_version": "source-a",
        }
        baseline = request_cache_key(context, "model-a", "prompt-a")
        self.assertNotEqual(baseline, request_cache_key({**context, "metric": "context_recall"}, "model-a", "prompt-a"))
        self.assertNotEqual(baseline, request_cache_key({**context, "config_hash": "config-b"}, "model-a", "prompt-a"))
        self.assertNotEqual(baseline, request_cache_key({**context, "source_version": "source-b"}, "model-a", "prompt-a"))
        self.assertNotEqual(baseline, request_cache_key(context, "model-b", "prompt-a"))
        self.assertNotEqual(baseline, request_cache_key(context, "model-a", "prompt-b"))


if __name__ == "__main__":
    unittest.main()
