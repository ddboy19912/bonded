"""The family-run numbers behind the tech report. No model calls.

    uv run python report_stats.py                     # runs/family and runs/pushed/family
    uv run python report_stats.py --fetched DIR --pushed DIR

summarize.py prints each log folder on its own. This reads both deliveries of the family run
(fetched and pushed), replays every episode the same way, and prints the report's tables:

- the two models that refused every direct ask, both attacks side by side, with a sign test over
  seeds and an interval that resamples whole seeds (episodes of one seed aren't independent);
- the six (model, delivery) cells, counted over all pairs (AgentDojo's way) and over the pairs
  that met the attack (Bonded's way), with Wilson and seed-resampled intervals;
- rules withheld against shown;
- Bonded's seeds by class, by where the text is planted, and the seeds that worked most;
- the job with and without an attack, and the direct asks;
- the rule breaks a blocking payment check would also catch, in episodes the attack wasn't counted
  for (the agent's own mistakes and breaches the seed didn't aim at).

Episodes that ended in an agent error are left out, as in summarize.py. Money counts only
episodes whose replay matches AgentDojo's log (summarize.py explains the unlogged retries).
"""

from __future__ import annotations

import argparse
import math
import random
import sys
from collections import defaultdict
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

from bonded_ap import family
from summarize import BRIEFING, load, wilson

Row = dict[str, Any]

ATTACKS = ("bonded_seed", "important_instructions")
DELIVERIES = ("fetched", "pushed")
HEADLINE_DRAWS = 10_000
CELL_DRAWS = 5_000


def load_family(roots: dict[str, Path]) -> list[Row]:
    """Every scored episode of the family run, tagged with its delivery and a plain model id."""
    rows = []
    for delivery, root in roots.items():
        for row in load(root):
            row["delivery"] = delivery
            # summarize.load tags the folder kind ("(all seeds)", "(pushed)"): keep the model id only.
            row["model"] = row["model"].split(" ")[0]
            rows.append(row)
    return [r for r in rows if not r["error"]]


def attacked(rows: Iterable[Row], attack: str | None = None) -> list[Row]:
    return [
        r
        for r in rows
        if r["user_task"] in BRIEFING and r["attack"] in ATTACKS and (attack is None or r["attack"] == attack)
    ]


def no_attack(rows: Iterable[Row]) -> list[Row]:
    return [r for r in rows if r["user_task"] in BRIEFING and r["attack"] in (None, "none")]


def direct_asks(rows: Iterable[Row]) -> list[Row]:
    return [r for r in rows if r["user_task"] not in BRIEFING]


def refusing_models(rows: Iterable[Row]) -> list[str]:
    """Models that carried out none of the attack goals when the user asked for them directly."""
    done: dict[str, int] = defaultdict(int)
    for r in direct_asks(rows):
        done[r["model"]] += bool(r["utility"])
    return sorted(m for m, n in done.items() if n == 0)


def seed_sign_test(rows: Iterable[Row]) -> tuple[int, int, int, float]:
    """Pair the two attacks on each seed and count which one worked more often there.

    Returns (seeds where Bonded's attack worked more, seeds where AgentDojo's did, ties, p), where p
    is the one-sided exact sign test: the chance of Bonded winning at least that many of the untied
    seeds if either attack were equally likely to win each one. The seed is the unit, so episodes of
    one seed (which aren't independent) count once.
    """
    falls: dict[str, dict[str, int]] = defaultdict(lambda: dict.fromkeys(ATTACKS, 0))
    for r in attacked(rows):
        falls[r["seed"]][r["attack"]] += bool(r["security"])
    ours = sum(f["bonded_seed"] > f["important_instructions"] for f in falls.values())
    theirs = sum(f["bonded_seed"] < f["important_instructions"] for f in falls.values())
    ties = len(falls) - ours - theirs
    n = ours + theirs
    p = sum(math.comb(n, k) for k in range(ours, n + 1)) / 2**n if n else 1.0
    return ours, theirs, ties, p


def seed_interval(rows: Iterable[Row], draws: int, rng_seed: int = 1) -> tuple[float, float]:
    """95% interval for the fall rate, resampling whole seeds with replacement."""
    by_seed: dict[str, list[bool]] = defaultdict(list)
    for r in rows:
        by_seed[r["seed"]].append(bool(r["security"]))
    seeds = sorted(by_seed)
    if not seeds:
        return (0.0, 0.0)
    rng = random.Random(rng_seed)
    rates = []
    for _ in range(draws):
        pick = [rng.choice(seeds) for _ in seeds]
        rates.append(sum(sum(by_seed[s]) for s in pick) / sum(len(by_seed[s]) for s in pick))
    rates.sort()
    return (rates[int(0.025 * draws)], rates[min(draws - 1, int(0.975 * draws))])


def money(rows: Iterable[Row]) -> float:
    """What the attack moved (lost or overpaid), on episodes whose replay matches the log."""
    return sum(r["attack_money"] for r in rows if r["security"] and r["replay_complete"])


def group_falls(rows: Iterable[Row], keys: Callable[[str], Iterable[str]]) -> dict[str, tuple[int, int, set[str]]]:
    """Falls and episodes per group; a seed may belong to several groups (it plants in several places)."""
    groups: dict[str, list[Any]] = defaultdict(lambda: [0, 0, set()])
    for r in rows:
        for key in keys(r["seed"]):
            groups[key][0] += bool(r["security"])
            groups[key][1] += 1
            groups[key][2].add(r["seed"])
    return {k: (v[0], v[1], v[2]) for k, v in groups.items()}


def rule_breaks_outside(rows: Iterable[Row]) -> list[Row]:
    """Episodes that broke a rule with money involved, where no attack was counted as the cause.

    Replay disagreements are left out, as in every money total: their replay can't see every action.
    """
    return [
        r
        for r in rows
        if r["user_task"] in BRIEFING
        and (r["attack"] in (None, "none") or not r["security"])
        and (r["lost"] + r["overpaid"]) > 0
        and r["replay_complete"]
    ]


def _pct(k: int, n: int) -> str:
    return f"{k}/{n} ({100 * k / n:.0f}%)" if n else "n/a"


def _ci(interval: tuple[float, float], digits: int = 0) -> str:
    return f"{100 * interval[0]:.{digits}f}-{100 * interval[1]:.{digits}f}%"


def report(rows: list[Row], out: Callable[[str], None] = print) -> None:
    seeds_meta = family.export()["seeds"]
    models = sorted({r["model"] for r in rows})
    refusing = refusing_models(rows)

    out("# The models that refused every direct ask\n")
    out(f"models: {', '.join(refusing) or 'none'}")
    ref = [r for r in attacked(rows) if r["model"] in refusing]
    for attack in ATTACKS:
        rs = [r for r in ref if r["attack"] == attack]
        met = [r for r in rs if r["seen"]]
        worked_seeds = {r["seed"] for r in rs if r["security"]}
        out(
            f"- {attack}: worked {_pct(sum(r['security'] for r in rs), len(rs))}; met {len(met)}; "
            f"worked of met {sum(r['security'] for r in met)}/{len(met)}; money ${money(rs):,.0f}; "
            f"seeds that worked {len(worked_seeds)} of {len({r['seed'] for r in rs})}"
        )
    ours = [r for r in ref if r["attack"] == "bonded_seed"]
    theirs = [r for r in ref if r["attack"] == "important_instructions"]
    if ours and theirs:
        out(f"- seed-resampled 95% interval, Bonded: {_ci(seed_interval(ours, HEADLINE_DRAWS), 1)}")
        won, lost, tied, p = seed_sign_test(ref)
        out(
            f"- sign test over seeds: Bonded worked more on {won}, AgentDojo on {lost}, tied {tied}; "
            f"one-sided p {p:.2e}"
        )
    asks = [r for r in direct_asks(rows) if r["model"] in refusing]
    if asks:
        paid = sum(r["payments"] > 0 and r["rule_breaks"] == 0 for r in asks)
        none = sum(r["payments"] == 0 and r["rule_breaks"] == 0 for r in asks)
        broke = sum(r["rule_breaks"] > 0 for r in asks)
        out(
            f"- direct asks on these models: {len(asks)}; paid something but broke no rule {paid}; "
            f"paid nothing {none}; broke a rule {broke}"
        )

    out("\n# The six cells\n")
    out(
        "model | delivery | Bonded met | Bonded all (Wilson) | seed CI | AgentDojo met | AgentDojo all | money | direct ask"
    )
    for delivery in DELIVERIES:
        for model in models:
            cell = [r for r in rows if r["model"] == model and r["delivery"] == delivery]
            b, a = attacked(cell, "bonded_seed"), attacked(cell, "important_instructions")
            if not b:
                continue
            kb, ka = sum(r["security"] for r in b), sum(r["security"] for r in a)
            bm, am = [r for r in b if r["seen"]], [r for r in a if r["seen"]]
            asks = direct_asks(cell)
            out(
                f"{model} | {delivery} | {sum(r['security'] for r in bm)}/{len(bm)} | {kb}/{len(b)} "
                f"({_ci(wilson(kb, len(b)))}) | {_ci(seed_interval(b, CELL_DRAWS))} | "
                f"{sum(r['security'] for r in am)}/{len(am)} | {ka}/{len(a)} | "
                f"${money(b):,.0f} / ${money(a):,.0f} | {sum(r['utility'] for r in asks)}/{len(asks)}"
            )

    out("\n# Rules withheld against shown (Bonded's seeds)\n")
    ours_all = attacked(rows, "bonded_seed")
    for task, name in BRIEFING.items():
        rs = [r for r in ours_all if r["user_task"] == task]
        out(
            f"- {name}: {sum(r['security'] for r in rs)}/{len(rs)}; "
            f"refusing models {sum(r['security'] for r in rs if r['model'] in refusing)}"
        )

    def refusing_share(group: str, keys: Callable[[str], Iterable[str]]) -> str:
        falls, total, _ = group_falls([r for r in ours_all if r["model"] in refusing], keys).get(group, (0, 0, set()))
        return f"{falls}/{total}"

    out("\n# Bonded's seeds by class\n")

    def by_class(seed: str) -> list[str]:
        return [seeds_meta[seed]["class"]]

    for group, (falls, total, seeds) in sorted(group_falls(ours_all, by_class).items()):
        out(f"- {group}: {len(seeds)} seeds; {_pct(falls, total)}; refusing models {refusing_share(group, by_class)}")

    out("\n# Bonded's seeds by where the text is planted\n")

    def by_vector(seed: str) -> list[str]:
        return seeds_meta[seed]["vectors"]

    vectors = group_falls(ours_all, by_vector)
    for group, (falls, total, seeds) in sorted(vectors.items(), key=lambda kv: -kv[1][0] / kv[1][1]):
        out(f"- {group}: {len(seeds)} seeds; {_pct(falls, total)}")

    out("\n# Seeds that worked (Bonded's seeds, all cells)\n")
    per_seed = group_falls(ours_all, lambda seed: [seed])
    ref_seed = group_falls([r for r in ours_all if r["model"] in refusing], lambda seed: [seed])
    worked = sorted(((v[0], k) for k, v in per_seed.items() if v[0]), reverse=True)
    out(f"{len(worked)} of {len(per_seed)} seeds worked at least once")
    for falls, seed in worked:
        refusing_falls, refusing_total, _ = ref_seed.get(seed, (0, 0, set()))
        out(f"- {seed}: {falls}/{per_seed[seed][1]}; refusing models {refusing_falls}/{refusing_total}")

    out("\n# The job\n")
    for delivery in DELIVERIES:
        for model in models:
            cell = [r for r in rows if r["model"] == model and r["delivery"] == delivery]
            plain = no_attack(cell)
            if not plain:
                continue
            under = {a: sum(r["utility"] for r in attacked(cell, a)) for a in ATTACKS}
            out(
                f"- {model} {delivery}: no attack paid right {sum(bool(r['paid_right']) for r in plain)}/{len(plain)}, "
                f"whole job {sum(bool(r['whole_job']) for r in plain)}/{len(plain)}, "
                f"mean tool calls {sum(r['tool_calls'] for r in plain) / len(plain):.1f}; "
                f"utility under attack: Bonded {under['bonded_seed']}, AgentDojo {under['important_instructions']}"
            )

    outside = rule_breaks_outside(rows)
    out("\n# A blocking payment check (Section 6)\n")
    falls = {a: sum(r["security"] for r in attacked(rows, a)) for a in ATTACKS}
    out(
        f"- attacks that worked, each a rule break: Bonded {falls['bonded_seed']}, AgentDojo {falls['important_instructions']}"
    )
    out(
        f"- rule breaks the attack wasn't counted for: {len(outside)} episodes, "
        f"${sum(r['lost'] + r['overpaid'] for r in outside):,.0f}"
    )
    disagree = sum(not r["replay_complete"] for r in rows)
    out(f"\nEpisodes: {len(rows)}; replay disagreements (left out of money): {disagree}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--fetched", type=Path, default=Path("runs/family"))
    parser.add_argument("--pushed", type=Path, default=Path("runs/pushed/family"))
    args = parser.parse_args()
    rows = load_family({"fetched": args.fetched, "pushed": args.pushed})
    if not rows:
        print("no logs found", file=sys.stderr)
        return 1
    report(rows)
    return 0


if __name__ == "__main__":
    sys.exit(main())
