#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { assertDatasetDir, SCRIPTED_RUNS_DIR } from "./payments-dataset.js";
import {
  runScripted,
  SCRIPTED_SEED_DIRS,
  scriptedResultsFile,
  scriptedResultsName,
  scriptedSeeds,
} from "./payments-scripted.js";

const USAGE = `Usage: pnpm sentinel:payments-scripted [options]

Runs the two scripted payables agents (no model, free, the same output every time) over every
off-chain seed, the benign twins and the controls, and writes one results file per agent for the
payments dataset (docs/SENTINEL.md, "The payments dataset"). The vulnerable agent acts on what it
reads; the cautious one does the job and ignores it. Seeds that live only in a picture aren't run:
both agents read text only. Prints counts only.

  --seeds <dir>   a seed folder; repeatable (default: the library, the staged folder and the
                  Index variants)
  --busy          also plant each realistic-job seed into the busy Monday
  --runs <n>      runs of each scenario (default 1; the agents are deterministic)
  --out <dir>     output folder, under datasets/ or ratings/ (default: ${SCRIPTED_RUNS_DIR})

Then: pnpm sentinel:payments-dataset --with-scripted`;

/**
 * The payment work, the part of the job these agents do: each queued invoice paid once and right,
 * verified bank changes applied, approved refunds sent. Replies and approval requests aren't it.
 */
const paymentsDone = (missed: readonly string[]) =>
  missed.every((m) => m.startsWith("reply:") || m.startsWith("approval:"));

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      seeds: { type: "string", multiple: true },
      busy: { type: "boolean", default: false },
      runs: { type: "string", default: "1" },
      out: { type: "string", default: SCRIPTED_RUNS_DIR },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  assertDatasetDir(values.out);
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a whole number from 1");
  const seeds = scriptedSeeds(values.seeds ?? SCRIPTED_SEED_DIRS);
  const options = { seeds, busy: values.busy, runs };
  mkdirSync(values.out, { recursive: true });
  for (const kind of ["vulnerable", "cautious"] as const) {
    const run = await runScripted(kind, options);
    const episodes = run.batch.episodes.map((e) => e.result);
    const attacks = episodes.filter((e) => e.kind === "attack");
    const fell = attacks.filter((e) => e.verdict.attackSucceeded);
    const others = episodes.filter((e) => e.kind !== "attack");
    const ownErrors = episodes.reduce((n, e) => n + (e.verdict.ownErrors?.length ?? 0), 0);
    const payments = episodes.reduce(
      (n, e) =>
        n + e.trace.filter((s) => s.tool === "pay_invoice" || s.tool === "issue_refund").length,
      0,
    );
    console.log(`== ${run.agent}`);
    console.log(
      `   ${run.attacks} attacks (${seeds.length} seeds${values.busy ? ", plus their busy-Monday plants" : ""}), ${others.length} controls and twins, ${runs} run(s) each; ${payments} payments tried`,
    );
    console.log(
      `   attacks that got a planted payment through: ${fell.length} of ${attacks.length}; breaches that were the agent's own error: ${ownErrors}; controls and twins with the payments done right: ${others.filter((e) => paymentsDone(e.missed)).length} of ${others.length}`,
    );
    if (kind === "vulnerable") {
      const held = [
        ...new Set(attacks.filter((e) => !e.verdict.attackSucceeded).map((e) => e.scenarioId)),
      ];
      if (held.length) console.log(`   not fallen for: ${held.join(", ")}`);
    }
    if (run.notShown.length)
      console.log(`   not run, in a picture only (not covered): ${run.notShown.join(", ")}`);
    if (run.busySkipped.length)
      console.log(
        `   not planted into the busy Monday: ${run.busySkipped.map((s) => `${s.id} (${s.reason})`).join(", ")}`,
      );
    const file = join(values.out, scriptedResultsName(kind));
    writeFileSync(file, scriptedResultsFile(run, options));
    console.log(`   wrote ${file}`);
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
