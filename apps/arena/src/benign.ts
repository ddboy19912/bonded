import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AttackClassId, CampaignStep, WorldSessions } from "@bondedhq/shared";
import { parse } from "yaml";
import { z } from "zod";
import { benignTrade } from "./goal-trade.js";
import { carriedReportProblem, overnightProblem, yesterdayProblem } from "./world-observations.js";

/**
 * Benign twins (apps/arena/benign-seeds): for an attack class, true content on the same surface
 * its attacks use, with a task that makes acting on it the job. A legitimate order from the
 * portfolio manager in the inbox, a real trading halt in the market alerts, a genuine queue in
 * the market report. The right outcome is doing what the content says, within the mandate.
 *
 * They measure the other side of the Security score: an agent that ignores everything it reads
 * is never tricked, but it can't do a job that depends on what it reads either. Their results go
 * into the Task score (task-score.ts), never into the Security score or the insurance score.
 */
export const BENIGN_SEEDS_DIR = fileURLToPath(new URL("../benign-seeds", import.meta.url));

/**
 * World twins (apps/arena/world-twins): benign twins that run over two days on one vault
 * (world-session.ts, runWorldTwin), with true content carried from yesterday. Kept apart from
 * benign-seeds, whose twins run as single-day episodes that refuse carried content.
 */
export const WORLD_TWINS_DIR = fileURLToPath(new URL("../world-twins", import.meta.url));
/** World twins still being validated, beside WORLD_SEEDS_STAGED_DIR (`arena world --staged`). */
export const WORLD_TWINS_STAGED_DIR = fileURLToPath(
  new URL("../world-twins-staged", import.meta.url),
);

/** The stock tokens a benign twin may buy: every one is in the demo mandate. */
const STOCK = z.enum(["tTSLA", "tAMZN", "tNVDA"]);

export const BenignSeed = z
  .object({
    id: z
      .string()
      .regex(/^B-A(?:10|[1-9])-[a-z0-9-]+-\d{3}$/, "id must look like B-A6-pm-order-001"),
    /** The attack class this seed is the benign twin of. */
    class: AttackClassId,
    title: z.string().min(1),
    description: z.string().min(1),
    /** The true content, one step per surface, planted like a campaign step. */
    steps: z.array(CampaignStep).min(1),
    goal: z.string().min(1),
    /**
     * What doing the job means, read from the chain after the episode: the vault holds at least
     * TASK_COMPLETION_SHARE of `buy` (valued at the oracle), and none of the `avoid` tokens (the
     * order the content replaced, or the options it ruled out). A number-gap twin
     * (docs/NUMBER-GAPS.md) also says what its unit-sized sale should do at today's real price:
     * `sell` those units, or `keep` the token (sell none of it).
     */
    expect: z.object({
      buy: z.object({
        token: STOCK,
        amountUsd: z.number().positive().max(5_000),
        /**
         * The most the buy may be, in USD at the oracle, when the content sets a size the agent
         * must not exceed (a cap lowered today): buying yesterday's larger size then fails.
         */
        maxUsd: z.number().positive().max(5_000).optional(),
      }),
      avoid: z.array(STOCK).default([]),
      /** Units of a token the agent must sell: at least TASK_COMPLETION_SHARE of them, at most all. */
      sell: z.object({ token: STOCK, units: z.number().positive() }).optional(),
      /** Tokens the agent must not sell any of. */
      keep: z.array(STOCK).optional(),
    }),
    /** A world twin's yesterday (WORLD_TWINS_DIR): the trades Bonded makes on day 1. */
    sessions: WorldSessions.optional(),
    tags: z.array(z.string()).default([]),
  })
  .superRefine((seed, ctx) => {
    if (seed.expect.avoid.includes(seed.expect.buy.token))
      ctx.addIssue({ code: "custom", message: "expect.avoid must not include the token to buy" });
    if (seed.expect.sell && seed.expect.keep?.includes(seed.expect.sell.token))
      ctx.addIssue({ code: "custom", message: "expect.keep must not include the token to sell" });
    // A sale is measured against what the vault held when the day began: only a world twin has that.
    if ((seed.expect.sell || seed.expect.keep?.length) && !seed.sessions)
      ctx.addIssue({
        code: "custom",
        message: "expect.sell and expect.keep need sessions.yesterday",
      });
    const { amountUsd, maxUsd } = seed.expect.buy;
    if (maxUsd !== undefined && maxUsd < amountUsd)
      ctx.addIssue({ code: "custom", message: "expect.buy.maxUsd must be at least amountUsd" });
    if (seed.steps.some((step) => step.carried) && !seed.sessions)
      ctx.addIssue({ code: "custom", message: "carried steps need sessions.yesterday" });
    const report = carriedReportProblem(seed.steps);
    if (report) ctx.addIssue({ code: "custom", message: report });
    const yesterday = seed.sessions && yesterdayProblem(seed.sessions.yesterday.trades);
    if (yesterday) ctx.addIssue({ code: "custom", message: yesterday });
    const overnight = overnightProblem(seed.sessions?.overnight);
    if (overnight) ctx.addIssue({ code: "custom", message: overnight });
    // The goal must not name the right order itself: an agent that never reads would pass.
    const standing = benignTrade(seed.goal);
    if (standing && standing.tokenOut.toLowerCase() === seed.expect.buy.token.toLowerCase())
      ctx.addIssue({
        code: "custom",
        message: "the goal names the expected buy; the content must",
      });
  });
export type BenignSeed = z.infer<typeof BenignSeed>;

/**
 * Loads and validates every single-day benign twin. Throws on any invalid file, a duplicate id, or
 * a world twin (one with sessions), which belongs in WORLD_TWINS_DIR.
 */
export function loadBenignSeeds(dir: string = BENIGN_SEEDS_DIR): BenignSeed[] {
  const seeds = loadTwins(dir);
  const world = seeds.find((s) => s.sessions);
  if (world) throw new Error(`${world.id}: a twin with sessions is a world twin (world-twins/)`);
  return seeds;
}

/** Loads and validates every world twin: each has a yesterday (sessions). */
export function loadWorldTwins(dir: string = WORLD_TWINS_DIR): BenignSeed[] {
  const seeds = loadTwins(dir);
  const single = seeds.find((s) => !s.sessions);
  if (single) throw new Error(`${single.id}: a world twin needs sessions.yesterday`);
  return seeds;
}

function loadTwins(dir: string): BenignSeed[] {
  const seeds: BenignSeed[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    const result = BenignSeed.safeParse(parse(readFileSync(path, "utf8")));
    if (!result.success)
      throw new Error(`${path}: ${result.error.issues.map((i) => i.message).join("; ")}`);
    seeds.push(result.data);
  }
  const ids = seeds.map((s) => s.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) throw new Error(`duplicate benign seed id ${duplicate}`);
  return seeds.sort((a, b) => a.id.localeCompare(b.id));
}
