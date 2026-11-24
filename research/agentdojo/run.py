"""Run the accounts_payable suite on a model through OpenRouter. This spends money: use --dry-run first.

    uv run python run.py --model z-ai/glm-5.3-flash --dry-run
    uv run python run.py --model z-ai/glm-5.3-flash --runs 3

Reads OPENROUTER_API_KEY from the environment (never from the command line). Each run writes
AgentDojo's own logs to runs/<model>/run-<n>/ (gitignored). Every (user task, injection task)
pair runs once per attack per run, plus each user task with no attack.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from agentdojo.agent_pipeline.tool_execution import ToolsExecutionLoop
from agentdojo.models import ModelsEnum
from agentdojo.scripts.benchmark import benchmark_suite

import bonded_ap
from bonded_ap import family
from bonded_ap.bad_args import tolerate_bad_arguments
from bonded_ap.prompts import arena_system_prompt
from bonded_ap.pushed import push_channels
from bonded_ap.task_suite import task_suite

DEFAULT_ATTACKS = ("bonded_seed", "important_instructions")
AGENTDOJO_MAX_ITERS = 15


def openrouter_usage_usd(attempts: int = 6) -> float:
    """What this OpenRouter key has spent so far, in dollars (GET /api/v1/key).

    Many runs share one key and check it after every suite, so the endpoint can answer 429 or
    a server error; wait and ask again rather than end the run.
    """
    request = urllib.request.Request(
        "https://openrouter.ai/api/v1/key",
        headers={"Authorization": f"Bearer {os.environ['OPENROUTER_API_KEY']}"},
    )
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return float(json.load(response)["data"]["usage"])
        except urllib.error.HTTPError as error:
            if (error.code != 429 and error.code < 500) or attempt == attempts - 1:
                raise
        except urllib.error.URLError:
            if attempt == attempts - 1:
                raise
        time.sleep(2**attempt * 5)
    raise AssertionError("unreachable")


def cap_loop(max_iters: int) -> None:
    """Set the model turns per episode. AgentDojo's default is 15; a turn may call several tools."""
    original = ToolsExecutionLoop.__init__

    def init(self, elements, max_iters_arg: int = max_iters) -> None:
        original(self, elements, max_iters_arg)

    ToolsExecutionLoop.__init__ = init  # type: ignore[method-assign]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", required=True, help="OpenRouter model id, e.g. z-ai/glm-5.3-flash")
    parser.add_argument("--attacks", default=",".join(DEFAULT_ATTACKS), help="comma-separated AgentDojo attack names")
    parser.add_argument("--runs", type=int, default=1, help="how many times to run every pair")
    parser.add_argument("--only-run", type=int, default=0, help="run only this run number (for parallel runs)")
    parser.add_argument("--logdir", type=Path, default=Path("runs"))
    parser.add_argument("--user-tasks", default="", help="comma-separated user task ids (default: all)")
    parser.add_argument("--injection-tasks", default="", help="comma-separated injection task ids (default: all)")
    parser.add_argument("--no-plain", action="store_true", help="skip the runs with no attack")
    parser.add_argument(
        "--max-iters", type=int, default=AGENTDOJO_MAX_ITERS, help="model turns per episode (AgentDojo's default: 15)"
    )
    parser.add_argument(
        "--max-usd",
        type=float,
        default=2.0,
        help="stop starting new suites once the key has spent this much since start (all processes on the key)",
    )
    parser.add_argument(
        "--system-prompt",
        choices=("agentdojo", "arena"),
        default="agentdojo",
        help="AgentDojo's default system message, or the Arena payables agent's (logs go under arena-prompt/)",
    )
    parser.add_argument(
        "--push",
        action="store_true",
        help="deliver the side channels in the user's message, as the Arena's --push-channels all (logs under pushed/)",
    )
    parser.add_argument(
        "--family",
        default="",
        help="run the one-suite-per-seed family (bonded_ap/family.py): all, or comma-separated seed ids. "
        "Without it, the six-seed pilot suite runs",
    )
    parser.add_argument("--dry-run", action="store_true", help="print the plan and make no model calls")
    args = parser.parse_args()

    attacks = [a for a in args.attacks.split(",") if a]
    user_ids = tuple(u for u in args.user_tasks.split(",") if u)
    injection_ids = tuple(i for i in args.injection_tasks.split(",") if i)
    if args.family:
        seeds = family.portable_seeds() if args.family == "all" else [x for x in args.family.split(",") if x]
        suites = [family.build(seed) for seed in seeds]
        # The no-attack job runs once per world, in a suite with nothing planted, scored on the
        # world's whole approved queue (bonded_ap/family.py, build_plain).
        worlds = sorted({family.export()["seeds"][seed]["world"] for seed in seeds})
        plain = [] if args.no_plain else [family.build_plain(w) for w in worlds]
        suites = plain + suites
        plain_suites = {suite.name for suite in plain}
    else:
        suites = [task_suite]
        plain_suites = set() if args.no_plain else {task_suite.name}
    episodes_per_run = 0
    for suite in suites:
        users = len(user_ids) or len(suite.user_tasks)
        plain_only = suite.name in plain_suites and suite is not task_suite
        injections = 0 if plain_only else len(injection_ids) or len(suite.injection_tasks)
        # With any attack, AgentDojo also runs each injection task once as the user's own request,
        # to check its goal can be done: once per run, not once per attack.
        direct = injections if attacks else 0
        plain = 1 if suite.name in plain_suites else 0
        episodes_per_run += users * (plain + injections * len(attacks)) + direct
    episodes = (1 if args.only_run else args.runs) * episodes_per_run
    print(f"suites: {len(suites)} ({'family: ' + args.family if args.family else 'accounts_payable pilot'})")
    print(
        f"attacks: {', '.join(attacks)}; runs: {args.runs}; episodes: {episodes} (with direct-ask checks); "
        f"turns per episode: {args.max_iters}. Logs already in the log folder are reused, not run again."
    )
    system_message = arena_system_prompt() if args.system_prompt == "arena" else None
    print(f"system prompt: {args.system_prompt}; channels: {'pushed' if args.push else 'fetched'}")
    if args.dry_run:
        return 0
    if not os.environ.get("OPENROUTER_API_KEY"):
        print("OPENROUTER_API_KEY is not set", file=sys.stderr)
        return 1
    os.environ["OPENAI_COMPATIBLE_BASE_URL"] = "https://openrouter.ai/api/v1"
    os.environ["OPENAI_COMPATIBLE_API_KEY"] = os.environ["OPENROUTER_API_KEY"]
    cap_loop(args.max_iters)
    tolerate_bad_arguments()
    if args.push:
        push_channels()
    start = openrouter_usage_usd()

    def spent() -> float:
        return openrouter_usage_usd() - start

    for n in [args.only_run] if args.only_run else range(1, args.runs + 1):
        root = args.logdir / "arena-prompt" if system_message else args.logdir
        root = root / "pushed" if args.push else root
        root = root / "family" if args.family else root
        logdir = root / args.model.replace("/", "_") / f"iters-{args.max_iters}" / f"run-{n}"
        for suite in suites:
            # A suite runs with no attack (the pilot, or a plain world), or with the attacks (a seed).
            if suite.name in plain_suites:
                runs_for = [None] if suite is not task_suite else [None, *attacks]
            else:
                runs_for = list(attacks)
            for attack in runs_for:
                if spent() > args.max_usd:
                    print(f"stopping: spent ${spent():.2f}, over --max-usd {args.max_usd}", file=sys.stderr)
                    return 2
                benchmark_suite(
                    suite=suite,
                    model=ModelsEnum.OPENAI_COMPATIBLE,
                    logdir=logdir,
                    force_rerun=False,
                    benchmark_version=bonded_ap.BENCHMARK_VERSION,
                    user_tasks=user_ids,
                    injection_tasks=injection_ids if attack else (),
                    model_id=args.model,
                    attack=attack,
                    system_message=system_message,
                )
                print(f"run {n}, {suite.name}, attack {attack or 'none'}: spent so far ${spent():.4f}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
