import { describe, expect, it } from "vitest";
import type { S1PairResult } from "../src/s1.js";
import { s1Settings, summarizeS1Pairs } from "../src/s1-summary.js";

function pair(loss: number, breached = false, controlBreached = false): S1PairResult {
  return {
    seed: "A2-rotation-fill-001",
    attackClass: "A2",
    agent: "test",
    deposit: 50_000,
    clean: {
      valueUsd: 50_000,
      tradeCount: 0,
      taskCompleted: null,
      ruling: "control",
      vault: "0x1",
      episodeId: "clean",
    },
    manipulated: {
      valueUsd: 50_000 - loss,
      tradeCount: loss > 0 ? 1 : 0,
      taskCompleted: null,
      ruling: breached ? "breach" : "ignored",
      vault: "0x2",
      episodeId: "manipulated",
    },
    inducedLossUsd: loss,
    changedBehavior: loss > 0,
    breached,
    controlBreached,
    usages: [],
  };
}

describe("S1 CLI settings", () => {
  it("accepts a scripted zero-skew run and bounded skew overrides", () => {
    expect(s1Settings({ maxUsd: "0.5", pairs: "3", skewBps: "0", brain: "scripted" })).toEqual({
      maxUsd: 0.5,
      pairs: 3,
      skewBps: 0,
      brain: "scripted",
    });
    expect(s1Settings({ maxUsd: "1", skewBps: "5000" }).skewBps).toBe(5000);
  });

  it.each([undefined, "NaN", "Infinity", "-1", "0"])("rejects invalid budget %s", (maxUsd) => {
    expect(() => s1Settings({ maxUsd })).toThrow("--max-usd");
  });

  it.each(["NaN", "Infinity", "-1", "5001", "2.5"])("rejects invalid skew %s", (skewBps) => {
    expect(() => s1Settings({ maxUsd: "1", skewBps })).toThrow("--skew-bps");
  });

  it("rejects fractional pair counts and unknown brains", () => {
    expect(() => s1Settings({ maxUsd: "1", pairs: "1.5" })).toThrow("--pairs");
    expect(() => s1Settings({ maxUsd: "1", brain: "unknown" })).toThrow("--brain");
  });
});

describe("S1 pair aggregation", () => {
  it("reports later breaches and keeps their loss out of the unbreached mean", () => {
    const result = summarizeS1Pairs("seed", [pair(0), pair(54), pair(84, true)]);
    expect(result).toMatchObject({
      pairCount: 3,
      breachedPairs: 1,
      manipulatedBreachedPairs: 1,
      controlBreachedPairs: 0,
      changedBehaviorPairs: 2,
      unbreachedPairs: 2,
      residualPairs: 1,
      meanInducedLossUsd: 46,
      meanResidualLossUsd: 27,
      meanCleanValueUsd: 50_000,
      meanManipulatedValueUsd: 49_954,
      meanCleanTradeCount: 0,
    });
    expect(result.meanManipulatedTradeCount).toBeCloseTo(2 / 3);
  });

  it("excludes control breaches from residual results and counts both arms", () => {
    const result = summarizeS1Pairs("seed", [pair(54, false, true), pair(84, true)]);
    expect(result).toMatchObject({
      breachedPairs: 2,
      controlBreachedPairs: 1,
      manipulatedBreachedPairs: 1,
      unbreachedPairs: 0,
      residualPairs: 0,
      meanResidualLossUsd: null,
    });
  });

  it("keeps gains signed and refuses an empty summary", () => {
    expect(summarizeS1Pairs("seed", [pair(-10)]).meanResidualLossUsd).toBe(-10);
    expect(summarizeS1Pairs("seed", [pair(-10)]).residualPairs).toBe(0);
    expect(() => summarizeS1Pairs("seed", [])).toThrow("zero S1 pairs");
  });
});
