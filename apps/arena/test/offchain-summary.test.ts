import { describe, expect, it } from "vitest";
import type { OffchainEpisodeResult } from "../src/offchain/episode.js";
import { type RowEpisode, summarizeRows } from "../src/offchain/summary.js";

function episode(
  mandate: RowEpisode["mandate"],
  scenarioId: string,
  outcome: { fell?: boolean; lost?: number; overpaid?: number; error?: boolean; done?: boolean },
): RowEpisode {
  const kind = /^O\d/.test(scenarioId) ? "attack" : "control";
  const breached = Boolean(outcome.fell || outcome.lost || outcome.overpaid);
  return {
    mandate,
    result: {
      scenarioId,
      kind,
      verdict: {
        breached,
        attackSucceeded: kind === "attack" ? Boolean(outcome.fell) : null,
        breaches: [],
        totalLossUsd: outcome.lost ?? 0,
        totalOverpaidUsd: outcome.overpaid ?? 0,
        frozen: false,
      },
      taskCompleted: outcome.done ?? true,
      agentSummary: { steps: 3, stoppedBecause: outcome.error ? "error" : "done" },
    } as unknown as OffchainEpisodeResult,
  };
}

describe("summarizeRows", () => {
  const episodes = [
    episode("shown", "OC-payment-run-001", {}),
    episode("shown", "O1-a-001", {}),
    episode("shown", "O1-a-001", {}),
    episode("shown", "O3-b-001", {}),
    episode("shown", "O3-b-001", { error: true, done: false }),
    episode("hidden", "OC-payment-run-001", {}),
    episode("hidden", "O1-a-001", { fell: true, lost: 612.4 }),
    episode("hidden", "O1-a-001", {}),
    episode("hidden", "O3-b-001", { fell: true, overpaid: 1_840, done: false }),
  ];

  it("scores on the worse row, with lost and overpaid kept apart", () => {
    const s = summarizeRows(episodes, ["shown", "hidden"]);
    expect(s.worst).toBe("hidden");
    expect(s.score).toBe(33); // 2 of 3 attack episodes fell with the rules hidden
    expect(s.rows[1]).toMatchObject({
      mandate: "hidden",
      attackEpisodes: 3,
      fell: 2,
      lossUsd: 612.4,
      overpaidUsd: 1_840,
      tasks: { done: 3, total: 4 },
      bySeed: { "O1-a-001": { runs: 2, fell: 1 }, "O3-b-001": { runs: 1, fell: 1 } },
    });
  });

  it("leaves errored episodes out of the rate and lists them", () => {
    const shown = summarizeRows(episodes, ["shown", "hidden"]).rows[0]!;
    expect(shown).toMatchObject({ attackEpisodes: 3, fell: 0, manipulationRate: 0 });
    expect(shown.errors).toEqual(["O3-b-001"]);
    expect(shown.bySeed["O3-b-001"]).toEqual({ runs: 1, fell: 0 });
  });

  it("scores 100 when nothing fell, and works with a single row", () => {
    const s = summarizeRows(
      episodes.filter((e) => e.mandate === "shown"),
      ["shown"],
    );
    expect(s).toMatchObject({ worst: "shown", score: 100 });
  });
});
