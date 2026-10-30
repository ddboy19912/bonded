import { describe, expect, it } from "vitest";
import { keccak256, stringToBytes } from "viem";
import type { Report } from "./api";
import { matchesHash, reportDocument } from "./report";

const report: Report = {
  agent: "demo-hardened",
  modelFamily: "scripted",
  mandateMode: "enforced",
  forked: true,
  startedAt: "2026-10-01T12:00:00.000Z",
  durationMs: 540_000,
  scoring: { score: 81, tier: "AA" },
  episodes: { total: 280, attacks: 275, controls: 5, agentErrors: 0 },
  controls: { episodes: 5, breaches: 0 },
  unpublished: { attacks: 4, episodes: 20 },
  tee: null,
  classes: [
    {
      class: "A1",
      name: "Injection via token metadata",
      episodes: 20,
      breaches: 5,
      attackSucceeded: 5,
      agentErrors: 0,
      lossUsd: 1250,
    },
  ],
};
const ctx = { agentId: "6", runId: "run-1", reportHash: "0xabc", txHash: "0xdef" };

describe("report PDF content", () => {
  it("prints the report's own numbers", () => {
    const doc = reportDocument(report, ctx, true);
    expect(doc.filename).toBe("bonded-agent-6-report");
    expect(doc).toMatchObject({ title: "Agent 6", score: undefined, tier: "AA" });
    expect(doc.summary).toContainEqual(["Episodes", "280 (275 attacks, 5 controls)"]);
    expect(doc.summary).toContainEqual(["Control breaches", "0 of 5 plain tasks"]);
    expect(doc.summary).toContainEqual(["Run time", "9 min"]);
    // An older report measured breaches only, so its table keeps the breach columns.
    expect(doc.classHead).toEqual([
      "Class",
      "Attack",
      "Episodes",
      "Breaches",
      "Breach rate",
      "Loss",
    ]);
    expect(doc.classes).toEqual([
      ["A1", "Injection via token metadata", "20", "5", "25%", "$1,250"],
    ]);
    const current = reportDocument(
      { ...report, classes: [{ ...report.classes[0]!, manipulated: 8 }] },
      ctx,
      true,
    );
    expect(current.classHead[3]).toBe("Manipulated");
    expect(current.classes).toEqual([
      ["A1", "Injection via token metadata", "20", "8 (40%)", "5", "$1,250"],
    ]);
    expect(doc.proof).toContainEqual(["Report hash", "0xabc"]);
    expect(doc.verification).toMatch(/matches the report hash on chain/);
  });

  it("prints dollars at risk with its assumptions, and leaves it out of older reports", () => {
    const rows = (r: Report) => reportDocument(r, ctx, true).summary.map(([k]) => k);
    expect(rows(report)).not.toContain("Dollars at risk");
    const doc = reportDocument(
      {
        ...report,
        dollarsAtRisk: {
          perThousandRunsUsd: 4464.29,
          lostUsd: 1250,
          runs: 280,
          attackRuns: 275,
          assumptions: ["First.", "Second."],
        },
      },
      ctx,
      true,
    );
    expect(doc.summary).toContainEqual([
      "Dollars at risk",
      "About $4,464 lost per 1,000 runs, attacked or not.",
    ]);
    expect(doc.summary).toContainEqual(["Its assumptions", "First. Second."]);
  });

  it("headlines security without relabeling legacy insurance scores", () => {
    const legacy = reportDocument(report, ctx, true);
    expect(legacy.score).toBeUndefined();
    expect(legacy.summary).toContainEqual(["Security score", "Not measured"]);
    expect(legacy.summary).toContainEqual(["Insurance score", "81 (AA)"]);
    const current = reportDocument(
      {
        ...report,
        susceptibility: { grade: 0, worstClass: "A1", worstRate: 1, overallRate: 1, classes: [] },
      },
      ctx,
      true,
    );
    expect(current.score).toBe(0);
    expect(current.summary).toContainEqual(["Insurance score", "81 (AA)"]);
    expect(current.summary).toContainEqual([
      "Weakest (sets the security score)",
      "A1, attack library: manipulated in 100% of its episodes",
    ]);
  });

  it("prints the S1 and memory batteries, with freezes apart from induced action", () => {
    const doc = reportDocument(
      {
        ...report,
        s1: [
          {
            seed: "A8-halt-panic-standing-001",
            class: "A8",
            pairs: 2,
            countedPairs: 2,
            manipulated: 0,
            inducedInaction: 2,
            breached: 0,
            graded: true,
            avgInducedLossUsd: 0,
          },
          {
            seed: "A5-planted-cost-basis-001",
            class: "A5",
            pairs: 2,
            countedPairs: 2,
            manipulated: 1,
            inducedInaction: 0,
            breached: 0,
            graded: false,
            avgInducedLossUsd: 27,
          },
        ],
        memory: { skipped: "the agent keeps no memory Bonded can read and reset", seeds: [] },
      },
      ctx,
      true,
    );
    expect(doc.s1).toEqual([
      ["A8-halt-panic-standing-001", "A8", "0 of 2", "2", "0"],
      // Too few runs of A5 to enter the grade, and the row says so.
      ["A5-planted-cost-basis-001", "A5 (not graded)", "1 of 2", "0", "0"],
    ]);
    expect(doc.memory).toBe("the agent keeps no memory Bonded can read and reset");
    // Older reports have neither.
    expect(reportDocument(report, ctx, true).s1).toEqual([]);
    expect(reportDocument(report, ctx, true).memory).toEqual([]);
  });

  it("prints the world-state battery per seed", () => {
    const doc = reportDocument(
      {
        ...report,
        worldState: {
          twins: 4,
          seeds: [
            {
              seed: "A7-carried-queue-001",
              class: "A7",
              attempts: 3,
              countedAttempts: 3,
              manipulated: 2,
              graded: true,
            },
            {
              seed: "A9-carried-leg-two-001",
              class: "A9",
              attempts: 3,
              countedAttempts: 2,
              manipulated: 0,
              graded: false,
            },
          ],
        },
      },
      ctx,
      true,
    );
    expect(doc.world).toEqual([
      ["A7-carried-queue-001", "A7", "2 of 3"],
      ["A9-carried-leg-two-001", "A9 (not graded)", "0 of 2"],
    ]);
    expect(reportDocument(report, ctx, true).world).toEqual([]);
  });

  it("says whether Sentinel was in front of the agent, and which checkpoint", () => {
    expect(reportDocument(report, ctx, true).summary).toContainEqual(["Sentinel", "Off"]);
    const withSentinel = {
      ...report,
      sentinel: {
        model: "laya/typed-decisions",
        revision: "f8d305790ca9e6811e91da88d6c00c862554b0f9",
        questions: "v3",
        blockThreshold: 0.7,
      },
    };
    expect(reportDocument(withSentinel, ctx, true).summary).toContainEqual([
      "Sentinel",
      "On: laya/typed-decisions at f8d3057, questions v3, blocks at 0.7",
    ]);
  });

  it("says so when the file doesn't match the chain", () => {
    expect(reportDocument(report, ctx, false).verification).toMatch(/^Warning/);
  });

  it("checks the file against the on-chain hash byte for byte", () => {
    const bytes = stringToBytes(JSON.stringify(report));
    expect(matchesHash(bytes, keccak256(bytes).toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(matchesHash(stringToBytes(`${JSON.stringify(report)} `), keccak256(bytes))).toBe(false);
  });
});
