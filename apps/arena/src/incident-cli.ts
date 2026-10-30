#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ATTACKS_DIR, loadAttackLibrary } from "./attacks.js";
import {
  ATTACKS_STAGED_INCIDENTS_DIR,
  attackSpecFromBlock,
  type SentinelBlock,
  writeIncidentAttack,
} from "./incident.js";
import {
  blocksFromEpisode,
  INCIDENT_SEEDS_DIR,
  type OffchainBlock,
  seedFromBlock,
  writeIncidentSeed,
} from "./offchain/incident.js";
import type { OffchainEpisodeResult } from "./offchain/episode.js";
import {
  loadOffchainSeeds,
  OFFCHAIN_SEEDS_DIR,
  OFFCHAIN_STAGED_SEEDS_DIR,
  type OffchainSeed,
} from "./offchain/seeds.js";

const USAGE = `Usage: pnpm --filter @bonded/arena incident-seed -- (--results <file> | --block <file>) [options]

Turns runtime blocks into candidate attack seeds, so live incidents feed the library
(docs/OFFCHAIN.md, "Blocks become seeds"; docs/SENTINEL.md, "Blocks become attacks"). Plain code,
no model. A candidate is a finding, not a score: it goes to a staged folder no rating reads.

  --results <file>   an off-chain results.json from a run with --enforce: every payment the
                     ledger blocked becomes a candidate
  --block <file>     a saved block, or a list of them, as JSON: a ledger block (source "ledger",
                     as blocksFromEpisode writes it) or a Sentinel check that blocked (the check's
                     mandate, proposedAction and untrustedInputs, plus Sentinel's verdict)
  --world <v1|v2|v3> the job a --results run used (default: each seed's own; v3 after --world busy)
  --out <dir>        where to write (default: apps/arena/offchain-seeds-staged/incidents/ for the
                     ledger, attacks-staged/incidents/ for Sentinel). Never the rated library
  --dry-run          print what would be written, write nothing`;

/** The job a scenario's seed runs in, from the library and staged seeds; v2 when unknown. */
function worldOf(scenarioId: string, seeds: readonly OffchainSeed[]): OffchainBlock["world"] {
  const base = scenarioId.match(/^(O[1-6]-[a-z0-9-]+?-\d{3})/)?.[1];
  return seeds.find((s) => s.id === scenarioId || s.id === base)?.world ?? "v2";
}

const inside = (dir: string, parent: string) => {
  const rel = relative(resolve(parent), resolve(dir));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
};

function main() {
  const { values } = parseArgs({
    options: {
      results: { type: "string" },
      block: { type: "string" },
      world: { type: "string" },
      out: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || (values.results === undefined) === (values.block === undefined)) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }
  if (values.world !== undefined && !["v1", "v2", "v3"].includes(values.world))
    throw new Error("--world must be v1, v2 or v3");
  if (values.out && (inside(values.out, OFFCHAIN_SEEDS_DIR) || inside(values.out, ATTACKS_DIR))) {
    throw new Error("--out is the rated library; candidates go to a staged folder");
  }
  const offchainSeeds = [
    ...loadOffchainSeeds(),
    ...loadOffchainSeeds(OFFCHAIN_STAGED_SEEDS_DIR),
    // Candidates already saved count as known, so a block isn't saved twice.
    ...(existsSync(INCIDENT_SEEDS_DIR) ? loadOffchainSeeds(INCIDENT_SEEDS_DIR) : []),
  ];

  const ledgerBlocks: OffchainBlock[] = [];
  const sentinelBlocks: SentinelBlock[] = [];
  if (values.results) {
    const file = JSON.parse(readFileSync(values.results, "utf8")) as {
      results?: OffchainEpisodeResult[];
    };
    if (!Array.isArray(file.results)) throw new Error(`${values.results} has no results`);
    for (const result of file.results) {
      const world =
        (values.world as OffchainBlock["world"] | undefined) ??
        worldOf(result.scenarioId, offchainSeeds);
      ledgerBlocks.push(...blocksFromEpisode(result, world));
    }
    console.log(
      `${ledgerBlocks.length} blocked attempt${ledgerBlocks.length === 1 ? "" : "s"} in ` +
        `${file.results.length} episodes` +
        (ledgerBlocks.length === 0 ? " (was the run made with --enforce?)" : ""),
    );
  } else {
    const parsed: unknown = JSON.parse(readFileSync(values.block!, "utf8"));
    for (const raw of Array.isArray(parsed) ? parsed : [parsed]) {
      const block = raw as Record<string, unknown>;
      if (block.source === "ledger") ledgerBlocks.push(raw as OffchainBlock);
      else if (block.proposedAction && Array.isArray(block.untrustedInputs))
        sentinelBlocks.push({ ...(raw as SentinelBlock), source: "sentinel" });
      else throw new Error("a block is a ledger block (source: ledger) or a Sentinel check");
    }
  }

  let written = 0;
  const done = new Set<string>();
  for (const block of ledgerBlocks) {
    const result = seedFromBlock(block, offchainSeeds);
    const label = `${block.scenarioId ?? "block"} (${block.action.tool})`;
    if (!result.ok) {
      console.log(`${label}: not kept, ${result.reason}`);
      continue;
    }
    if (done.has(result.seed.id)) continue;
    done.add(result.seed.id);
    const dir = values.out ?? INCIDENT_SEEDS_DIR;
    console.log(
      values["dry-run"]
        ? `${label}: would write ${result.seed.id} (${result.seed.class}, aims at ${result.seed.aimedAt.join(", ")})`
        : `${label}: wrote ${writeIncidentSeed(dir, result.seed, block)}`,
    );
    written++;
  }
  const library = sentinelBlocks.length > 0 ? loadAttackLibrary() : [];
  for (const block of sentinelBlocks) {
    const result = attackSpecFromBlock(block, library);
    const label = `Sentinel block (${block.proposedAction.tool})`;
    if (!result.ok) {
      console.log(`${label}: not kept, ${result.reason}`);
      continue;
    }
    if (done.has(result.spec.id)) continue;
    done.add(result.spec.id);
    const dir = values.out ?? ATTACKS_STAGED_INCIDENTS_DIR;
    console.log(
      values["dry-run"]
        ? `${label}: would write ${result.spec.id} (${result.spec.class}, ${result.spec.surfaces.join(", ")})`
        : `${label}: wrote ${writeIncidentAttack(dir, result)}`,
    );
    written++;
  }
  console.log(
    `${written} candidate${written === 1 ? "" : "s"}${values["dry-run"] ? " (dry run, nothing written)" : ""}. ` +
      "Findings, not scores: a person reviews each before a release moves it into the library.",
  );
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
