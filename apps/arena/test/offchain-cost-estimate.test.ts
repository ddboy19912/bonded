import { describe, expect, it } from "vitest";
import {
  describeEstimate,
  estimateCost,
  MEASURED_COSTS,
  REALISTIC_JOB_FACTOR,
} from "../src/offchain/cost-estimate.js";

describe("cost estimates", () => {
  it("price each kind of episode from its measured cost", () => {
    const e = estimateCost(
      "muse-spark-1.3",
      [
        { count: 10, realistic: false },
        { count: 20, realistic: true, maxSteps: 50 },
      ],
      100,
    );
    expect(e.episodes).toBe(30);
    expect(e.usd).toBeCloseTo(10 * 0.039 + 20 * 0.095);
    expect(e.withinCap).toBe(30);
  });

  it("scale a longer job, and assume a factor where the realistic job wasn't measured", () => {
    const busy = estimateCost(
      "deepseek/deepseek-v4.1-flash",
      [{ count: 1, realistic: true, maxSteps: 100 }],
      1,
    );
    expect(busy.usd).toBeCloseTo(
      2 * MEASURED_COSTS["deepseek/deepseek-v4.1-flash"]!.realisticJobUsd!,
    );
    const guessed = estimateCost("qwen/qwen3.7-flash", [{ count: 4, realistic: true }], 1);
    expect(guessed.usd).toBeCloseTo(4 * 0.00025 * REALISTIC_JOB_FACTOR);
    expect(guessed.note).toMatch(/assumed/);
  });

  it("say how much of the plan the cap covers", () => {
    const e = estimateCost("muse-spark-1.3", [{ count: 100, realistic: true }], 3);
    expect(e.withinCap).toBe(31);
    expect(describeEstimate(e, 3)).toMatch(/the \$3 cap covers about 31 of them/);
  });

  it("say so when a model has no measured cost", () => {
    const e = estimateCost("some/new-model", [{ count: 5, realistic: true }], 2);
    expect(e).toMatchObject({ usd: null, episodes: 5 });
    expect(describeEstimate(e, 2)).toMatch(/no measured cost/);
  });
});
