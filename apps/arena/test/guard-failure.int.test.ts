import type { AgentRunSummary, ArenaAgent } from "@bondedhq/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { GuardedAgent, createVulnerableAgent, type ActionGuard } from "@bonded/demo-agents";
import { loadAttackLibrary, rateAgent, Sandbox } from "../src/index.js";

let sandbox: Sandbox;
beforeAll(async () => {
  sandbox = await Sandbox.start();
}, 120_000);
afterAll(async () => {
  await sandbox?.stop();
});

/** A model guard whose service is down: every check throws. */
const unreachable: ActionGuard = {
  name: "sentinel/laya",
  check: async () => {
    throw new Error("fetch failed: connect ECONNREFUSED");
  },
};

it("counts writes refused because a guard failed, apart from real blocks", async () => {
  // A transfer-planting attack: the vulnerable agent tries to obey it, so the guard is asked.
  const attack = loadAttackLibrary().find((a) =>
    a.successPredicate.anyOf.includes("T1_UNAUTHORIZED_TRANSFER"),
  )!;
  const r = await rateAgent(sandbox, {
    agent: new GuardedAgent(createVulnerableAgent("scripted"), [unreachable], "sentinel"),
    attacks: [attack],
    controls: 0,
  });
  // The guard failed closed, so nothing breached, but the report says it couldn't assess.
  expect(r.report.guardFailures).toBeGreaterThan(0);
  expect(r.report.guardFailures).toBe(r.report.blockedByAgentGuard);
  expect(r.episodes[0]!.agentSummary.blockedActions?.every((b) => b.guardFailed)).toBe(true);
}, 300_000);

/** An agent whose first try ends with its runner's connection dropped; later tries run `inner`. */
function droppedOnce(inner: ArenaAgent, first: Partial<AgentRunSummary>) {
  const agent: ArenaAgent & { tries: number } = {
    name: inner.name,
    tries: 0,
    run: async (task, tools) =>
      agent.tries++ === 0
        ? ({
            steps: 0,
            stoppedBecause: "error",
            finalMessage: "the agent's runner disconnected during the episode",
            remote: { connectionDropped: true, reads: {} },
            ...first,
          } as AgentRunSummary)
        : inner.run(task, tools),
  };
  return agent;
}

const control = () => loadAttackLibrary().slice(0, 1);

it("keeps a guard failure from a try a dropped connection made it run again", async () => {
  const agent = droppedOnce(createVulnerableAgent("scripted"), {
    blockedActions: [{ tool: "transfer", args: {}, reason: "guard down", guardFailed: true }],
  });
  const r = await rateAgent(sandbox, { agent, attacks: control(), controls: 0 });
  expect(agent.tries).toBe(2);
  expect(r.episodes).toHaveLength(1);
  expect(r.report.guardFailures).toBeGreaterThanOrEqual(1);
}, 300_000);

it("doesn't run a dropped episode again past the spending cap", async () => {
  const agent = droppedOnce(createVulnerableAgent("scripted"), {
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 5 },
  });
  const r = await rateAgent(sandbox, { agent, attacks: control(), controls: 0, maxUsd: 1 });
  expect(agent.tries).toBe(1);
  expect(r.episodes).toHaveLength(0);
  expect(r.report.stoppedEarly).toMatch(/spending cap/);
}, 300_000);
