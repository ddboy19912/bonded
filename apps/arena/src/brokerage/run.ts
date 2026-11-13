import type { ArenaAgent, BrokerToolProfile } from "@bondedhq/shared";
import type { SpendingCap } from "../budget.js";
import { type BrokerEpisodeResult, neverRan, runBrokerEpisode } from "./episode.js";
import type { BrokerScenario } from "./scenarios.js";

/**
 * How many episodes in a row an outside agent may fail without making a tool call before the run
 * stops. One can be a blip; three in a row means the agent is gone (its runner disconnected, its
 * URL refuses brokerage episodes), and running the rest would only fill the report with episodes
 * that never tested it.
 */
export const UNREACHED_TO_STOP = 3;

export interface BrokerRunOptions {
  /** Episodes at once. An outside agent runs one at a time. */
  concurrency: number;
  hideMandate?: boolean;
  /** Whose tool names the agent is offered (default the world's own). */
  toolProfile?: BrokerToolProfile;
  /** Bonded's own model spend; the run stops when it is used up. */
  cap?: SpendingCap;
  /**
   * Stop after this many episodes in a row that never ran (see `neverRan`). Set it for an outside
   * agent; leave it out for Bonded's own, whose failures are a model's, one episode at a time.
   */
  stopAfterUnreached?: number;
  /** Episode step cap (the world's own when absent). */
  maxSteps?: number;
  /**
   * Called before each episode starts, with its place in the queue. Throw to stop the run (a lost
   * lease, say): the error comes out of `runBrokerQueue`.
   */
  beforeEpisode?: (index: number, total: number) => unknown;
  /**
   * Called as each episode lands, in the order they finish, and waited for. Throw to stop the run
   * (a time budget): the error comes out of `runBrokerQueue`.
   */
  onResult?: (result: BrokerEpisodeResult, scenario: BrokerScenario) => unknown;
}

export interface BrokerRun {
  results: BrokerEpisodeResult[];
  /** The spending cap stopped the run before every episode ran. */
  stoppedByCap: boolean;
  /** Why the run stopped early for another reason (the agent couldn't be reached). */
  stoppedEarly?: string;
}

/** Runs the queued episodes, a few at a time, until they are done or the run has to stop. */
export async function runBrokerQueue(
  queue: readonly BrokerScenario[],
  makeAgent: () => ArenaAgent,
  options: BrokerRunOptions,
): Promise<BrokerRun> {
  const results: BrokerEpisodeResult[] = [];
  let next = 0;
  let stoppedByCap = false;
  let stoppedEarly: string | undefined;
  let unreached = 0;
  /** The first callback or episode failure: no worker starts another episode after it. */
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (next < queue.length && stoppedEarly === undefined && !failure) {
      if (options.cap?.exceeded) {
        stoppedByCap = true;
        return;
      }
      const index = next++;
      const scenario = queue[index]!;
      await options.beforeEpisode?.(index, queue.length);
      const result = await runBrokerEpisode(makeAgent(), scenario, {
        ...(options.hideMandate !== undefined ? { hideMandate: options.hideMandate } : {}),
        ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
        ...(options.toolProfile ? { toolProfile: options.toolProfile } : {}),
      });
      results.push(result);
      await options.onResult?.(result, scenario);
      unreached = neverRan(result) ? unreached + 1 : 0;
      if (options.stopAfterUnreached !== undefined && unreached >= options.stopAfterUnreached)
        stoppedEarly = `the agent failed ${unreached} episodes in a row without making a tool call (${result.agentSummary.finalMessage ?? "no reason given"})`;
    }
  };
  // Every worker is waited for before a failure comes out, so none is still running an episode
  // when the caller moves on.
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(options.concurrency, queue.length)) }, () =>
      worker().catch((error: unknown) => {
        failure ??= { error };
      }),
    ),
  );
  if (failure) throw failure.error;
  return { results, stoppedByCap, ...(stoppedEarly !== undefined ? { stoppedEarly } : {}) };
}

/**
 * The flags given that do nothing for an outside agent: it runs its own model, one episode at a
 * time, and Bonded spends nothing on it. Refused rather than ignored, so nobody believes a run
 * used a model or a concurrency it didn't.
 */
export function flagsNotForRemote(values: Record<string, unknown>): string[] {
  return ["model", "concurrency", "max-usd"]
    .filter((flag) => values[flag] !== undefined)
    .map((flag) => `--${flag}`);
}
