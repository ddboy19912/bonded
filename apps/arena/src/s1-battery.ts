import type { AttackSpec } from "@bondedhq/shared";
import { BatchStopped } from "./budget.js";
import { goalOk } from "./harbinger/goals.js";
import { selectS1Seeds } from "./s1-seeds.js";
import { runS1Pair, S1BudgetExceeded, type S1Options, type S1PairResult } from "./s1.js";

/** Validate before any rated episodes run; never replace the seed's conditional goal. */
export function s1BatterySettings(seeds: AttackSpec[], pairs = 2) {
  if (!Number.isSafeInteger(pairs) || pairs < 1)
    throw new Error("S1 pairs must be a positive integer");
  const runnable = selectS1Seeds(seeds);
  for (const seed of runnable)
    if (!seed.goal?.trim() || !goalOk(seed.goal)) throw new Error(`${seed.id}: invalid S1 goal`);
  return { seeds: runnable, pairs };
}

/** Keep completed pairs and per-arm usage when the shared budget stops a battery. */
export async function runS1Battery(
  options: Omit<S1Options, "seed" | "goal"> & { seeds: AttackSpec[]; pairs: number },
  runPair: typeof runS1Pair = runS1Pair,
) {
  const results: S1PairResult[] = [];
  const { seeds, pairs, ...shared } = options;
  try {
    for (const seed of seeds) {
      for (let i = 0; i < pairs; i++) {
        if (options.budget?.exceeded) throw new S1BudgetExceeded();
        results.push(await runPair({ ...shared, seed, goal: seed.goal! }));
      }
    }
  } catch (error) {
    if (!(error instanceof S1BudgetExceeded || error instanceof BatchStopped)) throw error;
    return { results, stoppedEarly: true };
  }
  return { results, stoppedEarly: false };
}
