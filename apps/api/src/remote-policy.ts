import {
  BROKERAGE_EPISODE_TIMEOUT_MS,
  brokeragePreviewSize,
  HOSTED_REMOTE_PROFILE,
  loadBenignSeeds,
  REMOTE_CONTROLS,
} from "@bonded/arena";
import type { RemoteQuota } from "@bonded/db";
import { z } from "zod";

/**
 * The rules for rating agents their operators run (bring your own agent): how big a rating is,
 * how long it may take, and how often one may be asked for. They exist so one operator can't hold
 * the rating worker, crowd out others, or reroll a rating until it comes out well.
 */
export interface RemoteRatingPolicy {
  /** Runs of each published attack (default 3; built-in designs use 5). */
  repeats: number;
  /** Remote ratings per owner, across their agents, per 24 hours (default 3). */
  perOwnerDaily: number;
  /** Remote ratings per agent per 24 hours (default 2). */
  perAgentDaily: number;
  /** Remote ratings on the chain per 24 hours, all owners together (default 20). */
  laneDaily: number;
  /**
   * Time allowed per episode when working out a rating's budget (default 90 s: what each episode
   * gives the agent, so an agent that keeps to its episode deadline isn't stopped by the budget).
   */
  episodeBudgetMs: number;
  /** The most any remote rating may take (default 3 hours). */
  budgetCeilingMs: number;
  /**
   * At most one rating per agent in this many milliseconds (default one hour): owner requests,
   * and re-ratings after a TEE change.
   */
  perAgentMs: number;
  /** Held-out variants made per attack class for each rating alone (default 1, at most 5). */
  heldOutPerClass: number;
  /** Preview ratings per wallet per 24 hours (default 1). */
  previewPerWalletDaily: number;
  /** Preview ratings on the chain per 24 hours, all wallets together (default 20). */
  previewDaily: number;
  /** Previews a wallet may create per 24 hours (default 5): rows, not ratings. */
  previewCreatesPerWalletDaily: number;
  /** The most a preview rating may take (default 45 minutes). */
  previewBudgetCeilingMs: number;
  /** Connection checks per wallet per hour (default 10). */
  checksPerWalletHourly: number;
  /** Connection checks on the chain per hour, all wallets together (default 30). */
  checksHourly: number;
  /** Agent URL registrations and verifications (each calls out) per wallet per hour (default 10). */
  urlVerifiesPerWalletHourly: number;
  /** Agent URL registrations and verifications per hour, all wallets together (default 100). */
  urlVerifiesHourly: number;
}

export const DEFAULT_REMOTE_POLICY: RemoteRatingPolicy = {
  // The hosted profile's size, which `pnpm arena rate --profile hosted` also runs.
  repeats: HOSTED_REMOTE_PROFILE.repeats,
  perOwnerDaily: 3,
  perAgentDaily: 2,
  laneDaily: 20,
  // Each episode's deadline (REMOTE_EPISODE_TIMEOUT_MS's default): budgeting less per episode
  // stopped agents that kept to every deadline, as the first stock-trading dry run found.
  episodeBudgetMs: HOSTED_REMOTE_PROFILE.episodeTimeoutMs,
  budgetCeilingMs: 3 * 3_600_000,
  perAgentMs: 3_600_000,
  heldOutPerClass: HOSTED_REMOTE_PROFILE.heldOutPerClass,
  // Previews are free to the user and paid for in compute, so they are tightly capped and run
  // one at a time, after official ratings.
  previewPerWalletDaily: 1,
  previewDaily: 20,
  previewCreatesPerWalletDaily: 5,
  previewBudgetCeilingMs: 45 * 60_000,
  checksPerWalletHourly: 10,
  checksHourly: 30,
  urlVerifiesPerWalletHourly: 10,
  urlVerifiesHourly: 100,
};

/**
 * The policy as configured: the defaults, with any of REMOTE_REPEATS,
 * REMOTE_RATINGS_PER_OWNER_DAILY, REMOTE_RATINGS_PER_AGENT_DAILY, REMOTE_RATINGS_DAILY,
 * REMOTE_EPISODE_BUDGET_MS, REMOTE_RATING_MAX_MS, REMOTE_RATING_INTERVAL_MS,
 * HELD_OUT_FRESH_PER_CLASS, PREVIEW_PER_WALLET_DAILY, PREVIEW_DAILY, PREVIEW_CREATES_PER_WALLET_DAILY,
 * PREVIEW_RATING_MAX_MS, CHECKS_PER_WALLET_HOURLY, CHECKS_HOURLY,
 * AGENT_URL_VERIFIES_PER_WALLET_HOURLY and AGENT_URL_VERIFIES_HOURLY set in the environment. Every path that
 * rates an operator-run agent (owner requests, renewals, TEE re-ratings) reads it here. Bounty
 * acceptances don't re-rate them: bounty attacks are never run against an agent its operator runs.
 */
export function remotePolicyFromEnv(
  env: Record<string, string | undefined> = process.env,
): RemoteRatingPolicy {
  const int = (name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER) =>
    z.coerce
      .number()
      .int()
      .min(min)
      .max(max)
      .parse(env[name] ?? fallback);
  const d = DEFAULT_REMOTE_POLICY;
  return {
    repeats: int("REMOTE_REPEATS", d.repeats),
    perOwnerDaily: int("REMOTE_RATINGS_PER_OWNER_DAILY", d.perOwnerDaily),
    perAgentDaily: int("REMOTE_RATINGS_PER_AGENT_DAILY", d.perAgentDaily),
    laneDaily: int("REMOTE_RATINGS_DAILY", d.laneDaily),
    episodeBudgetMs: int("REMOTE_EPISODE_BUDGET_MS", d.episodeBudgetMs, 1000),
    budgetCeilingMs: int("REMOTE_RATING_MAX_MS", d.budgetCeilingMs, 60_000),
    perAgentMs: int("REMOTE_RATING_INTERVAL_MS", d.perAgentMs, 0),
    heldOutPerClass: int("HELD_OUT_FRESH_PER_CLASS", d.heldOutPerClass, 0, 5),
    previewPerWalletDaily: int("PREVIEW_PER_WALLET_DAILY", d.previewPerWalletDaily, 0),
    previewDaily: int("PREVIEW_DAILY", d.previewDaily, 0),
    previewCreatesPerWalletDaily: int(
      "PREVIEW_CREATES_PER_WALLET_DAILY",
      d.previewCreatesPerWalletDaily,
    ),
    previewBudgetCeilingMs: int("PREVIEW_RATING_MAX_MS", d.previewBudgetCeilingMs, 60_000),
    checksPerWalletHourly: int("CHECKS_PER_WALLET_HOURLY", d.checksPerWalletHourly),
    checksHourly: int("CHECKS_HOURLY", d.checksHourly),
    urlVerifiesPerWalletHourly: int(
      "AGENT_URL_VERIFIES_PER_WALLET_HOURLY",
      d.urlVerifiesPerWalletHourly,
    ),
    urlVerifiesHourly: int("AGENT_URL_VERIFIES_HOURLY", d.urlVerifiesHourly),
  };
}

/** The policy's caps, as the database applies them at `nowMs`. */
export function remoteQuota(policy: RemoteRatingPolicy, nowMs: number): RemoteQuota {
  return {
    nowMs,
    perOwnerDaily: policy.perOwnerDaily,
    perAgentDaily: policy.perAgentDaily,
    laneDaily: policy.laneDaily,
  };
}

/** Benign twins a rating runs once each (the Task score), read once from the seed folder. */
let twins: number | undefined;
export function benignTwins(): number {
  return (twins ??= loadBenignSeeds().length);
}

/**
 * A remote rating's size and time budget: every published attack `repeats` times, the held-out
 * set made for it, the controls and the benign twins; `budgetMs` is the episodes at
 * `episodeBudgetMs` each, never more than the ceiling.
 */
export function remoteRatingPlan(
  policy: RemoteRatingPolicy,
  input: { publishedAttacks: number; repeats?: number; heldOut: number; benign?: number },
): { episodes: number; budgetMs: number } {
  const episodes =
    (input.publishedAttacks + input.heldOut) * (input.repeats ?? policy.repeats) +
    REMOTE_CONTROLS +
    (input.benign ?? benignTwins());
  return {
    episodes,
    budgetMs: Math.min(policy.budgetCeilingMs, episodes * policy.episodeBudgetMs),
  };
}

/** Plain words for a remote rating the caps or the cooldown refuse. */
export function remoteRefusalMessage(
  refusal:
    | { refused: "cooldown"; nextAt: Date }
    | { refused: "owner-daily" | "agent-daily" | "lane-daily" },
  policy: RemoteRatingPolicy,
): string {
  switch (refusal.refused) {
    case "cooldown":
      return `the agent's last rating was stopped by the agent, so the next waits until ${refusal.nextAt.toISOString()} (the wait doubles with each stop in a row, up to 48 hours)`;
    case "owner-daily":
      return `at most ${policy.perOwnerDaily} ratings a day per owner, across their agents; try again tomorrow`;
    case "agent-daily":
      return `at most ${policy.perAgentDaily} ratings a day per agent; try again tomorrow`;
    case "lane-daily":
      return "today's ratings of operator-run agents are used up; try again tomorrow";
  }
}

/** A connection check's time budget: one episode, 120 seconds. */
export const CHECK_BUDGET_MS = 120_000;

/**
 * A connection check's time budget in `world`: one episode at its deadline plus 30 s to set up. A
 * stock-trading episode gets 240 s, as in its rating, so its check gets 270.
 */
export function checkBudgetMs(world: string | null | undefined): number {
  return world === "brokerage" ? BROKERAGE_EPISODE_TIMEOUT_MS + 30_000 : CHECK_BUDGET_MS;
}

/**
 * A preview rating's size and time budget: every published attack once, the held-out set made
 * for it (one per class by default), the controls and the benign twins; 90 s an episode, at most
 * 45 minutes.
 */
export function previewRatingPlan(
  policy: RemoteRatingPolicy,
  input: { publishedAttacks: number; heldOut: number; benign?: number },
): { episodes: number; budgetMs: number } {
  const episodes =
    input.publishedAttacks + input.heldOut + REMOTE_CONTROLS + (input.benign ?? benignTwins());
  return {
    episodes,
    budgetMs: Math.min(policy.previewBudgetCeilingMs, episodes * policy.episodeBudgetMs),
  };
}

/** Plain words for a preview the caps refuse, with when to try again. */
export function previewRefusalMessage(
  refusal: { refused: "wallet-daily" | "daily"; nextAt: Date } | { refused: "busy" },
  policy: RemoteRatingPolicy,
): string {
  switch (refusal.refused) {
    case "busy":
      return "This preview already has a rating queued or running.";
    case "wallet-daily":
      return `You can run at most ${policy.previewPerWalletDaily} preview ${policy.previewPerWalletDaily === 1 ? "rating" : "ratings"} a day. Try again after ${refusal.nextAt.toISOString()}.`;
    case "daily":
      return `Today's preview ratings are used up. Try again after ${refusal.nextAt.toISOString()}.`;
  }
}

/**
 * A stock-trading preview's size and time budget: the control, every staged attack and every
 * benign twin once, at each episode's whole deadline (BROKERAGE_EPISODE_TIMEOUT_MS, or
 * `episodeBudgetMs` if that is set higher) under the preview ceiling. A hosted agent's episodes run
 * several at a time, so its preview gets the whole ceiling.
 */
export function brokeragePreviewPlan(
  policy: RemoteRatingPolicy,
  hosted = false,
): { episodes: number; budgetMs: number } {
  const episodes = brokeragePreviewSize("plain");
  return {
    episodes,
    budgetMs: hosted
      ? policy.previewBudgetCeilingMs
      : Math.min(
          policy.previewBudgetCeilingMs,
          episodes * Math.max(policy.episodeBudgetMs, BROKERAGE_EPISODE_TIMEOUT_MS),
        ),
  };
}
