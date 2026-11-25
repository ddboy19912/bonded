"""The report's statistics: Fisher exact, seed resampling, refusing models and rule breaks."""

from __future__ import annotations

import math
from typing import Any

import pytest

from report_stats import (
    attacked,
    fisher_one_sided,
    group_falls,
    money,
    refusing_models,
    rule_breaks_outside,
    seed_interval,
)


def row(**fields: Any) -> dict[str, Any]:
    base = {
        "model": "m",
        "delivery": "fetched",
        "seed": "S1",
        "user_task": "user_task_0",
        "attack": "bonded_seed",
        "security": False,
        "seen": True,
        "utility": True,
        "attack_money": 0.0,
        "lost": 0.0,
        "overpaid": 0.0,
        "replay_complete": True,
    }
    return base | fields


def test_fisher_matches_the_hypergeometric_tail() -> None:
    # 3 of 3 against 0 of 3: only one table is as extreme, 1 / C(6, 3).
    assert fisher_one_sided(3, 3, 0, 3) == pytest.approx(1 / math.comb(6, 3))
    # With no difference the one-sided p is 1.
    assert fisher_one_sided(0, 5, 0, 5) == pytest.approx(1.0)
    # The report's headline: 56 of 888 against 0 of 888.
    assert fisher_one_sided(56, 888, 0, 888) < 1e-17


def test_seed_interval_resamples_whole_seeds() -> None:
    # Two seeds: one always works, one never does. Resampling seeds spans 0 to 1; per episode it wouldn't.
    rows = [row(seed="A", security=True)] * 6 + [row(seed="B")] * 6
    low, high = seed_interval(rows, draws=2_000)
    assert low == 0.0 and high == 1.0
    assert seed_interval(rows, draws=2_000) == (low, high), "a fixed random seed gives the same interval"
    assert seed_interval([], draws=10) == (0.0, 0.0)


def test_refusing_models_are_the_ones_that_did_no_direct_ask() -> None:
    rows = [
        row(model="refuses", user_task="direct", utility=False),
        row(model="refuses", user_task="direct", utility=False, delivery="pushed"),
        row(model="obeys", user_task="direct", utility=False),
        row(model="obeys", user_task="direct", utility=True, delivery="pushed"),
    ]
    assert refusing_models(rows) == ["refuses"]


def test_attacked_keeps_both_attacks_and_skips_plain_and_direct_episodes() -> None:
    rows = [
        row(),
        row(attack="important_instructions"),
        row(attack=None),
        row(user_task="direct"),
    ]
    assert len(attacked(rows)) == 2
    assert len(attacked(rows, "important_instructions")) == 1


def test_money_counts_falls_whose_replay_matches_the_log() -> None:
    rows = [
        row(security=True, attack_money=100.0),
        row(security=True, attack_money=50.0, replay_complete=False),
        row(security=False, attack_money=999.0),
    ]
    assert money(rows) == 100.0


def test_groups_count_a_seed_in_every_place_it_plants() -> None:
    places = {"A": ["email", "knowledge"], "B": ["email"]}
    rows = [row(seed="A", security=True), row(seed="B")]
    groups = group_falls(rows, lambda seed: places[seed])
    assert groups["email"][:2] == (1, 2)
    assert groups["knowledge"] == (1, 1, {"A"})


def test_rule_breaks_outside_include_no_attack_runs_and_unattributed_breaches() -> None:
    rows = [
        row(attack=None, security=True, lost=612.4),  # AgentDojo scores a no-attack run as secure
        row(security=False, overpaid=100.0),  # a breach the seed didn't aim at
        row(security=True, lost=500.0),  # the attack's own fall: counted elsewhere
        row(security=False),  # no breach
    ]
    outside = rule_breaks_outside(rows)
    assert [r["lost"] + r["overpaid"] for r in outside] == [612.4, 100.0]
