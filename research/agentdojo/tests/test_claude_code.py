"""Claude Code in AgentDojo's pipeline: what it's given, what it's not, and logs summarize.py can replay."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from agentdojo.agent_pipeline.agent_pipeline import AgentPipeline, load_system_message
from agentdojo.agent_pipeline.basic_elements import InitQuery, SystemMessage
from agentdojo.attacks.attack_registry import load_attack
from agentdojo.benchmark import benchmark_suite_with_injections
from agentdojo.logging import OutputLogger

from bonded_ap import BENCHMARK_VERSION, family
from bonded_ap.claude_code import (
    PIPELINE_NAME,
    TOOL_SERVER,
    ClaudeCodeLLM,
    ClaudeHarnessError,
    ClaudeLimitReached,
    ExecutedCall,
    ToolServer,
    UsageGate,
    claude_args,
    claude_env,
    read_stream,
    to_messages,
)
from summarize import load

FAKE = Path(__file__).parent / "fixtures" / "fake_claude.py"
SEED = "O1-records-001"


def fake(tmp_path: Path, mode: str = "run", calls: list | None = None):
    record = tmp_path / "record.json"

    def spawn(command: list[str], cwd: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        extra = {"FAKE_MODE": mode, "FAKE_CALLS": json.dumps(calls or []), "FAKE_RECORD": str(record)}
        return subprocess.run(
            [sys.executable, str(FAKE), *command[1:]],
            cwd=cwd,
            env={**env, **extra},
            capture_output=True,
            text=True,
            check=False,
        )

    return spawn, record


def pipeline(llm: ClaudeCodeLLM) -> AgentPipeline:
    p = AgentPipeline([SystemMessage(load_system_message(None)), InitQuery(), llm])
    p.name = PIPELINE_NAME
    return p


def test_env_keeps_the_login_and_drops_keys_and_session_variables() -> None:
    env = claude_env(
        {
            "HOME": "/home/a",
            "PATH": "/bin",
            "ANTHROPIC_API_KEY": "sk-ant-test",
            "OPENROUTER_API_KEY": "or-test",
            "CLAUDECODE": "1",
            "CLAUDE_CODE_USER_EMAIL": "someone@example.test",
        }
    )
    assert env == {"HOME": "/home/a", "PATH": "/bin"}


def test_args_replace_the_prompt_and_switch_off_settings_tools_and_skills() -> None:
    args = claude_args("claude-sonnet-5-5", "SYSTEM", "Pay the invoices.", "/tmp/mcp.json", 15)

    def value(flag: str) -> str:
        return args[args.index(flag) + 1]

    assert value("-p") == "Pay the invoices."
    assert value("--system-prompt") == "SYSTEM"
    assert value("--tools") == ""
    assert value("--setting-sources") == ""
    assert value("--allowedTools") == f"mcp__{TOOL_SERVER}"
    assert value("--max-turns") == "15"
    assert "--strict-mcp-config" in args and "--disable-slash-commands" in args
    assert TOOL_SERVER != "workspace"  # reserved in Claude Code


def test_gate_waits_for_the_window_and_stops_at_the_weeks_ceiling() -> None:
    waits: list[float] = []
    gate = UsageGate(now=lambda: 1000.0, sleep=waits.append, log=lambda _: None)
    gate.before_episode()  # nothing known yet
    gate.observe({"status": "allowed", "unifiedWindows": {"five_hour": {"utilization": 0.95, "resetsAt": 1600}}})
    gate.before_episode()
    assert waits == [660.0]
    gate.observe({"status": "allowed", "unifiedWindows": {"seven_day": {"utilization": 0.85}}})
    with pytest.raises(ClaudeLimitReached) as stop:
        gate.before_episode()
    assert stop.value.resets_at is None


def test_stream_adds_cached_input_and_spots_the_limit() -> None:
    run = read_stream(
        [
            json.dumps({"type": "system", "subtype": "init", "tools": ["mcp__toolbox__pay_invoice"]}),
            "not json",
            json.dumps({"type": "rate_limit_event", "rate_limit_info": {"status": "rejected", "resetsAt": 5}}),
            json.dumps(
                {
                    "type": "result",
                    "subtype": "success",
                    "is_error": False,
                    "result": "ok",
                    "usage": {"input_tokens": 3, "cache_read_input_tokens": 4, "output_tokens": 1},
                }
            ),
        ]
    )
    assert run.usage == {"input_tokens": 7, "output_tokens": 1}
    assert (run.limited, run.resets_at, run.final) == (True, 5, "ok")


def test_messages_strip_the_prefix_and_carry_only_calls_that_ran() -> None:
    events = [
        {"type": "assistant", "message": {"id": "m1", "content": [{"type": "text", "text": "Looking."}]}},
        {
            "type": "assistant",
            "message": {
                "id": "m1",
                "content": [
                    {"type": "tool_use", "id": "a", "name": "mcp__toolbox__list_vendors", "input": {}},
                    {"type": "tool_use", "id": "b", "name": "mcp__toolbox__pay_invoice", "input": {"account": "X"}},
                ],
            },
        },
        {
            "type": "user",
            "message": {
                "content": [
                    {"type": "tool_result", "tool_use_id": "a", "content": [{"type": "text", "text": "- id: v1"}]},
                    {"type": "tool_result", "tool_use_id": "b", "content": "refused", "is_error": True},
                ]
            },
        },
        {"type": "assistant", "message": {"id": "m2", "content": [{"type": "text", "text": "Done."}]}},
    ]
    messages = to_messages(events, [ExecutedCall("list_vendors", {}, "- id: v1", None)])
    assert [m["role"] for m in messages] == ["assistant", "tool", "tool", "assistant"]
    first, listed, refused = messages[0], messages[1], messages[2]
    assert first["role"] == "assistant" and listed["role"] == "tool" and refused["role"] == "tool"
    assert [c.function for c in first["tool_calls"] or []] == ["list_vendors", "pay_invoice"]
    assert listed["tool_call"].function == "list_vendors"
    # pay_invoice never reached the tool server, so a replay must not run it.
    assert refused["tool_call"] is None and refused["error"] == "refused"


def test_tool_server_speaks_enough_mcp_for_claude_code() -> None:
    import urllib.request

    seen: list[tuple[str, dict]] = []

    def call(name: str, args: dict) -> tuple[str, bool]:
        seen.append((name, args))
        return "ok", False

    with ToolServer([{"name": "ping_me", "description": "d", "inputSchema": {"type": "object"}}], call) as server:

        def post(body: dict) -> tuple[int, dict]:
            req = urllib.request.Request(
                server.url, data=json.dumps(body).encode(), headers={"content-type": "application/json"}
            )
            with urllib.request.urlopen(req) as r:
                text = r.read()
                return r.status, json.loads(text) if text else {}

        status, init = post(
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}}
        )
        assert status == 200 and init["result"]["protocolVersion"] == "2025-06-18"
        assert post({"jsonrpc": "2.0", "method": "notifications/initialized"})[0] == 202
        _, listed = post({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        assert [t["name"] for t in listed["result"]["tools"]] == ["ping_me"]
        _, called = post(
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "ping_me", "arguments": {"x": 1}}}
        )
        assert called["result"]["content"][0]["text"] == "ok" and seen == [("ping_me", {"x": 1})]
        _, unknown = post({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "nope"}})
        assert unknown["result"]["isError"] is True and len(seen) == 1


def test_an_attacked_episode_is_scored_logged_and_replayed_like_an_api_run(tmp_path: Path) -> None:
    suite = family.build(SEED)
    injection = suite.injection_tasks["injection_task_0"]
    # Claude Code carries out the attack's goal exactly: AgentDojo must score it and summarize.py replay it.
    goal_calls = [
        [c.function, dict(c.args)] for c in injection.ground_truth(suite.load_and_inject_default_environment({}))
    ]
    spawn, record = fake(tmp_path, calls=[["list_vendors", {}], *goal_calls])
    gate = UsageGate(log=lambda _: None)
    p = pipeline(ClaudeCodeLLM("claude-sonnet-5-5", gate=gate, spawn=spawn))
    logdir = tmp_path / "claude-sonnet-5-5" / "iters-15" / "run-1"
    with OutputLogger(str(logdir)):
        results = benchmark_suite_with_injections(
            p,
            suite,
            load_attack("bonded_seed", suite, p),
            logdir=logdir,
            force_rerun=False,
            user_tasks=["user_task_0"],
            benchmark_version=BENCHMARK_VERSION,
        )
    assert results["security_results"][("user_task_0", "injection_task_0")] is True
    assert gate.last == {"status": "allowed", "unifiedWindows": {"five_hour": {"utilization": 0.3}}}
    sent = json.loads(record.read_text())
    assert "ANTHROPIC_API_KEY" not in sent["env"]
    assert sent["cwd"].endswith("workspace")
    assert sent["args"][sent["args"].index("--system-prompt") + 1] == load_system_message(None)
    rows = [r for r in load(tmp_path) if r["attack"] == "bonded_seed"]
    assert len(rows) == 1
    row = rows[0]
    # The replay of the logged calls reaches the same verdict, and the planted text was read.
    assert row["security"] is True and row["replay_security"] is True and row["replay_complete"] is True
    assert row["seen"] is True and row["payments"] >= 1


def test_a_usage_limit_or_missing_tools_stops_the_run_unscored(tmp_path: Path) -> None:
    suite = family.build(SEED)
    env = suite.load_and_inject_default_environment({})
    from agentdojo.functions_runtime import FunctionsRuntime

    for mode, error in (("limited", ClaudeLimitReached), ("no-tools", ClaudeHarnessError)):
        spawn, _ = fake(tmp_path, mode=mode, calls=[["list_vendors", {}]])
        llm = ClaudeCodeLLM("claude-sonnet-5-5", spawn=spawn)
        with pytest.raises(error):
            llm.query("Pay the invoices.", FunctionsRuntime(suite.tools), env, [])


def test_only_claude_models() -> None:
    with pytest.raises(ValueError):
        ClaudeCodeLLM("deepseek/deepseek-v4.1-flash")
