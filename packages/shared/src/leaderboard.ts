import { z } from "zod";

/**
 * The public Agent Safety Leaderboard (docs/SPECIFICATION.md Section 13.2). Each entry is one Arena
 * rating of an agent, published at class level: breach counts per attack class, never the
 * seeds that broke it or its transcripts (docs/disclosures). Ratings are attested, and an entry
 * with `onchain` set can be checked against the registry.
 */

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

export const LeaderboardEntry = z.strictObject({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  /** `framework`: a popular open-source template; `reference`: Bonded's own demo agents. */
  kind: z.enum(["framework", "reference"]),
  framework: z.string().min(1),
  /** The published template the entry runs, when it is one. */
  template: z.url().optional(),
  /** The model behind the agent, or null for a scripted agent. */
  model: z.string().nullable(),
  ratedAt: z.iso.datetime(),
  /**
   * The public headline: the security grade (susceptibility, 0–100, 100 = never tricked), and
   * the class the agent is weakest on. This is what the board ranks by. Optional so entries rated
   * before the weakness axis existed still parse; unmeasured entries follow graded entries.
   */
  securityGrade: z.number().int().min(0).max(100).optional(),
  worstClass: z.string().nullable().optional(),
  /** The loss-based insurance score and its tier (used for pricing and eligibility). */
  score: z.number().int().min(0).max(100),
  tier: z.string(),
  expectedLossBps: z.number().int().min(0),
  premiumRateBps: z.number().int().min(0),
  insurable: z.boolean(),
  /** Attack and control episodes, and how many controls breached. */
  episodes: z.strictObject({
    attacks: z.number().int().min(0),
    controls: z.number().int().min(0),
    controlBreaches: z.number().int().min(0),
  }),
  classes: z.array(
    z.strictObject({
      class: z.string(),
      name: z.string(),
      episodes: z.number().int().min(0),
      /** Episodes where the agent acted on the attack (the weakness). Optional on older entries. */
      manipulated: z.number().int().min(0).optional(),
      breaches: z.number().int().min(0),
    }),
  ),
  reportHash: hex32,
  /** Registered on chain; `tx` is the score post, null while it hasn't confirmed yet. */
  onchain: z
    .strictObject({
      chain: z.string(),
      agentId: z.string().regex(/^\d+$/),
      tx: hex32.nullable(),
    })
    .nullable(),
  disclosure: z.strictObject({
    /** not-needed: Bonded's own agent. pending: notice drafted, not sent. */
    status: z.enum(["not-needed", "pending", "notified", "published"]),
    notifiedAt: z.iso.date().optional(),
    /** The disclosure note in the repository. */
    note: z.string().optional(),
  }),
});
export type LeaderboardEntry = z.infer<typeof LeaderboardEntry>;

export const Leaderboard = z.array(LeaderboardEntry).superRefine((entries, ctx) => {
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.slug)) ctx.addIssue({ code: "custom", message: `duplicate slug ${e.slug}` });
    seen.add(e.slug);
  }
});

/** The injection classes: an agent that falls for these fails "basic prompt injection". */
export const INJECTION_CLASSES = ["A1", "A2", "A7"] as const;

const failsInjection = (e: LeaderboardEntry) =>
  e.classes.some(
    (c) => (INJECTION_CLASSES as readonly string[]).includes(c.class) && c.breaches > 0,
  );

/**
 * The headline stat from real runs, for framework templates and basic prompt injection
 * (classes A1, A2, A7). Each row is one template on one model, so it counts both: distinct
 * templates (by their source URL, or name), and template/model evaluations. A template fails if
 * any of its evaluations does.
 */
export function leaderboardHeadline(entries: readonly LeaderboardEntry[]) {
  const evaluations = entries.filter((e) => e.kind === "framework");
  const templates = new Map<string, boolean>();
  for (const e of evaluations) {
    const key = e.template ?? e.name;
    templates.set(key, (templates.get(key) ?? false) || failsInjection(e));
  }
  return {
    templates: templates.size,
    failingTemplates: [...templates.values()].filter(Boolean).length,
    evaluations: evaluations.length,
    failingEvaluations: evaluations.filter(failsInjection).length,
  };
}
