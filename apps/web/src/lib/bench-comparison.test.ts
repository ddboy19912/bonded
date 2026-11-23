import { describe, expect, it } from "vitest";
import {
  attackExecuted,
  directAskOf,
  loadBenchComparison,
  pairsOf,
  utilityOf,
} from "./bench-comparison";

describe("bench comparison record", () => {
  const data = loadBenchComparison();
  const muse = data.comparisons.find((row) => row.model === "muse-spark-1.3");
  const glm = data.comparisons.find((row) => row.model === "z-ai/glm-5.3-flash");

  it("keeps one headline comparison", () => {
    expect(data.comparisons.filter((row) => row.headline)).toHaveLength(1);
    expect(muse?.headline).toBe(true);
  });

  it("records Muse falling on Bonded and holding on AgentDojo", () => {
    expect(muse?.bonded.fell).toBe(4);
    expect(muse?.bonded.countedEpisodes).toBe(178);
    expect(muse?.bonded.lossUsd).toBe(6160);
    expect(muse && attackExecuted(muse.agentdojo)).toBe(0);
    expect(muse && pairsOf(muse.agentdojo)).toBe(576);
    expect(muse && utilityOf(muse.agentdojo)).toBe(493);
    expect(muse && directAskOf(muse.agentdojo)).toEqual({ done: 27, total: 36 });
  });

  it("records invoices paid right beside the whole job, on the same episodes", () => {
    expect(muse?.bonded.tasksDone).toBe(58);
    expect(muse?.bonded.paymentsDone).toBe(300);
    expect(muse?.bonded.tasksTotal).toBe(306);
    expect(glm?.bonded.tasksDone).toBe(4);
    expect(glm?.bonded.paymentsDone).toBe(16);
    expect(glm?.bonded.tasksTotal).toBe(36);
  });

  it("rejects a paid-right count above the episodes it covers", () => {
    const row = data.comparisons[0]!;
    const broken = {
      ...data,
      comparisons: [{ ...row, bonded: { ...row.bonded, paymentsDone: row.bonded.tasksTotal + 1 } }],
    };
    expect(() => loadBenchComparison(broken)).toThrow(/paymentsDone is out of range/);
  });

  it("records the smaller GLM check on both benches", () => {
    expect(glm?.bonded.fell).toBe(18);
    expect(glm?.bonded.countedEpisodes).toBe(36);
    expect(glm && attackExecuted(glm.agentdojo)).toBe(0);
    expect(glm && pairsOf(glm.agentdojo)).toBe(144);
    expect(glm && utilityOf(glm.agentdojo)).toBe(131);
  });
});
