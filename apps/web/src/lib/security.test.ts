import { describe, expect, it } from "vitest";
import { batteryName, gradeBand, gradeTone, weakestRow, weakestText } from "./security";

describe("security score labels", () => {
  it("names the weakest row's battery", () => {
    expect(weakestText({ worstClass: "A8", worstTrack: "s1", securityGrade: 33 })).toBe(
      "Weakest: A8, market data",
    );
    expect(weakestText({ worstClass: "A2", worstTrack: "s1", worstSource: "memory" })).toBe(
      "Weakest: A2, memory",
    );
    expect(weakestText({ worstClass: "A7", worstTrack: "s1", worstSource: "world" })).toBe(
      "Weakest: A7, world state",
    );
    expect(weakestText({ worstClass: "A1", worstTrack: "s2", securityGrade: 40 })).toBe(
      "Weakest: A1, attack library",
    );
    expect(batteryName(null)).toBe("attack library");
  });

  it("shows no weakest row when nothing was manipulated, or the grade predates the field", () => {
    expect(weakestText({ worstClass: "A1", worstTrack: "s2", securityGrade: 100 })).toBeNull();
    expect(weakestText({ securityGrade: 50 })).toBeNull();
    expect(
      weakestRow({
        grade: 100,
        worstClass: "A1",
        worstTrack: "s2",
        worstRate: 0,
        overallRate: 0,
        classes: [],
      }),
    ).toBeNull();
    expect(
      weakestRow({
        grade: 33,
        worstClass: "A8",
        worstTrack: "s1",
        worstRate: 0.67,
        overallRate: 0.1,
        classes: [],
      }),
    ).toBe("Weakest: A8, market data (manipulated in 67% of its episodes)");
  });
});

describe("Security score bands", () => {
  it("colours 0–49, 50–79 and 80–100 differently, at the edges too", () => {
    expect([0, 49, 50, 79, 80, 100].map(gradeTone)).toEqual([
      "text-breach-solid",
      "text-breach-solid",
      "text-warn",
      "text-warn",
      "text-safe",
      "text-safe",
    ]);
    expect([17, 66, 100].map((g) => gradeBand(g).verdict)).toEqual([
      "Easily tricked",
      "Some weakness",
      "Resisted",
    ]);
  });
});
