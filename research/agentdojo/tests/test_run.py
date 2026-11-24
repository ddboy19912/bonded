"""The spend check waits and asks again when OpenRouter's key endpoint is busy."""

from __future__ import annotations

import io
import json
import urllib.error

import pytest

import run


def _error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("https://openrouter.ai/api/v1/key", code, "busy", {}, None)  # type: ignore[arg-type]


@pytest.fixture
def no_wait(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    waits: list[float] = []
    monkeypatch.setattr(run.time, "sleep", waits.append)
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    return waits


def _answers(monkeypatch: pytest.MonkeyPatch, answers: list[object]) -> None:
    def urlopen(*_: object, **__: object) -> io.BytesIO:
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return io.BytesIO(json.dumps({"data": {"usage": answer}}).encode())

    monkeypatch.setattr(run.urllib.request, "urlopen", urlopen)


@pytest.mark.parametrize("busy", [_error(429), _error(502), urllib.error.URLError("reset")])
def test_a_busy_endpoint_is_asked_again(monkeypatch: pytest.MonkeyPatch, no_wait: list[float], busy: Exception) -> None:
    _answers(monkeypatch, [busy, busy, 12.5])
    assert run.openrouter_usage_usd() == 12.5
    assert no_wait == [5, 10]


def test_a_refused_key_is_not_retried(monkeypatch: pytest.MonkeyPatch, no_wait: list[float]) -> None:
    _answers(monkeypatch, [_error(403), 1.0])
    with pytest.raises(urllib.error.HTTPError):
        run.openrouter_usage_usd()
    assert no_wait == []


def test_it_gives_up_in_the_end(monkeypatch: pytest.MonkeyPatch, no_wait: list[float]) -> None:
    _answers(monkeypatch, [_error(429)] * 3)
    with pytest.raises(urllib.error.HTTPError):
        run.openrouter_usage_usd(attempts=3)
    assert len(no_wait) == 2
