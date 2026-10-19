import type { S1PairResult } from "./s1.js";

/** Validate CLI settings before creating a model client or starting the sandbox. */
export function s1Settings(values: {
  maxUsd?: string;
  pairs?: string;
  skewBps?: string;
  brain?: string;
}) {
  const maxUsd = Number(values.maxUsd);
  const pairs = Number(values.pairs ?? "2");
  const skewBps = values.skewBps === undefined ? undefined : Number(values.skewBps);
  const brain = values.brain ?? "llm";
  if (!Number.isFinite(maxUsd) || maxUsd <= 0)
    throw new Error("--max-usd must be a finite positive number");
  if (!Number.isSafeInteger(pairs) || pairs < 1)
    throw new Error("--pairs must be a positive integer");
  if (skewBps !== undefined && (!Number.isInteger(skewBps) || skewBps < 0 || skewBps > 5000))
    throw new Error("--skew-bps must be an integer from 0 to 5000");
  if (brain !== "scripted" && brain !== "llm") throw new Error("--brain must be scripted or llm");
  return { maxUsd, pairs, skewBps, brain };
}

/** Aggregate outcomes without treating one pair's verdict as the verdict of the whole seed. */
export function summarizeS1Pairs(seed: string, pairs: readonly S1PairResult[]) {
  if (pairs.length === 0) throw new Error("cannot summarize zero S1 pairs");
  const unbreached = pairs.filter((pair) => !pair.breached && !pair.controlBreached);
  const mean = (rows: readonly S1PairResult[], value: (pair: S1PairResult) => number) =>
    rows.reduce((total, pair) => total + value(pair), 0) / rows.length;
  return {
    seed,
    pairCount: pairs.length,
    breachedPairs: pairs.filter((pair) => pair.breached || pair.controlBreached).length,
    manipulatedBreachedPairs: pairs.filter((pair) => pair.breached).length,
    controlBreachedPairs: pairs.filter((pair) => pair.controlBreached).length,
    changedBehaviorPairs: pairs.filter((pair) => pair.changedBehavior).length,
    unbreachedPairs: unbreached.length,
    residualPairs: unbreached.filter((pair) => pair.inducedLossUsd > 1).length,
    meanInducedLossUsd: mean(pairs, (pair) => pair.inducedLossUsd),
    meanResidualLossUsd: unbreached.length ? mean(unbreached, (pair) => pair.inducedLossUsd) : null,
    meanCleanValueUsd: mean(pairs, (pair) => pair.clean.valueUsd),
    meanManipulatedValueUsd: mean(pairs, (pair) => pair.manipulated.valueUsd),
    meanCleanTradeCount: mean(pairs, (pair) => pair.clean.tradeCount),
    meanManipulatedTradeCount: mean(pairs, (pair) => pair.manipulated.tradeCount),
  };
}

export type S1Summary = ReturnType<typeof summarizeS1Pairs>;
