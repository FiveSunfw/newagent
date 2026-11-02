"""Run three bounded, real model tool-call tasks against isolated public-source copies."""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from openai import AsyncOpenAI
from ragas.messages import AIMessage, HumanMessage, ToolCall, ToolMessage

from budget import MODEL_ID, BudgetExceeded, BudgetHalted, BudgetLedger, request_context
from common import NEWAGENT_ROOT, REPO_DIRS, sanitize_text, sanitize_value, stable_json, write_json_atomic


MODEL_TEMPERATURE = 0.7
MODEL_TOP_P = 1.0
MODEL_PRESENCE_PENALTY = 1.5
TOOL_TASK_MAX_OUTPUT = 512
MAX_MODEL_TURNS = 4
MAX_TOOL_CALLS = 6
MAX_FORMAT_FEEDBACK = 1


TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a public source file from the current repository copy. Paths must be repository-relative.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "startLine": {"type": "integer", "minimum": 1},
                },
                "required": ["path"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_repository",
            "description": "Search public source text by a literal symbol or phrase.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string", "minLength": 1, "maxLength": 120}},
                "required": ["query"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "replace_text",
            "description": "Replace exactly one source occurrence in this isolated public repository copy. Read the file first. before and after must differ.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "before": {"type": "string", "minLength": 1, "maxLength": 2000},
                    "after": {"type": "string", "maxLength": 3000},
                },
                "required": ["path", "before", "after"],
                "additionalProperties": False,
            },
        },
    },
]


class ToolTaskError(RuntimeError):
    pass


def _inside(root: Path, relative: str, must_exist: bool = True) -> Path:
    candidate = Path(relative)
    if candidate.is_absolute() or any(part in {"..", ""} for part in candidate.parts):
        raise ToolTaskError("tool path must be a clean repository-relative path")
    target = root.joinpath(candidate)
    resolved = target.resolve(strict=must_exist)
    base = root.resolve()
    if not resolved.is_relative_to(base):
        raise ToolTaskError("tool path escaped the isolated repository copy")
    normalized = relative.replace("\\", "/").lower()
    if any(part.startswith(".env") or part in {".git", ".npmrc", ".pypirc"} for part in normalized.split("/")):
        raise ToolTaskError("private/configuration files are not available to tool tasks")
    return resolved


def _prepare_workspace(sample: dict[str, Any], batch_dir: Path) -> Path:
    task = sample["tool_task_spec"]
    workspace = batch_dir / "tool-workspaces" / task["id"] / "repository"
    if not workspace.exists():
        source = NEWAGENT_ROOT / "upstream" / "eval" / REPO_DIRS[task["repository"]]
        if not source.is_dir():
            raise ToolTaskError(f"public source snapshot is missing for {task['repository']}")
        workspace.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(
            source,
            workspace,
            ignore=shutil.ignore_patterns(".git", "node_modules", ".env", ".env.*"),
        )
    return workspace.resolve()


def _read_file(root: Path, args: dict[str, Any], read_paths: set[str]) -> str:
    if set(args) - {"path", "startLine"} or not isinstance(args.get("path"), str):
        raise ToolTaskError("read_file requires path and optional startLine")
    path = args["path"].replace("\\", "/")
    target = _inside(root, path)
    if target.suffix.lower() not in {".ts", ".tsx", ".js", ".jsx", ".md", ".json"}:
        raise ToolTaskError("read_file only exposes source, Markdown, and JSON files")
    content = target.read_text(encoding="utf-8")
    if len(content) > 300_000:
        raise ToolTaskError("file exceeds the narrow tool-task read limit")
    start = args.get("startLine", 1)
    if not isinstance(start, int) or start < 1:
        raise ToolTaskError("startLine must be a positive integer")
    lines = content.splitlines()
    read_paths.add(path)
    selected = lines[start - 1 : start - 1 + 200]
    return "\n".join(f"{number}: {line}" for number, line in enumerate(selected, start=start))


def _search_repository(root: Path, args: dict[str, Any]) -> str:
    if set(args) != {"query"} or not isinstance(args.get("query"), str):
        raise ToolTaskError("search_repository requires a literal query")
    query = args["query"].strip()
    if not query or len(query) > 120:
        raise ToolTaskError("search query must contain 1 to 120 characters")
    output: list[dict[str, Any]] = []
    skipped = {".git", "node_modules", "dist", "coverage"}
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in {".ts", ".tsx", ".js", ".jsx", ".md"}:
            continue
        relative = path.relative_to(root)
        if any(part.lower() in skipped for part in relative.parts):
            continue
        if path.is_symlink():
            continue
        try:
            safe_path = _inside(root, relative.as_posix())
        except ToolTaskError:
            continue
        try:
            lines = safe_path.read_text(encoding="utf-8").splitlines()
        except (UnicodeDecodeError, OSError):
            continue
        for line_number, line in enumerate(lines, start=1):
            if query.casefold() in line.casefold():
                output.append({"path": relative.as_posix(), "line": line_number, "text": line[:500]})
                if len(output) >= 25:
                    break
        if len(output) >= 25:
            break
    return stable_json({"query": query, "hits": output})


def _replace_text(root: Path, args: dict[str, Any], read_paths: set[str]) -> str:
    if set(args) != {"path", "before", "after"}:
        raise ToolTaskError("replace_text requires path, before, and after")
    path = args["path"].replace("\\", "/")
    if path not in read_paths:
        raise ToolTaskError("read_file must be called for this path before editing")
    target = _inside(root, path)
    if target.suffix.lower() not in {".ts", ".tsx", ".js", ".jsx"}:
        raise ToolTaskError("replace_text only edits source-code files")
    before, after = args["before"], args["after"]
    if not isinstance(before, str) or not isinstance(after, str) or not before or before == after:
        raise ToolTaskError("before and after must be non-empty different strings")
    content = target.read_text(encoding="utf-8")
    if content.count(after) == 1:
        return "The requested replacement is already present."
    if content.count(before) != 1:
        raise ToolTaskError("before must match exactly one source occurrence")
    updated = content.replace(before, after, 1)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=target.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as stream:
            stream.write(updated)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_name, target)
    finally:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
    return "Replaced exactly one source occurrence."


def _dispatch(root: Path, tool_name: str, args: dict[str, Any], read_paths: set[str]) -> str:
    if tool_name == "read_file":
        return _read_file(root, args, read_paths)
    if tool_name == "search_repository":
        return _search_repository(root, args)
    if tool_name == "replace_text":
        return _replace_text(root, args, read_paths)
    raise ToolTaskError(f"unknown tool {tool_name!r}")


def _tool_call_from_api(call: Any) -> dict[str, Any]:
    function = call.function
    raw_arguments = function.arguments if isinstance(function.arguments, str) else ""
    try:
        args = json.loads(raw_arguments)
        if not isinstance(args, dict):
            raise ValueError("arguments are not an object")
        complete = True
    except (TypeError, json.JSONDecodeError, ValueError):
        args = None
        complete = False
    return {
        "id": call.id,
        "name": function.name,
        "args": args,
        "arguments_complete": complete,
        "arguments_text": stable_json(sanitize_value(args)) if complete else sanitize_text(raw_arguments),
        "argument_source": "live_model_tool_call",
    }


class ToolTaskRunner:
    def __init__(
        self,
        *,
        client: AsyncOpenAI,
        sample: dict[str, Any],
        batch_dir: Path,
        config_hash: str,
        ledger: BudgetLedger | None = None,
    ):
        self.client = client
        self.sample = sample
        self.batch_dir = batch_dir
        self.config_hash = config_hash
        self.ledger = ledger
        self.spec = sample["tool_task_spec"]
        self.workspace = _prepare_workspace(sample, batch_dir)
        self.state_path = batch_dir / "tool-state" / f"{self.spec['id']}.json"

    async def run(self) -> dict[str, Any]:
        if self.state_path.exists():
            state = json.loads(self.state_path.read_text(encoding="utf-8"))
        else:
            state = {
                "sample_id": self.sample["sample_id"],
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "Use only the supplied repository-relative tools. Do not access the network, "
                            "environment, or files outside this public-source copy. Follow the user task exactly."
                        ),
                    },
                    {"role": "user", "content": self.spec["question"]},
                ],
                "ragas_messages": [
                    {"type": "human", "content": self.spec["question"], "role": "developer"}
                ],
                "tool_messages": [],
                "read_paths": [],
                "completed_tool_call_ids": [],
                "pending_tool_calls": [],
                "format_feedback_count": 0,
                "trace_complete": True,
                "status": "running",
            }
            self._save_state(state)

        if state.get("status") == "complete":
            return state

        read_paths = set(state.get("read_paths", []))
        for turn in range(MAX_MODEL_TURNS):
            if state.get("pending_tool_calls"):
                self._apply_pending_tool_calls(state, read_paths)
                if state.get("status") != "running":
                    return state
                if self.ledger and self.ledger.halted:
                    return state
            if len(state.get("completed_tool_call_ids", [])) >= MAX_TOOL_CALLS:
                state["status"] = "tool_call_limit"
                self._save_state(state)
                return state
            try:
                with request_context(
                    sample_id=self.sample["sample_id"],
                    phase="tool_task_generation",
                    metric="ToolCallAccuracy",
                    config_hash=self.config_hash,
                    source_version=str(self.sample.get("source_revision") or "unknown"),
                ) as call_context:
                    response = await self.client.chat.completions.create(
                        model=MODEL_ID,
                        messages=state["messages"],
                        tools=TOOL_DEFINITIONS,
                        tool_choice="auto",
                        max_tokens=TOOL_TASK_MAX_OUTPUT,
                        temperature=MODEL_TEMPERATURE,
                        top_p=MODEL_TOP_P,
                        presence_penalty=MODEL_PRESENCE_PENALTY,
                    )
            except (BudgetExceeded, BudgetHalted) as exc:
                state["status"] = "paused_budget" if isinstance(exc, BudgetExceeded) else "usage_missing"
                state["trace_complete"] = False
                state["reason"] = sanitize_text(str(exc))
                state["request_ids"] = state.get("request_ids", []) + (call_context.get("request_ids", []) if "call_context" in locals() else [])
                self._save_state(state)
                return state
            if not response.choices:
                state["status"] = "empty_model_response"
                state["request_ids"] = state.get("request_ids", []) + call_context["request_ids"]
                self._save_state(state)
                return state

            assistant = response.choices[0].message
            api_tool_calls = assistant.tool_calls or []
            stored_calls = [_tool_call_from_api(call) for call in api_tool_calls]
            state["messages"].append(
                {
                    "role": "assistant",
                    "content": assistant.content or "",
                    "tool_calls": [
                        {
                            "id": call.get("id"),
                            "type": "function",
                            "function": {
                                "name": call.get("name"),
                                "arguments": stable_json(call.get("args")) if call.get("args") is not None else "{}",
                            },
                        }
                        for call in stored_calls
                    ],
                }
            )
            state["request_ids"] = state.get("request_ids", []) + call_context["request_ids"]
            state["ragas_messages"].append(
                {
                    "type": "ai",
                    "content": sanitize_text(assistant.content or ""),
                    "tool_calls": [call for call in stored_calls if call.get("arguments_complete")],
                    "role": "developer",
                    "turn": turn,
                }
            )
            state["pending_tool_calls"] = stored_calls
            self._save_state(state)

            if self.ledger and self.ledger.halted:
                state["status"] = "usage_missing"
                state["trace_complete"] = False
                state["reason"] = str(self.ledger.state.get("halt_reason") or "provider Usage missing")
                self._save_state(state)
                return state

            if not api_tool_calls:
                state["final_answer"] = sanitize_text(assistant.content or "")
                state["status"] = "complete" if state["final_answer"] else "empty_final_answer"
                self._save_state(state)
                return state

            self._apply_pending_tool_calls(state, read_paths)

            if state.get("format_feedback_count", 0) > MAX_FORMAT_FEEDBACK:
                state["status"] = "invalid_tool_arguments"
                self._save_state(state)
                return state

        state["status"] = "model_turn_limit"
        self._save_state(state)
        return state

    def _apply_pending_tool_calls(self, state: dict[str, Any], read_paths: set[str]) -> None:
        for stored in list(state.get("pending_tool_calls", [])):
            call_id = str(stored.get("id") or "")
            tool_name = stored.get("name")
            if call_id and call_id in state["completed_tool_call_ids"]:
                continue
            if not call_id or not stored.get("arguments_complete"):
                state["trace_complete"] = False
                state["format_feedback_count"] += 1
                message = "Tool arguments must be a JSON object with the documented properties."
                state["messages"].append({"role": "tool", "tool_call_id": call_id, "content": message})
                state["ragas_messages"].append(
                    {"type": "tool", "tool_call_id": call_id or "missing-call-id", "name": tool_name, "content": message, "role": "developer"}
                )
                if call_id:
                    state["completed_tool_call_ids"].append(call_id)
                self._save_state(state)
                if state["format_feedback_count"] > MAX_FORMAT_FEEDBACK:
                    state["status"] = "invalid_tool_arguments"
                    state["pending_tool_calls"] = []
                    self._save_state(state)
                    return
                continue

            try:
                tool_output = _dispatch(self.workspace, tool_name, stored["args"], read_paths)
                is_error = False
            except Exception as exc:
                tool_output = f"Tool error: {type(exc).__name__}: {exc}"
                is_error = True
            tool_output = sanitize_text(tool_output)
            state["messages"].append({"role": "tool", "tool_call_id": call_id, "content": tool_output})
            state["tool_messages"].append(
                {"call_id": call_id, "name": tool_name, "content": tool_output, "is_error": is_error}
            )
            state["ragas_messages"].append(
                {"type": "tool", "tool_call_id": call_id, "name": tool_name, "content": tool_output, "role": "developer"}
            )
            state["completed_tool_call_ids"].append(call_id)
            state["read_paths"] = sorted(read_paths)
            state["last_tool_call"] = {
                "id": call_id,
                "name": tool_name,
                "args": sanitize_value(stored["args"]),
                "arguments_text": stored.get("arguments_text"),
                "arguments_complete": True,
                "argument_source": stored.get("argument_source", "live_model_tool_call"),
            }
            state["last_tool_error"] = is_error
            self._save_state(state)
        state["pending_tool_calls"] = []
        self._save_state(state)

    def _save_state(self, state: dict[str, Any]) -> None:
        state["workspace_ref"] = self.sample.get("workspace_ref")
        state["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        write_json_atomic(self.state_path, sanitize_value(state))

    def independent_check(self, state: dict[str, Any]) -> dict[str, Any]:
        expected = self.spec.get("expected_state") or {}
        if "contains" in expected:
            path = expected.get("path", self.spec["source_file"])
            target = _inside(self.workspace, path)
            text = target.read_text(encoding="utf-8")
            return {"passed": expected["contains"] in text, "check": "expected_substring_in_source"}
        if "search_path" in expected:
            hits = _search_repository(self.workspace, {"query": expected["search_query"]})
            parsed = json.loads(hits)
            return {"passed": any(hit["path"] == expected["search_path"] for hit in parsed["hits"]), "check": "symbol_search_returned_target_file"}
        return {"passed": False, "check": "no_independent_check_configured"}


def to_ragas_messages(raw_messages: list[dict[str, Any]]) -> list[Any]:
    output: list[Any] = []
    for message in raw_messages:
        kind = message.get("type")
        role = message.get("role")
        prefix = f"[role={role}] " if role else ""
        if kind == "human":
            output.append(HumanMessage(content=prefix + message.get("content", "")))
        elif kind == "ai":
            calls = [
                ToolCall(name=call["name"], args=call["args"])
                for call in message.get("tool_calls", [])
                if call.get("arguments_complete") and isinstance(call.get("args"), dict)
            ]
            output.append(AIMessage(content=prefix + message.get("content", ""), tool_calls=calls or None))
        elif kind == "tool":
            call_id = message.get("tool_call_id")
            if not call_id:
                raise ToolTaskError("tool result is missing tool_call_id; refusing to fabricate a trajectory")
            output.append(
                ToolMessage(
                    content=prefix + f"[tool={message.get('name') or 'unknown'};call_id={call_id}]\n" + message.get("content", ""),
                    metadata={"tool_name": message.get("name"), "tool_call_id": call_id, "role": role},
                )
            )
    return output
