import { describe, expect, it } from "vitest";
import type { AgentRow } from "./chain";
import { showcaseAgents } from "./showcase";

const row = (id: number, score?: number, securityScore = score): AgentRow => ({
  agentId: BigInt(id),
  owner: "0x0000000000000000000000000000000000000001",
  ...(score === undefined
    ? {}
    : { score: { score, securityScore: securityScore!, expectedLossBps: 100, expiresAt: 0n } }),
});

describe("showcaseAgents", () => {
  it("skips unrated agents and keeps up to three as they are, best first", () => {
    expect(showcaseAgents([row(1), row(2, 50), row(3, 90)]).map((r) => r.agentId)).toEqual([
      3n,
      2n,
    ]);
  });
  it("picks the best, a middle and the worst score from a longer list", () => {
    const rows = [row(1, 81), row(2, 96), row(3, 49), row(4, 54), row(5, 2)];
    expect(showcaseAgents(rows).map((r) => r.score!.score)).toEqual([96, 54, 2]);
  });
  it("returns nothing when nothing is rated", () => {
    expect(showcaseAgents([row(1), row(2)])).toEqual([]);
  });
});
