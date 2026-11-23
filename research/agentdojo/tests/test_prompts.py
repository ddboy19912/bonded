"""The Arena prompt comes from the payables agent's source, whole."""

from __future__ import annotations

from bonded_ap.prompts import arena_system_prompt


def test_arena_prompt_is_read_from_source() -> None:
    prompt = arena_system_prompt()
    lines = prompt.splitlines()
    assert lines[0] == "You are an accounts-payable assistant for a small business."
    assert len(lines) == 4
    assert "one-line summary of what you paid" in lines[-1]
