import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArenaAgent } from "@bondedhq/shared";
import type { BenignSeed } from "./benign.js";
import { SpendingCap, type TokenPrice } from "./budget.js";
import { BENIGN_GOALS, type EpisodeResult, runEpisode, saveEpisode } from "./episode.js";
import type { Sandbox } from "./sandbox.js";
import { type RatingTask, taskScore } from "./task-score.js";
import { DEFAULT_CONTROLS } from "./rate.js";
import type { AgentVaultOptions } from "./vault.js";

export interface TaskBatteryOptions {
  agent: ArenaAgent;
  seeds: BenignSeed[];
  /** Runs of each twin (default 1). */
  runs?: number;
  /** Control episodes (default DEFAULT_CONTROLS). */
  controls?: number;
  vault?: AgentVaultOptions;
  maxUsd?: number;
  episodeTimeoutMs?: number;
  fallbackPrice?: TokenPrice;
  /** Where to write task.json and the traces. */
  outDir?: string;
  onEpisode?: (result: EpisodeResult, index: number, total: number) => void | Promise<void>;
}

/** What `arena task` writes to task.json. */
export interface TaskBatteryResult {
  agent: string;
  startedAt: string;
  durationMs: number;
  /**
   * The Task score from controls and twins only: no attacks ran, so `underAttack` is empty and
   * the score is the lower of the two parts.
   */
  task: RatingTask;
  spend: ReturnType<SpendingCap["summary"]>;
  /** Why it stopped before every episode ran (the spending cap), or null. */
  stoppedEarly: string | null;
}

/**
 * The Task score on its own: control episodes and benign twins, in a random order, with no
 * attacks. For an agent whose Security score was already measured (the leaderboard), so its Task
 * score can be added without re-running the attack library. Nothing is signed or posted.
 */
export async function runTaskBattery(
  sandbox: Sandbox,
  options: TaskBatteryOptions,
): Promise<{ result: TaskBatteryResult; controls: EpisodeResult[]; benign: EpisodeResult[] }> {
  const runs = options.runs ?? 1;
  const controlCount = options.controls ?? DEFAULT_CONTROLS;
  if (!Number.isInteger(runs) || runs < 1) throw new Error("runs must be a positive integer");
  const jobs: (BenignSeed | null)[] = [
    ...Array.from({ length: controlCount }, () => null),
    ...Array.from({ length: runs }, () => options.seeds).flat(),
  ];
  for (let i = jobs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [jobs[i], jobs[j]] = [jobs[j]!, jobs[i]!];
  }
  const cap = new SpendingCap({
    maxUsd: options.maxUsd ?? Number.POSITIVE_INFINITY,
    ...(options.fallbackPrice ? { fallbackPrice: options.fallbackPrice } : {}),
  });
  const tracesDir = options.outDir ? join(options.outDir, "traces") : undefined;
  const worldSecret = randomBytes(32).toString("hex");
  const started = Date.now();
  const controls: EpisodeResult[] = [];
  const benign: EpisodeResult[] = [];
  let stoppedEarly: string | null = null;
  for (const [index, seed] of jobs.entries()) {
    if (cap.exceeded) {
      stoppedEarly = `spending cap of $${options.maxUsd} reached after ${index} of ${jobs.length} episodes`;
      break;
    }
    const result = await runEpisode(sandbox, {
      agent: options.agent,
      attack: null,
      ...(seed
        ? { benign: seed }
        : { goal: BENIGN_GOALS[Math.floor(Math.random() * BENIGN_GOALS.length)]! }),
      worldSeed: `${worldSecret}:${index}`,
      ...(options.vault ? { vault: options.vault } : {}),
      ...(options.episodeTimeoutMs ? { timeoutMs: options.episodeTimeoutMs } : {}),
    });
    cap.add(result.agentSummary.usage);
    (seed ? benign : controls).push(result);
    if (tracesDir) saveEpisode(result, tracesDir);
    await options.onEpisode?.(result, index, jobs.length);
  }
  const result: TaskBatteryResult = {
    agent: options.agent.name,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    task: taskScore(controls, benign),
    spend: cap.summary(),
    stoppedEarly,
  };
  if (options.outDir) {
    mkdirSync(options.outDir, { recursive: true });
    writeFileSync(join(options.outDir, "task.json"), `${JSON.stringify(result, null, 2)}\n`);
  }
  return { result, controls, benign };
}
