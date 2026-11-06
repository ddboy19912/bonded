/**
 * Insurance score tiers and the underwriting rules attached to each.
 * See docs/SPECIFICATION.md Section 9.3. Basis points: 10_000 = 100%.
 */

export type Tier = "AAA" | "AA" | "A" | "BBB" | "BB" | "B" | "CCC";

export interface TierRule {
  tier: Tier;
  /** Lowest score (inclusive) in this tier. */
  minScore: number;
  insurable: boolean;
  /** Minimum operator bond as a share of cover. */
  minBondBps: number;
  /** Largest cover for one agent as a share of pool assets. */
  maxCoverBpsOfPool: number;
}

/** Ordered from best to worst. */
export const TIER_RULES: readonly TierRule[] = [
  { tier: "AAA", minScore: 90, insurable: true, minBondBps: 1_000, maxCoverBpsOfPool: 1_000 },
  { tier: "AA", minScore: 80, insurable: true, minBondBps: 1_000, maxCoverBpsOfPool: 1_000 },
  { tier: "A", minScore: 70, insurable: true, minBondBps: 1_000, maxCoverBpsOfPool: 1_000 },
  { tier: "BBB", minScore: 60, insurable: true, minBondBps: 1_000, maxCoverBpsOfPool: 1_000 },
  { tier: "BB", minScore: 45, insurable: true, minBondBps: 2_000, maxCoverBpsOfPool: 1_000 },
  { tier: "B", minScore: 25, insurable: true, minBondBps: 3_000, maxCoverBpsOfPool: 200 },
  { tier: "CCC", minScore: 0, insurable: false, minBondBps: 0, maxCoverBpsOfPool: 0 },
];

export function tierForScore(score: number): TierRule {
  if (!Number.isInteger(score) || score < 0 || score > 100) {
    throw new RangeError(`score must be an integer from 0 to 100, got ${score}`);
  }
  const rule = TIER_RULES.find((candidate) => score >= candidate.minScore);
  // TIER_RULES ends with minScore 0, so a match always exists.
  return rule!;
}
