/**
 * What a run will cost before it starts, from per-episode costs measured on earlier runs. Printed
 * by the runners, so a budget is set from evidence rather than a guess. An estimate, not a cap:
 * `--max-usd` still stops the run.
 */

export interface MeasuredCost {
  /** Mean cost of one episode of the first job (the approved-queue payment run). */
  firstJobUsd: number;
  /** Mean cost of one episode of the realistic job, when measured. */
  realisticJobUsd?: number;
  source: string;
}

/**
 * Measured costs, by model id. First-job costs are the Index's (Oct 26 and 27). Realistic-job
 * costs are from the staged runs of Oct 27 and 28. The Meta API reports no cost, so Muse's figures
 * are estimated from token counts.
 */
export const MEASURED_COSTS: Record<string, MeasuredCost> = {
  "muse-spark-1.3": {
    firstJobUsd: 0.039,
    realisticJobUsd: 0.095,
    source: "Index Oct 26; staged run Oct 28 (estimated: the Meta API reports no cost)",
  },
  "muse-spark-1.2": { firstJobUsd: 0.0512, source: "Index Oct 27 (estimated)" },
  "muse-spark-1.1": { firstJobUsd: 0.0384, source: "Index Oct 27 (estimated)" },
  "meta-llama/llama-4-maverick": {
    firstJobUsd: 0.0033,
    realisticJobUsd: 0.0142,
    source: "Index Oct 27; staged run Oct 28",
  },
  "deepseek/deepseek-v4.1-flash": {
    firstJobUsd: 0.002,
    realisticJobUsd: 0.0037,
    source: "Index Oct 26; staged run Oct 27",
  },
  "z-ai/glm-5.3": { firstJobUsd: 0.0021, source: "Index Oct 26" },
  "z-ai/glm-5.3-flash": {
    firstJobUsd: 0.0012,
    realisticJobUsd: 0.0018,
    source: "Index Oct 26; staged run Oct 27",
  },
  "qwen/qwen3.7-flash": { firstJobUsd: 0.00025, source: "Index Oct 26" },
  "meta-models/muse-spark-open": {
    firstJobUsd: 0.041,
    source: "smoke run Oct 30, 3 episodes with images (estimated at Baseten's list price)",
  },
  "claude-haiku-5-5": {
    firstJobUsd: 0.0016,
    source: "smoke run Oct 29, 3 episodes (Anthropic's token counts, priced exactly)",
  },
};

/**
 * How much more a realistic-job episode costs than a first-job one, when a model has no
 * realistic-job measurement. The measured models range from 1.5 to 4.3 times; 2.5 is their middle.
 */
export const REALISTIC_JOB_FACTOR = 2.5;

/** One kind of episode a run plans: how many, and whether it is the realistic job. */
export interface PlannedEpisodes {
  count: number;
  realistic: boolean;
  /** Tool calls the episode allows, when above the realistic job's 50: it costs proportionally more. */
  maxSteps?: number;
}

export interface CostEstimate {
  /** Null when the model has no measured cost. */
  usd: number | null;
  episodes: number;
  /** Episodes the cap pays for at this rate (all of them when it covers the estimate). */
  withinCap: number | null;
  note: string;
}

const perEpisode = (cost: MeasuredCost, plan: PlannedEpisodes) => {
  if (!plan.realistic) return cost.firstJobUsd;
  const base = cost.realisticJobUsd ?? cost.firstJobUsd * REALISTIC_JOB_FACTOR;
  return base * Math.max(1, (plan.maxSteps ?? 50) / 50);
};

/** The estimate for running `plans` on `model`, under a cap of `maxUsd`. */
export function estimateCost(
  model: string,
  plans: readonly PlannedEpisodes[],
  maxUsd: number,
  extraUsd = 0,
): CostEstimate {
  const episodes = plans.reduce((n, p) => n + p.count, 0);
  const cost = MEASURED_COSTS[model];
  if (!cost) {
    return {
      usd: null,
      episodes,
      withinCap: null,
      note: `no measured cost for ${model}; the cap of $${maxUsd} still applies`,
    };
  }
  const usd = plans.reduce((sum, p) => sum + p.count * perEpisode(cost, p), 0) + extraUsd;
  const mean = episodes === 0 ? 0 : (usd - extraUsd) / episodes;
  const withinCap =
    usd <= maxUsd || mean === 0 ? episodes : Math.max(0, Math.floor((maxUsd - extraUsd) / mean));
  const guessed = plans.some((p) => p.realistic && cost.realisticJobUsd === undefined);
  return {
    usd,
    episodes,
    withinCap,
    note:
      `${cost.source}` +
      (guessed ? `; realistic-job cost assumed ${REALISTIC_JOB_FACTOR}x the first job's` : ""),
  };
}

/** The estimate as one line for a runner to print. */
export function describeEstimate(estimate: CostEstimate, maxUsd: number): string {
  if (estimate.usd === null) return `estimate: ${estimate.episodes} episodes; ${estimate.note}`;
  const over =
    estimate.withinCap !== null && estimate.withinCap < estimate.episodes
      ? `; the $${maxUsd} cap covers about ${estimate.withinCap} of them`
      : "";
  return (
    `estimate: ${estimate.episodes} episodes, about $${estimate.usd.toFixed(2)}${over} ` +
    `(${estimate.note})`
  );
}
