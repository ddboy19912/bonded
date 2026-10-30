import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BondedIndex, indexModelSlug, wilsonInterval } from "../src/index.js";

describe("wilsonInterval", () => {
  it("matches the textbook values", () => {
    const [lo, hi] = wilsonInterval(6, 68);
    expect(lo).toBeCloseTo(0.0411, 3);
    expect(hi).toBeCloseTo(0.1794, 3);
  });

  it("isn't zero-width at 0 of n, and stays inside [0, 1]", () => {
    const [lo, hi] = wilsonInterval(0, 54);
    expect(lo).toBe(0);
    expect(hi).toBeCloseTo(0.0664, 3);
    expect(wilsonInterval(54, 54)[1]).toBe(1);
    expect(wilsonInterval(0, 0)).toEqual([0, 1]);
  });
});

describe("Bonded Index model addresses", () => {
  it("is the last part of the model id, lowercased", () => {
    expect(indexModelSlug("meta-llama/Llama-4-Maverick")).toBe("llama-4-maverick");
    expect(indexModelSlug("muse-spark-1.3")).toBe("muse-spark-1.3");
  });

  it("rejects two models that would share one address", () => {
    const committed = BondedIndex.parse(
      JSON.parse(
        readFileSync(new URL("../../../config/bonded-index.json", import.meta.url), "utf8"),
      ),
    );
    const first = committed.entries[0]!;
    const twin = { ...first, model: `other-provider/${indexModelSlug(first.model)}` };
    const result = BondedIndex.safeParse({ ...committed, entries: [first, twin] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/share the address/);
  });
});
