"""Persistent, serial cost guard for all SiliconFlow chat-completions calls."""

from __future__ import annotations

import asyncio
import contextvars
import hashlib
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from decimal import Decimal, ROUND_CEILING
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

import httpx

from common import RAGAS_DATA_ROOT, sanitize_text, sanitize_value, sha256_text, stable_json, write_json_atomic


MODEL_ID = "deepseek-ai/DeepSeek-V4-Flash"
BASE_URL = "https://api.siliconflow.cn/v1"
PRICE_SOURCE = "https://docs.siliconflow.cn/docs/release-notes/overview"
INPUT_CNY_PER_MILLION = Decimal("3")
OUTPUT_CNY_PER_MILLION = Decimal("9")
MAX_OUTPUT_TOKENS = 4096
INPUT_TOKEN_OVERHEAD = 512
CAP_CNY = Decimal("3.00")

_CALL_CONTEXT: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar(
    "newagent_ragas_call_context", default=None
)


class BudgetError(RuntimeError):
    pass


class BudgetExceeded(BudgetError):
    pass


class BudgetHalted(BudgetError):
    pass


class RequestNotAllowed(BudgetError):
    pass


class CallContext:
    def __init__(
        self,
        *,
        sample_id: str,
        phase: str,
        metric: str,
        config_hash: str,
        source_version: str,
    ) -> None:
        self.value = {
            "sample_id": sample_id,
            "phase": phase,
            "metric": metric,
            "config_hash": config_hash,
            "source_version": source_version,
            "request_ids": [],
        }
        self._token: contextvars.Token | None = None

    def __enter__(self) -> dict[str, Any]:
        self._token = _CALL_CONTEXT.set(self.value)
        return self.value

    def __exit__(self, exc_type, exc, traceback) -> None:
        if self._token is not None:
            _CALL_CONTEXT.reset(self._token)


class RunLock:
    """An OS-held lock; the lock is released by Windows even after process exit."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.stream = None

    def __enter__(self) -> "RunLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.stream = self.path.open("a+b")
        if self.path.stat().st_size == 0:
            self.stream.write(b"0")
            self.stream.flush()
        self.stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            self.stream.close()
            self.stream = None
            raise BudgetError("Another Ragas run holds the E-drive budget lock") from exc
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        if self.stream is None:
            return
        self.stream.seek(0)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(self.stream.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(self.stream.fileno(), fcntl.LOCK_UN)
        self.stream.close()
        self.stream = None


def _decimal(value: Any) -> Decimal:
    return Decimal(str(value)).quantize(Decimal("0.00000001"), rounding=ROUND_CEILING)


def _estimate_cost(input_token_upper_bound: int, output_token_reserve: int) -> Decimal:
    raw = (
        Decimal(input_token_upper_bound) * INPUT_CNY_PER_MILLION
        + Decimal(output_token_reserve) * OUTPUT_CNY_PER_MILLION
    ) / Decimal(1_000_000)
    return raw.quantize(Decimal("0.00000001"), rounding=ROUND_CEILING)


class BudgetLedger:
    def __init__(self, path: Path, cache_dir: Path, cap_cny: Decimal = CAP_CNY) -> None:
        if cap_cny > CAP_CNY or cap_cny <= 0:
            raise ValueError("Ragas budget cap must be positive and no greater than ¥3.00")
        self.path = path
        self.cache_dir = cache_dir
        self.cap_cny = cap_cny
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        if self.path.exists():
            self.state = json.loads(self.path.read_text(encoding="utf-8"))
            if Decimal(str(self.state.get("cap_cny", "0"))) > cap_cny:
                raise BudgetError("Existing ledger cap exceeds the configured ¥3.00 ceiling")
            self._recover_incomplete_requests()
        else:
            self.state = {
                "schema_version": "newagent-ragas-budget-v1",
                "cap_cny": str(cap_cny),
                "spent_cny": "0.00000000",
                "reserved_cny": "0.00000000",
                "halted": False,
                "halt_reason": None,
                "cache_replays": 0,
                "price": {
                    "model": MODEL_ID,
                    "observed_at_asia_shanghai": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(timespec="seconds"),
                    "input_cny_per_million": str(INPUT_CNY_PER_MILLION),
                    "output_cny_per_million": str(OUTPUT_CNY_PER_MILLION),
                    "cache_discount_applied": False,
                    "rate_basis": "highest non-discounted public schedule, regardless of local billing hour",
                    "source": PRICE_SOURCE,
                    "basis": "normal-time published rates; cache reads charged at full input price",
                },
                "requests": [],
            }
            self._save()

    def _recover_incomplete_requests(self) -> None:
        requests = self.state.setdefault("requests", [])
        pending = [item for item in requests if item.get("status") == "pending"]
        if pending:
            # A crash after send has unknown billing. Keep the pre-reserved amount and stop.
            self.state["halted"] = True
            self.state["halt_reason"] = "pending request after restart; usage is unknown"
            for item in pending:
                item["status"] = "usage_unknown_after_restart"
            self._save()

    def _save(self) -> None:
        spent = sum(
            (Decimal(str(item.get("actual_cost_cny", "0"))) for item in self.state["requests"]),
            Decimal("0"),
        )
        reserved = sum(
            (
                Decimal(str(item.get("reserved_cost_cny", "0")))
                for item in self.state["requests"]
                if item.get("status") in {"pending", "usage_unknown", "usage_unknown_after_restart"}
            ),
            Decimal("0"),
        )
        self.state["spent_cny"] = str(_decimal(spent))
        self.state["reserved_cny"] = str(_decimal(reserved))
        self.state["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        write_json_atomic(self.path, self.state)

    @property
    def halted(self) -> bool:
        return bool(self.state.get("halted"))

    @property
    def remaining_cny(self) -> Decimal:
        return self.cap_cny - Decimal(self.state["spent_cny"]) - Decimal(self.state["reserved_cny"])

    def _request_by_id(self, request_id: str) -> dict[str, Any] | None:
        return next((item for item in self.state["requests"] if item["request_id"] == request_id), None)

    def cached_response(self, request_id: str) -> bytes | None:
        if self.halted:
            raise BudgetHalted(str(self.state.get("halt_reason") or "budget ledger is halted"))
        item = self._request_by_id(request_id)
        if not item or item.get("status") != "complete":
            return None
        response_path = self.cache_dir / f"{request_id}.json"
        if not response_path.exists():
            self.state["halted"] = True
            self.state["halt_reason"] = f"completed response cache is missing for {request_id}"
            self._save()
            raise BudgetHalted(self.state["halt_reason"])
        self.state["cache_replays"] = int(self.state.get("cache_replays", 0)) + 1
        self._save()
        return response_path.read_bytes()

    def reserve(
        self,
        *,
        request_id: str,
        context: dict[str, Any],
        input_bytes: int,
        output_tokens: int,
        request_body_hash: str,
        model: str,
    ) -> Decimal:
        if self.halted:
            raise BudgetHalted(str(self.state.get("halt_reason") or "budget ledger is halted"))
        old = self._request_by_id(request_id)
        if old:
            if old.get("status") == "complete":
                return Decimal("0")
            raise BudgetHalted("request already exists without a settled Usage record")

        input_upper = input_bytes + INPUT_TOKEN_OVERHEAD
        reservation = _estimate_cost(input_upper, output_tokens)
        if Decimal(self.state["spent_cny"]) + Decimal(self.state["reserved_cny"]) + reservation > self.cap_cny:
            reason = f"budget cap reached before send: worst-case reservation ¥{reservation:.6f} would exceed ¥{self.cap_cny:.2f}"
            self.state["requests"].append(
                {
                    "request_id": request_id,
                    "sample_id": context.get("sample_id"),
                    "phase": context.get("phase"),
                    "metric": context.get("metric"),
                    "config_hash": context.get("config_hash"),
                    "source_version": context.get("source_version"),
                    "model": model,
                    "prompt_hash": context.get("prompt_hash", request_body_hash),
                    "input_hash": request_body_hash,
                    "input_bytes_upper_bound": input_upper,
                    "output_tokens_reserved": output_tokens,
                    "reserved_cost_cny": "0.00000000",
                    "actual_cost_cny": "0.00000000",
                    "status": "budget_refused",
                    "reason": reason,
                    "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                }
            )
            self.state["halted"] = True
            self.state["halt_reason"] = reason
            self._save()
            raise BudgetExceeded(reason)

        record = {
            "request_id": request_id,
            "sample_id": context.get("sample_id"),
            "phase": context.get("phase"),
            "metric": context.get("metric"),
            "config_hash": context.get("config_hash"),
            "source_version": context.get("source_version"),
            "model": model,
            "prompt_hash": context.get("prompt_hash", request_body_hash),
            "input_hash": request_body_hash,
            "input_bytes_upper_bound": input_upper,
            "output_tokens_reserved": output_tokens,
            "reserved_cost_cny": str(reservation),
            "actual_cost_cny": "0.00000000",
            "status": "pending",
            "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        self.state["requests"].append(record)
        self._save()
        return reservation

    def settle(self, request_id: str, usage: dict[str, Any] | None, response: bytes | None, status_code: int | None) -> dict[str, Any]:
        record = self._request_by_id(request_id)
        if not record:
            raise BudgetError("Usage settlement has no matching reservation")
        if usage is None:
            record["status"] = "usage_unknown"
            record["status_code"] = status_code
            self.state["halted"] = True
            self.state["halt_reason"] = "provider Usage was missing; subsequent charged requests are paused"
            self._save()
            return record

        prompt_tokens = usage.get("prompt_tokens")
        completion_tokens = usage.get("completion_tokens")
        if not isinstance(prompt_tokens, int) or not isinstance(completion_tokens, int):
            return self.settle(request_id, None, response, status_code)

        # Cached input is intentionally billed at the full cache-miss rate for the cap estimate.
        actual_cost = _estimate_cost(prompt_tokens, completion_tokens)
        record["usage"] = {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": usage.get("total_tokens"),
            "cached_prompt_tokens": ((usage.get("prompt_tokens_details") or {}).get("cached_tokens")),
        }
        record["actual_cost_cny"] = str(actual_cost)
        record["reserved_cost_cny"] = "0.00000000"
        record["status_code"] = status_code
        record["status"] = "complete" if status_code and 200 <= status_code < 300 else "provider_error_with_usage"
        record["completed_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        if response is not None and status_code and 200 <= status_code < 300:
            cache_path = self.cache_dir / f"{request_id}.json"
            fd, temp_name = tempfile.mkstemp(prefix=f".{request_id}.", suffix=".tmp", dir=self.cache_dir)
            try:
                with os.fdopen(fd, "wb") as stream:
                    stream.write(response)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temp_name, cache_path)
            finally:
                try:
                    os.unlink(temp_name)
                except FileNotFoundError:
                    pass
            record["response_cache"] = cache_path.name
        settled_spend = sum(
            (Decimal(str(item.get("actual_cost_cny", "0"))) for item in self.state["requests"]),
            Decimal("0"),
        )
        remaining_reservations = sum(
            (
                Decimal(str(item.get("reserved_cost_cny", "0")))
                for item in self.state["requests"]
                if item.get("status") in {"pending", "usage_unknown", "usage_unknown_after_restart"}
            ),
            Decimal("0"),
        )
        if settled_spend + remaining_reservations > self.cap_cny:
            self.state["halted"] = True
            self.state["halt_reason"] = "settled provider Usage exceeded the conservative pre-call estimate"
        self._save()
        return record

    def pause(self, reason: str) -> None:
        self.state["halted"] = True
        self.state["halt_reason"] = sanitize_text(reason)
        self._save()


def request_context(
    *, sample_id: str, phase: str, metric: str, config_hash: str, source_version: str
) -> CallContext:
    return CallContext(
        sample_id=sample_id,
        phase=phase,
        metric=metric,
        config_hash=config_hash,
        source_version=source_version,
    )


def request_cache_key(context: dict[str, Any], model: str, body_hash: str) -> str:
    return sha256_text(
        stable_json(
            {
                "model": model,
                "sample_id": context.get("sample_id"),
                "phase": context.get("phase"),
                "metric": context.get("metric"),
                "config_hash": context.get("config_hash"),
                "source_version": context.get("source_version"),
                "body_hash": body_hash,
            }
        )
    )


def _extract_output(payload: dict[str, Any]) -> Any:
    choices = payload.get("choices") or []
    if not choices:
        return None
    message = choices[0].get("message") or {}
    safe_tool_calls = []
    for call in message.get("tool_calls") or []:
        function = call.get("function") or {}
        arguments = function.get("arguments")
        if isinstance(arguments, str):
            try:
                arguments = stable_json(sanitize_value(json.loads(arguments)))
            except (json.JSONDecodeError, TypeError):
                arguments = sanitize_text(arguments)
        safe_tool_calls.append(
            {
                "id": sanitize_text(str(call.get("id") or "")),
                "name": sanitize_text(str(function.get("name") or "")),
                "arguments": arguments,
            }
        )
    return {
        "content": sanitize_text(message.get("content") or ""),
        "tool_calls": safe_tool_calls,
    }


def _sanitize_provider_response_for_cache(payload: dict[str, Any]) -> bytes:
    """Retain Usage for replay while sanitizing generated text and arguments before disk writes."""
    safe_payload = json.loads(stable_json(payload))
    for choice in safe_payload.get("choices") or []:
        message = choice.get("message") or {}
        if isinstance(message.get("content"), str):
            message["content"] = sanitize_text(message["content"])
        if isinstance(message.get("refusal"), str):
            message["refusal"] = sanitize_text(message["refusal"])
        for call in message.get("tool_calls") or []:
            function = call.get("function") or {}
            arguments = function.get("arguments")
            if isinstance(arguments, str):
                try:
                    function["arguments"] = stable_json(sanitize_value(json.loads(arguments)))
                except (json.JSONDecodeError, TypeError):
                    function["arguments"] = sanitize_text(arguments)
    return stable_json(safe_payload).encode("utf-8")


class BudgetedTransport(httpx.AsyncBaseTransport):
    def __init__(self, ledger: BudgetLedger, call_log_path: Path, inner: httpx.AsyncBaseTransport | None = None):
        self.ledger = ledger
        self.call_log_path = call_log_path
        self.inner = inner or httpx.AsyncHTTPTransport(retries=0)
        self._serial = asyncio.Lock()

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        async with self._serial:
            parsed_url = urlparse(str(request.url))
            if parsed_url.scheme != "https" or parsed_url.netloc.lower() != "api.siliconflow.cn" or not parsed_url.path.endswith("/chat/completions"):
                raise RequestNotAllowed("Ragas runner permits only SiliconFlow chat-completion calls")
            raw_body = await request.aread()
            try:
                payload = json.loads(raw_body)
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise RequestNotAllowed("request body was not valid JSON; request was not sent") from exc
            if payload.get("model") != MODEL_ID:
                raise RequestNotAllowed("request model did not match the fixed SiliconFlow evaluation model")
            if payload.get("stream"):
                raise RequestNotAllowed("streaming is disabled so every call can be budgeted and reconciled")

            output_key = "max_completion_tokens" if "max_completion_tokens" in payload else "max_tokens"
            requested_output = payload.get(output_key)
            if requested_output is None:
                requested_output = MAX_OUTPUT_TOKENS
                payload["max_tokens"] = requested_output
                output_key = "max_tokens"
            output_reserve = min(int(requested_output), MAX_OUTPUT_TOKENS)
            for token_key in ("max_tokens", "max_completion_tokens"):
                if token_key in payload:
                    payload[token_key] = min(int(payload[token_key]), MAX_OUTPUT_TOKENS)
            payload[output_key] = output_reserve
            request_body = stable_json(payload).encode("utf-8")
            body_hash = hashlib.sha256(request_body).hexdigest()
            context = _CALL_CONTEXT.get() or {
                "sample_id": "unscoped",
                "phase": "unscoped",
                "metric": "unscoped",
                "config_hash": "unscoped",
                "source_version": "unscoped",
                "request_ids": [],
            }
            request_id = request_cache_key(context, MODEL_ID, body_hash)
            cached = self.ledger.cached_response(request_id)
            if cached is not None:
                context["request_ids"].append(request_id)
                return httpx.Response(
                    200,
                    headers={"content-type": "application/json"},
                    content=cached,
                    request=request,
                )

            reservation = self.ledger.reserve(
                request_id=request_id,
                context={**context, "prompt_hash": body_hash},
                input_bytes=len(request_body),
                output_tokens=output_reserve,
                request_body_hash=body_hash,
                model=MODEL_ID,
            )
            active_context = _CALL_CONTEXT.get()
            if active_context is not None:
                active_context["request_ids"].append(request_id)

            forwarded_headers = dict(request.headers)
            forwarded_headers.pop("content-length", None)
            forwarded = httpx.Request(
                request.method,
                request.url,
                headers=forwarded_headers,
                content=request_body,
                extensions=request.extensions,
            )
            try:
                response = await self.inner.handle_async_request(forwarded)
                response_bytes = await response.aread()
                await response.aclose()
            except Exception as exc:
                record = self.ledger.settle(request_id, None, None, None)
                self._append_call_log(record, None, sanitize_text(type(exc).__name__ + ": " + str(exc)))
                raise BudgetHalted("provider request ended without Usage; evaluation paused") from exc

            response_payload: dict[str, Any] | None = None
            try:
                candidate = json.loads(response_bytes)
                if isinstance(candidate, dict):
                    response_payload = candidate
            except (UnicodeDecodeError, json.JSONDecodeError):
                response_payload = None
            usage = response_payload.get("usage") if response_payload else None
            cached_response = (
                _sanitize_provider_response_for_cache(response_payload)
                if response_payload is not None and response.status_code and 200 <= response.status_code < 300
                else None
            )
            record = self.ledger.settle(request_id, usage, cached_response, response.status_code)
            self._append_call_log(record, response_payload, None)
            response_headers = {
                key: value
                for key, value in response.headers.items()
                if key.lower() not in {"content-length", "content-encoding", "transfer-encoding"}
            }
            return httpx.Response(
                status_code=response.status_code,
                headers=response_headers,
                content=response_bytes,
                request=request,
            )

    def _append_call_log(
        self, ledger_record: dict[str, Any], payload: dict[str, Any] | None, error: str | None
    ) -> None:
        output = _extract_output(payload) if payload else None
        row = {
            "schema_version": "newagent-ragas-llm-call-v1",
            "request_id": ledger_record["request_id"],
            "sample_id": ledger_record.get("sample_id"),
            "phase": ledger_record.get("phase"),
            "metric": ledger_record.get("metric"),
            "config_hash": ledger_record.get("config_hash"),
            "source_version": ledger_record.get("source_version"),
            "model": ledger_record.get("model"),
            "prompt_hash": ledger_record.get("prompt_hash"),
            "input_hash": ledger_record.get("input_hash"),
            "usage": ledger_record.get("usage"),
            "estimated_cost_cny": ledger_record.get("actual_cost_cny"),
            "status": ledger_record.get("status"),
            "output": output,
            "error": sanitize_text(error) if error else None,
        }
        self.call_log_path.parent.mkdir(parents=True, exist_ok=True)
        with self.call_log_path.open("a", encoding="utf-8", newline="\n") as stream:
            stream.write(stable_json(row) + "\n")
            stream.flush()
            os.fsync(stream.fileno())

    async def aclose(self) -> None:
        await self.inner.aclose()
