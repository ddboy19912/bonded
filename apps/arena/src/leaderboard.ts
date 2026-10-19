import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Attestation, Leaderboard, LeaderboardEntry } from "@bondedhq/shared";
import { keccak256, stringToBytes } from "viem";
import type { RatingReport } from "./rate.js";

/** The published leaderboard (served by GET /leaderboard). */
export const LEADERBOARD_FILE = fileURLToPath(
  new URL("../../../config/leaderboard.json", import.meta.url),
);

export function readLeaderboard(path = LEADERBOARD_FILE): LeaderboardEntry[] {
  return Leaderboard.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** The headline the board ranks by: the security grade (susceptibility), with unmeasured legacy entries
 * after measured grades. Insurance scores cannot substitute for security evidence. */
export function rankingScore(e: LeaderboardEntry): number {
  return e.securityGrade ?? -1;
}

export function writeLeaderboard(entries: LeaderboardEntry[], path = LEADERBOARD_FILE): void {
  const sorted = [...Leaderboard.parse(entries)].sort(
    (a, b) => rankingScore(b) - rankingScore(a) || a.slug.localeCompare(b.slug),
  );
  writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`);
}

/**
 * Why a rating can't be published: it stopped early or had agent errors, so some attacks were
 * never judged and its result would look cleaner than it is. Undefined if it can.
 */
export function unpublishableReason(report: RatingReport): string | undefined {
  if (report.stoppedEarly) return `it stopped early (${report.stoppedEarly})`;
  if (report.episodes.agentErrors > 0)
    return `${report.episodes.agentErrors} episode(s) ended in an agent error`;
  const errored = report.classes.filter((c) => c.agentErrors > 0).map((c) => c.class);
  if (errored.length) return `agent errors in ${errored.join(", ")}`;
  return undefined;
}

/**
 * A rating as a leaderboard entry: class-level results only. The report's worst-case list
 * (which seeds breached) and the traces stay out, per the disclosure policy.
 */
export function entryFromRating(
  report: RatingReport,
  reportHash: string,
  meta: Pick<
    LeaderboardEntry,
    "slug" | "name" | "kind" | "framework" | "model" | "onchain" | "disclosure"
  > & { template?: string },
): LeaderboardEntry {
  const reason = unpublishableReason(report);
  if (reason) throw new Error(`not publishable: ${reason}`);
  return LeaderboardEntry.parse({
    ...meta,
    ratedAt: report.startedAt,
    ...(report.susceptibility
      ? { securityGrade: report.susceptibility.grade, worstClass: report.susceptibility.worstClass }
      : {}),
    score: report.scoring.score,
    tier: report.scoring.tier,
    expectedLossBps: report.scoring.expectedLossBps,
    premiumRateBps: report.scoring.premiumRateBps,
    insurable: report.scoring.insurable,
    episodes: {
      attacks: report.episodes.attacks,
      controls: report.controls.episodes,
      controlBreaches: report.controls.breaches,
    },
    classes: report.classes.map((c) => ({
      class: c.class,
      name: c.name,
      episodes: c.episodes,
      ...(c.manipulated === undefined ? {} : { manipulated: c.manipulated }),
      breaches: c.breaches,
    })),
    reportHash,
  });
}

/** Insert or replace the entry with the same slug. */
export function upsertEntry(entries: LeaderboardEntry[], entry: LeaderboardEntry) {
  return [...entries.filter((e) => e.slug !== entry.slug), entry];
}

/**
 * A rating folder, checked before anything is published (docs/SPECIFICATION.md Section 8.6): the
 * keccak256 of report.json's exact bytes must equal the attestation's report hash (top level
 * and signed), the attestation must parse, and its score and expected loss must be the report's.
 * A mismatched or edited folder throws.
 */
export function loadRating(dir: string): {
  report: RatingReport;
  attestation: Attestation;
  reportHash: string;
} {
  const bytes = readFileSync(join(dir, "report.json"), "utf8");
  const file = JSON.parse(readFileSync(join(dir, "attestation.json"), "utf8")) as {
    attestation: unknown;
    reportHash?: string;
  };
  const attestation = Attestation.parse(file.attestation);
  const hash = keccak256(stringToBytes(bytes));
  if (hash !== attestation.reportHash || hash !== file.reportHash)
    throw new Error(`${dir}: report.json doesn't match the attestation's report hash`);
  const report = JSON.parse(bytes) as RatingReport;
  if (
    report.scoring.score !== attestation.score ||
    report.scoring.expectedLossBps !== attestation.expectedLossBps ||
    // The public security grade must match what was signed, when the report carries one.
    (report.susceptibility !== undefined &&
      report.susceptibility.grade !== attestation.securityScore)
  )
    throw new Error(`${dir}: the report's score or expected loss differs from the attestation`);
  return { report, attestation, reportHash: hash };
}
