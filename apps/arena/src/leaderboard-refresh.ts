import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ATTACK_LIBRARY_VERSION, type LeaderboardEntry } from "@bondedhq/shared";
import { assertHeldOutOffMetaApi } from "./held-out-guard.js";
import type { AddRatingResult, EntryMeta } from "./leaderboard-add.js";
import { loadRating, unpublishableReason } from "./leaderboard.js";
import type { RatingReport } from "./rate.js";

/**
 * `pnpm leaderboard refresh`: re-rate every leaderboard entry with the standard settings, resume
 * after a crash or a failed rating, and post them all together. The pieces here are pure or take
 * their side effects as arguments, so planning and resuming are tested without running a model.
 */

/** Where `arena rate` writes by default; refresh runs go in `refresh-v<version>` under it. */
export const RATINGS_DIR = fileURLToPath(new URL("../ratings/", import.meta.url));

/** The standard leaderboard settings (the Oct 19–20 re-rating's, with a higher episode limit). */
export const REFRESH_DEFAULTS = {
  repeats: 5,
  /** Bonded's own agents through a framework: an Oct 20 run lost episodes at 300 s. */
  episodeTimeoutS: 900,
  /** One rating's model spend cap, also bounded by what's left of the total. */
  perRatingMaxUsd: 1,
  /**
   * The cost estimate for one model-driven rating at 5 runs with S1 and the world-state battery:
   * the Oct 19–20 re-rating spent $0.33–0.41 per entry on DeepSeek v4.1 Flash and GLM 5.3 Flash,
   * and the world-state battery adds 36 two-day episodes and its twins at 3 attempts a seed
   * (about $0.05–0.10). Scripted agents cost nothing.
   */
  estimateUsd: 0.55,
  /** Tries per entry in one invocation; a later invocation tries again. */
  attempts: 2,
  parallel: 1,
} as const;

/** How to rate one entry: the `arena rate` agent and, for a model-driven one, its model. */
export interface RefreshTarget {
  agent: "agentkit" | "solana-agent-kit" | "hardened" | "vulnerable";
  brain: "scripted" | "llm";
  model: string | null;
}

/** Which `arena rate --agent` runs each framework on the board. */
const FRAMEWORK_AGENTS: Record<string, RefreshTarget["agent"]> = {
  "Coinbase AgentKit": "agentkit",
  "Solana Agent Kit": "solana-agent-kit",
};

/** Bonded's reference agents, by slug prefix. */
const REFERENCE_AGENTS: [prefix: string, agent: RefreshTarget["agent"]][] = [
  ["bonded-hardened", "hardened"],
  ["bonded-vulnerable", "vulnerable"],
];

/** The agent and model an entry is re-rated with. Throws for an entry no rule covers. */
export function refreshTarget(e: LeaderboardEntry): RefreshTarget {
  if (e.kind === "reference") {
    const agent = REFERENCE_AGENTS.find(([prefix]) => e.slug.startsWith(prefix))?.[1];
    if (agent) return { agent, brain: e.model ? "llm" : "scripted", model: e.model };
  } else {
    const agent = FRAMEWORK_AGENTS[e.framework];
    if (agent) {
      if (!e.model) throw new Error(`${e.slug}: a framework entry needs a model to re-rate`);
      return { agent, brain: "llm", model: e.model };
    }
  }
  throw new Error(
    `${e.slug}: no rule to re-rate it (${e.kind}, framework "${e.framework}"); add one to ` +
      "FRAMEWORK_AGENTS or REFERENCE_AGENTS in apps/arena/src/leaderboard-refresh.ts",
  );
}

/** What a rating folder holds. */
export type RatingState =
  | { status: "complete"; report: RatingReport; spentUsd: number }
  | { status: "failed"; reason: string; spentUsd: number }
  | { status: "missing" };

/**
 * A rating folder is complete when it verifies (report.json's hash is the attestation's), is
 * publishable (no early stop, no agent errors) and ran against the current attack library.
 * Anything else that exists — a crash mid-rating, a timeout, an unsigned or stale rating — is
 * failed, with whatever model spend its report recorded.
 */
export function ratingState(dir: string): RatingState {
  if (!existsSync(dir)) return { status: "missing" };
  const spentUsd = reportSpend(dir);
  let report: RatingReport;
  try {
    report = loadRating(dir).report;
  } catch (error) {
    const reason = existsSync(join(dir, "report.json"))
      ? error instanceof Error
        ? error.message.replace(`${dir}: `, "")
        : String(error)
      : "no report (the rating didn't finish)";
    return { status: "failed", reason, spentUsd };
  }
  const unpublishable = unpublishableReason(report);
  if (unpublishable) return { status: "failed", reason: unpublishable, spentUsd };
  if (report.libraryVersion !== ATTACK_LIBRARY_VERSION)
    return {
      status: "failed",
      reason: `rated on attack library ${report.libraryVersion === undefined ? "(no version)" : `v${report.libraryVersion}`}, current is v${ATTACK_LIBRARY_VERSION}`,
      spentUsd,
    };
  return { status: "complete", report, spentUsd };
}

/** The model spend a folder's report recorded, or 0 if there is none to read. */
function reportSpend(dir: string): number {
  try {
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as RatingReport;
    return report.spend?.spentUsd ?? 0;
  } catch {
    return 0;
  }
}

/** Model spend recorded by every rating in a refresh run, including failed attempts set aside. */
export function runSpend(runDir: string): number {
  if (!existsSync(runDir)) return 0;
  return readdirSync(runDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .reduce((sum, d) => sum + reportSpend(join(runDir, d.name)), 0);
}

export interface RefreshJob {
  entry: LeaderboardEntry;
  target: RefreshTarget;
  /** Where its rating goes. */
  dir: string;
  /** `skip`: already complete on the current library; `rate`: missing or failed. */
  action: "skip" | "rate";
  /**
   * Skipped because the board already holds a current rating the registry confirms, rather than
   * because the run has one: there is nothing new to publish for it.
   */
  onBoard?: true;
  /** Why: what the folder holds now. */
  reason: string;
  estimateUsd: number;
}

export interface RefreshPlan {
  runDir: string;
  jobs: RefreshJob[];
  /** Spend already recorded in the run (earlier attempts). */
  spentUsd: number;
  /** Estimated spend for the ratings still to run. */
  estimateUsd: number;
}

/** The run's folder: one per attack library version, unless named. */
export function refreshRunDir(ratingsDir: string, run?: string): string {
  return join(ratingsDir, run ?? `refresh-v${ATTACK_LIBRARY_VERSION}`);
}

/** Whether a board entry was rated on the current attack library and has been posted. */
export function isCurrentOnBoard(e: LeaderboardEntry): boolean {
  return e.libraryVersion === ATTACK_LIBRARY_VERSION && Boolean(e.onchain?.tx);
}

/**
 * The slugs of current board entries whose registry score is the entry's (same report hash and
 * score), read with `readScore`. A failed read throws: guessing "not verified" would re-rate, and
 * spend on, an entry that may be fine.
 */
export async function verifiedOnChain(
  entries: readonly LeaderboardEntry[],
  readScore: (
    chain: "robinhoodTestnet",
    agentId: string,
  ) => Promise<{ reportHash: string; score: number } | null>,
): Promise<Set<string>> {
  const verified = new Set<string>();
  for (const e of entries) {
    if (!isCurrentOnBoard(e) || e.onchain?.chain !== "robinhoodTestnet") continue;
    let s: Awaited<ReturnType<typeof readScore>>;
    try {
      s = await readScore("robinhoodTestnet", e.onchain.agentId);
    } catch (error) {
      throw new Error(
        `${e.slug}: couldn't read agent ${e.onchain.agentId}'s score from the registry (${error instanceof Error ? error.message : String(error)}); try again`,
        { cause: error },
      );
    }
    if (s && s.reportHash.toLowerCase() === e.reportHash.toLowerCase() && s.score === e.score)
      verified.add(e.slug);
  }
  return verified;
}

/** The entries in `only` (all when omitted), in board order. Unknown slugs throw. */
export function pickEntries(
  entries: readonly LeaderboardEntry[],
  only?: readonly string[],
): readonly LeaderboardEntry[] {
  const unknown = only?.filter((slug) => !entries.some((e) => e.slug === slug)) ?? [];
  if (unknown.length) throw new Error(`not on the leaderboard: ${unknown.join(", ")}`);
  return only ? entries.filter((e) => only.includes(e.slug)) : entries;
}

/**
 * A held-out set is needed only when the plan rates something: a refresh with every entry
 * current runs on a machine without one. Throws when a rating needs one and none was found, and
 * when a rating with one would send it to Meta Model API (held-out-guard.ts), before any runs.
 */
export function checkHeldOut(plan: RefreshPlan, heldOut: string | null, noHeldOut: boolean): void {
  const rated = plan.jobs.filter((j) => j.action === "rate");
  if (heldOut === null && !noHeldOut && rated.length > 0)
    throw new Error(
      "no held-out set found in ~/.config/bonded/held-out: pass --held-out <dir>, or --no-held-out",
    );
  if (heldOut !== null)
    assertHeldOutOffMetaApi(
      rated.map((j) => ({ role: `${j.entry.slug}'s agent`, model: j.target.model ?? undefined })),
    );
}

/**
 * Plans a refresh: every entry (or those in `only`, in board order), each skipped if its folder
 * in the run is complete, or if it is in `verified` (already rated on the current library and
 * confirmed on chain), and rated otherwise. Unknown slugs in `only` and entries with no re-rate
 * rule throw before anything runs.
 */
export function planRefresh(options: {
  entries: readonly LeaderboardEntry[];
  runDir: string;
  only?: readonly string[];
  estimateUsd?: number;
  repeats?: number;
  /** Slugs from `verifiedOnChain`; omit to re-rate regardless of the board (a named run). */
  verified?: ReadonlySet<string>;
}): RefreshPlan {
  const { runDir } = options;
  const picked = pickEntries(options.entries, options.only);
  const perRating =
    (options.estimateUsd ?? REFRESH_DEFAULTS.estimateUsd) *
    ((options.repeats ?? REFRESH_DEFAULTS.repeats) / REFRESH_DEFAULTS.repeats);
  const jobs = picked.map((entry): RefreshJob => {
    const target = refreshTarget(entry);
    const dir = join(runDir, entry.slug);
    const state = ratingState(dir);
    const estimateUsd = target.brain === "llm" ? perRating : 0;
    if (state.status === "complete")
      return { entry, target, dir, action: "skip", reason: "complete", estimateUsd: 0 };
    if (options.verified?.has(entry.slug) && isCurrentOnBoard(entry))
      return {
        entry,
        target,
        dir,
        action: "skip",
        onBoard: true,
        reason: `on the board at v${ATTACK_LIBRARY_VERSION}, verified on chain`,
        estimateUsd: 0,
      };
    return {
      entry,
      target,
      dir,
      action: "rate",
      reason: state.status === "missing" ? "not rated yet" : `failed: ${state.reason}`,
      estimateUsd,
    };
  });
  return {
    runDir,
    jobs,
    spentUsd: runSpend(runDir),
    estimateUsd: jobs.reduce((sum, j) => sum + j.estimateUsd, 0),
  };
}

export interface RateSettingsForRefresh {
  repeats: number;
  episodeTimeoutS: number;
  /** The held-out attack folder, or null to rate without one. */
  heldOut: string | null;
}

/** The `arena rate` arguments for one entry. `maxUsd` is set for model-driven agents only. */
export function rateArgs(
  job: Pick<RefreshJob, "target" | "dir">,
  settings: RateSettingsForRefresh,
  maxUsd?: number,
): string[] {
  const { target } = job;
  return [
    "rate",
    "--agent",
    target.agent,
    ...(target.agent === "hardened" || target.agent === "vulnerable"
      ? ["--brain", target.brain]
      : []),
    ...(target.model ? ["--model", target.model] : []),
    "--repeats",
    String(settings.repeats),
    ...(settings.heldOut ? ["--held-out", settings.heldOut] : []),
    "--episode-timeout",
    String(settings.episodeTimeoutS),
    ...(target.brain === "llm" && maxUsd !== undefined ? ["--max-usd", maxUsd.toFixed(2)] : []),
    "--out",
    job.dir,
  ];
}

/** The newest held-out folder under ~/.config/bonded/held-out (named by date), if any. */
export function defaultHeldOutDir(root = join(homedir(), ".config", "bonded", "held-out")) {
  if (!existsSync(root)) return undefined;
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  return dirs.length ? join(root, dirs.at(-1)!) : undefined;
}

/** Moves a failed attempt aside as `<dir>.failed-<n>`, keeping its logs and spend. */
export function setAside(dir: string): string {
  let n = 1;
  while (existsSync(`${dir}.failed-${n}`)) n++;
  const to = `${dir}.failed-${n}`;
  renameSync(dir, to);
  return to;
}

/** The entry's identity, for re-adding it with a new rating. */
export function metaOf(e: LeaderboardEntry): EntryMeta {
  return {
    slug: e.slug,
    name: e.name,
    kind: e.kind,
    framework: e.framework,
    model: e.model,
    disclosure: e.disclosure,
    ...(e.template ? { template: e.template } : {}),
  };
}

export interface RefreshOutcome {
  slug: string;
  /** `skipped`: already complete; `rated`: completed now; `failed`; `budget`: not started. */
  status: "skipped" | "rated" | "failed" | "budget";
  detail: string;
  /** Skipped as already current on the board and on chain (see RefreshJob.onBoard). */
  onBoard?: true;
  /** This invocation's attempts. */
  attempts: number;
  spentUsd: number;
  previousGrade?: number;
  grade?: number;
  score?: number;
  posted?: AddRatingResult["posted"];
  postError?: string;
}

export interface RefreshDeps {
  /** Runs `arena rate` with these arguments; resolves with its exit code. */
  rate: (job: RefreshJob, args: string[], attempt: number) => Promise<number>;
  /** Adds the complete rating to the leaderboard file, and posts it unless --no-post. */
  add: (job: RefreshJob) => Promise<AddRatingResult>;
  log: (line: string) => void;
}

export interface RefreshRunOptions {
  settings: RateSettingsForRefresh;
  /** Total model spend cap for the run, counting earlier attempts. Required if any model rating runs. */
  maxUsd?: number;
  perRatingMaxUsd?: number;
  attempts?: number;
  parallel?: number;
  /** Publish the complete ones even if some failed (normally all or nothing). */
  publishPartial?: boolean;
}

/** Below this, a model rating isn't started: it would stop early and be thrown away. */
const MIN_RATING_USD = 0.05;

/**
 * Runs a plan: rates what isn't complete (a failed attempt is set aside and retried, up to
 * `attempts`), sharing the total cap across ratings in flight, then publishes every entry
 * together (`deps.add`) once all are complete. Returns one outcome per job, in plan order.
 */
export async function runRefresh(
  plan: RefreshPlan,
  options: RefreshRunOptions,
  deps: RefreshDeps,
): Promise<{ outcomes: RefreshOutcome[]; published: boolean; spentUsd: number }> {
  const attempts = options.attempts ?? REFRESH_DEFAULTS.attempts;
  const perRating = options.perRatingMaxUsd ?? REFRESH_DEFAULTS.perRatingMaxUsd;
  const needsBudget = plan.jobs.some((j) => j.action === "rate" && j.target.brain === "llm");
  if (needsBudget && options.maxUsd === undefined)
    throw new Error("--max-usd is required when a model-driven entry needs rating");
  let spent = plan.spentUsd;
  let reserved = 0;
  const outcomes = new Map<string, RefreshOutcome>();

  const rateOne = async (job: RefreshJob): Promise<RefreshOutcome> => {
    const base = { slug: job.entry.slug, previousGrade: job.entry.securityGrade };
    let tries = 0;
    let jobSpend = 0;
    let detail = job.reason;
    while (tries < attempts) {
      const state = ratingState(job.dir);
      if (state.status === "complete") break;
      if (state.status === "failed") {
        const to = setAside(job.dir);
        deps.log(`${job.entry.slug}: set aside ${to} (${state.reason})`);
      }
      let cap: number | undefined;
      if (job.target.brain === "llm") {
        cap = Math.min(perRating, options.maxUsd! - spent - reserved);
        if (cap < MIN_RATING_USD)
          return {
            ...base,
            status: tries ? "failed" : "budget",
            detail: `total cap reached ($${spent.toFixed(2)} of $${options.maxUsd!.toFixed(2)} spent)`,
            attempts: tries,
            spentUsd: jobSpend,
          };
        reserved += cap;
      }
      tries++;
      deps.log(
        `${job.entry.slug}: rating, attempt ${tries} of ${attempts}${cap === undefined ? "" : ` (cap $${cap.toFixed(2)})`}`,
      );
      let code: number;
      try {
        code = await deps.rate(job, rateArgs(job, options.settings, cap), tries);
      } finally {
        if (cap !== undefined) reserved -= cap;
      }
      const after = ratingState(job.dir);
      const used = after.status === "missing" ? 0 : after.spentUsd;
      spent += used;
      jobSpend += used;
      if (after.status === "complete") {
        detail = "rated";
        break;
      }
      detail =
        after.status === "missing"
          ? `arena rate exited with ${code} and wrote nothing`
          : `${after.reason}${code ? ` (exit ${code})` : ""}`;
      deps.log(`${job.entry.slug}: attempt ${tries} failed: ${detail}`);
    }
    const final = ratingState(job.dir);
    if (final.status !== "complete")
      return { ...base, status: "failed", detail, attempts: tries, spentUsd: jobSpend };
    return {
      ...base,
      status: "rated",
      detail,
      attempts: tries,
      spentUsd: jobSpend,
      ...(final.report.susceptibility ? { grade: final.report.susceptibility.grade } : {}),
      score: final.report.scoring.score,
    };
  };

  for (const job of plan.jobs)
    if (job.action === "skip" && job.onBoard)
      outcomes.set(job.entry.slug, {
        slug: job.entry.slug,
        status: "skipped",
        onBoard: true,
        detail: job.reason,
        attempts: 0,
        spentUsd: 0,
        previousGrade: job.entry.securityGrade,
        ...(job.entry.securityGrade === undefined ? {} : { grade: job.entry.securityGrade }),
        score: job.entry.score,
      });
    else if (job.action === "skip") {
      const state = ratingState(job.dir);
      outcomes.set(job.entry.slug, {
        slug: job.entry.slug,
        status: "skipped",
        detail: "complete from an earlier run",
        attempts: 0,
        spentUsd: 0,
        previousGrade: job.entry.securityGrade,
        ...(state.status === "complete"
          ? {
              ...(state.report.susceptibility ? { grade: state.report.susceptibility.grade } : {}),
              score: state.report.scoring.score,
            }
          : {}),
      });
    }
  const queue = plan.jobs.filter((j) => j.action === "rate");
  const workers = Array.from(
    { length: Math.max(1, Math.min(options.parallel ?? REFRESH_DEFAULTS.parallel, queue.length)) },
    async () => {
      for (let job = queue.shift(); job; job = queue.shift())
        outcomes.set(job.entry.slug, await rateOne(job));
    },
  );
  await Promise.all(workers);

  const ordered = plan.jobs.map((j) => outcomes.get(j.entry.slug)!);
  const allComplete = ordered.every((o) => o.status === "skipped" || o.status === "rated");
  let published = false;
  if (allComplete || options.publishPartial) {
    // One at a time: each post is a transaction from the same key.
    for (const job of plan.jobs) {
      const outcome = outcomes.get(job.entry.slug)!;
      if (outcome.status !== "skipped" && outcome.status !== "rated") continue;
      // Already on the board and on chain: nothing new to add or post.
      if (job.onBoard) continue;
      try {
        const result = await deps.add(job);
        if (result.posted) outcome.posted = result.posted;
      } catch (error) {
        outcome.postError = error instanceof Error ? error.message : String(error);
        deps.log(`${job.entry.slug}: publishing failed: ${outcome.postError}`);
      }
    }
    published = true;
  }
  return { outcomes: ordered, published, spentUsd: spent };
}

/** The plan as lines, for `--dry-run` and before a run. */
export function describePlan(
  plan: RefreshPlan,
  settings: RateSettingsForRefresh,
  maxUsd?: number,
): string[] {
  const toRate = plan.jobs.filter((j) => j.action === "rate");
  const lines = [
    `Refresh on attack library v${ATTACK_LIBRARY_VERSION}: ${plan.jobs.length} entries, ${toRate.length} to rate, ${plan.jobs.length - toRate.length} already complete`,
    `  folder: ${plan.runDir}`,
    `  settings: ${settings.repeats} runs of each attack, ${settings.episodeTimeoutS} s episodes, S1 at 2 pairs a seed, ` +
      (settings.heldOut ? `held-out set ${settings.heldOut}` : "no held-out set"),
    "",
    ...plan.jobs.map(
      (j) =>
        `  ${j.action === "skip" ? "skip" : "rate"}  ${j.entry.slug.padEnd(48)} ${(j.target.model ?? `${j.target.agent} (scripted)`).padEnd(30)} ` +
        `${j.action === "rate" ? `~$${j.estimateUsd.toFixed(2)}  ` : ""}${j.reason}`,
    ),
    "",
    `  estimate: ~$${plan.estimateUsd.toFixed(2)} for the ratings still to run` +
      (plan.spentUsd > 0 ? `, $${plan.spentUsd.toFixed(2)} already spent in this run` : "") +
      (maxUsd === undefined
        ? ""
        : `; cap $${maxUsd.toFixed(2)}${plan.spentUsd + plan.estimateUsd > maxUsd ? " (the estimate is over it: some ratings may not run)" : ""}`),
    `  (estimate: $${REFRESH_DEFAULTS.estimateUsd.toFixed(2)} per model-driven rating at ${REFRESH_DEFAULTS.repeats} runs, from the Oct 19–20 re-rating on DeepSeek v4.1 Flash and GLM 5.3 Flash; scripted agents are free; retries cost extra)`,
  ];
  return lines;
}

/** The summary table printed at the end. */
export function describeOutcomes(
  result: Awaited<ReturnType<typeof runRefresh>>,
  options: { post: boolean; maxUsd?: number },
): string[] {
  const grade = (g?: number) => (g === undefined ? "–" : String(g));
  const lines = [
    "",
    "Summary",
    ...result.outcomes.map(
      (o) =>
        `  ${o.status.padEnd(8)} ${o.slug.padEnd(48)} grade ${grade(o.previousGrade)} -> ${grade(o.grade)}` +
        `${o.score === undefined ? "" : `, insurance ${o.score}`}` +
        `${o.spentUsd ? `, $${o.spentUsd.toFixed(2)}` : ""}` +
        `${o.posted ? `, posted ${o.posted.tx}` : ""}` +
        `${o.postError ? `, NOT published: ${o.postError}` : ""}` +
        `${o.status === "failed" || o.status === "budget" ? ` (${o.detail})` : ""}`,
    ),
    "",
    `  spent in this run: $${result.spentUsd.toFixed(2)}${options.maxUsd === undefined ? "" : ` of $${options.maxUsd.toFixed(2)}`}`,
  ];
  const unfinished = result.outcomes.filter((o) => o.status === "failed" || o.status === "budget");
  if (unfinished.length)
    lines.push(
      `  ${unfinished.length} not complete: run the same command again to retry only those` +
        (result.published ? "" : "; nothing was published"),
    );
  else if (result.outcomes.every((o) => o.onBoard))
    lines.push(
      "  nothing to do: every entry is already current on the board and verified on chain",
    );
  else if (!options.post) lines.push("  leaderboard file updated; scores not posted (--no-post)");
  else if (result.outcomes.some((o) => o.postError))
    lines.push("  some entries failed to publish: run the same command again to retry them");
  return lines;
}
