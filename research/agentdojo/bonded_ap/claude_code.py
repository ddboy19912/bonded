"""Claude Code as the model in AgentDojo's pipeline, on a Claude subscription.

AgentDojo's own pipeline is SystemMessage -> InitQuery -> LLM -> ToolsExecutionLoop(ToolsExecutor,
LLM). Claude Code runs its own tool loop, so this element replaces the LLM and the loop: it runs
`claude -p` once per episode with the episode's tools served from a local MCP server, and turns
what Claude Code did back into AgentDojo's messages. AgentDojo then scores the environment and
writes its log as it does for any model, so summarize.py and report_stats.py read the runs unchanged.

Kept the same as the OpenRouter runs:
- the system message (AgentDojo's default, or the Arena's) replaces Claude Code's own;
- the first message is the user task's prompt, with the channels pushed into it when --push is on;
- the tools are the suite's functions, with the same names, descriptions and JSON schemas;
- a tool result is the text AgentDojo's ToolsExecutor would send (YAML, or the error);
- at most 15 model turns per episode, as AgentDojo's loop;
- the important_instructions template addresses the model as "AI assistant", the name it used for
  the OpenRouter models, so both attacks' text is the same as in the family run.

Not the same: tool names reach the model as mcp__toolbox__<name>; Claude Code adds a short note on
the working folder, the OS, the date and the model's name; its own thinking and sampling defaults
apply. None of the user's Claude Code settings, hooks, plugins, skills, CLAUDE.md or memory are
loaded, and the environment keeps only what Claude Code needs to find its login (no API keys).
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import tempfile
import threading
import time
from ast import literal_eval
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from agentdojo.agent_pipeline.base_pipeline_element import BasePipelineElement
from agentdojo.agent_pipeline.tool_execution import is_string_list, tool_result_to_str
from agentdojo.functions_runtime import EmptyEnv, Env, FunctionCall, FunctionsRuntime
from agentdojo.models import MODEL_NAMES
from agentdojo.types import (
    ChatAssistantMessage,
    ChatMessage,
    ChatToolResultMessage,
    text_content_block_from_string,
)
from typing_extensions import Self

PIPELINE_NAME = "claude-code"
# The attack template's name for the model (agentdojo.attacks.base_attacks.get_model_name_from_pipeline).
MODEL_NAMES.setdefault(PIPELINE_NAME, "AI assistant")

# "workspace" is reserved in Claude Code. Tools reach the model as mcp__toolbox__<name>.
TOOL_SERVER = "toolbox"
TOOL_PREFIX = f"mcp__{TOOL_SERVER}__"
KEPT_ENV = ("HOME", "PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "CLAUDE_CONFIG_DIR")


def claude_env(env: Mapping[str, str]) -> dict[str, str]:
    """Only what Claude Code needs to find its login. An API key would bill the API instead."""
    return {k: env[k] for k in KEPT_ENV if k in env}


def claude_args(model: str, system: str, prompt: str, mcp_config: str, max_turns: int) -> list[str]:
    return [
        "-p",
        prompt,
        "--model",
        model,
        "--system-prompt",
        system,
        "--mcp-config",
        mcp_config,
        "--strict-mcp-config",
        "--tools",
        "",
        "--allowedTools",
        f"mcp__{TOOL_SERVER}",
        "--setting-sources",
        "",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--max-turns",
        str(max_turns),
        "--output-format",
        "stream-json",
        "--verbose",
    ]


class ClaudeLimitReached(Exception):
    """The subscription is out of usage. The episode isn't scored; run again after `resets_at`."""

    def __init__(self, resets_at: float | None, message: str = "the Claude subscription's usage limit was reached"):
        super().__init__(message)
        self.resets_at = resets_at


class ClaudeHarnessError(Exception):
    """Claude Code didn't get the episode's tools: the harness failed, not the model."""


class UsageGate:
    """Pauses before an episode when the 5-hour window is nearly full; stops at the week's ceiling."""

    def __init__(
        self,
        pause_at: float = 0.9,
        stop_at_weekly: float = 0.8,
        now: Callable[[], float] = time.time,
        sleep: Callable[[float], None] = time.sleep,
        log: Callable[[str], None] = print,
    ) -> None:
        if not (0 < pause_at <= 1 and 0 < stop_at_weekly <= 1):
            raise ValueError("usage thresholds must be above 0 and at most 1")
        self.pause_at, self.stop_at_weekly = pause_at, stop_at_weekly
        self.now, self.sleep, self.log = now, sleep, log
        self.last: dict[str, Any] | None = None

    def observe(self, info: dict[str, Any]) -> None:
        self.last = info

    def before_episode(self) -> None:
        while self.last is not None:
            windows = self.last.get("unifiedWindows") or {}
            week = (windows.get("seven_day") or {}).get("utilization") or 0
            if week >= self.stop_at_weekly:
                raise ClaudeLimitReached(
                    None, f"the 7-day window is {week:.0%} used (ceiling {self.stop_at_weekly:.0%})"
                )
            hours = windows.get("five_hour") or {}
            rejected = self.last.get("status") == "rejected"
            if not rejected and (hours.get("utilization") or 0) < self.pause_at:
                return
            resets_at = (self.last.get("resetsAt") if rejected else hours.get("resetsAt")) or self.last.get("resetsAt")
            wait = resets_at - self.now() + 60 if resets_at else 30 * 60
            self.last = None
            if wait > 0:
                self.log(f"claude-code: the 5-hour window is full; waiting {wait / 60:.0f} min for it to reset")
                self.sleep(wait)


@dataclass
class ClaudeRun:
    subtype: str | None = None
    is_error: bool = True
    final: str | None = None
    usage: dict[str, int] = field(default_factory=lambda: {"input_tokens": 0, "output_tokens": 0})
    limited: bool = False
    resets_at: float | None = None
    tools: list[str] | None = None
    mcp_errors: list[str] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)


def read_stream(lines: Sequence[str], on_rate_limit: Callable[[dict[str, Any]], None] | None = None) -> ClaudeRun:
    run = ClaudeRun()
    for line in lines:
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        run.events.append(event)
        kind = event.get("type")
        if kind == "system" and event.get("subtype") == "init":
            run.tools = [str(t) for t in event.get("tools") or []]
            run.mcp_errors = [str(e.get("message", e)) for e in event.get("mcp_server_errors") or []]
        elif kind == "rate_limit_event":
            info = event.get("rate_limit_info") or {}
            if info.get("status") == "rejected":
                run.limited, run.resets_at = True, info.get("resetsAt")
            if on_rate_limit:
                on_rate_limit(info)
        elif kind == "result":
            run.subtype = event.get("subtype")
            run.is_error = event.get("is_error") is True or run.subtype != "success"
            run.final = event.get("result") if isinstance(event.get("result"), str) else None
            u = event.get("usage") or {}
            run.usage = {
                "input_tokens": sum(
                    int(u.get(k) or 0)
                    for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")
                ),
                "output_tokens": int(u.get("output_tokens") or 0),
            }
            if run.is_error and any(s in (run.final or "").lower() for s in ("usage limit", "limit reached")):
                run.limited = True
    return run


@dataclass
class ExecutedCall:
    function: str
    args: dict[str, Any]
    text: str
    error: str | None
    raw_args: dict[str, Any] | None = None


def to_messages(events: Sequence[dict[str, Any]], executed: Sequence[ExecutedCall]) -> list[ChatMessage]:
    """Claude Code's turns as AgentDojo messages.

    Assistant events that share a message id are one turn. A tool result's tool_call is the call the
    tool server ran, matched by name, original arguments and result, so summarize.py replays exactly the calls
    that ran. A call Claude Code refused before it reached the server gets no tool_call.
    """
    messages: list[ChatMessage] = []
    pending = list(executed)
    calls: dict[str, FunctionCall] = {}
    turn: ChatAssistantMessage | None = None
    current_id: str | None = None
    for event in events:
        if event.get("type") == "assistant":
            message = event.get("message") or {}
            blocks = message.get("content") or []
            if turn is None or message.get("id") != current_id:
                turn = ChatAssistantMessage(role="assistant", content=None, tool_calls=None)
                messages.append(turn)
                current_id = message.get("id")
            for block in blocks:
                if block.get("type") == "text" and block.get("text"):
                    turn["content"] = [*(turn["content"] or []), text_content_block_from_string(block["text"])]
                elif block.get("type") == "tool_use":
                    name = str(block.get("name", "")).removeprefix(TOOL_PREFIX)
                    args = block.get("input") if isinstance(block.get("input"), dict) else {}
                    call = FunctionCall(function=name, args=args, id=block.get("id"))
                    turn["tool_calls"] = [*(turn["tool_calls"] or []), call]
                    calls[str(block.get("id"))] = call
        elif event.get("type") == "user":
            turn, current_id = None, None
            for block in (event.get("message") or {}).get("content") or []:
                if not isinstance(block, dict) or block.get("type") != "tool_result":
                    continue
                content = block.get("content")
                text = (
                    "".join(c.get("text", "") for c in content if isinstance(c, dict))
                    if isinstance(content, list)
                    else str(content or "")
                )
                rid = str(block.get("tool_use_id"))
                request = calls.pop(rid, None)
                matched = None
                if request is not None:
                    for record in pending:
                        original = record.raw_args if record.raw_args is not None else record.args
                        if (record.function, original, record.error is not None, record.text) == (
                            request.function,
                            request.args,
                            bool(block.get("is_error")),
                            text,
                        ):
                            pending.remove(record)
                            matched = FunctionCall(function=record.function, args=record.args, id=rid)
                            break
                messages.append(
                    ChatToolResultMessage(
                        role="tool",
                        content=[text_content_block_from_string(text)],
                        tool_call_id=rid,
                        tool_call=matched,  # type: ignore[typeddict-item]
                        error=text if block.get("is_error") else None,
                    )
                )
    if pending:
        raise ClaudeHarnessError("The transcript is missing a matching result for an executed tool call")
    return messages


class ToolServer:
    """The episode's tools over MCP (streamable HTTP, JSON responses, no sessions) on 127.0.0.1."""

    def __init__(self, tools: list[dict[str, Any]], call: Callable[[str, dict[str, Any]], tuple[str, bool]]):
        self.tools = tools
        self.names = {t["name"] for t in tools}
        self.call = call
        self.path = f"/{secrets.token_hex(16)}/mcp"
        server = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:  # quiet
                pass

            def do_GET(self) -> None:  # no server-sent stream
                self.send_response(405)
                self.end_headers()

            def do_DELETE(self) -> None:
                self.send_response(200)
                self.end_headers()

            def do_POST(self) -> None:
                if self.path != server.path:
                    self.send_response(404)
                    self.end_headers()
                    return
                body = self.rfile.read(int(self.headers.get("content-length") or 0))
                try:
                    request = json.loads(body)
                except json.JSONDecodeError:
                    self.send_response(400)
                    self.end_headers()
                    return
                batch = request if isinstance(request, list) else [request]
                replies = [r for r in (server.answer(m) for m in batch) if r is not None]
                if not replies:
                    self.send_response(202)
                    self.end_headers()
                    return
                data = json.dumps(replies if isinstance(request, list) else replies[0]).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.http.server_address[1]}{self.path}"

    def __enter__(self) -> Self:
        self.thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.http.shutdown()
        self.http.server_close()

    def answer(self, message: dict[str, Any]) -> dict[str, Any] | None:
        if "id" not in message:  # a notification
            return None
        method, params, rid = message.get("method"), message.get("params") or {}, message["id"]
        if method == "initialize":
            result: dict[str, Any] = {
                "protocolVersion": params.get("protocolVersion", "2025-06-18"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": TOOL_SERVER, "version": "1.0.0"},
            }
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": self.tools}
        elif method == "tools/call":
            name, args = params.get("name"), params.get("arguments") or {}
            if not isinstance(name, str) or name not in self.names:
                text, is_error = f"Invalid tool {name} provided.", True
            else:
                text, is_error = self.call(name, args)
            result = {"content": [{"type": "text", "text": text}], "isError": is_error}
        else:
            return {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"no method {method}"}}
        return {"jsonrpc": "2.0", "id": rid, "result": result}


Spawn = Callable[[list[str], str, dict[str, str]], subprocess.CompletedProcess[str]]


def _spawn(command: list[str], cwd: str, env: dict[str, str], timeout: float) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


class ClaudeCodeLLM(BasePipelineElement):
    """Runs the whole episode in Claude Code. Put it after SystemMessage and InitQuery."""

    name = PIPELINE_NAME

    def __init__(
        self,
        model: str,
        max_turns: int = 15,
        gate: UsageGate | None = None,
        claude_bin: str | None = None,
        timeout_s: float = 20 * 60,
        spawn: Callable[[list[str], str, dict[str, str]], subprocess.CompletedProcess[str]] | None = None,
    ) -> None:
        if not model.startswith("claude-"):
            raise ValueError("ClaudeCodeLLM needs a Claude model id, e.g. claude-sonnet-5-5")
        self.model, self.max_turns, self.gate = model, max_turns, gate
        self.claude_bin = claude_bin or os.environ.get("CLAUDE_CODE_BIN") or "claude"
        self.timeout_s = timeout_s
        self.spawn = spawn or (lambda command, cwd, env: _spawn(command, cwd, env, timeout_s))
        self.last_usage: dict[str, int] = {}

    def query(
        self,
        query: str,
        runtime: FunctionsRuntime,
        env: Env = EmptyEnv(),  # noqa: B008 (AgentDojo's signature)
        messages: Sequence[ChatMessage] = [],
        extra_args: dict = {},  # noqa: B006
    ) -> tuple[str, FunctionsRuntime, Env, Sequence[ChatMessage], dict]:
        system = next(
            ("".join(b.get("content") or "" for b in m["content"] or []) for m in messages if m["role"] == "system"),
            "",
        )
        if self.gate:
            self.gate.before_episode()
        tools = [
            {"name": f.name, "description": f.description, "inputSchema": f.parameters.model_json_schema()}
            for f in runtime.functions.values()
        ]
        executed: list[ExecutedCall] = []

        def call(name: str, args: dict[str, Any]) -> tuple[str, bool]:
            # As ToolsExecutor: string-encoded lists become lists, then the runtime runs the call.
            normalized = {
                k: literal_eval(v) if isinstance(v, str) and is_string_list(v) else v for k, v in args.items()
            }
            result, error = runtime.run_function(env, name, normalized)
            text = error or tool_result_to_str(result)
            executed.append(ExecutedCall(name, normalized, text, error, raw_args=args))
            return text, error is not None

        folder = Path(tempfile.mkdtemp(prefix="agent-"))
        try:
            workdir = folder / "workspace"
            workdir.mkdir()
            with ToolServer(tools, call) as server:
                config = folder / "mcp.json"
                config.write_text(json.dumps({"mcpServers": {TOOL_SERVER: {"type": "http", "url": server.url}}}))
                command = [
                    self.claude_bin,
                    *claude_args(self.model, system, query, str(config), self.max_turns),
                ]
                try:
                    done = self.spawn(command, str(workdir), claude_env(os.environ))
                except subprocess.TimeoutExpired:
                    done = subprocess.CompletedProcess(command, -9, "", "timed out")
        finally:
            shutil.rmtree(folder, ignore_errors=True)
        run = read_stream(done.stdout.splitlines(), self.gate.observe if self.gate else None)
        self.last_usage = run.usage
        if run.limited:
            raise ClaudeLimitReached(run.resets_at)
        if run.mcp_errors:
            raise ClaudeHarnessError(f"Claude Code did not load the tool server: {'; '.join(run.mcp_errors)}")
        if tools and run.tools is not None and not any(t.startswith(TOOL_PREFIX) for t in run.tools):
            raise ClaudeHarnessError("Claude Code started without the episode's tools")
        if run.subtype is None:
            raise ClaudeHarnessError(f"Claude Code exited ({done.returncode}) without a result: {done.stderr[-500:]}")
        if run.subtype != "error_max_turns" and (run.is_error or done.returncode != 0):
            raise ClaudeHarnessError(
                f"Claude Code failed ({done.returncode}, {run.subtype}): {(run.final or done.stderr)[-500:]}"
            )
        new = to_messages(run.events, executed)
        if not new or new[-1]["role"] != "assistant":
            # Claude Code stopped on a tool result (the turn cap): end on its final message, if any.
            new.append(
                ChatAssistantMessage(
                    role="assistant",
                    content=[text_content_block_from_string(run.final or "")],
                    tool_calls=None,
                )
            )
        return query, runtime, env, [*messages, *new], extra_args
