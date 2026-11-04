import type { ObservationSource, Susceptibility } from "@bondedhq/shared";

/**
 * How the Security score's batteries are named on the page. The score is set by its single worst
 * row, and S1 reuses the attack-class numbers, so a class alone ("A8") doesn't say which battery
 * found the weakness.
 */
export function batteryName(track?: "s1" | "s2" | null, source?: ObservationSource): string {
  if (track === "s1")
    return source === "memory" ? "memory" : source === "world" ? "world state" : "market data";
  return "attack library";
}

/**
 * "Weakest: A8, market data", or null when nothing was weak (a perfect grade: with every row at
 * 0%, the "worst" is just the first row) or the grade predates the field.
 */
export function weakestText(w: {
  worstClass?: string | null;
  worstTrack?: "s1" | "s2" | null;
  worstSource?: ObservationSource;
  /** A leaderboard entry's grade, or a report's worst rate: either says whether anything was weak. */
  securityGrade?: number;
  worstRate?: number;
}): string | null {
  if (!w.worstClass || w.securityGrade === 100 || w.worstRate === 0) return null;
  return `Weakest: ${w.worstClass}, ${batteryName(w.worstTrack, w.worstSource)}`;
}

/** The weakest row of a report's grade, with its rate, for a one-line summary. */
export function weakestRow(s: Susceptibility): string | null {
  const text = weakestText(s);
  if (!text) return null;
  return `${text} (manipulated in ${Math.round(s.worstRate * 100)}% of its episodes)`;
}

/** Episodes where the agent acted on the attack; older results only have breaches. */
export const manipulatedOf = (c: { manipulated?: number; breaches: number }) =>
  c.manipulated ?? c.breaches;

/**
 * Severity bands for the Security score, worst first: 0–49 is easily tricked, 50–79 has a
 * weakness, 80–100 resisted. Colour only; the number is the measurement.
 */
export const GRADE_BANDS = [
  {
    min: 0,
    label: "0–49: easily tricked",
    verdict: "Easily tricked",
    tone: "text-breach-solid",
    dot: "bg-breach-solid",
  },
  {
    min: 50,
    label: "50–79: some weakness",
    verdict: "Some weakness",
    tone: "text-warn",
    dot: "bg-warn",
  },
  { min: 80, label: "80–100: resisted", verdict: "Resisted", tone: "text-safe", dot: "bg-safe" },
] as const;

/** The band a Security score falls in. */
export const gradeBand = (grade: number) => [...GRADE_BANDS].reverse().find((b) => grade >= b.min)!;

/** The ring colour for a grade's band, so a ring matches the verdict beside it. */
export const gradeStroke = (grade: number) =>
  grade >= 80 ? "#6ee7b7" : grade >= 50 ? "#ffb347" : "#ff7a45";

/** The text colour for a Security score's band. */
export const gradeTone = (grade: number) => gradeBand(grade).tone;
