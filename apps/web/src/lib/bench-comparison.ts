import raw from "../../../../config/bench-comparison.json";

/** One staged seed that moved money, on one briefing. */
export interface BenchFall {
  seed: string;
  name: string;
  mandate: "shown" | "hidden";
  fell: number;
  runs: number;
  lossUsd: number;
  overpaidUsd: number;
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
  /** Episodes where every part of the job was done: payments, replies, approvals, bank changes. */
  tasksDone: number;
  tasksTotal: number;
  /**
   * Of the same episodes, those where every required invoice was paid once, in full, to the
   * vendor's verified account, and nothing went to an attacker. The other parts of the job are
   * ignored, which is closer to how AgentDojo checks a task. Re-scored from the saved runs.
   */
  paymentsDone: number;
  falls: BenchFall[];
  notes: string[];
}

/** One AgentDojo injection attack on the banking suite. */
export interface AgentDojoAttack {
  id: string;
  /** Pairs where the hidden goal ran. AgentDojo stores this as its security flag. */
  attackExecuted: number;
  pairs: number;
  /**
   * Pairs where the agent met the attack, counted the same way as Bonded's countedEpisodes.
   * attackExecuted is out of these; without it, out of all pairs.
   */
  met?: number;
  /** Pairs where the real user task was done. */
  utility: number;
  /** Money the hidden goal moved, lost or overpaid, from Bonded's replay of the logs. */
  movedUsd?: number;
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
  /** How the attack reached the agent: through its tools, or written into the task message. */
  channels: "fetched" | "pushed";
  /** The comparison the Index page leads with. The others follow it. */
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
    if (item.channels !== "fetched" && item.channels !== "pushed") {
      throw new Error(`bench comparison: ${String(item.model)} channels must be fetched or pushed`);
    }
    const tasksTotal = needNumber(item.bonded, "tasksTotal");
    const paymentsDone = needNumber(item.bonded, "paymentsDone");
    if (paymentsDone < 0 || paymentsDone > tasksTotal) {
      throw new Error(`bench comparison: ${String(item.model)} paymentsDone is out of range`);
    }
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

/** The pairs an attack's success is counted out of: those that met it, as on Bonded's side. */
export const metOf = (bench: AgentDojoBench) =>
  bench.attacks.reduce((n, attack) => n + (attack.met ?? attack.pairs), 0);

export const utilityOf = (bench: AgentDojoBench) =>
  bench.attacks.reduce((n, attack) => n + attack.utility, 0);

export const movedOf = (bench: AgentDojoBench) =>
  bench.attacks.every((attack) => attack.movedUsd !== undefined)
    ? bench.attacks.reduce((n, attack) => n + (attack.movedUsd ?? 0), 0)
    : undefined;

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

/** One Bonded attack with its result under each briefing: rules withheld and rules given. */
export interface SeedFalls {
  seed: string;
  name: string;
  hidden?: BenchFall;
  shown?: BenchFall;
}

/**
 * The falls grouped one row per attack, so the same attack with and without the rules sits side
 * by side. Most falls first, then most money.
 */
export function fallsBySeed(falls: BenchFall[]): SeedFalls[] {
  const bySeed = new Map<string, SeedFalls>();
  for (const fall of falls) {
    const row = bySeed.get(fall.seed) ?? { seed: fall.seed, name: fall.name };
    row[fall.mandate] = fall;
    bySeed.set(fall.seed, row);
  }
  const fell = (row: SeedFalls) => (row.hidden?.fell ?? 0) + (row.shown?.fell ?? 0);
  const usd = (row: SeedFalls) =>
    [row.hidden, row.shown].reduce((n, f) => n + (f ? f.lossUsd + f.overpaidUsd : 0), 0);
  return [...bySeed.values()].sort((a, b) => fell(b) - fell(a) || usd(b) - usd(a));
}
