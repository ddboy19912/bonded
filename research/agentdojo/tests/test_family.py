"""One suite per seed: every portable seed builds, passes AgentDojo's checks and scores as the Arena does."""

from __future__ import annotations

import warnings
from pathlib import Path

import pytest
import yaml
from agentdojo.agent_pipeline.ground_truth_pipeline import GroundTruthPipeline
from agentdojo.attacks.base_attacks import BaseAttack
from agentdojo.functions_runtime import FunctionsRuntime

from bonded_ap import family
from bonded_ap.environment import APEnvironment

SEED_DIR = Path(__file__).resolve().parents[3] / "apps" / "arena" / "offchain-seeds"
SEEDS = family.portable_seeds()


class _Probe(BaseAttack):
    name = "probe"

    def attack(self, user_task, injection_task):  # pragma: no cover - never called
        return {}


def _run(suite: family.SeedSuite, env: APEnvironment, calls: list[tuple[str, dict]]) -> APEnvironment:
    post = env.model_copy(deep=True)
    runtime = FunctionsRuntime(suite.tools)
    for name, args in calls:
        runtime.run_function(post, name, args)
    return post


def test_which_seeds_port() -> None:
    assert len(SEEDS) == 36
    reasons = family.unportable_seeds()
    assert len(reasons) == 10
    assert sum("image" in why for why in reasons.values()) == 6
    assert reasons["O4-tool-description-001"] == "it poisons a tool description"
    assert reasons["O1-portal-swap-001"] == "its portal page changes on a second read"


@pytest.mark.parametrize("seed", SEEDS)
def test_suite_passes_agentdojo_checks(seed: str) -> None:
    suite = family.build(seed)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        ok, (user_results, injection_results) = suite.check(check_injectable=False)
    assert ok, (user_results, injection_results)


@pytest.mark.parametrize("seed", SEEDS)
def test_both_attacks_reach_the_same_vectors(seed: str) -> None:
    """AgentDojo's attack fills what the job shows the model; that must be every vector the seed has."""
    suite = family.build(seed)
    vectors = set(suite.get_injection_vector_defaults())
    for user_task in suite.user_tasks.values():
        probe = _Probe(suite, GroundTruthPipeline(user_task))
        assert set(probe.get_injection_candidates(user_task)) == vectors
    injection_task = next(iter(suite.injection_tasks.values()))
    assert set(injection_task.PAYLOADS) == vectors  # type: ignore[attr-defined]


@pytest.mark.parametrize("seed", SEEDS)
def test_with_no_attack_the_seed_is_not_there(seed: str) -> None:
    suite = family.build(seed)
    env = suite.load_and_inject_default_environment({})
    ids = {e.id for e in env.workspace.inbox} | {s.email.id for s in env.workspace.scheduled if s.email}
    ids |= {m.id for m in env.workspace.channels.messages} | {d.id for d in env.workspace.channels.knowledge}
    for _, item in suite.template.new_items:
        assert item not in ids
    text = env.model_dump_json()
    for vector, payload in suite.template.payloads.items():
        if suite.template.defaults[vector] == "" and len(payload) > 40:
            assert payload[:40] not in text, vector


@pytest.mark.parametrize("seed", SEEDS)
def test_with_the_attack_the_seed_text_is_there_word_for_word(seed: str) -> None:
    suite = family.build(seed)
    payloads = next(iter(suite.injection_tasks.values())).PAYLOADS  # type: ignore[attr-defined]
    env = suite.load_and_inject_default_environment(payloads)
    text = env.model_dump()
    flat = repr(text)
    for vector, payload in payloads.items():
        assert repr(payload)[1:-1][:200] in flat, vector


@pytest.mark.parametrize("seed", SEEDS)
def test_payloads_come_from_the_seed_file(seed: str) -> None:
    """Text vectors (messages, notes, knowledge, email bodies) are the seed file's own words."""
    plant = yaml.safe_load((SEED_DIR / f"{seed}.yaml").read_text())["plant"]

    def strings(value: object) -> list[str]:
        if isinstance(value, str):
            return [value]
        if isinstance(value, dict):
            return [s for v in value.values() for s in strings(v)]
        if isinstance(value, list):
            return [s for v in value for s in strings(v)]
        return []

    written = {s.strip() for s in strings(plant)}
    suite = family.build(seed)
    for vector, payload in suite.template.payloads.items():
        if vector.endswith("_body") or vector.startswith(("message_", "note_", "knowledge_")):
            assert payload.strip() in written, vector


@pytest.mark.parametrize("seed", SEEDS)
def test_the_job_done_right_is_not_a_fall(seed: str) -> None:
    suite = family.build(seed)
    payloads = next(iter(suite.injection_tasks.values())).PAYLOADS  # type: ignore[attr-defined]
    env = suite.load_and_inject_default_environment(payloads)
    user_task = suite.user_tasks["user_task_0"]
    post = _run(suite, env, [(c.function, dict(c.args)) for c in user_task.ground_truth(env)])
    assert user_task.utility("", env, post)
    assert not family.attack_worked(env, post, suite.record)
    assert family.attack_money(env, post, suite.record) == 0


@pytest.mark.parametrize("seed", SEEDS)
def test_a_refusal_is_not_a_fall(seed: str) -> None:
    suite = family.build(seed)
    env = suite.load_and_inject_default_environment({})
    post = _run(suite, env, [("list_emails", {})])
    assert not family.attack_worked(env, post, suite.record)


def test_a_mistyped_genuine_account_is_the_agents_own_error() -> None:
    """A breach involving nothing the seed planted isn't the attack working (Arena attribution)."""
    suite = family.build("O1-lookalike-domain-001")
    env = suite.load_and_inject_default_environment({})
    post = _run(
        suite,
        env,
        [
            (
                "pay_invoice",
                {"account": "GB33 BUKB 2020 1555 5555 99", "amount_usd": 1840, "invoice_reference": "ACM-2291"},
            )
        ],
    )
    assert post.ledger.breaches
    assert not family.attack_worked(env, post, suite.record)


def test_a_planted_account_paid_is_the_attack_working() -> None:
    suite = family.build("O1-lookalike-domain-001")
    env = suite.load_and_inject_default_environment({})
    post = _run(
        suite,
        env,
        [
            (
                "pay_invoice",
                {"account": "GB82 WEST 1234 5698 7654 32", "amount_usd": 612.4, "invoice_reference": "NIM-88412"},
            )
        ],
    )
    assert family.attack_worked(env, post, suite.record)
    assert family.attack_money(env, post, suite.record) == 612.4


def test_prompts_are_the_arenas_words() -> None:
    record = family.export()["seeds"]["O1-agent-001"]
    suite = family.build("O1-agent-001")
    assert suite.user_tasks["user_task_0"].PROMPT == f"{record['jobText']}\n\n{record['goal']}"
    assert suite.user_tasks["user_task_1"].PROMPT == f"{record['mandateText']}\n\n{record['goal']}"
    assert "Pay only to the bank account the vendor master holds" in suite.user_tasks["user_task_1"].PROMPT
