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
  const glm = data.comparisons.find((row) => row.model === "z-ai/glm-5.3-flash");

  it("leads with the like-for-like GLM run, and only that", () => {
    // Muse's row compared attacks delivered in the briefing with fetched AgentDojo ones: dropped.
    expect(data.comparisons.map((row) => row.model)).toEqual(["z-ai/glm-5.3-flash"]);
    expect(glm?.headline).toBe(true);
  });

  it("records every portable seed against AgentDojo's attack, same job, harness and delivery", () => {
    expect(glm?.bonded.fell).toBe(14);
    expect(glm?.bonded.countedEpisodes).toBe(208);
    expect(glm?.bonded.notMet).toBe(14);
    expect(glm?.bonded.lossUsd).toBe(15440);
    expect(glm?.bonded.overpaidUsd).toBe(4180);
    expect(glm && attackExecuted(glm.agentdojo)).toBe(0);
    expect(glm && pairsOf(glm.agentdojo)).toBe(222);
    expect(glm && utilityOf(glm.agentdojo)).toBe(214);
    expect(glm && directAskOf(glm.agentdojo)).toEqual({ done: 0, total: 111 });
  });

  it("adds up: falls to the count, the loss to the falls, met and unmet to the episodes", () => {
    const falls = glm?.bonded.falls ?? [];
    expect(falls.reduce((n, fall) => n + fall.fell, 0)).toBe(glm?.bonded.fell);
    expect(falls.reduce((n, fall) => n + fall.lossUsd, 0)).toBe(glm?.bonded.lossUsd);
    expect((glm?.bonded.countedEpisodes ?? 0) + (glm?.bonded.notMet ?? 0)).toBe(
      glm?.bonded.tasksTotal,
    );
  });

  it("records invoices paid right beside the whole job, on the same episodes", () => {
    expect(glm?.bonded.tasksDone).toBe(127);
    expect(glm?.bonded.paymentsDone).toBe(201);
    expect(glm?.bonded.tasksTotal).toBe(222);
  });

  it("rejects a paid-right count above the episodes it covers", () => {
    const row = data.comparisons[0]!;
    const broken = {
      ...data,
      comparisons: [{ ...row, bonded: { ...row.bonded, paymentsDone: row.bonded.tasksTotal + 1 } }],
    };
    expect(() => loadBenchComparison(broken)).toThrow(/paymentsDone is out of range/);
  });
});
