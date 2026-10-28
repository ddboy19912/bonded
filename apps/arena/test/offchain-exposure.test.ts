import type { AgentToolbox, ArenaAgent } from "@bondedhq/shared";
import { describe, expect, it } from "vitest";
import { runOffchainEpisode } from "../src/offchain/episode.js";
import { attackSeen } from "../src/offchain/exposure.js";
import {
  attackScenario,
  loadOffchainSeeds,
  OFFCHAIN_STAGED_SEEDS_DIR,
} from "../src/offchain/seeds.js";
import { summarizeRows } from "../src/offchain/summary.js";

const staged = loadOffchainSeeds(OFFCHAIN_STAGED_SEEDS_DIR);
const chatSeed = staged.find((s) => s.id === "O5-chat-ceo-001")!;

const agent = (script: (tools: AgentToolbox) => Promise<void>): ArenaAgent => ({
  name: "scripted",
  async run(_task, tools) {
    await script(tools);
    return { steps: 0, stoppedBecause: "done" };
  },
});
const listsQueue = agent(async (tools) => {
  await tools.call("list_approved_invoices", {});
});
const readsChat = agent(async (tools) => {
  await tools.call("list_chat_messages", {});
  await tools.call("list_approved_invoices", {});
});

describe("exposure", () => {
  it("records whether the agent met the attack", async () => {
    const skipped = await runOffchainEpisode(listsQueue, attackScenario(chatSeed));
    const read = await runOffchainEpisode(readsChat, attackScenario(chatSeed));
    expect(skipped.attackOpened).toBe(false);
    expect(read.attackOpened).toBe(true);
  });

  it("counts a vector pushed into the briefing as met", () => {
    expect(attackSeen(chatSeed, [])).toBe(false);
    expect(attackSeen(chatSeed, [], ["chat"])).toBe(true);
    expect(attackSeen(chatSeed, [], ["sms"])).toBe(false);
  });

  it("leaves unmet attacks out of the rate only when exposure is measured", async () => {
    const episodes = await Promise.all(
      [listsQueue, readsChat].map(async (a) => ({
        mandate: "hidden" as const,
        result: await runOffchainEpisode(a, attackScenario(chatSeed)),
      })),
    );
    const counted = summarizeRows(episodes, ["hidden"]).rows[0]!;
    const measured = summarizeRows(episodes, ["hidden"], "measured").rows[0]!;
    expect(counted.attackEpisodes).toBe(2);
    expect(measured.attackEpisodes).toBe(1);
    expect(measured.notMet).toEqual(["O5-chat-ceo-001"]);
    expect(counted.notMet).toEqual(["O5-chat-ceo-001"]);
  });
});
