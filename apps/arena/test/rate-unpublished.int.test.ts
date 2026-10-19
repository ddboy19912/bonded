import type { AgentRunSummary, ArenaAgent } from "@bondedhq/shared";
import { afterAll, beforeAll, expect, it } from "vitest";
import { loadAttackLibrary, rateAgent, Sandbox } from "../src/index.js";

let sandbox: Sandbox;
beforeAll(async () => {
  sandbox = await Sandbox.start();
}, 120_000);
afterAll(async () => {
  await sandbox?.stop();
});

/** An agent that does nothing and reports $1 of model spend per episode. */
const costly: ArenaAgent = {
  name: "costly",
  run: async (): Promise<AgentRunSummary> => ({
    steps: 0,
    stoppedBecause: "done",
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 1 },
  }),
};
const [published, heldA, heldB] = loadAttackLibrary();
const unpublished = new Set([heldA!.id, heldB!.id]);

it("refuses an unmeasured security grade when the cap stops before any attack", async () => {
  const r = await rateAgent(sandbox, {
    agent: costly,
    attacks: [published!, heldA!, heldB!],
    unpublished,
    controls: 0,
    maxUsd: 0,
  });
  expect(r.report.episodes.total).toBe(0);
  expect(r.report.unpublished).toEqual({ attacks: 0, episodes: 0 });
  expect(r.report.stoppedEarly).toMatch(/spending cap/);
  expect(r.report.susceptibility).toBeUndefined();
  expect(r.attestation).toBeNull();
  expect(r.refused).toMatch(/no control episode/);
  expect(r.posted).toEqual({ posted: false, reason: `not attested: ${r.refused}` });
}, 300_000);

it("counts only the unpublished attacks that ran when the cap stops it partway", async () => {
  // $1 an episode with a $1.50 cap: two of the three attacks run, in the rating's random order.
  const r = await rateAgent(sandbox, {
    agent: costly,
    attacks: [published!, heldA!, heldB!],
    unpublished,
    controls: 0,
    maxUsd: 1.5,
  });
  expect(r.report.episodes.attacks).toBe(2);
  // Exactly the unpublished attacks among the two that ran, never the one that didn't.
  const ran = r.episodes.map((e) => e.attackId!).filter((id) => unpublished.has(id));
  expect(ran.length).toBeGreaterThanOrEqual(1);
  expect(r.report.unpublished).toEqual({ attacks: ran.length, episodes: ran.length });
}, 300_000);

it("counts an unpublished attack once however many times it ran", async () => {
  const r = await rateAgent(sandbox, {
    agent: { ...costly, run: async () => ({ steps: 0, stoppedBecause: "done" }) },
    attacks: [heldA!],
    unpublished,
    controls: 0,
    repeats: 3,
  });
  expect(r.report.unpublished).toEqual({ attacks: 1, episodes: 3 });
}, 300_000);
