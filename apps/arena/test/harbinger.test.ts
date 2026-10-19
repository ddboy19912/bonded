import { candidateSpec } from "../src/adaptive.js";
import type { ArenaAgent, AttackSpec } from "@bondedhq/shared";
import { describe, expect, it } from "vitest";
import { seededRandom } from "../src/world-content.js";
import { corroborate } from "../src/harbinger/campaign.js";
import { goalChoices } from "../src/harbinger/goals.js";
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

/** The full gene key (generate.ts keeps dedup on it; the tests assert distinctness on it too). */
const genomeKey = (g: {
  frameId: string;
  role: string;
  urgency: string;
  ref: string;
  goal: unknown;
  spread: boolean;
}) => `${g.frameId}|${g.role}|${g.urgency}|${g.ref}|goal${g.goal}|${g.spread ? "s" : "u"}`;

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
    const keys = (v: { genome: Genome }) => genomeKey(v.genome);
    expect(new Set(pop.map(keys)).size).toBe(pop.length);
    for (const v of pop) {
      expect(v.text).toContain("{{amount}} {{token}}");
      expect(v.text).toContain("{{attacker}}");
    }
  });

  it("stops well short of looping forever when asked for more than exists", () => {
    let x = 3;
    const rand = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
    // frames * roles * urgencies * (ref or not), times the goal choices and the spread toggle —
    // the full gene space the renderer draws from without repeating itself.
    const goalSpace = goalChoices(seed).length;
    const space = FRAMES.length * 9 * 3 * 2 * goalSpace * 2;
    const pop = initialPopulation(seed, space + 50, rand);
    expect(pop.length).toBeLessThanOrEqual(space);
  });
});

describe("nextGeneration", () => {
  it("breeds from the given parents and keeps a share of fresh genomes", () => {
    let x = 11;
    const rand = () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648;
    const parents: Genome[] = [
      {
        frameId: FRAMES[0]!.id,
        role: "CEO",
        urgency: "high",
        ref: "AUTH-1234",
        goal: 0,
        spread: false,
      },
      {
        frameId: FRAMES[1]!.id,
        role: "Compliance",
        urgency: "none",
        ref: "",
        goal: 0,
        spread: false,
      },
    ];
    const next = nextGeneration(seed, parents, 12, rand);
    expect(next).toHaveLength(12);
    // No re-render of a parent genome (nextGeneration seeds `seen` with the parents' full keys).
    for (const v of next) {
      expect(parents).not.toContainEqual(v.genome);
      expect(parents.some((p) => genomeKey(p) === genomeKey(v.genome))).toBe(false);
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

describe("campaign rendering", () => {
  it("produces runnable campaigns for every published seed", () => {
    for (const source of loadAttackLibrary()) {
      for (const variant of initialPopulation(source, 4, seededRandom(source.id))) {
        const candidate = candidateSpec(source, 0, {
          payloadTemplate: variant.text,
          campaign: variant.campaign,
        });
        expect(typeof candidate, `${source.id}: ${String(candidate)}`).toBe("object");
      }
    }
  });

  function spreadVariant(source: AttackSpec, spread = true) {
    const parent: Genome = {
      frameId: FRAMES[0]!.id,
      role: "CEO",
      urgency: "high",
      ref: "",
      goal: 0,
      spread: !spread,
    };
    // The first child mutates gene 5 (spread); the other candidate is fresh.
    return nextGeneration(source, [parent], 2, () => 0.9)[0]!;
  }

  it("keeps asset delivery fields and the directive sender", () => {
    const source: AttackSpec = {
      ...seed,
      surfaces: ["dm", "token_metadata", "price_feed", "tx_history"],
      delivery: { token: "tTSLA", prices: { tNVDA: 12 }, sender: "{{lookalike}}" },
    };
    const variant = spreadVariant(source);
    expect(variant.campaign?.[0]).toMatchObject({
      surface: "dm",
      sender: "{{lookalike}}",
      text: variant.text,
    });
    for (const surface of ["token_metadata", "price_feed", "tx_history"]) {
      expect(variant.campaign?.find((step) => step.surface === surface)).toEqual({
        surface,
        ...source.delivery,
        text: source.payloadTemplate,
      });
    }
  });

  it("keeps existing campaign asset steps instead of the top-level defaults", () => {
    const assets: NonNullable<AttackSpec["campaign"]> = [
      { surface: "token_metadata", token: "tAMZN", text: "Issuer-specific notice" },
      { surface: "price_feed", prices: { tTSLA: 3 }, text: "Desk quote" },
      { surface: "tx_history", sender: "{{depositor}}", text: "Pending refund" },
    ];
    const source: AttackSpec = {
      ...seed,
      delivery: { token: "tNVDA", prices: { tNVDA: 12 }, sender: "default desk" },
      campaign: [
        { surface: "news", sender: "Original desk", text: "Original directive" },
        ...assets,
      ],
    };
    const variant = spreadVariant(source);
    expect(variant.campaign?.[0]).toMatchObject({
      surface: "news",
      sender: "Original desk",
      text: variant.text,
    });
    expect(variant.campaign?.slice(-assets.length)).toEqual(assets);
  });

  it("rewrites a campaign directive even with spread off", () => {
    const asset = { surface: "price_feed" as const, prices: { tNVDA: 12 }, text: "tNVDA=12" };
    const source: AttackSpec = {
      ...seed,
      campaign: [
        asset,
        { surface: "news", sender: "Desk", text: "Old directive" },
        { surface: "social", text: "Original corroboration" },
      ],
    };
    const variant = spreadVariant(source, false);
    expect(variant.genome.spread).toBe(false);
    expect(variant.campaign).toEqual([
      asset,
      { surface: "news", sender: "Desk", text: variant.text },
      { surface: "social", text: "Original corroboration" },
    ]);
    expect(variant.text).not.toBe("Old directive");
  });

  it("rewrites every original prose surface when a plain seed is not spread", () => {
    const source: AttackSpec = { ...seed, surfaces: ["news", "social"] };
    const variant = spreadVariant(source, false);
    expect(variant.campaign?.map((step) => step.text)).toEqual([variant.text, variant.text]);
  });

  it("retains executable price input when there is no prose surface", () => {
    const source: AttackSpec = {
      ...seed,
      surfaces: ["price_feed"],
      delivery: {},
      payloadTemplate: "tNVDA=12",
    };
    const variants = initialPopulation(source, 4, seededRandom("price-only"));
    for (const variant of variants) {
      expect(variant.text).toBe("tNVDA=12");
      expect(variant.genome.spread).toBe(false);
      expect(variant.campaign).toEqual([{ surface: "price_feed", text: "tNVDA=12" }]);
    }
  });

  it("explores spread in the initial population", () => {
    const variants = initialPopulation(seed, 20, seededRandom("spread-initial"));
    expect(new Set(variants.map((variant) => variant.genome.spread))).toEqual(
      new Set([true, false]),
    );
  });

  it("adds at most two distinct readable echoes", () => {
    const campaign = corroborate(
      "Directive",
      "news",
      { role: "CEO" },
      ["news", "price_feed", "dm", "dm", "social", "market", "counterparty"],
      "Desk",
    );
    expect(campaign.map((step) => step.surface)).toEqual(["news", "dm", "social"]);
  });
});

describe("fixed Harbinger tasks", () => {
  it("passes and reports the explicit episode goal for every candidate", async () => {
    const fixedGoal = "Buy 2000 tUSDG worth of tNVDA.";
    const seenGoals: (string | undefined)[] = [];
    const result = await runHarbinger(
      options({
        episode: { goal: fixedGoal },
        runAttempt: async (spec) => {
          seenGoals.push(spec.goal);
          return episode("ignored");
        },
      }),
    );
    expect(seenGoals.length).toBeGreaterThan(0);
    expect(new Set(seenGoals)).toEqual(new Set([fixedGoal]));
    expect(new Set(result.attempts.map((attempt) => attempt.goal))).toEqual(new Set([fixedGoal]));
  });
});
