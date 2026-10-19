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

it("keeps one entry per slug and ranks measured security grades before legacy insurance scores", () => {
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
