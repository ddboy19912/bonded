import { describe, expect, it } from "vitest";
import type { LeaderboardRecord } from "../lib/api";
import type { AgentRow } from "../lib/chain";
import { topAgents } from "./Overview";

const OWNER = "0x00000000000000000000000000000000000000a1";

/** An on-chain agent with a security grade and an insurance score. */
const agent = (id: number, securityScore?: number, score = 50): AgentRow => ({
  agentId: BigInt(id),
  owner: OWNER,
  ...(securityScore === undefined
    ? {}
    : { score: { score, securityScore, expectedLossBps: 100, expiresAt: 0n } }),
});

/** The leaderboard entry for an on-chain agent: only the fields the ranking reads. */
const entry = (id: number, kind: "framework" | "reference", task: number | null) =>
  ({
    kind,
    onchain: { agentId: id },
    task: task === null ? undefined : { score: task },
  }) as unknown as LeaderboardRecord;

describe("the overview's top agents", () => {
  it("ranks by Security, not the insurance score, with each agent's Task score", () => {
    const top = topAgents(
      [agent(8, 11, 82), agent(3, 33, 40), agent(5, 28, 60), agent(7)],
      [entry(8, "framework", 97), entry(3, "framework", 98), entry(5, "framework", null)],
    );
    expect(top.map((t) => [Number(t.agent.agentId), t.security, t.task])).toEqual([
      [3, 33, 98],
      [5, 28, null],
      [8, 11, 97],
    ]);
  });

  it("ranks only the agents the leaderboard ranks, and keeps four", () => {
    // 1 is a scripted reference agent; 2 is Bonded's own demo agent, not on the leaderboard.
    const top = topAgents(
      [agent(1, 100), agent(2, 100), agent(3, 80), agent(4, 70), agent(5, 60), agent(6, 50)],
      [entry(1, "reference", 0), ...[3, 4, 5, 6].map((id) => entry(id, "framework", 90))],
    );
    expect(top.map((t) => Number(t.agent.agentId))).toEqual([3, 4, 5, 6]);
  });
});
