import { describe, expect, it } from "vitest";
import { CALIBRATION, calibrationProblems } from "../src/offchain/calibration.js";
import type { LedgerBreachType } from "../src/offchain/ledger.js";
import { loadOffchainSeeds, OFFCHAIN_STAGED_SEEDS_DIR } from "../src/offchain/seeds.js";

const seeds = [...loadOffchainSeeds(), ...loadOffchainSeeds(OFFCHAIN_STAGED_SEEDS_DIR)];

describe("calibration against published fraud patterns", () => {
  it("maps every library and staged seed, and each seed aims at the pattern's rule", () => {
    expect(calibrationProblems(seeds)).toEqual([]);
  });

  it("covers every off-chain attack class", () => {
    const byId = new Map(seeds.map((seed) => [seed.id, seed]));
    const classes = new Set(
      CALIBRATION.flatMap((pattern) => pattern.seeds.map((id) => byId.get(id)!.class)),
    );
    expect([...classes].sort()).toEqual(["O1", "O2", "O3", "O4", "O5", "O6"]);
  });

  it("names a documented pattern and a source for every entry", () => {
    for (const pattern of CALIBRATION) {
      expect(pattern.name.length).toBeGreaterThan(3);
      expect(pattern.documented.length).toBeGreaterThan(30);
      expect(pattern.source).toMatch(/FBI IC3|UK Finance|OWASP/);
      expect(pattern.rules.length).toBeGreaterThan(0);
    }
  });

  it("reports a seed the map names but the library doesn't have", () => {
    const without = seeds.filter((seed) => seed.id !== "O1-lookalike-domain-001");
    expect(calibrationProblems(without)).toContain(
      "lookalike-domain: no seed O1-lookalike-domain-001",
    );
  });

  it("reports a seed that doesn't aim at the pattern's rule", () => {
    const wrong = seeds.map((seed) =>
      seed.id === "O1-lookalike-domain-001"
        ? { ...seed, aimedAt: ["duplicate_payment"] as LedgerBreachType[] }
        : seed,
    );
    expect(calibrationProblems(wrong)).toContain(
      "lookalike-domain: O1-lookalike-domain-001 doesn't aim at unknown_payee",
    );
  });

  it("reports a seed no pattern covers", () => {
    expect(
      calibrationProblems([...seeds, { id: "O1-new-001", aimedAt: ["unknown_payee"] }]),
    ).toContain("unmapped seed O1-new-001");
  });
});
