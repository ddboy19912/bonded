import { describe, expect, it } from "vitest";
import { brokeragePreviewSize, HOSTED_REMOTE_PROFILE, loadBenignSeeds } from "@bonded/arena";
import { REMOTE_EPISODE_TIMEOUT_MS } from "../src/remote-agent.js";
import {
  DEFAULT_REMOTE_POLICY,
  remotePolicyFromEnv,
  remoteQuota,
  remoteRatingPlan,
  previewRatingPlan,
  benignTwins,
  brokeragePreviewPlan,
} from "../src/remote-policy.js";

describe("remotePolicyFromEnv", () => {
  it("is the defaults with nothing set", () => {
    expect(remotePolicyFromEnv({})).toEqual(DEFAULT_REMOTE_POLICY);
  });

  it("takes every setting from the environment, one source for the API, worker and bounties", () => {
    const policy = remotePolicyFromEnv({
      REMOTE_REPEATS: "2",
      REMOTE_RATINGS_PER_OWNER_DAILY: "7",
      REMOTE_RATINGS_PER_AGENT_DAILY: "4",
      REMOTE_RATINGS_DAILY: "50",
      REMOTE_EPISODE_BUDGET_MS: "30000",
      REMOTE_RATING_MAX_MS: "3600000",
      REMOTE_RATING_INTERVAL_MS: "600000",
      HELD_OUT_FRESH_PER_CLASS: "2",
      PREVIEW_PER_WALLET_DAILY: "3",
      PREVIEW_DAILY: "9",
      PREVIEW_CREATES_PER_WALLET_DAILY: "6",
      PREVIEW_RATING_MAX_MS: "600000",
      CHECKS_PER_WALLET_HOURLY: "4",
      CHECKS_HOURLY: "12",
      AGENT_URL_VERIFIES_PER_WALLET_HOURLY: "3",
      AGENT_URL_VERIFIES_HOURLY: "30",
    });
    expect(policy).toEqual({
      repeats: 2,
      perOwnerDaily: 7,
      perAgentDaily: 4,
      laneDaily: 50,
      episodeBudgetMs: 30_000,
      budgetCeilingMs: 3_600_000,
      perAgentMs: 600_000,
      heldOutPerClass: 2,
      previewPerWalletDaily: 3,
      previewDaily: 9,
      previewCreatesPerWalletDaily: 6,
      previewBudgetCeilingMs: 600_000,
      checksPerWalletHourly: 4,
      checksHourly: 12,
      urlVerifiesPerWalletHourly: 3,
      urlVerifiesHourly: 30,
    });
    expect(remoteQuota(policy, 5)).toEqual({
      nowMs: 5,
      perOwnerDaily: 7,
      perAgentDaily: 4,
      laneDaily: 50,
    });
    expect(remoteRatingPlan(policy, { publishedAttacks: 50, heldOut: 10 })).toEqual({
      episodes: 126 + benignTwins(),
      budgetMs: 3_600_000,
    });
    // A preview: the library once, the held-out set, 6 controls and the benign twins; 30 s an
    // episode here, capped.
    expect(previewRatingPlan(policy, { publishedAttacks: 10, heldOut: 4, benign: 0 })).toEqual({
      episodes: 20,
      budgetMs: 600_000,
    });
    expect(previewRatingPlan(policy, { publishedAttacks: 2, heldOut: 0, benign: 11 })).toEqual({
      episodes: 19,
      budgetMs: 570_000,
    });
    expect(benignTwins()).toBe(loadBenignSeeds().length);
  });

  it("sizes a default preview as the spec says: 90 s an episode, at most 45 minutes", () => {
    expect(previewRatingPlan(DEFAULT_REMOTE_POLICY, { publishedAttacks: 70, heldOut: 10 })).toEqual(
      {
        episodes: 86 + benignTwins(),
        budgetMs: 45 * 60_000,
      },
    );
    expect(
      previewRatingPlan(DEFAULT_REMOTE_POLICY, { publishedAttacks: 4, heldOut: 0, benign: 0 }),
    ).toEqual({
      episodes: 10,
      budgetMs: 900_000,
    });
    expect(DEFAULT_REMOTE_POLICY).toMatchObject({
      previewPerWalletDaily: 1,
      previewDaily: 20,
      checksPerWalletHourly: 10,
    });
    // Turning previews off is allowed: 0 a day.
    expect(remotePolicyFromEnv({ PREVIEW_DAILY: "0" }).previewDaily).toBe(0);
  });

  it("refuses a setting that isn't a positive whole number", () => {
    expect(() => remotePolicyFromEnv({ REMOTE_RATINGS_DAILY: "0" })).toThrow();
    expect(() => remotePolicyFromEnv({ REMOTE_REPEATS: "two" })).toThrow();
    expect(() => remotePolicyFromEnv({ REMOTE_RATING_INTERVAL_MS: "-1" })).toThrow();
    expect(() => remotePolicyFromEnv({ HELD_OUT_FRESH_PER_CLASS: "6" })).toThrow();
    // No wait between ratings, and no held-out set, are allowed (local runs and tests).
    expect(remotePolicyFromEnv({ REMOTE_RATING_INTERVAL_MS: "0" }).perAgentMs).toBe(0);
    expect(remotePolicyFromEnv({ HELD_OUT_FRESH_PER_CLASS: "0" }).heldOutPerClass).toBe(0);
  });

  it("matches the hosted profile the arena CLI runs locally", () => {
    expect(DEFAULT_REMOTE_POLICY.repeats).toBe(HOSTED_REMOTE_PROFILE.repeats);
    expect(DEFAULT_REMOTE_POLICY.heldOutPerClass).toBe(HOSTED_REMOTE_PROFILE.heldOutPerClass);
    expect(REMOTE_EPISODE_TIMEOUT_MS).toBe(HOSTED_REMOTE_PROFILE.episodeTimeoutMs);
    // The budget gives each episode its whole deadline, so an agent that keeps to every deadline
    // isn't stopped for running past the budget.
    expect(DEFAULT_REMOTE_POLICY.episodeBudgetMs).toBe(REMOTE_EPISODE_TIMEOUT_MS);
  });
});

describe("brokeragePreviewPlan", () => {
  it("gives an operator-run stock-trading preview 90 s an episode, a hosted one the ceiling", () => {
    const run = brokeragePreviewPlan(DEFAULT_REMOTE_POLICY);
    expect(run.episodes).toBe(brokeragePreviewSize("plain"));
    expect(run.budgetMs).toBe(
      Math.min(45 * 60_000, brokeragePreviewSize("plain") * REMOTE_EPISODE_TIMEOUT_MS),
    );
    // The dry run's preview: 20 episodes got 13 minutes, and an agent at about 60 s an episode
    // was stopped after 13. Now it has 30.
    expect(brokeragePreviewSize("plain")).toBe(20);
    expect(run.budgetMs).toBe(30 * 60_000);
    expect(brokeragePreviewPlan(DEFAULT_REMOTE_POLICY, true).budgetMs).toBe(45 * 60_000);
    // A lower ceiling still caps it.
    const low = { ...DEFAULT_REMOTE_POLICY, previewBudgetCeilingMs: 10 * 60_000 };
    expect(brokeragePreviewPlan(low).budgetMs).toBe(10 * 60_000);
  });
});
