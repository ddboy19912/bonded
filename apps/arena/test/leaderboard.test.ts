import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keccak256, stringToBytes } from "viem";
import {
  entryFromRating,
  loadRating,
  readLeaderboard,
  unpublishableReason,
  upsertEntry,
  writeLeaderboard,
} from "../src/leaderboard.js";
import type { RatingReport } from "../src/rate.js";

const report = {
  startedAt: "2026-10-03T12:00:00.000Z",
  scoring: {
    score: 31,
    tier: "CCC",
    expectedLossBps: 1500,
    premiumRateBps: 2100,
    insurable: false,
  },
  episodes: { total: 42, attacks: 40, controls: 2, agentErrors: 0 },
  controls: { episodes: 2, breaches: 0 },
  classes: [
    {
      class: "A2",
      name: "Injection via content",
      episodes: 4,
      agentErrors: 0,
      breaches: 3,
      attackSucceeded: 3,
      lossUsd: 15000,
    },
  ],
  worst: [
    {
      episodeId: "A2-fake-halt-news-001-1",
      attackId: "A2-fake-halt-news-001",
      lossUsd: 5000,
      breaches: ["T1_UNAUTHORIZED_TRANSFER"],
    },
  ],
} as unknown as RatingReport;

const meta = {
  slug: "agentkit-test",
  name: "AgentKit chatbot",
  kind: "framework" as const,
  framework: "Coinbase AgentKit",
  model: "deepseek/deepseek-v4.1-flash",
  onchain: null,
  disclosure: { status: "pending" as const },
};

it("publishes class-level results only, never which seeds broke the agent", () => {
  const e = entryFromRating(report, `0x${"ab".repeat(32)}`, meta);
  expect(e).toMatchObject({
    score: 31,
    episodes: { attacks: 40, controls: 2, controlBreaches: 0 },
    classes: [{ class: "A2", name: "Injection via content", episodes: 4, breaches: 3 }],
  });
  expect(JSON.stringify(e)).not.toContain("A2-fake-halt-news-001");
  expect(JSON.stringify(e)).not.toContain("lossUsd");
});

it("records the attack library version the rating ran against, when the report has one", () => {
  const hash = `0x${"ab".repeat(32)}` as const;
  expect(entryFromRating({ ...report, libraryVersion: 3 }, hash, meta).libraryVersion).toBe(3);
  // An older report without a version stays unversioned rather than claiming the current one.
  expect(entryFromRating(report, hash, meta)).not.toHaveProperty("libraryVersion");
});

it("publishes the grade's weakest track and the S1 and memory batteries at class level", () => {
  const graded = {
    ...report,
    susceptibility: {
      grade: 25,
      worstClass: "A8",
      worstTrack: "s1",
      worstRate: 0.75,
      overallRate: 0.4,
      classes: [],
    },
    s1: [
      {
        seed: "A8-fake-depeg-001",
        class: "A8",
        pairs: 4,
        countedPairs: 4,
        manipulated: 3,
        breached: 2,
        controlBreached: 0,
        inducedInaction: 0,
        unclassified: 0,
        graded: true,
        avgInducedLossUsd: 10,
      },
      {
        seed: "A8-halt-panic-standing-001",
        class: "A8",
        pairs: 4,
        countedPairs: 4,
        manipulated: 0,
        breached: 0,
        controlBreached: 0,
        inducedInaction: 4,
        unclassified: 0,
        graded: true,
        avgInducedLossUsd: 0,
      },
      {
        seed: "A3-stale-tick-001",
        class: "A3",
        pairs: 2,
        countedPairs: 2,
        manipulated: 1,
        breached: 0,
        controlBreached: 0,
        graded: false,
        avgInducedLossUsd: 0,
      },
    ],
    memory: {
      seeds: [
        {
          seed: "A2-memory-x-001",
          class: "A2",
          attempts: 3,
          countedAttempts: 3,
          graded: false,
          manipulated: 1,
        },
        {
          seed: "A2-memory-y-001",
          class: "A2",
          attempts: 3,
          countedAttempts: 2,
          graded: false,
          manipulated: 0,
        },
      ],
    },
    worldState: {
      twins: 4,
      seeds: [
        {
          seed: "A7-carried-queue-001",
          class: "A7",
          attempts: 3,
          countedAttempts: 3,
          graded: true,
          manipulated: 2,
        },
        {
          seed: "A7-carried-approval-001",
          class: "A7",
          attempts: 3,
          countedAttempts: 2,
          graded: true,
          manipulated: 0,
        },
        {
          seed: "A9-carried-leg-two-001",
          class: "A9",
          attempts: 3,
          countedAttempts: 1,
          graded: false,
          manipulated: 0,
        },
      ],
    },
  } as unknown as RatingReport;
  const e = entryFromRating(graded, `0x${"ab".repeat(32)}`, meta);
  expect(e).toMatchObject({ securityGrade: 25, worstClass: "A8", worstTrack: "s1" });
  expect(e.worstSource).toBeUndefined();
  expect(e.s1Classes).toEqual([
    { class: "A3", counted: 2, manipulated: 1, inducedInaction: 0, breaches: 0, graded: false },
    { class: "A8", counted: 8, manipulated: 3, inducedInaction: 4, breaches: 2, graded: true },
  ]);
  expect(e.memoryClasses).toEqual([{ class: "A2", counted: 5, manipulated: 1, graded: false }]);
  expect(e.worldClasses).toEqual([
    { class: "A7", counted: 5, manipulated: 2, graded: true },
    { class: "A9", counted: 1, manipulated: 0, graded: false },
  ]);
  // Seed ids stay out, as for the main library.
  expect(JSON.stringify(e)).not.toContain("A8-fake-depeg-001");
  // A rating with no batteries publishes neither field.
  const plain = entryFromRating(report, `0x${"ab".repeat(32)}`, meta);
  expect(plain.s1Classes).toBeUndefined();
  expect(plain.memoryClasses).toBeUndefined();
  expect(plain.worldClasses).toBeUndefined();
});

it("keeps one entry per slug and ranks measured Security scores before legacy insurance scores", () => {
  const dir = mkdtempSync(join(tmpdir(), "lb-"));
  try {
    const file = join(dir, "leaderboard.json");
    writeFileSync(file, "[]\n");
    const a = entryFromRating(report, `0x${"ab".repeat(32)}`, meta);
    const b = { ...a, slug: "other", score: 90, securityGrade: 0 };
    writeLeaderboard(upsertEntry(upsertEntry(readLeaderboard(file), a), b), file);
    writeLeaderboard(upsertEntry(readLeaderboard(file), { ...a, score: 35 }), file);
    expect(readLeaderboard(file).map((e) => [e.slug, e.score])).toEqual([
      ["other", 90],
      ["agentkit-test", 35],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("publishing a rating", () => {
  const folder = (r: object, tamper?: (bytes: string) => string) => {
    const dir = mkdtempSync(join(tmpdir(), "rating-"));
    const bytes = `${JSON.stringify(r, null, 2)}\n`;
    const reportHash = keccak256(stringToBytes(bytes));
    const attestation = {
      agentId: "1",
      score: 31,
      securityScore: 31,
      expectedLossBps: 1500,
      reportHash,
      mandateHash: `0x${"11".repeat(32)}`,
      codeHash: `0x${"22".repeat(32)}`,
      teeMeasurement: `0x${"00".repeat(32)}`,
      modelFamily: "unknown",
      issuedAt: 1_790_000_000,
      expiresAt: 1_792_592_000,
    };
    writeFileSync(join(dir, "report.json"), tamper ? tamper(bytes) : bytes);
    writeFileSync(join(dir, "attestation.json"), JSON.stringify({ attestation, reportHash }));
    return dir;
  };
  const full = {
    ...(report as object),
    stoppedEarly: null,
    episodes: { total: 42, attacks: 40, controls: 2, agentErrors: 0 },
  };

  it("accepts a report whose bytes the attestation signed", () => {
    const dir = folder(full);
    try {
      expect(loadRating(dir).report.scoring.score).toBe(31);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a report edited after signing, even with the same score", () => {
    // The reviewer's case: A2 results changed, score kept.
    const dir = folder(full, (b) => b.replace('"breaches": 3', '"breaches": 4'));
    try {
      expect(() => loadRating(dir)).toThrow(/doesn't match the attestation/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses incomplete ratings: all errors, or stopped early", () => {
    const allErrors = {
      ...full,
      episodes: { total: 42, attacks: 40, controls: 2, agentErrors: 42 },
      classes: [{ class: "A2", name: "x", episodes: 0, agentErrors: 4, breaches: 0 }],
    } as unknown as RatingReport;
    expect(unpublishableReason(allErrors)).toMatch(/agent error/);
    expect(() => entryFromRating(allErrors, `0x${"ab".repeat(32)}`, meta)).toThrow(
      /not publishable/,
    );
    const capped = { ...full, stoppedEarly: "spending cap reached" } as unknown as RatingReport;
    expect(() => entryFromRating(capped, `0x${"ab".repeat(32)}`, meta)).toThrow(/stopped early/);
  });
});
