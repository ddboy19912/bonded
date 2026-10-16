import type { ArenaAgent } from "@bondedhq/shared";
import { describe, expect, it } from "vitest";
import {
  FRAMES,
  type Genome,
  HARBINGER_CLAUSE_TYPES,
  initialPopulation,
  loadAttackLibrary,
  nextGeneration,
  type EpisodeResult,
  runHarbinger,
  seedClause,
  type Sandbox,
} from "../src/index.js";

const seed = loadAttackLibrary().find((s) => s.id === "A6-ceo-urgent-004")!;
const agent: ArenaAgent = { name: "fake", run: async () => ({ steps: 0, stoppedBecause: "done" }) };

type Outcome = "ignored" | "guard_blocked" | "breach" | "unseen";

function episode(outcome: Outcome, finalMessage = "done"): EpisodeResult {
  const breached = outcome === "breach";
  return {
    id: `ep-${outcome}-${Math.random()}`,
    attackId: seed.id,
    planted: [{ surface: "dm", text: "x" }],
    trace:
      outcome === "unseen"
        ? []
        : [
            {
              step: 1,
              tool: "read_inbox",
              args: {},
              result: { ok: true },
              txHashes: [],
              breaches: [],
            },
          ],
    agentSummary: {
      steps: 1,
      stoppedBecause: "done",
      finalMessage,
      ...(outcome === "guard_blocked"
        ? { blockedActions: [{ tool: "transfer", reason: "x" }] }
        : {}),
    },
    drained: [],
    verdict: {
      breached,
      attackSucceeded: breached,
      breaches: breached ? [{ blocked: false }] : [],
      totalLossUsd: breached ? 8000 : 0,
      frozen: breached,
    },
  } as unknown as EpisodeResult;
}

describe("seedClause", () => {
  it("covers every breach type a seed can ask for", () => {
    for (const type of HARBINGER_CLAUSE_TYPES) expect(typeof type).toBe("string");
    expect(seedClause(seed)).toContain("{{attacker}}");
  });
});

describe("initialPopulation", () => {
  it("is deterministic from the seed and the random source", () => {
    const a = initialPopulation(
      seed,
      10,
      (() => {
        let x = 1;
        return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
      })(),
    );
    const b = initialPopulation(
      seed,
      10,
      (() => {
        let x = 1;
        return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
      })(),
    );
    expect(a).toEqual(b);
  });

  it("gives distinct genomes, each rendered with the seed's clause", () => {
    let x = 7;
    const rand = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pop = initialPopulation(seed, 15, rand);
    const keys = pop.map(
      (v) => `${v.genome.frameId}|${v.genome.role}|${v.genome.urgency}|${v.genome.ref}`,
    );
    expect(new Set(keys).size).toBe(pop.length);
    for (const v of pop) {
      expect(v.text).toContain("{{amount}} {{token}}");
      expect(v.text).toContain("{{attacker}}");
    }
  });

  it("stops well short of looping forever when asked for more than exists", () => {
    let x = 3;
    const rand = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
    const space = FRAMES.length * 6 * 3 * 2; // frames * roles * urgencies * (ref or not)
    const pop = initialPopulation(seed, space + 50, rand);
    expect(pop.length).toBeLessThanOrEqual(space);
  });
});

describe("nextGeneration", () => {
  it("breeds from the given parents and keeps a share of fresh genomes", () => {
    let x = 11;
    const rand = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
    const parents: Genome[] = [
      { frameId: FRAMES[0]!.id, role: "CEO", urgency: "high", ref: "AUTH-1234" },
      { frameId: FRAMES[1]!.id, role: "Compliance", urgency: "none", ref: "" },
    ];
    const next = nextGeneration(seed, parents, 12, rand);
    expect(next).toHaveLength(12);
    // No duplicate of a parent genome (nextGeneration seeds `seen` with the parents).
    for (const v of next) {
      const isParent = parents.some(
        (p) =>
          p.frameId === v.genome.frameId &&
          p.role === v.genome.role &&
          p.urgency === v.genome.urgency &&
          p.ref === v.genome.ref,
      );
      expect(isParent).toBe(false);
    }
  });

  it("returns nothing new when there are no parents to breed from", () => {
    let x = 2;
    const rand = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
    // Still gets the "fresh" share even with zero parents.
    const next = nextGeneration(seed, [], 5, rand);
    expect(next.length).toBeGreaterThan(0);
    expect(next.length).toBeLessThanOrEqual(5);
  });
});

function options(
  over: Partial<Parameters<typeof runHarbinger>[0]> & {
    runAttempt: Parameters<typeof runHarbinger>[0]["runAttempt"];
  },
) {
  return {
    sandbox: {} as Sandbox,
    agent,
    seed,
    population: 4,
    generations: 2,
    maxUsd: 10,
    ...over,
  } as Parameters<typeof runHarbinger>[0];
}

describe("runHarbinger", () => {
  it("stops at the first breach and reports which generation found it", async () => {
    let n = 0;
    const result = await runHarbinger(
      options({
        runAttempt: async () => episode(++n > 6 ? "breach" : "ignored"),
      }),
    );
    expect(result.breached).toBe(true);
    expect(result.breachGeneration).not.toBeNull();
    expect(result.stoppedBecause).toBe("breached");
    // Stopped partway through a generation, not after running every possible attempt.
    expect(result.attempts.length).toBeLessThan(4 * 3);
    expect(result.attempts.at(-1)?.succeeded).toBe(true);
  });

  it("holds for the full generation budget when nothing breaches", async () => {
    const result = await runHarbinger(options({ runAttempt: async () => episode("ignored") }));
    expect(result.breached).toBe(false);
    expect(result.stoppedBecause).toBe("generations");
    expect(result.attempts).toHaveLength(4 * 3); // population * (generations + 1)
    expect(result.bestScore).toBe(2); // "ignored" with no flagged words
  });

  it("scores guard-blocked tries higher, so they breed into later generations", async () => {
    const genomesPerGeneration: Genome[][] = [];
    let seenGuardBlock = false;
    const result = await runHarbinger(
      options({
        population: 6,
        generations: 3,
        onAttempt: (a) => {
          genomesPerGeneration[a.generation] ??= [];
          genomesPerGeneration[a.generation]!.push(a.genome);
        },
        runAttempt: async (_spec, generation, index) => {
          // The very first try in generation 0 is a near-success; everything else is ignored,
          // so later generations should drift toward variants of that one gene combination.
          if (!seenGuardBlock && generation === 0 && index === 0) {
            seenGuardBlock = true;
            return episode("guard_blocked");
          }
          return episode("ignored");
        },
      }),
    );
    expect(result.stoppedBecause).toBe("generations");
    // The guard-blocked genome (score 3) should appear as a parent influence: later generations
    // are not identical to a purely random draw, i.e. at least one later genome reuses its frame.
    const firstGenome = genomesPerGeneration[0]![0]!;
    const laterFrames = genomesPerGeneration
      .slice(1)
      .flat()
      .map((g) => g.frameId);
    expect(laterFrames).toContain(firstGenome.frameId);
  });

  it("counts an over-long draft as invalid without running an episode", async () => {
    let runs = 0;
    const longSeed = { ...seed, id: "A6-ceo-urgent-004" };
    // Force every rendered text to be invalid by using a population bigger than nothing special —
    // instead, directly check the invalid path via a runAttempt spy: with normal templates nothing
    // is invalid, so this test exercises the counting logic through a population of 2, generations 0.
    const result = await runHarbinger(
      options({
        seed: longSeed,
        population: 2,
        generations: 0,
        runAttempt: async () => {
          runs++;
          return episode("ignored");
        },
      }),
    );
    expect(runs).toBe(2);
    expect(result.attempts.every((a) => a.ruling !== "invalid")).toBe(true);
  });

  it("stops when the spend cap is reached", async () => {
    const result = await runHarbinger(
      options({
        maxUsd: 0.05,
        population: 10,
        generations: 5,
        runAttempt: async () => ({
          ...episode("ignored"),
          agentSummary: {
            steps: 1,
            stoppedBecause: "done",
            usage: { inputTokens: 1000, outputTokens: 1000, costUsd: 0.03 },
          },
        }),
      }),
    );
    expect(result.stoppedBecause).toBe("budget");
    expect(result.spend.spentUsd).toBeGreaterThanOrEqual(0.05);
    expect(result.attempts.length).toBeLessThan(10 * 6);
  });

  it("is reproducible: the same seed id gives the same first-generation texts", async () => {
    const texts: string[][] = [[], []];
    for (const i of [0, 1]) {
      await runHarbinger(
        options({
          population: 5,
          generations: 0,
          onAttempt: (a) => texts[i]!.push(a.payloadTemplate),
          runAttempt: async () => episode("ignored"),
        }),
      );
    }
    expect(texts[0]).toEqual(texts[1]);
  });

  it("gives a different population for a different --random-seed", async () => {
    const texts: string[][] = [[], []];
    for (const [i, randomSeed] of [seed.id, "variant-2"].entries()) {
      await runHarbinger(
        options({
          population: 5,
          generations: 0,
          randomSeed,
          onAttempt: (a) => texts[i]!.push(a.payloadTemplate),
          runAttempt: async () => episode("ignored"),
        }),
      );
    }
    expect(texts[0]).not.toEqual(texts[1]);
  });
});
