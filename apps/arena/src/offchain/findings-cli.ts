#!/usr/bin/env node
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readAdaptiveResults, writeFinding } from "./findings.js";
import { assertPrivateDir } from "./held-out.js";
import { loadOffchainSeeds, OFFCHAIN_STAGED_SEEDS_DIR } from "./seeds.js";

const USAGE = `Usage: pnpm --filter @bonded/arena offchain-findings --results <dir> [options]

Turns saved adaptive results into a finding, a disclosure note and, when a rewrite got through, a
bounty candidate seed. It reads the results an adaptive run already wrote, so it spends nothing.
The finding holds numbers only. The note holds the class and vector result, never the payload.
The candidate holds the rewrite, so it is written to a private directory: ratings/ or outside the
repo. A person reviews the note and sends it; this tool never contacts anyone.

  --results <dir>  the adaptive results to read (required), e.g. ratings/offchain-adaptive-payables
  --out <dir>      where to write the artifacts (default: ratings/offchain-findings)
  --staged         load apps/arena/offchain-seeds-staged, for results from a staged run`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      results: { type: "string" },
      out: { type: "string" },
      staged: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || !values.results) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  const seeds = loadOffchainSeeds(values.staged ? OFFCHAIN_STAGED_SEEDS_DIR : undefined);
  const byId = new Map(seeds.map((seed) => [seed.id, seed]));
  const saved = readAdaptiveResults(values.results);
  if (saved.length === 0) throw new Error(`no adaptive results in ${values.results}`);

  const out = values.out ?? join("ratings", "offchain-findings");
  assertPrivateDir(out, "a finding");

  let candidates = 0;
  for (const { result, ratedAt } of saved) {
    const seed = byId.get(result.seed);
    if (!seed) {
      throw new Error(
        `no seed ${result.seed} in ${values.staged ? "the staged set" : "the library"}; ` +
          "pass --staged if the run used staged seeds",
      );
    }
    const artifacts = writeFinding(out, seed, result, ratedAt);
    if (artifacts.candidate) candidates++;
    const outcome = artifacts.finding.breached
      ? artifacts.finding.roundsToBreach === 0
        ? "breached by the published text"
        : `breached in round ${artifacts.finding.roundsToBreach}`
      : "held";
    console.log(
      `${seed.id.padEnd(32)} ${outcome.padEnd(32)} ` +
        `${artifacts.candidate ? `candidate ${artifacts.candidate.id}` : ""}`,
    );
  }
  console.log(
    `\n${saved.length} finding${saved.length === 1 ? "" : "s"}, ${candidates} bounty ` +
      `candidate${candidates === 1 ? "" : "s"}. Artifacts in ${out}.`,
  );
  console.log(
    "Review each disclosure note, copy it to docs/disclosures/ if it is going public, and send it " +
      "privately through the project's security policy. The candidate is private: do not commit it.",
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
