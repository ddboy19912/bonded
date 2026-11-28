"""A stand-in for `claude -p ... --output-format stream-json` in tests.

It reads the MCP config it was given, speaks MCP to the episode's tool server as Claude Code does
(initialize, tools/list, tools/call), runs the calls in FAKE_CALLS (a JSON list of
[name, arguments]) and prints the stream-json events a real run prints. FAKE_MODE: run (default),
limited (the plan is out of usage), no-tools (the server was refused). FAKE_RECORD: a file to write
its argv, env and working folder to.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request

args = sys.argv[1:]


def flag(name: str) -> str:
    return args[args.index(name) + 1]


def emit(event: dict) -> None:
    print(json.dumps(event), flush=True)


if os.environ.get("FAKE_RECORD"):
    with open(os.environ["FAKE_RECORD"], "w") as f:
        json.dump({"args": args, "env": dict(os.environ), "cwd": os.getcwd()}, f)

mode = os.environ.get("FAKE_MODE", "run")
with open(flag("--mcp-config")) as f:
    config = json.load(f)
name, server = next(iter(config["mcpServers"].items()))
if mode == "no-tools":
    emit({"type": "system", "subtype": "init", "tools": [], "mcp_server_errors": [{"message": "reserved name"}]})
    emit({"type": "result", "subtype": "success", "is_error": False, "result": "no tools"})
    sys.exit(0)

ids = iter(range(1, 1000))


def rpc(method: str, params: dict | None = None, notify: bool = False) -> dict:
    body: dict = {"jsonrpc": "2.0", "method": method, "params": params or {}}
    if not notify:
        body["id"] = next(ids)
    request = urllib.request.Request(
        server["url"],
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json", "accept": "application/json, text/event-stream"},
    )
    with urllib.request.urlopen(request) as response:
        text = response.read()
        return json.loads(text) if text else {}


rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "fake", "version": "1"}})
rpc("notifications/initialized", notify=True)
tools = rpc("tools/list")["result"]["tools"]
emit({"type": "system", "subtype": "init", "tools": [f"mcp__{name}__{t['name']}" for t in tools]})
calls = json.loads(os.environ.get("FAKE_CALLS", "[]"))
for i, (tool, arguments) in enumerate(calls):
    result = rpc("tools/call", {"name": tool, "arguments": arguments})["result"]
    emit(
        {
            "type": "assistant",
            "message": {
                "id": f"msg-{i}",
                "content": [
                    {"type": "text", "text": f"Calling {tool}."},
                    {"type": "tool_use", "id": f"tu-{i}", "name": f"mcp__{name}__{tool}", "input": arguments},
                ],
            },
        }
    )
    emit(
        {
            "type": "user",
            "message": {
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": f"tu-{i}",
                        "content": result["content"],
                        "is_error": result.get("isError", False),
                    }
                ]
            },
        }
    )
if mode == "limited":
    emit({"type": "rate_limit_event", "rate_limit_info": {"status": "rejected", "resetsAt": 2_000_000_000}})
    emit({"type": "result", "subtype": "error_during_execution", "is_error": True, "result": "usage limit reached"})
    sys.exit(1)
emit({"type": "assistant", "message": {"id": "msg-final", "content": [{"type": "text", "text": "All done."}]}})
emit(
    {
        "type": "rate_limit_event",
        "rate_limit_info": {"status": "allowed", "unifiedWindows": {"five_hour": {"utilization": 0.3}}},
    }
)
emit(
    {
        "type": "result",
        "subtype": "success",
        "is_error": False,
        "result": "All done.",
        "usage": {"input_tokens": 10, "cache_read_input_tokens": 5, "output_tokens": 2},
    }
)
