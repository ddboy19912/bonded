import raw from "../../../../config/bench-comparison.json";

/** One staged seed that moved money, on one briefing. */
export interface BenchFall {
  seed: string;
  name: string;
  mandate: "shown" | "hidden";
  fell: number;
  runs: number;
  lossUsd: number;
}

/** Bonded's own bench: staged payment attacks, judged by the ledger. */
export interface BondedBench {
  bench: "Bonded";
  suite: string;
  ranOn: string;
  conditions: string[];
  /** Attack episodes the agent actually met. Episodes that never opened the plant are notMet. */
  countedEpisodes: number;
  fell: number;
  notMet: number;
  lossUsd: number;
  overpaidUsd: number;
  tasksDone: number;
  tasksTotal: number;
  spendUsd: number;
  spendEstimated: boolean;
  falls: BenchFall[];
  notes: string[];
}

/** One AgentDojo injection attack on the banking suite. */
export interface AgentDojoAttack {
  id: string;
  /** Pairs where the hidden goal ran. AgentDojo stores this as its security flag. */
  attackExecuted: number;
  pairs: number;
  /** Pairs where the real user task was done. */
  utility: number;
  /** The injection goal posed as the user's own request. */
  directAskDone: number;
  directAskTotal: number;
}

export interface AgentDojoBench {
  bench: "AgentDojo";
  suite: string;
  packageVersion: string;
  ranOn: string;
  attacks: AgentDojoAttack[];
  notes: string[];
}

export interface BenchComparison {
  model: string;
  label: string;
  /** The comparison the Index page leads with. The others stay in the record. */
  headline: boolean;
  scope?: string;
  bonded: BondedBench;
  agentdojo: AgentDojoBench;
}

export interface BenchComparisonFile {
  recordedOn: string;
  disclaimer: string;
  comparisons: BenchComparison[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function needNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`bench comparison: ${key} must be a number`);
  }
  return value;
}

/**
 * The campaign record (config/bench-comparison.json). Checked at load so a missing total
 * fails loudly instead of drawing a blank comparison.
 */
export function loadBenchComparison(data: unknown = raw): BenchComparisonFile {
  if (!isRecord(data) || !Array.isArray(data.comparisons) || data.comparisons.length === 0) {
    throw new Error("bench comparison: no comparisons");
  }
  const comparisons = data.comparisons.map((item) => {
    if (!isRecord(item) || !isRecord(item.bonded) || !isRecord(item.agentdojo)) {
      throw new Error("bench comparison: a row is missing a bench");
    }
    needNumber(item.bonded, "fell");
    needNumber(item.bonded, "countedEpisodes");
    if (!Array.isArray(item.agentdojo.attacks) || item.agentdojo.attacks.length === 0) {
      throw new Error(`bench comparison: ${String(item.model)} has no AgentDojo attacks`);
    }
    return item as unknown as BenchComparison;
  });
  const headline = comparisons.filter((row) => row.headline);
  if (headline.length !== 1) throw new Error("bench comparison: expected one headline row");
  return {
    recordedOn: String(data.recordedOn),
    disclaimer: String(data.disclaimer),
    comparisons,
  };
}

export const attackExecuted = (bench: AgentDojoBench) =>
  bench.attacks.reduce((n, attack) => n + attack.attackExecuted, 0);

export const pairsOf = (bench: AgentDojoBench) =>
  bench.attacks.reduce((n, attack) => n + attack.pairs, 0);

export const utilityOf = (bench: AgentDojoBench) =>
  bench.attacks.reduce((n, attack) => n + attack.utility, 0);

export const directAskOf = (bench: AgentDojoBench) =>
  bench.attacks.reduce(
    (sum, attack) => ({
      done: sum.done + attack.directAskDone,
      total: sum.total + attack.directAskTotal,
    }),
    { done: 0, total: 0 },
  );

export const money = (usd: number) =>
  `$${usd.toLocaleString("en-US", { minimumFractionDigits: usd % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
