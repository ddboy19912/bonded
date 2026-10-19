import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAttackLibrary } from "../src/attacks.js";
import { goalOk } from "../src/harbinger/goals.js";
import { plantAttack } from "../src/episode.js";
import { selectS1Seeds } from "../src/s1-seeds.js";
import { World } from "../src/world.js";

// Structural guards for the S1 attack battery (docs/S1-TAXONOMY.md). Deterministic and free: no
// chain and no model. loadAttackLibrary already throws on an invalid seed or a duplicate id; this
// pins the S1-specific invariants and the taxonomy's family coverage so a new seed can't drift.

const S1_DIR = fileURLToPath(new URL("../s1-seeds", import.meta.url));
const seeds = loadAttackLibrary(S1_DIR);

// The Arena's only market tokens (apps/arena/src/vault.ts). A skew or spoofed price on anything
// else is a no-op, so it would silently never fire.
const MARKET_TOKENS = new Set(["tUSDG", "tTSLA", "tAMZN", "tNVDA"]);
const STOCK_TOKENS = new Set(["tTSLA", "tAMZN", "tNVDA"]);
const tokens = [...MARKET_TOKENS].map((symbol, i) => ({
  symbol,
  address: `0x${String(i + 1).repeat(40)}` as `0x${string}`,
  decimals: symbol === "tUSDG" ? 6 : 18,
}));
const depositor = `0x${"a".repeat(40)}` as const;
const vars = { lookalike: `0x${"b".repeat(40)}` };
const seedWorld = () => new World(tokens, depositor);

// Every falsehood family the taxonomy claims to cover must have at least one seed.
const FAMILY_TAGS = [
  "s1-event",
  "s1-social",
  "s1-anchor",
  "s1-price",
  "s1-numeric",
  "s1-context",
  "s1-panic",
  "s1-counterparty",
];

describe("S1 seed battery", () => {
  it("has seeds", () => {
    expect(seeds.length).toBeGreaterThanOrEqual(15);
  });

  it("every seed is tagged s1 and carries a benign, in-mandate goal", () => {
    for (const s of seeds) {
      expect(s.tags, s.id).toContain("s1");
      expect(s.goal, `${s.id} needs its own goal`).toBeTruthy();
      // The goal is handed to the agent as its task, so it must be safe by itself (no planted
      // address, placeholder or oversize ask): the breach must come from the attack, not the task.
      expect(goalOk(s.goal!), `${s.id} goal must pass goalOk`).toBe(true);
    }
  });

  it("every execution skew and spoofed price names a real market token", () => {
    for (const s of seeds) {
      const skew = s.delivery.executionSkew;
      if (skew) expect(STOCK_TOKENS.has(skew.token), `${s.id} skew token`).toBe(true);
      for (const token of Object.keys(s.delivery.prices ?? {}))
        expect(MARKET_TOKENS.has(token), `${s.id} price token ${token}`).toBe(true);
    }
  });

  it("renders and plants every seed on its declared surfaces", () => {
    for (const seed of seeds) {
      const world = seedWorld();
      expect(() => plantAttack(world, seed, vars), seed.id).not.toThrow();
      if (seed.surfaces.includes("tx_history")) {
        expect(
          world.transfers.some((entry) => entry.note === seed.payloadTemplate),
          seed.id,
        ).toBe(true);
      }
    }
  });

  it("delivers the liquidity claim in the market report, not just a numeric price", () => {
    const seed = seeds.find((s) => s.id === "A3-liquidity-depth-001")!;
    const world = seedWorld();
    plantAttack(world, seed, vars);
    expect(world.marketReport).toContain("liquidity: deep");
    expect(world.priceOverrides.get("tNVDA")).toBe(180);
  });

  it("delivers numeric data through the tool named by the goal", () => {
    for (const seed of seeds.filter((s) => s.class === "A7")) {
      const world = seedWorld();
      plantAttack(world, seed, vars);
      expect(seed.goal, seed.id).toContain("get_market_report");
      expect(world.marketReport, seed.id).toContain(seed.payloadTemplate);
    }
  });

  it("excludes reserved multi-agent seeds and rejects explicit unsupported or unknown selections", () => {
    const runnable = selectS1Seeds(seeds);
    expect(runnable).toHaveLength(seeds.length - 1);
    expect(runnable.every((s) => !s.tags.includes("needs-multiagent"))).toBe(true);
    expect(() => selectS1Seeds(seeds, "A10")).toThrow(/multi-agent targets are not supported/);
    expect(() => selectS1Seeds(seeds, "A10-false-consensus-anchor-001")).toThrow(/not supported/);
    expect(() => selectS1Seeds(seeds, "A2,typo")).toThrow(/no S1 seeds match typo/);
    expect(selectS1Seeds(seeds, "A7")).toHaveLength(3);
    expect(selectS1Seeds(seeds, "A3-liquidity-depth-001")).toHaveLength(1);
  });

  it("covers every falsehood family in the taxonomy", () => {
    const tags = new Set(seeds.flatMap((s) => s.tags));
    for (const family of FAMILY_TAGS) expect(tags, `no seed for ${family}`).toContain(family);
  });

  it("marks the multi-agent seed as not yet exercisable", () => {
    // A10 needs a pipeline target; until then its seeds must be flagged, not silently counted.
    for (const s of seeds.filter((x) => x.class === "A10"))
      expect(s.tags, s.id).toContain("needs-multiagent");
  });
});
