import type { AttackSpec } from "@bondedhq/shared";
import type { Random } from "../world-content.js";
import {
  clauseFor,
  FRAMES,
  type FrameContext,
  referenceCode,
  ROLES,
  URGENCIES,
} from "./techniques.js";

/**
 * The genes behind one rendered text: which frame, role, urgency and reference code it used.
 * Kept separately from the text so mutation and crossover work on the genes, not on parsing
 * English back out of a sentence.
 */
export interface Genome {
  frameId: string;
  role: string;
  urgency: FrameContext["urgency"];
  /** "" for no reference code. */
  ref: string;
}

export interface Variant {
  genome: Genome;
  text: string;
}

const key = (g: Genome) => `${g.frameId}|${g.role}|${g.urgency}|${g.ref ? "ref" : "noref"}`;
const pick = <T>(xs: readonly T[], rand: Random): T => xs[Math.floor(rand() * xs.length)] as T;

function randomGenome(rand: Random): Genome {
  return {
    frameId: pick(FRAMES, rand).id,
    role: pick(ROLES, rand),
    urgency: pick(URGENCIES, rand),
    ref: rand() < 0.6 ? referenceCode(rand) : "",
  };
}

/** One gene changed: a different frame, a different role, a different urgency, or the code toggled. */
function mutateGenome(genome: Genome, rand: Random): Genome {
  const gene = Math.floor(rand() * 4);
  if (gene === 0) return { ...genome, frameId: pick(FRAMES, rand).id };
  if (gene === 1) return { ...genome, role: pick(ROLES, rand) };
  if (gene === 2) return { ...genome, urgency: pick(URGENCIES, rand) };
  return { ...genome, ref: genome.ref ? "" : referenceCode(rand) };
}

/** Each gene taken from one parent or the other. */
function crossoverGenome(a: Genome, b: Genome, rand: Random): Genome {
  return {
    frameId: rand() < 0.5 ? a.frameId : b.frameId,
    role: rand() < 0.5 ? a.role : b.role,
    urgency: rand() < 0.5 ? a.urgency : b.urgency,
    ref: rand() < 0.5 ? a.ref : b.ref,
  };
}

function render(genome: Genome, clause: string): string {
  const frame = FRAMES.find((f) => f.id === genome.frameId);
  if (!frame) throw new Error(`unknown frame ${genome.frameId}`);
  return frame.render({ clause, role: genome.role, ref: genome.ref, urgency: genome.urgency });
}

/** The clause this seed's breach types ask for: the first one Harbinger has a clause for. */
export function seedClause(seed: AttackSpec): string {
  const type = seed.successPredicate.anyOf[0];
  if (!type) throw new Error(`${seed.id}: successPredicate.anyOf is empty`);
  return clauseFor(type);
}

/**
 * A first generation: random, distinct genomes rendered against the seed's clause. Pure
 * function of the seed and the random source, so a run is reproducible from its seed string.
 */
export function initialPopulation(seed: AttackSpec, size: number, rand: Random): Variant[] {
  const clause = seedClause(seed);
  const seen = new Set<string>();
  const variants: Variant[] = [];
  // FRAMES.length * ROLES.length * URGENCIES.length * 2 (ref or not) distinct genomes exist;
  // give up well before exhausting that space rather than loop forever on a large `size`.
  for (let tries = 0; variants.length < size && tries < size * 20; tries++) {
    const genome = randomGenome(rand);
    const k = key(genome);
    if (seen.has(k)) continue;
    seen.add(k);
    variants.push({ genome, text: render(genome, clause) });
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
  const clause = seedClause(seed);
  const seen = new Set<string>(parents.map(key));
  const variants: Variant[] = [];
  const freshShare = Math.max(1, Math.round(size * 0.2));
  for (
    let tries = 0;
    variants.length < size - freshShare && tries < size * 20 && parents.length;
    tries++
  ) {
    const a = pick(parents, rand);
    const genome =
      parents.length > 1 && rand() < 0.5
        ? crossoverGenome(a, pick(parents, rand), rand)
        : mutateGenome(a, rand);
    const k = key(genome);
    if (seen.has(k)) continue;
    seen.add(k);
    variants.push({ genome, text: render(genome, clause) });
  }
  for (let tries = 0; variants.length < size && tries < freshShare * 20; tries++) {
    const genome = randomGenome(rand);
    const k = key(genome);
    if (seen.has(k)) continue;
    seen.add(k);
    variants.push({ genome, text: render(genome, clause) });
  }
  return variants;
}
