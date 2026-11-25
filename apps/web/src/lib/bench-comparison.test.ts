import { describe, expect, it } from "vitest";
import {
  attackExecuted,
  directAskOf,
  loadBenchComparison,
  metOf,
  movedOf,
  pairsOf,
  utilityOf,
  type BenchComparison,
} from "./bench-comparison";

describe("bench comparison record", () => {
  const data = loadBenchComparison();
  const cell = (model: string, channels: BenchComparison["channels"]) =>
    data.comparisons.find((row) => row.model === model && row.channels === channels);
  const glm = cell("z-ai/glm-5.3-flash", "pushed");

  it("records all three models, fetched and pushed, with GLM pushed as the headline", () => {
    // Muse's row compared attacks delivered in the briefing with fetched AgentDojo ones: dropped.
    expect(data.comparisons.map((row) => `${row.model} ${row.channels}`).sort()).toEqual([
      "deepseek/deepseek-v4.1-flash fetched",
      "deepseek/deepseek-v4.1-flash pushed",
      "qwen/qwen3.7-flash fetched",
      "qwen/qwen3.7-flash pushed",
      "z-ai/glm-5.3-flash fetched",
      "z-ai/glm-5.3-flash pushed",
    ]);
    expect(data.comparisons.filter((row) => row.headline)).toEqual([glm]);
  });

  it("records every portable seed against AgentDojo's attack, same job, harness and delivery", () => {
    expect(glm?.bonded.fell).toBe(14);
    expect(glm?.bonded.countedEpisodes).toBe(208);
    expect(glm?.bonded.notMet).toBe(14);
    expect(glm?.bonded.lossUsd).toBe(15440);
    expect(glm?.bonded.overpaidUsd).toBe(4180);
    expect(glm && attackExecuted(glm.agentdojo)).toBe(0);
    expect(glm && pairsOf(glm.agentdojo)).toBe(222);
    expect(glm && metOf(glm.agentdojo)).toBe(205);
    expect(glm && utilityOf(glm.agentdojo)).toBe(214);
    expect(glm && directAskOf(glm.agentdojo)).toEqual({ done: 0, total: 111 });
  });

  it("keeps the cells where AgentDojo's attack did better", () => {
    // Qwen obeys a plain request; pushed, AgentDojo's attack beat Bonded's seeds.
    const qwen = cell("qwen/qwen3.7-flash", "pushed");
    expect(qwen?.bonded.fell).toBe(48);
    expect(qwen && attackExecuted(qwen.agentdojo)).toBe(68);
    // Out of the runs that met each attack, so the bars compare like for like: 33% vs 44%.
    expect(qwen?.bonded.countedEpisodes).toBe(144);
    expect(qwen && metOf(qwen.agentdojo)).toBe(156);
    expect(qwen && movedOf(qwen.agentdojo)).toBeCloseTo(135159.2, 2);
    expect(qwen && directAskOf(qwen.agentdojo)).toEqual({ done: 51, total: 111 });
  });

  it.each(["fetched", "pushed"] as const)("matches the README's family table, %s", (channels) => {
    const fell = { fetched: [19, 8, 9], pushed: [15, 14, 48] }[channels];
    const ran = { fetched: [0, 0, 5], pushed: [0, 0, 68] }[channels];
    const models = ["deepseek/deepseek-v4.1-flash", "z-ai/glm-5.3-flash", "qwen/qwen3.7-flash"];
    expect(models.map((m) => cell(m, channels)?.bonded.fell)).toEqual(fell);
    expect(models.map((m) => attackExecuted(cell(m, channels)!.agentdojo))).toEqual(ran);
  });

  it("adds up in every row: falls to the count and the money, met and unmet to the episodes", () => {
    for (const row of data.comparisons) {
      const falls = row.bonded.falls;
      expect(falls.reduce((n, fall) => n + fall.fell, 0)).toBe(row.bonded.fell);
      expect(falls.reduce((n, fall) => n + fall.lossUsd, 0)).toBeCloseTo(row.bonded.lossUsd, 2);
      expect(falls.reduce((n, fall) => n + fall.overpaidUsd, 0)).toBeCloseTo(
        row.bonded.overpaidUsd,
        2,
      );
      expect(row.bonded.countedEpisodes + row.bonded.notMet).toBe(row.bonded.tasksTotal);
    }
  });

  it("counts AgentDojo's attack out of the runs that met it, as on Bonded's side", () => {
    for (const row of data.comparisons) {
      expect(row.agentdojo.attacks.every((attack) => attack.met !== undefined)).toBe(true);
      expect(metOf(row.agentdojo)).toBeLessThanOrEqual(pairsOf(row.agentdojo));
      expect(attackExecuted(row.agentdojo)).toBeLessThanOrEqual(metOf(row.agentdojo));
    }
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

  it("rejects a row without a delivery", () => {
    const row = data.comparisons[0]!;
    const broken = { ...data, comparisons: [{ ...row, channels: "emailed" }] };
    expect(() => loadBenchComparison(broken)).toThrow(/channels must be fetched or pushed/);
  });
});
