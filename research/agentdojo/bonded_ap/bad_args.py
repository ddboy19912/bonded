"""Tool calls whose arguments aren't valid JSON get a tool error, as the Arena's agent loop does.

AgentDojo's OpenAI-compatible client parses each tool call's arguments with json.loads and lets
the error escape, so one malformed call from the model ends the whole benchmark process. The
Arena's hosted agent (apps/arena/src/hosted/instructions-agent.ts) answers that call with
"the arguments weren't valid JSON", runs nothing, and the episode goes on. This does the same:
the call keeps its raw text under INVALID_ARGS, and the runtime refuses to run it.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from agentdojo.agent_pipeline.llms import openai_llm
from agentdojo.functions_runtime import FunctionCall, FunctionsRuntime

INVALID_ARGS = "__invalid_json_arguments__"
ERROR = "the arguments weren't valid JSON"


def parse_tool_call(tool_call: Any) -> FunctionCall:
    raw = tool_call.function.arguments or "{}"
    try:
        args = json.loads(raw)
    except json.JSONDecodeError:
        args = None
    if not isinstance(args, dict):
        args = {INVALID_ARGS: raw}
    return FunctionCall(function=tool_call.function.name, args=args, id=tool_call.id)


def is_invalid(args: Mapping[str, Any]) -> bool:
    return INVALID_ARGS in args


_run_function = FunctionsRuntime.run_function


def _guarded_run_function(self, env, function, kwargs, raise_on_error=False):  # type: ignore[no-untyped-def]
    if is_invalid(kwargs):
        if raise_on_error:
            raise ValueError(ERROR)
        return "", ERROR
    return _run_function(self, env, function, kwargs, raise_on_error)


def tolerate_bad_arguments() -> None:
    """Install both halves: parse without raising, and never run a call that didn't parse."""
    openai_llm._openai_to_tool_call = parse_tool_call  # type: ignore[assignment]
    FunctionsRuntime.run_function = _guarded_run_function  # type: ignore[method-assign]
