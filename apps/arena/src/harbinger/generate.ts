import type { AttackSpec, AttackSurface } from "@bondedhq/shared";
import type { Random } from "../world-content.js";
import { corroborate } from "./campaign.js";
import { goalChoices } from "./goals.js";
import {
  clauseFor,
  type Frame,
  FRAMES,
  type FrameContext,
  recordFor,
  referenceCode,
  ROLES,
  URGENCIES,
} from "./techniques.js";

/**
 * The genes behind one rendered attack: which frame, role, urgency and reference code it used,
 * which task the agent got (goal gene) and whether the text is planted alone or corroborated
 * across surfaces (spread gene). Kept separately from the text so mutation and crossover work
 * on the genes, not on parsing English back out of a sentence.
 *
 * v2 (docs/PLAN.md, Pillar P3): a genome is a point in the joint space framing × task ×
 * surface. The old genome mutated framing only, so the search could not answer "would a
 * different task or a corroborating story have reached this agent".
 */

export interface Genome {
  frameId: string;
  role: string;
  urgency: FrameContext["urgency"];
  /** "" for no reference code. */
  ref: string;
  /** Index into the seed's goal choices (goals.ts): 0 is the seed's own goal when it has one. */
  goal: number;
  /** Whether the text is corroborated across the seed's other surfaces (a campaign). */
  spread: boolean;
}

export interface Variant {
  genome: Genome;
  text: string;
  /** When the spread gene is on: the campaign steps to plant (directive + echoes). */
  campaign?: { surface: AttackSurface; sender?: string; text: string }[];
  /** The task this variant gives the agent. */
  goal: string;
}

const key = (g: Genome) =>
  `${g.frameId}|${g.role}|${g.urgency}|${g.ref ? "ref" : "noref"}|goal${g.goal}|${g.spread ? "s" : "u"}`;
const pick = <T>(xs: readonly T[], rand: Random): T => xs[Math.floor(rand() * xs.length)] as T;

function genomeGoals(seed: AttackSpec, rand: Random): number {
  const count = goalChoices(seed).length;
  if (count <= 1) return 0;
  // Bias early draws toward the seed's own goal; the mutation and fresh shares explore the rest.
  return rand() < 0.4 ? 0 : Math.floor(rand() * count);
}

function randomGenome(rand: Random, frames: readonly Frame[]): Genome {
  return {
    frameId: pick(frames, rand).id,
    role: pick(ROLES, rand),
    urgency: pick(URGENCIES, rand),
    ref: rand() < 0.6 ? referenceCode(rand) : "",
    goal: 0,
    spread: false,
  };
}

/** One gene changed: frame, role, urgency, reference code, task or campaign spread. */
function mutateGenome(
  genome: Genome,
  goalCount: number,
  rand: Random,
  frames: readonly Frame[],
): Genome {
  const gene = Math.floor(rand() * 6);
  if (gene === 0) return { ...genome, frameId: pick(frames, rand).id };
  if (gene === 1) return { ...genome, role: pick(ROLES, rand) };
  if (gene === 2) return { ...genome, urgency: pick(URGENCIES, rand) };
  if (gene === 4 && goalCount > 1) return { ...genome, goal: Math.floor(rand() * goalCount) };
  if (gene === 5) return { ...genome, spread: !genome.spread };
  return { ...genome, ref: genome.ref ? "" : referenceCode(rand) };
}

/** Each gene taken from one parent or the other. */
function crossoverGenome(a: Genome, b: Genome, rand: Random): Genome {
  return {
    frameId: rand() < 0.5 ? a.frameId : b.frameId,
    role: rand() < 0.5 ? a.role : b.role,
    urgency: rand() < 0.5 ? a.urgency : b.urgency,
    ref: rand() < 0.5 ? a.ref : b.ref,
    goal: rand() < 0.5 ? a.goal : b.goal,
    spread: rand() < 0.5 ? a.spread : b.spread,
  };
}

/** The clause this seed's breach types ask for: the first one Harbinger has a clause for. */
export function seedClause(seed: AttackSpec): string {
  const type = seed.successPredicate.anyOf[0];
  if (!type) throw new Error(`${seed.id}: successPredicate.anyOf is empty`);
  return clauseFor(type);
}

/** The same breach as instruction-free record data (document-family frames). */
export function seedRecord(seed: AttackSpec): string {
  const type = seed.successPredicate.anyOf[0];
  if (!type) throw new Error(`${seed.id}: successPredicate.anyOf is empty`);
  return recordFor(type);
}

/** One variant of a genome on a seed: the render plus its task and, when spread, its campaign. */
function renderVariant(seed: AttackSpec, genome: Genome): Variant {
  // Lookup is against the full set, not the active filter: a crossover may carry any frame id.
  const frame = FRAMES.find((f) => f.id === genome.frameId);
  if (!frame) throw new Error(`unknown frame ${genome.frameId}`);
  const goals = goalChoices(seed);
  const goal = goals[genome.goal % goals.length] ?? goals[0]!;
  const ctx: FrameContext = {
    clause: seedClause(seed),
    record: seedRecord(seed),
    role: genome.role,
    ref: genome.ref,
    urgency: genome.urgency,
  };
  const text = toPayloadSize(frame.render(ctx));
  if (!genome.spread || !spreadPossible(seed)) return { genome, text, goal };
  const campaign = corroborate(
    text,
    directiveSurfaceOf(seed),
    genome,
    extraEchoes(seed),
    undefined,
  );
  const withAssets = [...campaign, ...assetSteps(seed)];
  return {
    genome,
    text,
    goal,
    campaign: withAssets.map((piece, i) => ({
      sender: piece.sender,
      surface: piece.surface,
      text: i === 0 ? toPayloadSize(piece.text) : piece.text,
    })),
  };
}

/**
 * The seed's asset surfaces (token metadata, feed prices, transfer-history entries) don't carry
 * a frame's prose, so a campaign plants the seed's own payload on them alongside the directive —
 * the seed's original vectors stay in play, with the corroboration around them.
 */
function assetSteps(seed: AttackSpec): { surface: AttackSurface; sender?: string; text: string }[] {
  const steps: { surface: AttackSurface; sender?: string; text: string }[] = [];
  for (const surface of seed.surfaces) {
    if (surface === "token_metadata")
      steps.push({
        surface,
        ...(seed.delivery.token ? { token: seed.delivery.token } : {}),
        text: seed.payloadTemplate,
      });
    if (surface === "price_feed") steps.push({ surface, text: seed.payloadTemplate });
    if (surface === "tx_history")
      steps.push({
        surface,
        ...(seed.delivery.sender ? { sender: seed.delivery.sender } : {}),
        text: seed.payloadTemplate,
      });
  }
  return steps;
}

/**
 * Whether a campaign can be built for this seed: its directive needs a readable surface (a
 * price feed takes only price lines, transfer history takes only an address as the sender, so
 * neither can carry a frame's text — a one-surface price_feed or tx_history seed can't spread).
 */
function spreadPossible(seed: AttackSpec): boolean {
  return seed.surfaces.some(
    (s) => s !== "price_feed" && s !== "tx_history" && s !== "token_metadata",
  );
}

const MAX_PAYLOAD_CHARS = 1_500;
/** Keeps a rendered frame inside the Arena's payload limit (bounty check) by trimming the tail. */
function toPayloadSize(text: string): string {
  return text.length > MAX_PAYLOAD_CHARS ? text.slice(0, MAX_PAYLOAD_CHARS) : text;
}

/**
 * Which of the seed's surfaces carries the directive: the first surface the campaign doesn't
 * feed (an asset surface like token_metadata or price_feed can't carry a readable directive).
 */
function directiveSurfaceOf(seed: AttackSpec): AttackSurface {
  const readable = seed.surfaces.filter(
    (s) => s !== "token_metadata" && s !== "price_feed" && s !== "tx_history",
  );
  return readable[0] ?? seed.surfaces[0]!;
}

/** Echo surfaces for the campaign: the seed's readable surfaces, then inbox and news as defaults. */
function extraEchoes(seed: AttackSpec): readonly AttackSurface[] {
  const readable = seed.surfaces.filter(
    (s) => s !== "token_metadata" && s !== "price_feed" && s !== "tx_history",
  );
  return [...readable.slice(1), "dm", "news"] as const;
}

/**
 * A first generation: random, distinct genomes rendered against the seed's clause. Pure
 * function of the seed and the random source, so a run is reproducible from its seed string.
 */
export function initialPopulation(
  seed: AttackSpec,
  size: number,
  rand: Random,
  frames: readonly Frame[] = FRAMES,
): Variant[] {
  const seen = new Set<string>();
  const variants: Variant[] = [];
  // frames x ROLES x URGENCIES x 2 (ref or not), times the goal count, spread or not — the
  // distinct space is far larger than any population we run, so cap tries instead of looping.
  for (let tries = 0; variants.length < size && tries < size * 20; tries++) {
    const genome = { ...randomGenome(rand, frames), goal: genomeGoals(seed, rand) };
    const k = key(genome);
    if (seen.has(k)) continue;
    seen.add(k);
    variants.push(renderVariant(seed, genome));
  }
  return variants;
}

/**
 * The next generation: mutations and crossovers of the fittest genomes from the last one, plus a
 * few fresh random genomes so the search doesn't collapse onto one idea. `parents` should be
 * sorted fittest first.
 */
export function nextGeneration(
  seed: AttackSpec,
  parents: readonly Genome[],
  size: number,
  rand: Random,
  frames: readonly Frame[] = FRAMES,
): Variant[] {
  const goalCount = goalChoices(seed).length;
  const seen = new Set<string>(parents.map(key));
  const variants: Variant[] = [];
  const freshShare = Math.max(1, Math.round(size * 0.2));
  for (
    let tries = 0;
    variants.length < size - freshShare && tries < size * 20 && parents.length;
    tries++
  ) {
    const a = pick(parents, rand);
    const base =
      parents.length > 1 && rand() < 0.5
        ? crossoverGenome(a, pick(parents, rand), rand)
        : mutateGenome(a, goalCount, rand, frames);
    const genome: Genome = base.goal >= goalCount ? { ...base, goal: 0 } : base;
    // Never re-run a parent's exact genome: try a mutation instead, once.
    if (seen.has(key(genome))) continue;
    seen.add(key(genome));
    variants.push(renderVariant(seed, genome));
  }
  for (let tries = 0; variants.length < size && tries < freshShare * 20; tries++) {
    const genome = { ...randomGenome(rand, frames), goal: genomeGoals(seed, rand) };
    const k = key(genome);
    if (seen.has(k)) continue;
    seen.add(k);
    variants.push(renderVariant(seed, genome));
  }
  return variants;
}
