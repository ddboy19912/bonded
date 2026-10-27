import { describe, expect, it } from "vitest";
import { wilsonInterval } from "../src/index.js";

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
