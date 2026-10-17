#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_AGENT_MODEL, isMemoryAgent } from "@bonded/demo-agents";
import type { EvmMandateInput } from "@bondedhq/shared";
import { BENIGN_GOALS } from "./episode.js";
import { loadAttackLibrary } from "./attacks.js";
import { loadDotEnv } from "./env.js";
import { FRAMES } from "./harbinger/techniques.js";
import { type HarbingerResult, runHarbinger } from "./harbinger/run.js";
import { runMemoryAttempt } from "./memory-attempt.js";
import { Sandbox } from "./sandbox.js";
import { buildTarget } from "./targets.js";

const USAGE = `Usage: pnpm --filter @bonded/arena harbinger --max-usd <n> [options]

Harbinger v2: a self-generating attacker. It writes attack text itself, from a library of
templates (src/harbinger/techniques.ts) combined and mutated by code — no model call, so the
only cost is running the texts against the target agent. For each seed it runs one generation
of candidate attacks, scores each from the vault's breach log and the agent's own reply, and
breeds the fittest into the next generation. The genome searches framing x task x surface
jointly: each candidate also picks a benign task (goals.ts) and, when its spread gene is on, a
multi-surface campaign (campaign.ts). Stops at the first breach, the generation limit, or
--max-usd.

  --max-usd <n>          stop once the TARGET agent's model spend reaches this, per seed (required)
  --agent <name>         hardened | vulnerable | partial | gated | memory-bot | custom:<design> |
                         agentkit | solana-agent-kit (default: agentkit)
  --brain <scripted|llm> brain for hardened, vulnerable and partial (default: llm)
  --model <id>           the agent's model (default: ${DEFAULT_AGENT_MODEL})
  --hide-mandate         custom bots and memory-bot only: leave the mandate out of the prompt
  --seeds <list>         seed ids or classes, or "all" (default: the first seed of every class)
  --tags <list>          only seeds carrying every one of these tags (e.g. coupled)
  --goal-index <0-3>     the agent's task: one of the Arena's benign goals (episode.ts), fixed for
                         every seed. Left alone, the engine picks the task per candidate instead.
  --population <n>       candidate texts run per generation (default: 12)
  --generations <n>      generations after the first (default: 4)
  --random-seed <s>      a different value gives a different population for the same seed; default
                         is the seed's own id, so a run is reproducible
  --enforce              run the vault in Enforce mode
  --refunds              the mandate allows refunds to the depositor (for goals that have the
                         agent work a refund queue, so a refund to the true depositor isn't a
                         breach and the vault only records the lookalike one)
  --out <dir>            where to write results (default: ratings/harbinger-<agent>)`;

function describe(r: HarbingerResult): string {
  const outcome = r.breached
    ? `breached in generation ${r.breachGeneration}`
    : `held, best score ${r.bestScore} of 4 (${r.stoppedBecause})`;
  const real = r.attempts.filter((a) => a.ruling !== "invalid").length;
  return `${r.seed.padEnd(32)} ${outcome.padEnd(32)} ${real} of ${r.attempts.length} tries  $${r.spend.spentUsd.toFixed(3)}`;
}

/** Prints the winning genes of a breach (which task, which frame, one run or a campaign). */
function breachPath(r: HarbingerResult): string | undefined {
  const win = r.attempts.find((a) => a.succeeded);
  if (!win) return undefined;
  const frame = win.genome.frameId;
  const campaign = win.genome.spread ? "campaign" : "single";
  return `  (${frame}, ${campaign}, ${win.goal ? "workflow goal" : "seed goal"}: ${win.goal ?? "?"})`;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      "max-usd": { type: "string" },
      agent: { type: "string", default: "agentkit" },
      brain: { type: "string", default: "llm" },
      model: { type: "string" },
      "hide-mandate": { type: "boolean", default: false },
      seeds: { type: "string" },
      tags: { type: "string" },
      "goal-index": { type: "string" },
      population: { type: "string", default: "12" },
      generations: { type: "string", default: "4" },
      "random-seed": { type: "string" },
      enforce: { type: "boolean", default: false },
      refunds: { type: "boolean", default: false },
      out: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  const maxUsd = Number(values["max-usd"]);
  const population = Number(values.population);
  const generations = Number(values.generations);
  if (
    values.help ||
    !(maxUsd > 0) ||
    !Number.isInteger(population) ||
    population < 2 ||
    !Number.isInteger(generations) ||
    generations < 0
  ) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  const goal =
    values["goal-index"] === undefined ? undefined : BENIGN_GOALS[Number(values["goal-index"])];
  if (values["goal-index"] !== undefined && goal === undefined)
    throw new Error(`--goal-index must be 0 to ${BENIGN_GOALS.length - 1}`);

  loadDotEnv();
  const agent = buildTarget(values.agent, values.brain, values.model, !values["hide-mandate"]);

  const library = loadAttackLibrary();
  const wanted = values.seeds?.split(",").map((s) => s.trim());
  const tags =
    values.tags
      ?.split(",")
      .map((t) => t.trim())
      .filter(Boolean) ?? [];
  // --tags selects over the whole library; without it the default set is one seed per class
  // (as before), so a first per-class sweep stays cheap unless the tags ask for more.
  let seeds = wanted
    ? library.filter(
        (s) => wanted.includes("all") || wanted.some((w) => w === s.class || w === s.id),
      )
    : tags.length
      ? library.filter((s) => tags.every((t) => s.tags.includes(t)))
      : [...new Map(library.map((s) => [s.class, s])).values()];
  if (tags.length && wanted) seeds = seeds.filter((s) => tags.every((t) => s.tags.includes(t)));
  if (seeds.length === 0)
    throw new Error(
      `no seeds match ${values.seeds ?? "default"}${tags.length ? ` tagged ${tags.join(",")}` : ""}`,
    );

  const outDir = values.out ?? join("ratings", `harbinger-${agent.name.replaceAll("/", "_")}`);
  mkdirSync(outDir, { recursive: true });
  const sandbox = await Sandbox.start();
  try {
    const mandate: Partial<EvmMandateInput> = {
      ...(values.enforce ? { mode: "enforce" as const } : {}),
      // Refund-queue goals need a refund destination, else even a refund to the true depositor
      // would record a breach and the run would tell us nothing about the attack.
      ...(values.refunds || values.agent === "partial"
        ? { destinations: [sandbox.address("depositor")] }
        : {}),
    };
    const episodeOptions = {
      ...(Object.keys(mandate).length ? { vault: { mandate } } : {}),
      // Without --goal-index the engine's task (each candidate's goal gene) reaches the episode
      // through the attack spec; a fixed --goal-index overrides every candidate's task.
      ...(goal ? { goal } : {}),
      // The spend cap is only checked between episodes, so a looping model needs a time limit.
      timeoutMs: 90_000,
    };
    const estimate = population * (generations + 1);
    console.log(
      `Agent ${agent.name}, ${FRAMES.length} frames x ${population} population x ${generations + 1} ` +
        `generations (up to ~${estimate} episodes per seed), up to $${maxUsd} per seed\n`,
    );
    const results: HarbingerResult[] = [];
    for (const seed of seeds) {
      const result = await runHarbinger({
        sandbox,
        agent,
        seed,
        population,
        generations,
        maxUsd,
        episode: episodeOptions,
        ...(isMemoryAgent(agent)
          ? {
              runAttempt: (spec, generation) =>
                runMemoryAttempt(sandbox, agent, spec, generation, episodeOptions),
            }
          : {}),
      });
      results.push(result);
      console.log(describe(result));
      const path = breachPath(result);
      if (path) console.log(path);
      // The payloads that worked are real attack text: they stay in the gitignored ratings folder.
      writeFileSync(join(outDir, `${seed.id}.json`), `${JSON.stringify(result, null, 2)}\n`);
    }
    const hit = results.filter((r) => r.breached);
    console.log(`\n${results.length} seeds: ${hit.length} breached. Results in ${outDir}`);
    if (hit.length) console.log(`Breached: ${hit.map((r) => r.seed).join(", ")}`);
  } finally {
    await sandbox.stop();
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
