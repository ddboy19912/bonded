import { BondedIndexEntry } from "@bondedhq/shared";
import { describe, expect, it } from "vitest";
import type { BatchResult } from "../src/offchain/batch.js";
import type { OffchainEpisodeResult } from "../src/offchain/episode.js";
import { attackSetHash, INDEX_MODELS, indexEntry, withEntry } from "../src/offchain/index-sweep.js";
import { loadOffchainSeeds } from "../src/offchain/seeds.js";
import { type RowEpisode, summarizeRows } from "../src/offchain/summary.js";

const seeds = loadOffchainSeeds();

function episode(
  mandate: RowEpisode["mandate"],
  scenarioId: string,
  attackClass: string | undefined,
  outcome: { fell?: boolean; lost?: number; overpaid?: number } = {},
): RowEpisode {
  const breached = Boolean(outcome.fell);
  return {
    mandate,
    result: {
      scenarioId,
      kind: attackClass ? "attack" : "control",
      ...(attackClass ? { attackClass } : {}),
      verdict: {
        breached,
        attackSucceeded: attackClass ? breached : null,
        breaches: [],
        totalLossUsd: outcome.lost ?? 0,
        totalOverpaidUsd: outcome.overpaid ?? 0,
        frozen: false,
      },
      taskCompleted: true,
      agentSummary: { steps: 3, stoppedBecause: "done" },
    } as unknown as OffchainEpisodeResult,
  };
}

const episodes = [
  episode("shown", "OC-payment-run-001", undefined),
  episode("shown", "O1-a-001", "O1"),
  episode("shown", "O3-b-001", "O3"),
  episode("hidden", "OC-payment-run-001", undefined),
  episode("hidden", "O1-a-001", "O1", { fell: true, lost: 612.4 }),
  episode("hidden", "O3-b-001", "O3", { fell: true, overpaid: 1_840 }),
];
const batch: BatchResult = {
  episodes,
  summary: summarizeRows(episodes, ["shown", "hidden"]),
  notShown: ["O4-image-fine-print-001"],
  skipped: [],
  counterpartyTurns: { turns: 0, refused: 0 },
};

const entry = indexEntry({
  model: INDEX_MODELS.find((m) => m.model === "deepseek/deepseek-v4.1-flash")!,
  agent: "payables-agent",
  batch,
  attackSeeds: seeds,
  variants: 0,
  runs: 1,
  attacker: {
    candidates: [{ seed: "x", kept: false, reason: "refused", attempts: 2, refusals: 1 }],
    probes: { O6: { asked: 5, replied: 4, refused: 1, failed: 0, refusals: [] } },
  },
  spend: { spentUsd: 0.3, estimated: false },
  ranAt: "2026-10-27T10:00:00.000Z",
});

describe("indexEntry", () => {
  it("builds a valid entry with intervals, classes and the worse row's score", () => {
    expect(BondedIndexEntry.parse(entry)).toEqual(entry);
    expect(entry).toMatchObject({ score: 0, worst: "hidden", rail: "offchain" });
    const hidden = entry.rows.find((r) => r.mandate === "hidden")!;
    expect(hidden).toMatchObject({
      fell: 2,
      attackEpisodes: 2,
      lossUsd: 612.4,
      overpaidUsd: 1_840,
      byClass: { O1: { episodes: 1, fell: 1 }, O3: { episodes: 1, fell: 1 } },
    });
    expect(hidden.interval[0]).toBeGreaterThan(0.3); // 2 of 2 is still uncertain
    expect(entry.scoreInterval[0]).toBe(0);
    expect(entry.scoreInterval[1]).toBeGreaterThan(30);
    expect(entry.attacker).toEqual({
      drafts: { attempts: 2, refused: 1 },
      probe: { asked: 5, refused: 1, failed: 0 },
    });
    expect(entry.cost).toEqual({
      spentUsd: 0.3,
      estimated: false,
      episodes: 6,
      perThousandEpisodesUsd: 50,
    });
    expect(entry.attacks).toMatchObject({ notShown: ["O4-image-fine-print-001"], variants: 0 });
  });
});

describe("text tool calls", () => {
  it("are counted in the entry when the agent read any", () => {
    expect(entry).not.toHaveProperty("textToolCalls");
    const withText: BatchResult = {
      ...batch,
      episodes: batch.episodes.map((e) => ({
        ...e,
        result: { ...e.result, agentSummary: { ...e.result.agentSummary, textToolCalls: 2 } },
      })),
    };
    const e = indexEntry({
      model: INDEX_MODELS[0]!,
      agent: "payables-agent",
      batch: withText,
      attackSeeds: seeds,
      variants: 0,
      runs: 1,
      attacker: { candidates: [], probes: {} },
      spend: { spentUsd: 0, estimated: false },
      ranAt: "2026-10-27T10:00:00.000Z",
    });
    expect(e.textToolCalls).toBe(12);
  });
});

describe("withEntry", () => {
  it("replaces a model's earlier entry and keeps the Index's model order", () => {
    const muse = { ...entry, model: "muse-spark-1.3", label: "Muse Spark 1.3" };
    let index = withEntry(undefined, entry);
    index = withEntry(index, muse);
    index = withEntry(index, { ...entry, score: 91 });
    expect(index.entries.map((e) => [e.model, e.score])).toEqual([
      ["muse-spark-1.3", 0],
      ["deepseek/deepseek-v4.1-flash", 91],
    ]);
  });
});

describe("attackSetHash", () => {
  it("depends on the seeds, not their order", () => {
    expect(attackSetHash([...seeds].reverse())).toBe(attackSetHash(seeds));
    expect(attackSetHash(seeds.slice(1))).not.toBe(attackSetHash(seeds));
  });
});
