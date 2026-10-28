import { type ArenaAgent, type ChatClient, LlmError } from "@bondedhq/shared";
import { describe, expect, it } from "vitest";
import { SpendingCap } from "../src/budget.js";
import { runOffchainBatch } from "../src/offchain/batch.js";
import { controlScenario } from "../src/offchain/scenarios.js";

/** An agent whose model account runs dry after `ok` episodes. */
function agentWithCredits(ok: number): () => ArenaAgent {
  let runs = 0;
  return () => ({
    name: "scripted",
    async run(_task, tools) {
      runs++;
      if (runs > ok) throw new LlmError(402, "LLM request failed (402): requires more credits");
      await tools.call("list_approved_invoices", {});
      return { steps: 1, stoppedBecause: "done" };
    },
  });
}

describe("a batch that runs out of credits", () => {
  it("stops starting episodes, keeps what ran and lists the rest as skipped", async () => {
    const result = await runOffchainBatch({
      agent: agentWithCredits(2),
      seesImages: false,
      images: false,
      attackSeeds: [],
      controls: [controlScenario],
      rows: ["hidden"],
      runs: 6,
      parallel: 1,
      cap: new SpendingCap({ maxUsd: 1 }),
      client: {} as ChatClient,
      counterpartyModel: "none",
    });
    expect(result.outOfCredits).toBe(true);
    expect(result.episodes).toHaveLength(2);
    expect(result.skipped).toHaveLength(4);
    expect(result.summary.rows[0]!.errors).toEqual([]);
  });

  it("isn't triggered by an agent's ordinary failure", async () => {
    const failing = (): ArenaAgent => ({
      name: "scripted",
      async run() {
        throw new Error("the agent gave up");
      },
    });
    const result = await runOffchainBatch({
      agent: failing,
      seesImages: false,
      images: false,
      attackSeeds: [],
      controls: [controlScenario],
      rows: ["hidden"],
      runs: 2,
      parallel: 1,
      cap: new SpendingCap({ maxUsd: 1 }),
      client: {} as ChatClient,
      counterpartyModel: "none",
    });
    expect(result.outOfCredits).toBe(false);
    expect(result.episodes).toHaveLength(2);
  });
});
