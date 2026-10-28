import { type ArenaAgent, type ChatClient, LlmError } from "@bondedhq/shared";
import { describe, expect, it } from "vitest";
import { SpendingCap } from "../src/budget.js";
import { runOffchainBatch } from "../src/offchain/batch.js";
import { controlScenario } from "../src/offchain/scenarios.js";

/** An agent whose model account refuses the next call after `ok` episodes. */
function agentWithCredits(ok: number, status: 401 | 402 | 403): () => ArenaAgent {
  let runs = 0;
  return () => ({
    name: "scripted",
    async run(_task, tools) {
      runs++;
      if (runs > ok) throw new LlmError(status, `LLM request failed (${status}): refused`);
      await tools.call("list_approved_invoices", {});
      return { steps: 1, stoppedBecause: "done" };
    },
  });
}

describe("a batch that the model account refuses", () => {
  it.each([401, 402, 403] as const)(
    "stops on %i, keeps what ran, lists the rest as skipped and does not count it as an error",
    async (status) => {
      const result = await runOffchainBatch({
        agent: agentWithCredits(2, status),
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
      expect(result.accountStop).toBe(status);
      expect(result.outOfCredits).toBe(true);
      expect(result.episodes).toHaveLength(2);
      expect(result.skipped).toHaveLength(4);
      expect(result.summary.rows[0]!.errors).toEqual([]);
    },
  );

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
