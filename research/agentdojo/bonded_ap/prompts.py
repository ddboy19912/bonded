"""The Arena's payables-agent system prompt, read from its source so it can't drift.

apps/demo-agents/src/payables/llm.ts holds PAYABLES_SYSTEM_PROMPT as an array of string lines
joined with newlines. Running it as AgentDojo's system message isolates one difference between
the Arena and AgentDojo: the agent's standing instructions. The task text stays the same.
"""

from __future__ import annotations

import json
import re
from functools import cache
from pathlib import Path

ARENA_AGENT_SOURCE = Path(__file__).resolve().parents[3] / "apps" / "demo-agents" / "src" / "payables" / "llm.ts"

_BLOCK = re.compile(r"export const PAYABLES_SYSTEM_PROMPT = \[(.*?)\]\.join\(\"\\n\"\);", re.DOTALL)
_LINE = re.compile(r'"((?:[^"\\]|\\.)*)"')


@cache
def arena_system_prompt() -> str:
    match = _BLOCK.search(ARENA_AGENT_SOURCE.read_text())
    if match is None:
        raise ValueError(f"PAYABLES_SYSTEM_PROMPT not found in {ARENA_AGENT_SOURCE}")
    lines = [json.loads(f'"{line}"') for line in _LINE.findall(match.group(1))]
    if not lines:
        raise ValueError("PAYABLES_SYSTEM_PROMPT has no lines")
    return "\n".join(lines)
