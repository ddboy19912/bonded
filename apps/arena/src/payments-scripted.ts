import { existsSync } from "node:fs";
import { type ChatClient, OFFCHAIN_LIBRARY_VERSION } from "@bondedhq/shared";
import { SpendingCap } from "./budget.js";
import { type BatchResult, controlsFor, runOffchainBatch } from "./offchain/batch.js";
import { INDEX_VARIANTS_DIR } from "./offchain/index-sweep.js";
import {
  SCRIPTED_PAYABLES_NAMES,
  ScriptedCounterparty,
  type ScriptedPayablesKind,
  scriptedPayablesAgent,
} from "./offchain/scripted-payables.js";
import {
  loadOffchainSeeds,
  OFFCHAIN_SEEDS_DIR,
  OFFCHAIN_STAGED_SEEDS_DIR,
  type OffchainSeed,
  plantIntoBusyWorld,
} from "./offchain/seeds.js";
import type { MandateRow } from "./offchain/summary.js";

/**
 * The payments dataset's scripted source (docs/SENTINEL.md, "The payments dataset"): the two
 * scripted payables agents (scripted-payables.ts) on every off-chain seed, with the benign twins
 * and controls, judged by the ledger as any run is. No model is called and nothing is spent: the
 * O6 counterparty is scripted too. Each agent's episodes are written as an off-chain results
 * file, which the dataset build reads beside the Index traces.
 */

/** The seed folders the runs read: the library, the staged folder and the Index variants. */
export const SCRIPTED_SEED_DIRS: readonly string[] = [
  OFFCHAIN_SEEDS_DIR,
  OFFCHAIN_STAGED_SEEDS_DIR,
  INDEX_VARIANTS_DIR,
];

export interface ScriptedRunOptions {
  seeds: readonly OffchainSeed[];
  /**
   * Also plant each realistic-job seed into the busy Monday (`plantIntoBusyWorld`), as
   * `--world busy` does for a rating. The same attack in a busier inbox is a different input.
   */
  busy?: boolean;
  /** Runs of each scenario (default 1: a scripted agent does the same thing every time). */
  runs?: number;
  /**
   * Briefing rows (default shown only). Neither agent reads its briefing and a payment case doesn't
   * carry it, so a hidden row would only repeat the shown one.
   */
  rows?: readonly MandateRow[];
}

export interface ScriptedRun {
  kind: ScriptedPayablesKind;
  agent: string;
  /** The attacks run: the seeds, then their busy-Monday plants. */
  attacks: number;
  /** Seeds planted only in a picture: not run, because the agents read text only. */
  notShown: string[];
  /** Realistic-job seeds that couldn't be planted into the busy Monday, with why. */
  busySkipped: { id: string; reason: string }[];
  batch: BatchResult;
}

/** Every seed in the folders that exist, sorted by id. */
export function scriptedSeeds(dirs: readonly string[] = SCRIPTED_SEED_DIRS): OffchainSeed[] {
  return dirs
    .filter((dir) => existsSync(dir))
    .flatMap((dir) => loadOffchainSeeds(dir))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Whether any of the seeds is one waiting in the staged folder. */
export function includesStaged(seeds: readonly OffchainSeed[]): boolean {
  if (!existsSync(OFFCHAIN_STAGED_SEEDS_DIR)) return false;
  const staged = new Set(loadOffchainSeeds(OFFCHAIN_STAGED_SEEDS_DIR).map((s) => s.id));
  return seeds.some((s) => staged.has(s.id));
}

/** Runs one scripted agent over the seeds, their twins and the controls. */
export async function runScripted(
  kind: ScriptedPayablesKind,
  options: ScriptedRunOptions,
): Promise<ScriptedRun> {
  const busy = options.busy ? plantIntoBusyWorld(options.seeds) : { seeds: [], skipped: [] };
  const attackSeeds = [...options.seeds, ...busy.seeds];
  const batch = await runOffchainBatch({
    agent: () => scriptedPayablesAgent(kind),
    // Text only: a seed that lives only in a picture is listed as not shown, not run.
    seesImages: false,
    images: false,
    attackSeeds,
    // A staged-folder seed brings the twins of the staged channel attacks (PENDING_TWINS).
    controls: controlsFor(options.seeds, undefined, { staged: includesStaged(options.seeds) }),
    attribution: "planted",
    rows: options.rows ?? ["shown"],
    runs: options.runs ?? 1,
    // One at a time, so the episodes come out in the same order every run.
    parallel: 1,
    cap: new SpendingCap({ maxUsd: 1 }),
    client: {} as ChatClient,
    counterpartyModel: "scripted",
    counterparty: (seed) => new ScriptedCounterparty(seed),
  });
  return {
    kind,
    agent: SCRIPTED_PAYABLES_NAMES[kind],
    attacks: attackSeeds.length,
    notShown: [...new Set(batch.notShown)],
    busySkipped: options.busy
      ? busy.skipped.filter((s) => options.seeds.find((x) => x.id === s.id)?.world === "v2")
      : [],
    batch,
  };
}

/**
 * A run as an off-chain results file (`summary` and `results`, as `offchain` writes them), with
 * `origin: "scripted"` so the dataset build can tell these cases from a model's.
 */
export function scriptedResultsFile(run: ScriptedRun, options: ScriptedRunOptions): string {
  const summary = {
    agent: run.agent,
    origin: "scripted",
    libraryVersion: OFFCHAIN_LIBRARY_VERSION,
    attribution: "planted",
    vision: false,
    images: false,
    busy: Boolean(options.busy),
    runs: options.runs ?? 1,
    attacks: run.attacks,
    notShown: run.notShown,
    busySkipped: run.busySkipped,
    ...run.batch.summary,
  };
  const results = run.batch.episodes.map((e) => ({ mandate: e.mandate, ...e.result }));
  return `${JSON.stringify({ summary, results }, null, 2)}\n`;
}

/** The results file's name for an agent. */
export const scriptedResultsName = (kind: ScriptedPayablesKind) => `scripted-${kind}.json`;
