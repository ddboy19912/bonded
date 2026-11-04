import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type LeaderboardEntry, TASK_SCORE_VERSION } from "@bondedhq/shared";
import { entryTask } from "./leaderboard.js";
import { pickEntries, type RefreshTarget, refreshTarget } from "./leaderboard-refresh.js";
import type { TaskBatteryResult } from "./task-battery.js";

// `pnpm leaderboard task`: adds the Task score to entries whose Security score was already
// measured, by running only the controls and benign twins (`arena task`), never the attack
// library. The entries' grades, scores and on-chain posts are left as they are.

/** The default settings: Bonded's own agents through a framework need long episodes. */
export const TASK_DEFAULTS = {
  episodeTimeoutS: 900,
  /** One entry's model spend cap. */
  perEntryMaxUsd: 0.25,
  /**
   * The cost estimate for one model-driven entry: 22 episodes (6 controls, 16 twins), against
   * $0.33–0.41 for a full rating's ~450 on the same Flash models (Oct 19–20 re-rating).
   */
  estimateUsd: 0.05,
} as const;

export interface TaskJob {
  entry: LeaderboardEntry;
  target: RefreshTarget;
  /** Where `arena task` writes task.json and its traces. */
  dir: string;
}

export interface TaskPlan {
  runDir: string;
  /** Measure every planned entry again, even when its previous run is complete. */
  force: boolean;
  jobs: TaskJob[];
  /** Entries left out, and why (already current). */
  skipped: { slug: string; reason: string }[];
  /** Model-driven jobs times the per-entry estimate. */
  estimateUsd: number;
}

/** Which entries need a Task score run: every selected one not already on this Task version. */
export function planTask(options: {
  entries: LeaderboardEntry[];
  runDir: string;
  only?: string[];
  /** Run even entries whose Task score is current. */
  force?: boolean;
  estimateUsd?: number;
}): TaskPlan {
  const jobs: TaskJob[] = [];
  const skipped: TaskPlan["skipped"] = [];
  for (const entry of pickEntries(options.entries, options.only)) {
    if (!options.force && entry.task?.version === TASK_SCORE_VERSION) {
      skipped.push({
        slug: entry.slug,
        reason: `Task score already on version ${TASK_SCORE_VERSION}`,
      });
      continue;
    }
    jobs.push({ entry, target: refreshTarget(entry), dir: join(options.runDir, entry.slug) });
  }
  const paid = jobs.filter((j) => j.target.brain === "llm").length;
  return {
    runDir: options.runDir,
    force: options.force ?? false,
    jobs,
    skipped,
    estimateUsd: paid * (options.estimateUsd ?? TASK_DEFAULTS.estimateUsd),
  };
}

/** The `arena task` arguments for one job. */
export function taskArgs(
  job: Pick<TaskJob, "target" | "dir">,
  settings: { episodeTimeoutS: number },
  maxUsd?: number,
): string[] {
  const { target } = job;
  return [
    "task",
    "--agent",
    target.agent,
    ...(target.agent === "hardened" || target.agent === "vulnerable"
      ? ["--brain", target.brain]
      : []),
    ...(target.model ? ["--model", target.model] : []),
    "--episode-timeout",
    String(settings.episodeTimeoutS),
    ...(target.brain === "llm" && maxUsd !== undefined ? ["--max-usd", maxUsd.toFixed(2)] : []),
    "--out",
    job.dir,
  ];
}

/**
 * A job's task.json, if it finished on this Task version: a run that stopped early, or one on
 * another version, is no result.
 */
export function readTaskResult(dir: string): TaskBatteryResult | undefined {
  const path = join(dir, "task.json");
  if (!existsSync(path)) return undefined;
  const result = JSON.parse(readFileSync(path, "utf8")) as TaskBatteryResult;
  if (result.stoppedEarly || result.task.version !== TASK_SCORE_VERSION) return undefined;
  return result;
}

export interface TaskOutcome {
  slug: string;
  status: "measured" | "reused" | "failed";
  score?: number | null;
  spentUsd: number;
  reason?: string;
}

/**
 * Runs the plan one entry at a time, within `maxUsd` in total (required for model-driven jobs),
 * and returns the entries with their Task score set. A finished task.json from an earlier run is
 * reused unless forced, so running it again normally only measures what failed.
 */
export async function runTaskRefresh(
  plan: TaskPlan,
  entries: LeaderboardEntry[],
  options: { episodeTimeoutS: number; maxUsd?: number; perEntryMaxUsd?: number },
  deps: {
    run: (job: TaskJob, args: string[]) => Promise<number>;
    log: (line: string) => void;
  },
): Promise<{ entries: LeaderboardEntry[]; outcomes: TaskOutcome[] }> {
  if (options.maxUsd === undefined && plan.jobs.some((j) => j.target.brain === "llm"))
    throw new Error("--max-usd is required when a model-driven entry needs a Task score");
  const updated = new Map(entries.map((e) => [e.slug, e]));
  const outcomes: TaskOutcome[] = [];
  let spent = 0;
  for (const job of plan.jobs) {
    const slug = job.entry.slug;
    let result = plan.force ? undefined : readTaskResult(job.dir);
    let status: TaskOutcome["status"] = "reused";
    if (!result) {
      const left = options.maxUsd === undefined ? undefined : Math.max(0, options.maxUsd - spent);
      if (job.target.brain === "llm" && left !== undefined && left <= 0) {
        outcomes.push({
          slug,
          status: "failed",
          spentUsd: 0,
          reason: "the spending cap was used up",
        });
        continue;
      }
      const cap =
        left === undefined
          ? undefined
          : Math.min(left, options.perEntryMaxUsd ?? TASK_DEFAULTS.perEntryMaxUsd);
      deps.log(`${slug}: measuring the Task score`);
      // A failed rerun must not leave the previous result looking like this attempt's output.
      rmSync(join(job.dir, "task.json"), { force: true });
      const code = await deps.run(job, taskArgs(job, options, cap));
      result = readTaskResult(job.dir);
      status = "measured";
      if (code !== 0 || !result) {
        const partial = existsSync(join(job.dir, "task.json"))
          ? (JSON.parse(readFileSync(join(job.dir, "task.json"), "utf8")) as TaskBatteryResult)
          : undefined;
        spent += partial?.spend.spentUsd ?? 0;
        outcomes.push({
          slug,
          status: "failed",
          spentUsd: partial?.spend.spentUsd ?? 0,
          reason: partial?.stoppedEarly ?? `arena task exited with ${code}`,
        });
        continue;
      }
      spent += result.spend.spentUsd;
    }
    updated.set(slug, { ...job.entry, task: entryTask(result.task, result.startedAt, "task") });
    outcomes.push({
      slug,
      status,
      score: result.task.score,
      spentUsd: status === "measured" ? result.spend.spentUsd : 0,
    });
  }
  return { entries: [...updated.values()], outcomes };
}
