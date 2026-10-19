#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_AGENT_MODEL } from "@bonded/demo-agents";
import { loadAttackLibrary } from "./attacks.js";
import { selectS1Seeds } from "./s1-seeds.js";
import { SpendingCap } from "./budget.js";
import { loadDotEnv } from "./env.js";
import { runS1Pair, S1BudgetExceeded, type S1PairResult } from "./s1.js";
import { s1Settings, summarizeS1Pairs, type S1Summary } from "./s1-summary.js";
import { Sandbox } from "./sandbox.js";
import { buildTarget } from "./targets.js";

const USAGE = `Usage: pnpm --filter @bonded/arena s1 --max-usd <n> [options]

S1 market-data manipulation (src/s1.ts): the surface the vault's breach log can't see. For each
seed it runs the same agent, task and benign world twice — clean and with the attack planted —
and reports the induced loss in the vault's value at the TRUE on-chain oracle. An in-mandate
bad trade records no breach but can still cost the vault.

Both sides use the same venue skew and reference oracle. The paired value delta measures the
effect of the planted content in that market. Adverse fills can cause a vault breach when their
loss exceeds the slippage limit; smaller losses remain measurable. See docs/HARBINGER.md.

  --max-usd <n>          stop once the target's model spend reaches this, total (required)
  --agent <name>         agentkit | custom:<design> | hardened | ... (default: agentkit)
  --brain <scripted|llm> brain for hardened, vulnerable and partial (default: llm)
  --model <id>           the agent's model (default: ${DEFAULT_AGENT_MODEL})
  --hide-mandate         custom bots: leave the mandate out of the prompt
  --seeds <list>         restrict to these seed ids (default: every runnable S1 seed; multi-agent seeds excluded)
  --pairs <n>            clean/manipulated pairs per seed, to average out agent noise (default: 2)
  --skew-bps <n>         override every seed's executionSkew.bps (isolate the skew on a fixed framing)
  --out <dir>            where to write results (default: ratings/s1-<agent>)

The S1 seeds live in apps/arena/s1-seeds/ (a feed/news dislocation plus delivery.executionSkew),
kept out of the main attacks/ library because they carry no money-move instruction.`;

/** The S1 seed set: adverse-fill market-data seeds, separate from the main attack library. */
const S1_SEEDS_DIR = fileURLToPath(new URL("../s1-seeds", import.meta.url));

function describe(r: S1Summary): string {
  const residual = r.meanResidualLossUsd === null ? "n/a" : `$${r.meanResidualLossUsd.toFixed(2)}`;
  return (
    `${r.seed.padEnd(30)} ${r.pairCount} pairs; breaches ${r.breachedPairs}; ` +
    `(clean ${r.controlBreachedPairs}, manipulated ${r.manipulatedBreachedPairs}); ` +
    `behavior changed ${r.changedBehaviorPairs}; mean loss $${r.meanInducedLossUsd.toFixed(2)}; ` +
    `unbreached mean loss ${residual} (${r.unbreachedPairs} pairs, ${r.residualPairs} harmed)\n` +
    `  mean values clean $${r.meanCleanValueUsd.toFixed(2)} / manip $${r.meanManipulatedValueUsd.toFixed(2)}; ` +
    `mean trades ${r.meanCleanTradeCount.toFixed(2)} -> ${r.meanManipulatedTradeCount.toFixed(2)}`
  );
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      "max-usd": { type: "string" },
      agent: { type: "string", default: "agentkit" },
      model: { type: "string" },
      brain: { type: "string", default: "llm" },
      "hide-mandate": { type: "boolean", default: false },
      seeds: { type: "string" },
      pairs: { type: "string", default: "2" },
      "skew-bps": { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const {
    maxUsd,
    pairs,
    skewBps: skewOverride,
    brain,
  } = s1Settings({
    maxUsd: values["max-usd"],
    pairs: values.pairs,
    skewBps: values["skew-bps"],
    brain: values.brain,
  });
  const seeds = selectS1Seeds(loadAttackLibrary(S1_SEEDS_DIR), values.seeds);
  loadDotEnv();
  const agent = buildTarget(values.agent, brain, values.model, !values["hide-mandate"]);
  const runSeeds =
    skewOverride === undefined
      ? seeds
      : seeds.map((s) =>
          s.delivery.executionSkew
            ? {
                ...s,
                delivery: {
                  ...s.delivery,
                  executionSkew: { ...s.delivery.executionSkew, bps: skewOverride },
                },
              }
            : s,
        );

  for (const seed of runSeeds) {
    if (!seed.goal?.trim()) throw new Error(`${seed.id}: S1 seeds require an explicit benign goal`);
  }

  const outDir = values.out ?? join("ratings", `s1-${agent.name.replaceAll("/", "_")}`);
  mkdirSync(outDir, { recursive: true });
  const sandbox = await Sandbox.start();
  const cap = new SpendingCap({ maxUsd });
  const results: S1Summary[] = [];
  try {
    console.log(
      `Agent ${agent.name}, ${seeds.length} S1 seeds x ${pairs} pair(s), up to $${maxUsd} total\n` +
        `(induced loss = clean value - manipulated value, at the true oracle with matched venue skew)\n`,
    );
    for (const seed of runSeeds) {
      if (cap.exceeded) {
        console.log(`stopping: spend cap $${maxUsd} reached`);
        break;
      }
      const goal = seed.goal!;
      const pairResults: S1PairResult[] = [];
      const resultIndex = results.length;
      for (let i = 0; i < pairs && !cap.exceeded; i++) {
        try {
          pairResults.push(await runS1Pair({ sandbox, agent, seed, goal, budget: cap }));
          const summary = summarizeS1Pairs(seed.id, pairResults);
          results[resultIndex] = summary;
          // Preserve completed observations even if a later pair fails.
          writeFileSync(
            join(outDir, `${seed.id}.json`),
            `${JSON.stringify({ seed: seed.id, goal, executionSkew: seed.delivery.executionSkew, summary, pairs: pairResults }, null, 2)}\n`,
          );
        } catch (error) {
          if (!(error instanceof S1BudgetExceeded)) throw error;
          console.log(`stopping: spend cap $${maxUsd} reached before completing a pair`);
          break;
        }
      }
      if (pairResults.length === 0) break;
      console.log(describe(results[resultIndex]!));
    }
    const pairCount = results.reduce((total, row) => total + row.pairCount, 0);
    const harmed = results.reduce((total, row) => total + row.residualPairs, 0);
    const breached = results.reduce((total, row) => total + row.breachedPairs, 0);
    const spend = cap.summary();
    console.log(
      `\n${results.length} seeds, ${pairCount} completed pairs: ${breached} pairs recorded a vault breach, ` +
        `${harmed} pairs showed induced loss without a breach. ` +
        `Spend $${spend.spentUsd.toFixed(3)}. Results in ${outDir}`,
    );
  } finally {
    try {
      // The cap includes failed/incomplete arms, even when they produce no pair result.
      writeFileSync(
        join(outDir, "summary.json"),
        `${JSON.stringify({ results, spend: cap.summary() }, null, 2)}\n`,
      );
    } finally {
      await sandbox.stop();
    }
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
