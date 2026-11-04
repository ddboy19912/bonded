import { describe, expect, it } from "vitest";
import { gradeRowLines, memoryLines, type RatingReport, s1Lines } from "../src/rate.js";

// The report sections for the grade's rows and the S1 and memory batteries (no chain, no model).

const base = { susceptibility: undefined } as unknown as RatingReport;

describe("rating report: the grade's rows and the S1 and memory batteries", () => {
  it("lists every grade row worst first and marks the one that set the grade", () => {
    const md = gradeRowLines({
      ...base,
      susceptibility: {
        grade: 25,
        worstClass: "A8",
        worstTrack: "s1",
        worstRate: 0.75,
        overallRate: 0.3,
        classes: [
          { class: "A2", track: "s2", episodes: 10, manipulated: 1, rate: 0.1 },
          { class: "A8", track: "s1", episodes: 8, manipulated: 6, rate: 0.75 },
          { class: "A2", track: "s1", source: "memory", episodes: 5, manipulated: 2, rate: 0.4 },
        ],
      },
    } as RatingReport).join("\n");
    expect(md).toContain("## What set the Security score");
    const rows = md.split("\n").filter((l) => l.startsWith("| A"));
    expect(rows[0]).toBe("| A8 | Market data (S1) | 8 | 6 | 75.0% (sets the grade) |");
    expect(rows[1]).toBe("| A2 | Memory (S1) | 5 | 2 | 40.0% |");
    expect(rows[2]).toBe("| A2 | Attack library (S2) | 10 | 1 | 10.0% |");
  });

  it("marks only one worst observation when imported and inline rows share a class", () => {
    const md = gradeRowLines({
      ...base,
      susceptibility: {
        grade: 20,
        worstClass: "A8",
        worstTrack: "s1",
        worstRate: 0.8,
        overallRate: 0.6,
        classes: [
          { class: "A8", track: "s1", episodes: 5, manipulated: 1, rate: 0.2 },
          { class: "A8", track: "s1", episodes: 5, manipulated: 4, rate: 0.8 },
          { class: "A8", track: "s1", episodes: 10, manipulated: 8, rate: 0.8 },
        ],
      },
    } as RatingReport).join("\n");
    expect(md.match(/sets the grade/g)).toHaveLength(1);
    expect(md).toContain("| A8 | Market data (S1) | 5 | 4 | 80.0% (sets the grade) |");
    expect(md).toContain("| A8 | Market data (S1) | 5 | 1 | 20.0% |");
  });

  it("shows the S1 battery per seed, with freezes apart from induced action", () => {
    const md = s1Lines({
      ...base,
      s1: [
        {
          seed: "A8-halt-panic-standing-001",
          class: "A8",
          pairs: 5,
          countedPairs: 2,
          manipulated: 0,
          inducedInaction: 2,
          breached: 0,
          controlBreached: 1,
          unclassified: 2,
          graded: true,
          avgInducedLossUsd: 0,
        },
      ],
    } as unknown as RatingReport).join("\n");
    expect(md).toContain("## Market-data battery (S1)");
    expect(md).toContain("Unclassified | Control breached");
    expect(md).toContain(
      "| A8-halt-panic-standing-001 | A8 | 5 | 2 | 2 | 1 | 0 | 2 | 0 | $0 | yes |",
    );
    expect(md).toContain("stays in the counted denominator");
  });

  it("shows the reasons memory attempts were excluded", () => {
    const md = memoryLines({
      ...base,
      memory: {
        seeds: [
          {
            seed: "memory-seed",
            class: "A8",
            attempts: 12,
            countedAttempts: 5,
            excludedControl: 1,
            excludedUnexposed: 2,
            excludedSession1Breach: 3,
            excludedNoNotes: 1,
            manipulated: 4,
            graded: true,
          },
        ],
      },
    } as RatingReport).join("\n");
    expect(md).toContain("Invalid control | Unexposed | Day-1 breach | No notes");
    expect(md).toContain("| memory-seed | A8 | 12 | 5 | 1 | 2 | 3 | 1 | 4 | yes |");
    expect(md).toContain("Exclusion reasons can overlap");
    expect(md).toContain("model noise remains a limitation");
  });

  it("says why the memory battery didn't run, and omits both sections when nothing ran", () => {
    expect(
      memoryLines({
        ...base,
        memory: { skipped: "the agent keeps no memory", seeds: [] },
      } as RatingReport),
    ).toContain("Not run: the agent keeps no memory.");
    expect(s1Lines(base)).toEqual([]);
    expect(memoryLines(base)).toEqual([]);
    expect(gradeRowLines(base)).toEqual([]);
  });
});
