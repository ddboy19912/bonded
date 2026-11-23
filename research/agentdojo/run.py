"""Run the accounts_payable suite on a model through OpenRouter. This spends money: use --dry-run first.

    uv run python run.py --model z-ai/glm-5.3-flash --dry-run
    uv run python run.py --model z-ai/glm-5.3-flash --runs 3

Reads OPENROUTER_API_KEY from the environment (never from the command line). Each run writes
AgentDojo's own logs to runs/<model>/run-<n>/ (gitignored). Every (user task, injection task)
pair runs once per attack per run, plus each user task with no attack.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from agentdojo.scripts.benchmark import benchmark_suite

import bonded_ap
from bonded_ap.task_suite import task_suite

DEFAULT_ATTACKS = ("bonded_seed", "important_instructions")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", required=True, help="OpenRouter model id, e.g. z-ai/glm-5.3-flash")
    parser.add_argument("--attacks", default=",".join(DEFAULT_ATTACKS), help="comma-separated AgentDojo attack names")
    parser.add_argument("--runs", type=int, default=1, help="how many times to run every pair")
    parser.add_argument("--logdir", type=Path, default=Path("runs"))
    parser.add_argument("--dry-run", action="store_true", help="print the plan and make no model calls")
    args = parser.parse_args()

    attacks = [a for a in args.attacks.split(",") if a]
    users, injections = len(task_suite.user_tasks), len(task_suite.injection_tasks)
    episodes = args.runs * users * (1 + injections * len(attacks))
    print(f"suite accounts_payable ({bonded_ap.BENCHMARK_VERSION}): {users} user tasks x {injections} injection tasks")
    print(f"attacks: {', '.join(attacks)}; runs: {args.runs}; episodes: {episodes}")
    if args.dry_run:
        return 0
    if not os.environ.get("OPENROUTER_API_KEY"):
        print("OPENROUTER_API_KEY is not set", file=sys.stderr)
        return 1
    os.environ["OPENAI_COMPATIBLE_BASE_URL"] = "https://openrouter.ai/api/v1"
    os.environ["OPENAI_COMPATIBLE_API_KEY"] = os.environ["OPENROUTER_API_KEY"]

    for n in range(1, args.runs + 1):
        logdir = args.logdir / args.model.replace("/", "_") / f"run-{n}"
        common = {
            "suite": task_suite,
            "model": "openai-compatible",
            "logdir": logdir,
            "force_rerun": False,
            "benchmark_version": bonded_ap.BENCHMARK_VERSION,
            "model_id": args.model,
        }
        benchmark_suite(**common, attack=None)
        for attack in attacks:
            benchmark_suite(**common, attack=attack)
    return 0


if __name__ == "__main__":
    sys.exit(main())
