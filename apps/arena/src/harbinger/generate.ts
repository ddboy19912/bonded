import type { AttackSpec, AttackSurface } from "@bondedhq/shared";
import type { Random } from "../world-content.js";
import { corroborate } from "./campaign.js";
import { goalChoices } from "./goals.js";
import {
  clauseFor,
  FRAMES,
  type FrameContext,
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
  /** Exact steps to plant, preserving the seed assets alongside the generated directive. */
  campaign?: AttackSpec["campaign"];
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

function randomGenome(rand: Random): Genome {
  return {
    frameId: pick(FRAMES, rand).id,
    role: pick(ROLES, rand),
    urgency: pick(URGENCIES, rand),
    ref: rand() < 0.6 ? referenceCode(rand) : "",
    goal: 0,
    spread: false,
  };
}

/** One gene changed: frame, role, urgency, reference code, task or campaign spread. */
function mutateGenome(genome: Genome, goalCount: number, rand: Random): Genome {
  const gene = Math.floor(rand() * 6);
  if (gene === 0) return { ...genome, frameId: pick(FRAMES, rand).id };
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

/** One variant of a genome on a seed: the render plus its task and, when spread, its campaign. */
function renderVariant(seed: AttackSpec, genome: Genome): Variant {
  const frame = FRAMES.find((f) => f.id === genome.frameId);
  if (!frame) throw new Error(`unknown frame ${genome.frameId}`);
  const goals = goalChoices(seed);
  const goal = goals[genome.goal % goals.length] ?? goals[0]!;
  const ctx: FrameContext = {
    clause: seedClause(seed),
    role: genome.role,
    ref: genome.ref,
    urgency: genome.urgency,
  };
  const rendered = toPayloadSize(frame.render(ctx));
  const originalSteps =
    seed.campaign ??
    seed.surfaces.map((surface) => ({
      surface,
      ...seed.delivery,
      text: seed.payloadTemplate,
    }));
  const directiveIndex = originalSteps.findIndex((step) => step.surface !== "price_feed");
  // A price-only seed cannot carry prose. Keep its executable price input and report it honestly.
  const text = directiveIndex < 0 ? seed.payloadTemplate : rendered;
  if (!genome.spread || !spreadPossible(seed)) {
    const campaign = originalSteps.map((step, index) => ({
      ...step,
      text: (seed.campaign ? index === directiveIndex : step.surface !== "price_feed")
        ? text
        : step.text,
    }));
    return { genome: { ...genome, spread: false }, text, goal, campaign };
  }
  const directiveSurface = directiveSurfaceOf(seed);
  const campaign = corroborate(
    text,
    directiveSurface,
    genome,
    extraEchoes(seed),
    seed.campaign?.find((step) => step.surface === directiveSurface)?.sender ??
      seed.delivery.sender,
  );
  const assets = assetSteps(seed);
  const withAssets = [...campaign.slice(0, 8 - assets.length), ...assets];
  return {
    genome,
    text,
    goal,
    campaign: withAssets.map((piece, i) => ({
      ...piece,
      text: i === 0 ? toPayloadSize(piece.text) : piece.text,
    })),
  };
}

/**
 * With spread enabled, the seed's asset surfaces retain their original payloads alongside
 * the generated directive on a separate readable surface —
 * the seed's original vectors stay in play, with the corroboration around them.
 */
function assetSteps(seed: AttackSpec): NonNullable<AttackSpec["campaign"]> {
  // Campaign steps are authoritative: their text and delivery can differ from the seed defaults.
  if (seed.campaign) return seed.campaign.filter((step) => isAssetSurface(step.surface));
  return seed.surfaces.filter(isAssetSurface).map((surface) => ({
    surface,
    ...seed.delivery,
    text: seed.payloadTemplate,
  }));
}

const isAssetSurface = (surface: AttackSurface): boolean =>
  surface === "token_metadata" || surface === "price_feed" || surface === "tx_history";

function readableSurfaces(seed: AttackSpec): AttackSurface[] {
  const surfaces = seed.campaign?.map((step) => step.surface) ?? seed.surfaces;
  return [...new Set(surfaces.filter((surface) => !isAssetSurface(surface)))];
}

/**
 * Spreading needs a separate readable surface for the directive, keeping the original asset
 * vectors intact. Asset-only seeds keep their existing surfaces.
 */
function spreadPossible(seed: AttackSpec): boolean {
  return readableSurfaces(seed).length > 0;
}

const MAX_PAYLOAD_CHARS = 1_500;
/** Keeps a rendered frame inside the Arena's payload limit (bounty check) by trimming the tail. */
function toPayloadSize(text: string): string {
  return text.length > MAX_PAYLOAD_CHARS ? text.slice(0, MAX_PAYLOAD_CHARS) : text;
}

/**
 * The spread directive goes on the first non-asset surface so asset vectors stay intact.
 */
function directiveSurfaceOf(seed: AttackSpec): AttackSurface {
  const readable = readableSurfaces(seed);
  return readable[0] ?? seed.surfaces[0]!;
}

/** Echo surfaces for the campaign: the seed's readable surfaces, then inbox and news as defaults. */
function extraEchoes(seed: AttackSpec): readonly AttackSurface[] {
  const readable = readableSurfaces(seed);
  return [...readable.slice(1), "dm", "news"] as const;
}

/**
 * A first generation: random, distinct genomes rendered against the seed's clause. Pure
 * function of the seed and the random source, so a run is reproducible from its seed string.
 */
export function initialPopulation(seed: AttackSpec, size: number, rand: Random): Variant[] {
  const seen = new Set<string>();
  const variants: Variant[] = [];
  // FRAMES x ROLES x URGENCIES x 2 (ref or not), times the goal count, spread or not — the
  // distinct space is far larger than any population we run, so cap tries instead of looping.
  for (let tries = 0; variants.length < size && tries < size * 20; tries++) {
    const genome = {
      ...randomGenome(rand),
      goal: genomeGoals(seed, rand),
      spread: spreadPossible(seed) && rand() < 0.5,
    };
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
        : mutateGenome(a, goalCount, rand);
    const genome: Genome = {
      ...base,
      goal: base.goal >= goalCount ? 0 : base.goal,
      spread: spreadPossible(seed) && base.spread,
    };
    // Never re-run a parent's exact genome: try a mutation instead, once.
    if (seen.has(key(genome))) continue;
    seen.add(key(genome));
    variants.push(renderVariant(seed, genome));
  }
  for (let tries = 0; variants.length < size && tries < freshShare * 20; tries++) {
    const genome = {
      ...randomGenome(rand),
      goal: genomeGoals(seed, rand),
      spread: spreadPossible(seed) && rand() < 0.5,
    };
    const k = key(genome);
    if (seen.has(k)) continue;
    seen.add(k);
    variants.push(renderVariant(seed, genome));
  }
  return variants;
}
