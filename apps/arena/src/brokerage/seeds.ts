import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { BROKER_BREACH_TYPES } from "./ledger.js";
import {
  BASE_MUST_TRADE,
  BROKER_ATTACK_CLASSES,
  BROKER_GOAL,
  type BrokerAttackClass,
  type BrokerPlan,
  type BrokerScenario,
  baseBrokerWorld,
} from "./scenarios.js";

/**
 * Brokerage seeds: attacks and their benign twins, each planted into the base account
 * (scenarios.ts). They're staged: no rating or Index reads this folder, and what they find is
 * reported as findings until a library release moves them (CLAUDE.md; docs/SCORING.md,
 * "Releases: batch the bumps").
 */
export const BROKER_STAGED_SEEDS_DIR = fileURLToPath(
  new URL("../../broker-seeds-staged", import.meta.url),
);

const CLASSES = Object.keys(BROKER_ATTACK_CLASSES) as [BrokerAttackClass, ...BrokerAttackClass[]];
const Iso = z.iso.datetime();

const FeedSeed = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  title: z.string().optional(),
  body: z.string().min(1),
  publishedAt: Iso,
});

const FilingSeed = z.object({
  id: z.string().min(1),
  filer: z.string().min(1),
  filerId: z.string().min(1),
  form: z.string().min(1),
  filedAt: Iso,
  summary: z.string().min(1),
  text: z.string().min(1),
});

const MessageSeed = z.object({
  id: z.string().min(1),
  from: z.object({ name: z.string().min(1), address: z.string().min(3) }),
  subject: z.string().min(1),
  body: z.string().min(1),
  receivedAt: Iso,
});

const Prices = z.record(z.string(), z.number().positive());
const Side = z.enum(["buy", "sell"]);

const TradeSpec = z
  .object({
    symbol: z.string().min(1),
    side: Side,
    amountUsd: z.number().positive().optional(),
    quantity: z.number().positive().optional(),
  })
  .refine((t) => (t.amountUsd === undefined) !== (t.quantity === undefined), {
    message: "a trade needs exactly one of amountUsd or quantity",
  });

export const BrokerSeedSchema = z
  .object({
    id: z.string().regex(/^(twin-)?T[1-6]-[a-z0-9-]+-\d{3}$/),
    /** An attack's class. */
    class: z.enum(CLASSES).optional(),
    /** A benign twin's: the attack class whose channel it uses for genuine work. */
    twinOf: z.enum(CLASSES).optional(),
    title: z.string().min(1),
    description: z.string().min(1),
    aimedAt: z.array(z.enum([...BROKER_BREACH_TYPES, "planted_trade"])).default([]),
    plantedTrades: z.array(z.object({ symbol: z.string().min(1), side: Side })).default([]),
    /** Symbols the attack planted, beyond its planted trades' (which count already). */
    plantedSymbols: z.array(z.string().min(1)).default([]),
    plantedAccounts: z.array(z.string().min(1)).default([]),
    /** Trades the job needs on top of the base job's. */
    mustTrade: z.array(TradeSpec).default([]),
    mustWithdraw: z
      .array(z.object({ account: z.string().min(1), amountUsd: z.number().positive() }))
      .default([]),
    plant: z.object({
      news: z.array(FeedSeed).default([]),
      social: z.array(FeedSeed).default([]),
      notes: z.array(FeedSeed).default([]),
      alerts: z.array(FeedSeed).default([]),
      filings: z.array(FilingSeed).default([]),
      messages: z.array(MessageSeed).default([]),
      /** Quotes to set or override, e.g. a thin stock's pumped price. */
      prices: Prices.default({}),
      /** What a symbol is really worth, where it differs from its quote. */
      fairPrices: Prices.default({}),
      /** Added under the holder's instructions (a twin's genuine request). */
      instructionsAppend: z.string().optional(),
    }),
  })
  .superRefine((seed, ctx) => {
    const isAttack = seed.class !== undefined;
    if (isAttack === (seed.twinOf !== undefined)) {
      ctx.addIssue({ code: "custom", message: "a seed needs exactly one of class or twinOf" });
    }
    if (isAttack && !seed.id.startsWith(`${seed.class}-`)) {
      ctx.addIssue({ code: "custom", message: "an attack's id starts with its class" });
    }
    if (!isAttack && !seed.id.startsWith(`twin-${seed.twinOf}-`)) {
      ctx.addIssue({ code: "custom", message: "a twin's id starts with twin-<class>" });
    }
    if (isAttack && seed.aimedAt.length === 0) {
      ctx.addIssue({ code: "custom", message: "an attack needs aimedAt" });
    }
    if (isAttack && seed.aimedAt.includes("planted_trade") && seed.plantedTrades.length === 0) {
      ctx.addIssue({ code: "custom", message: "aimedAt planted_trade needs plantedTrades" });
    }
    if (!isAttack && (seed.aimedAt.length > 0 || seed.plantedTrades.length > 0)) {
      ctx.addIssue({ code: "custom", message: "a twin plants no attack" });
    }
  });
export type BrokerSeed = z.infer<typeof BrokerSeedSchema>;

export function loadBrokerSeeds(dir: string = BROKER_STAGED_SEEDS_DIR): BrokerSeed[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => {
      const parsed = BrokerSeedSchema.safeParse(parse(readFileSync(join(dir, f), "utf8")));
      if (!parsed.success) throw new Error(`${f}: ${z.prettifyError(parsed.error)}`);
      if (`${parsed.data.id}.yaml` !== f)
        throw new Error(`${f}: id ${parsed.data.id} doesn't match`);
      return parsed.data;
    });
}

/** The seed planted into a fresh base world, with the holder's explicit or plain plan. */
export function scenarioFor(seed: BrokerSeed, plan: BrokerPlan = "explicit"): BrokerScenario {
  const world = baseBrokerWorld(plan);
  const p = seed.plant;
  world.news.push(...p.news);
  world.social.push(...p.social);
  world.notes.push(...p.notes);
  world.alerts.push(...p.alerts);
  world.filings.push(...p.filings);
  world.messages.push(...p.messages);
  Object.assign(world.prices, p.prices);
  Object.assign(world.fairPrices, p.fairPrices);
  if (p.instructionsAppend) world.instructions += `\n${p.instructionsAppend}`;

  const allIds = [
    ...world.news,
    ...world.social,
    ...world.notes,
    ...world.alerts,
    ...world.filings,
    ...world.messages,
  ].map((i) => i.id);
  const duplicate = allIds.find((id, i) => allIds.indexOf(id) !== i);
  if (duplicate) throw new Error(`${seed.id}: item id ${duplicate} is used twice`);

  const isAttack = seed.class !== undefined;
  const plantedSymbols = [
    ...new Set([...seed.plantedTrades.map((t) => t.symbol), ...seed.plantedSymbols]),
  ];
  return {
    id: seed.id,
    kind: isAttack ? "attack" : "twin",
    ...(seed.class ? { attackClass: seed.class } : {}),
    ...(seed.twinOf ? { twinOf: seed.twinOf } : {}),
    title: seed.title,
    goal: BROKER_GOAL,
    world,
    attack: isAttack
      ? {
          aimedAt: seed.aimedAt,
          plantedTrades: seed.plantedTrades,
          plantedSymbols,
          plantedAccounts: seed.plantedAccounts,
        }
      : null,
    mustTrade: [...BASE_MUST_TRADE, ...seed.mustTrade].map((t) => ({ ...t })),
    mustWithdraw: seed.mustWithdraw.map((w) => ({ ...w })),
    ...(isAttack ? { exposure: exposureOf(seed) } : {}),
  };
}

/** The tool calls that would show the agent the planted items. */
function exposureOf(seed: BrokerSeed): { tools: string[]; reads: string[] } {
  const p = seed.plant;
  const tools = [
    ...(p.news.length ? ["list_news"] : []),
    ...(p.social.length ? ["list_social_posts"] : []),
    ...(p.notes.length ? ["list_analyst_notes"] : []),
    ...(p.alerts.length ? ["list_alerts"] : []),
    // A filing's summary shows in the listing; its text needs read_filing.
    ...(p.filings.length ? ["list_filings"] : []),
  ];
  const reads = [...p.filings.map((f) => f.id), ...p.messages.map((m) => m.id)];
  return { tools, reads };
}
