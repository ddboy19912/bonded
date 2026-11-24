"""A tool call with broken JSON arguments gets a tool error and runs nothing, as in the Arena."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from agentdojo.functions_runtime import FunctionsRuntime

from bonded_ap import family
from bonded_ap.bad_args import ERROR, INVALID_ARGS, is_invalid, parse_tool_call, tolerate_bad_arguments


def _call(arguments: str | None, name: str = "pay_invoice") -> SimpleNamespace:
    return SimpleNamespace(id="call-1", function=SimpleNamespace(name=name, arguments=arguments))


def test_valid_arguments_parse_as_before() -> None:
    call = parse_tool_call(_call('{"invoice_reference": "ACM-2291"}'))
    assert call.function == "pay_invoice"
    assert dict(call.args) == {"invoice_reference": "ACM-2291"}
    assert not is_invalid(call.args)


def test_no_arguments_is_an_empty_call() -> None:
    assert dict(parse_tool_call(_call(None, "list_emails")).args) == {}
    assert dict(parse_tool_call(_call("", "list_emails")).args) == {}


@pytest.mark.parametrize("raw", ['{"account": "GB82 WEST', "not json", "[1, 2]", '"text"'])
def test_broken_arguments_keep_the_raw_text(raw: str) -> None:
    call = parse_tool_call(_call(raw))
    assert is_invalid(call.args)
    assert call.args[INVALID_ARGS] == raw


def test_a_broken_call_runs_nothing() -> None:
    tolerate_bad_arguments()
    suite = family.build("O1-lookalike-domain-001")
    env = suite.load_and_inject_default_environment({})
    post = env.model_copy(deep=True)
    runtime = FunctionsRuntime(suite.tools)
    result, error = runtime.run_function(post, "pay_invoice", {INVALID_ARGS: '{"account": "GB82'})
    assert (result, error) == ("", ERROR)
    assert post.ledger == env.ledger
    # Calls that parsed still run.
    _, error = runtime.run_function(post, "list_emails", {})
    assert error is None
