import type { AgentRunSummary, ArenaAgent } from "@bondedhq/shared";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { loadAttackLibrary, rateAgent, Sandbox } from "../src/index.js";
import { loadMemorySeeds } from "../src/memory-observations.js";
import { loadS1Seeds } from "../src/s1-observations.js";
import { runControls } from "../src/controls.js";

let sandbox: Sandbox;
beforeAll(async () => {
  sandbox = await Sandbox.start();
}, 120_000);
afterAll(async () => {
  await sandbox?.stop();
});

/** An agent that takes 300 ms to finish each episode. */
const slow: ArenaAgent = {
  name: "slow",
  run: async (): Promise<AgentRunSummary> => {
    await new Promise((r) => setTimeout(r, 300));
    return { steps: 0, stoppedBecause: "done" };
  },
};
const [attack] = loadAttackLibrary();

it("applies the timeout forwarded by the controls command", async () => {
  const result = await runControls(sandbox, {
    agent: slow,
    episodes: 1,
    episodeTimeoutMs: 50,
  });
  expect(result.episodes[0]!.agentSummary).toMatchObject({
    stoppedBecause: "error",
    finalMessage: "timed out after 50 ms",
  });
});

it("applies episodeTimeoutMs to Bonded's own agents' episodes", async () => {
  const tight = await rateAgent(sandbox, {
    agent: slow,
    attacks: [attack!],
    controls: 0,
    episodeTimeoutMs: 50,
  });
  expect(tight.episodes[0]!.agentSummary).toMatchObject({
    stoppedBecause: "error",
    finalMessage: "timed out after 50 ms",
  });
  const roomy = await rateAgent(sandbox, {
    agent: slow,
    attacks: [attack!],
    controls: 0,
    episodeTimeoutMs: 5_000,
  });
  expect(roomy.episodes[0]!.agentSummary.stoppedBecause).toBe("done");
}, 300_000);

it.each(["s1", "memory"] as const)(
  "applies the timeout to %s battery episodes",
  async (battery) => {
    const notes: string[] = [];
    const agent = {
      ...slow,
      memory: notes,
      reset() {
        notes.length = 0;
      },
      async run(...args: Parameters<ArenaAgent["run"]>) {
        notes.push("session notes");
        return slow.run(...args);
      },
    };
    const config =
      battery === "s1"
        ? { s1: { seeds: [loadS1Seeds()[0]!], pairs: 1 } }
        : { memory: { seeds: [loadMemorySeeds()[0]!], rounds: 1 } };
    const onEpisode = vi.fn();
    await expect(
      rateAgent(sandbox, {
        agent,
        attacks: [],
        controls: 0,
        episodeTimeoutMs: 50,
        onEpisode,
        ...config,
      }),
    ).rejects.toThrow(/timed out|failed/);
    expect(onEpisode).toHaveBeenCalledOnce();
    expect(onEpisode.mock.calls[0]![0].agentSummary).toMatchObject({
      stoppedBecause: "error",
      finalMessage: "timed out after 50 ms",
    });
    onEpisode.mockClear();
    await rateAgent(sandbox, {
      agent,
      attacks: [],
      controls: 0,
      episodeTimeoutMs: 5000,
      onEpisode,
      ...config,
    });
    expect(onEpisode).toHaveBeenCalledTimes(battery === "s1" ? 2 : 4);
    expect(
      onEpisode.mock.calls.every(([episode]) => episode.agentSummary.stoppedBecause === "done"),
    ).toBe(true);
  },
);

it("keeps completed controls when an account stop interrupts a vault rating", async () => {
  let starts = 0;
  const agent: ArenaAgent = {
    name: "quota-fixture",
    run: async () =>
      ++starts === 1
        ? { steps: 0, stoppedBecause: "done" }
        : { steps: 0, stoppedBecause: "error", batchStopReason: "subscription ceiling" },
  };
  const result = await rateAgent(sandbox, { agent, attacks: [], controls: 4 });
  expect(starts).toBe(2);
  expect(result.report.controls.episodes).toBe(1);
  expect(result.report.episodes.agentErrors).toBe(0);
  expect(result.report.stoppedEarly).toBe("subscription ceiling");
  expect(result.attestation).toBeNull();
});
