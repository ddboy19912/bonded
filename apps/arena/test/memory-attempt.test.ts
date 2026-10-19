import type { ArenaAgent } from "@bondedhq/shared";
import { beforeEach, expect, test, vi } from "vitest";
import { loadAttackLibrary } from "../src/attacks.js";
import { type EpisodeResult, runEpisode } from "../src/episode.js";
import { runMemoryAttempt } from "../src/memory-attempt.js";
import type { Sandbox } from "../src/sandbox.js";

vi.mock("../src/episode.js", async (original) => ({
  ...(await original<typeof import("../src/episode.js")>()),
  runEpisode: vi.fn(),
}));

const spec = loadAttackLibrary()[0]!;
const sandbox = {} as Sandbox;
const agent: ArenaAgent & { memory: string[]; reset: () => void } = {
  name: "memory-test",
  memory: [],
  reset() {
    this.memory = [];
  },
  run: async () => ({ steps: 0, stoppedBecause: "done" }),
};
const result = (breached: boolean): EpisodeResult =>
  ({
    verdict: { breached, totalLossUsd: breached ? 5000 : 0 },
    trace: [],
    drained: [],
    agentSummary: {
      steps: 1,
      stoppedBecause: "done",
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 },
    },
  }) as unknown as EpisodeResult;

beforeEach(() => {
  vi.mocked(runEpisode).mockReset();
  agent.memory = [];
});

test("a first-session breach stops before incurring a second session's spend", async () => {
  const first = result(true);
  vi.mocked(runEpisode).mockResolvedValue(first);
  expect(await runMemoryAttempt(sandbox, agent, spec, 0)).toBe(first);
  expect(runEpisode).toHaveBeenCalledTimes(1);
});

test("keeps the first day's notes and fixes the world across candidate ids", async () => {
  vi.mocked(runEpisode)
    .mockImplementationOnce(async () => {
      agent.memory = ["first-day note"];
      return result(false);
    })
    .mockImplementationOnce(async () => {
      agent.memory = ["second-day note"];
      return result(false);
    })
    .mockResolvedValue(result(false));
  const merged = await runMemoryAttempt(sandbox, agent, spec, 0, {}, "fixed-world");
  await runMemoryAttempt(
    sandbox,
    agent,
    { ...spec, id: `${spec.id}-adapt-1` },
    1,
    {},
    "fixed-world",
  );
  expect(merged.agentSummary.finalMessage).toContain("Notes it kept: first-day note");
  expect(merged.agentSummary.finalMessage).not.toContain("second-day note");
  expect(merged.agentSummary.usage?.costUsd).toBeCloseTo(0.02);
  expect(vi.mocked(runEpisode).mock.calls.map((call) => call[1].worldSeed)).toEqual([
    "fixed-world",
    "fixed-world-day2",
    "fixed-world",
    "fixed-world-day2",
  ]);
});
