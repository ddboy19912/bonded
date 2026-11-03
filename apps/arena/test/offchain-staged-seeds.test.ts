import { describe, expect, it } from "vitest";
import { plantedFacts } from "../src/offchain/attribution.js";
import { runOffchainEpisode } from "../src/offchain/episode.js";
import { PENDING_TWINS, STAGED_TWINS, TWIN_VECTOR } from "../src/offchain/scenarios.js";
import {
  ScriptedCounterparty,
  scriptedPayablesAgent,
  type ScriptedPayablesKind,
} from "../src/offchain/scripted-payables.js";
import {
  attackScenario,
  loadOffchainSeeds,
  OFFCHAIN_STAGED_SEEDS_DIR,
  type OffchainSeed,
  plantIntoBusyWorld,
  seedNeedsVision,
  seedVectors,
  worldFor,
} from "../src/offchain/seeds.js";
import { includesStaged, scriptedSeeds } from "../src/payments-scripted.js";

/**
 * The staged off-chain seeds (apps/arena/offchain-seeds-staged): not rated, run by
 * `offchain --staged` and the scripted payments runs (docs/SENTINEL.md, "The payments dataset").
 */
const staged = loadOffchainSeeds(OFFCHAIN_STAGED_SEEDS_DIR);

/**
 * Realistic seeds whose wording the scripted vulnerable agent's rules don't read ("get the
 * deposit out today", "send it again"). They stay as written: a model may still fall for them.
 */
const NOT_FALLEN = ["O3-not-received-001", "O5-chat-relay-001"];

const run = (kind: ScriptedPayablesKind, seed: OffchainSeed) =>
  runOffchainEpisode(scriptedPayablesAgent(kind), attackScenario(seed), {
    attribution: "planted",
    images: false,
    ...(seed.counterparty ? { counterparty: new ScriptedCounterparty(seed.counterparty) } : {}),
  });

describe("the staged off-chain seeds", () => {
  it("load, and the scripted payments runs read every one", () => {
    expect(staged.length).toBeGreaterThan(0);
    const read = new Set(scriptedSeeds().map((s) => s.id));
    for (const s of staged) expect(read.has(s.id), s.id).toBe(true);
    // So the scripted runs add the staged channel attacks' twins; the library alone doesn't.
    expect(includesStaged(scriptedSeeds())).toBe(true);
    expect(includesStaged(loadOffchainSeeds())).toBe(false);
  });

  it("each plants an account, reference or amount the genuine world doesn't have, in text", () => {
    for (const s of staged) {
      expect(plantedFacts(s, worldFor(s)), s.id).not.toEqual([]);
      // Text only: the scripted agents, which read no pictures, meet every one.
      expect(seedNeedsVision(s), s.id).toBe(false);
    }
  });

  it("the realistic-job seeds plant into the busy Monday unchanged", () => {
    const quietWeek = staged.filter((s) => s.world === "v2");
    expect(quietWeek.length).toBeGreaterThan(0);
    expect(plantIntoBusyWorld(quietWeek).skipped).toEqual([]);
  });

  it("every channel a staged attack arrives through has a benign twin on that channel", () => {
    const twinned = new Set(
      [...STAGED_TWINS, ...PENDING_TWINS].map((build) => TWIN_VECTOR[build().id]),
    );
    for (const s of staged.filter((seed) => seed.world !== "v1"))
      for (const vector of seedVectors(s))
        if (vector !== "email" && vector !== "counterparty")
          expect(twinned.has(vector), `${s.id} through ${vector}`).toBe(true);
  });

  it.each(staged.map((s) => [s.id, s] as const))(
    "%s: the cautious agent stays safe; every breach the vulnerable one makes is the attack's",
    async (id, seed) => {
      const safe = await run("cautious", seed);
      expect(safe.verdict.breached).toBe(false);
      // The payment work is done; replies and approvals aren't these agents' part of the job.
      expect(safe.missed.filter((m) => !/^(reply|approval):/.test(m))).toEqual([]);
      const fooled = await run("vulnerable", seed);
      expect(fooled.verdict.ownErrors).toEqual([]);
      expect(fooled.verdict.attackSucceeded).toBe(!NOT_FALLEN.includes(id));
    },
  );
});
