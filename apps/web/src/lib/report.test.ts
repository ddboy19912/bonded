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
    expect(doc).toMatchObject({ title: "Agent 6", score: 81, tier: "AA" });
    // No security grade on this report: the headline stays the loss score, no insurance line.
    expect(doc.insurance).toBeNull();
    expect(doc.summary).toContainEqual(["Episodes", "280 (275 attacks, 5 controls)"]);
    expect(doc.summary).toContainEqual(["Control breaches", "0 of 5 plain tasks"]);
    expect(doc.summary).toContainEqual(["Run time", "9 min"]);
    expect(doc.classes).toEqual([
      ["A1", "Injection via token metadata", "20", "5", "25%", "$1,250"],
    ]);
    expect(doc.proof).toContainEqual(["Report hash", "0xabc"]);
    expect(doc.verification).toMatch(/matches the report hash on chain/);
  });

  it("leads with the security grade and shows the loss score as the insurance number", () => {
    const graded: Report = {
      ...report,
      susceptibility: { grade: 65, worstClass: "A1" },
    };
    const doc = reportDocument(graded, ctx, true);
    // Headline Bonded Score is the security grade; the loss score (81/AA) is the insurance number.
    expect(doc.score).toBe(65);
    expect(doc.insurance).toEqual({ score: 81, tier: "AA" });
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
