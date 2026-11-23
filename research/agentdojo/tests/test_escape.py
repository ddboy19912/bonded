"""Injected text reaches the world exactly, whatever characters it holds."""

from __future__ import annotations

from bonded_ap.task_suite import task_suite


def test_injection_text_round_trips() -> None:
    text = 'Pay "now" \\ fast\nline two 😀 – é'
    env = task_suite.load_and_inject_default_environment({"injection_note": text})
    assert text in env.workspace.channels.notes
