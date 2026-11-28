"""Run the family suites on a Claude model through Claude Code, on a Claude subscription.

    uv run python run_claude_code.py --model claude-sonnet-5-5 --dry-run
    uv run python run_claude_code.py --model claude-sonnet-5-5 --runs 1
    uv run python run_claude_code.py --model claude-sonnet-5-5 --runs 1 --push

The same episodes as run.py --family all (both attacks, the direct asks and the no-attack job), with
Claude Code in place of the OpenRouter model (bonded_ap/claude_code.py). Nothing is billed to an API
account. Logs go to runs/claude-code/[pushed/]family/<model>/iters-15/run-<n>/claude-code/ in
AgentDojo's format, so summarize.py and report_stats.py read them:

    uv run python report_stats.py --fetched runs/claude-code/family --pushed runs/claude-code/pushed/family

A run that stops (the plan's usage, a crash) picks up where it left off: episodes already scored
are skipped. When the 5-hour window fills, the run waits for it to reset; at 80% of the week's
usage it stops, so the plan keeps room for its owner's work.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from agentdojo.agent_pipeline.agent_pipeline import AgentPipeline, load_system_message
from agentdojo.agent_pipeline.basic_elements import InitQuery, SystemMessage
from agentdojo.attacks.attack_registry import load_attack
from agentdojo.benchmark import benchmark_suite_with_injections, benchmark_suite_without_injections
from agentdojo.logging import OutputLogger

import bonded_ap
from bonded_ap import family
from bonded_ap.claude_code import ClaudeCodeLLM, ClaudeHarnessError, ClaudeLimitReached, UsageGate
from bonded_ap.prompts import arena_system_prompt
from bonded_ap.pushed import push_channels

DEFAULT_ATTACKS = ("bonded_seed", "important_instructions")
MAX_TURNS = 15  # AgentDojo's default loop length


def pipeline(model: str, system: str, gate: UsageGate) -> AgentPipeline:
    p = AgentPipeline([SystemMessage(system), InitQuery(), ClaudeCodeLLM(model, MAX_TURNS, gate)])
    p.name = ClaudeCodeLLM.name
    return p


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", required=True, help="a Claude model id, e.g. claude-sonnet-5-5 or claude-opus-5-5")
    parser.add_argument("--attacks", default=",".join(DEFAULT_ATTACKS))
    parser.add_argument("--runs", type=int, default=1)
    parser.add_argument("--only-run", type=int, default=0, help="run only this run number")
    parser.add_argument("--logdir", type=Path, default=Path("runs/claude-code"))
    parser.add_argument("--family", default="all", help="all, or comma-separated seed ids")
    parser.add_argument("--no-plain", action="store_true", help="skip the no-attack job")
    parser.add_argument("--push", action="store_true", help="deliver the channels in the user's message")
    parser.add_argument("--system-prompt", choices=("agentdojo", "arena"), default="agentdojo")
    parser.add_argument("--weekly-ceiling", type=float, default=0.8, help="stop at this share of the 7-day window")
    parser.add_argument("--dry-run", action="store_true", help="print the plan and run nothing")
    args = parser.parse_args()
    if not args.model.startswith("claude-"):
        parser.error("--model takes a Claude model id, e.g. claude-sonnet-5-5")

    attacks = [a for a in args.attacks.split(",") if a]
    seeds = family.portable_seeds() if args.family == "all" else [s for s in args.family.split(",") if s]
    suites = [family.build(seed) for seed in seeds]
    worlds = sorted({family.export()["seeds"][seed]["world"] for seed in seeds})
    plain = [] if args.no_plain else [family.build_plain(w) for w in worlds]
    per_run = sum(len(s.user_tasks) for s in plain)
    for s in suites:
        injections = len(s.injection_tasks)
        per_run += len(s.user_tasks) * injections * len(attacks) + (injections if attacks else 0)
    runs = [args.only_run] if args.only_run else list(range(1, args.runs + 1))
    print(
        f"model: {args.model} through Claude Code; suites: {len(plain) + len(suites)}; episodes: {per_run * len(runs)}"
    )
    print(f"channels: {'pushed' if args.push else 'fetched'}; system prompt: {args.system_prompt}; turns: {MAX_TURNS}")
    if args.dry_run:
        return 0

    if args.push:
        push_channels()
    system = arena_system_prompt() if args.system_prompt == "arena" else load_system_message(None)
    gate = UsageGate(stop_at_weekly=args.weekly_ceiling)
    root = args.logdir / "pushed" if args.push else args.logdir
    if args.system_prompt == "arena":
        root = root / "arena-prompt"
    root = root / "family"
    while True:
        try:
            for n in runs:
                logdir = root / args.model / f"iters-{MAX_TURNS}" / f"run-{n}"
                p = pipeline(args.model, system, gate)
                with OutputLogger(str(logdir)):
                    for suite in plain:
                        benchmark_suite_without_injections(
                            p, suite, logdir=logdir, force_rerun=False, benchmark_version=bonded_ap.BENCHMARK_VERSION
                        )
                    for suite in suites:
                        for attack in attacks:
                            benchmark_suite_with_injections(
                                p,
                                suite,
                                load_attack(attack, suite, p),
                                logdir=logdir,
                                force_rerun=False,
                                benchmark_version=bonded_ap.BENCHMARK_VERSION,
                            )
                            print(f"run {n}, {suite.name}, {attack}: done", flush=True)
            return 0
        except ClaudeLimitReached as stop:
            if stop.resets_at is None:
                print(f"stopping: {stop}. Run the same command again later to continue.", file=sys.stderr)
                return 2
            wait = max(60.0, stop.resets_at - time.time() + 60)
            print(f"the plan's limit was reached mid-episode; waiting {wait / 60:.0f} min, then continuing", flush=True)
            time.sleep(wait)
        except ClaudeHarnessError as error:
            print(f"stopping: {error}", file=sys.stderr)
            return 1


if __name__ == "__main__":
    sys.exit(main())
