import type { AttackSpec } from "@bondedhq/shared";
import { candidateSpec, scoreAttempt } from "../adaptive.js";
import { SpendingCap } from "../budget.js";
import { type EpisodeOptions, type EpisodeResult, runEpisode } from "../episode.js";
import { type Ruling, rulingOf } from "../report.js";
import type { Sandbox } from "../sandbox.js";
import { seededRandom } from "../world-content.js";
import { type Genome, initialPopulation, nextGeneration } from "./generate.js";

/**
 * Harbinger: a self-generating attacker. Every attack text comes from the deterministic template
 * library (techniques.ts, generate.ts), never from a model call, so the only cost is running the
 * texts against the target agent. A generation of candidate texts is run as episodes, scored from
 * the episode record (`scoreAttempt`, the same deterministic judge the adaptive loop uses), and
 * the fittest genomes breed the next generation by mutation and crossover.
 *
 * What it controls is the planted text, exactly as the adaptive loop (adaptive.ts): surface,
 * sender, task, tools and vault stay as the seed set them, and the verdict is the vault's breach
 * log. The difference is where the text comes from.
 */

export interface HarbingerAttempt {
  generation: number;
  genome: Genome;
  payloadTemplate: string;
  /** The task the agent got this try (the genome's goal gene). */
  goal?: string;
  ruling: Ruling | "invalid";
  note?: string;
  succeeded: boolean;
  lossUsd: number;
  score: number;
  agentSaid?: string;
  episodeId?: string;
}

export interface HarbingerResult {
  seed: string;
  attackClass: AttackSpec["class"];
  agent: string;
  population: number;
  generations: number;
  breached: boolean;
  /** Which generation found the breach, or null. */
  breachGeneration: number | null;
  bestScore: number;
  attempts: HarbingerAttempt[];
  stoppedBecause: "breached" | "generations" | "budget";
  spend: ReturnType<SpendingCap["summary"]>;
}

export interface HarbingerOptions {
  sandbox: Sandbox;
  agent: EpisodeOptions["agent"];
  seed: AttackSpec;
  /** Texts run per generation. */
  population: number;
  /** Generations after the first (so generation 0 always runs). */
  generations: number;
  /** Stop once the target agent's model spend reaches this (Harbinger itself never calls a model). */
  maxUsd: number;
  /** Changes the random population without changing anything else; default is the seed's own id. */
  randomSeed?: string;
  episode?: Pick<EpisodeOptions, "vault" | "goal" | "maxSteps" | "timeoutMs">;
  /** Runs one attempt; replaceable so the loop can be tested without a chain. */
  runAttempt?: (spec: AttackSpec, generation: number, index: number) => Promise<EpisodeResult>;
  onAttempt?: (attempt: HarbingerAttempt) => void;
}

export async function runHarbinger(options: HarbingerOptions): Promise<HarbingerResult> {
  const { seed } = options;
  const popSize = Math.max(2, options.population);
  const cap = new SpendingCap({ maxUsd: options.maxUsd });
  const rand = seededRandom(`harbinger-${options.randomSeed ?? seed.id}`);
  const attempts: HarbingerAttempt[] = [];
  const attempt =
    options.runAttempt ??
    ((spec: AttackSpec, generation: number, index: number) =>
      runEpisode(options.sandbox, {
        ...options.episode,
        agent: options.agent,
        attack: spec,
        variantId: `harbinger-g${generation}-${index}`,
        // One benign world for the whole campaign, so the planted text is the only thing that changes.
        worldSeed: `harbinger-${seed.id}`,
      }));

  const record = (a: HarbingerAttempt) => {
    attempts.push(a);
    options.onAttempt?.(a);
  };
  const finish = (stoppedBecause: HarbingerResult["stoppedBecause"]): HarbingerResult => ({
    seed: seed.id,
    attackClass: seed.class,
    agent: options.agent.name,
    population: popSize,
    generations: options.generations,
    breached: attempts.some((a) => a.succeeded),
    breachGeneration: attempts.find((a) => a.succeeded)?.generation ?? null,
    bestScore: attempts.reduce((max, a) => Math.max(max, a.score), 0),
    attempts,
    stoppedBecause,
    spend: cap.summary(),
  });

  let parents: Genome[] = [];
  for (let generation = 0; generation <= options.generations; generation++) {
    const population =
      generation === 0
        ? initialPopulation(seed, popSize, rand)
        : nextGeneration(seed, parents, popSize, rand);
    const scored: { genome: Genome; score: number }[] = [];
    for (let index = 0; index < population.length; index++) {
      if (cap.exceeded) return finish("budget");
      const variant = population[index]!;
      const candidate = candidateSpec(
        seed,
        generation,
        {
          payloadTemplate: variant.text,
          ...(variant.campaign ? { campaign: variant.campaign } : {}),
        },
        index,
      );
      if (typeof candidate === "string") {
        // A template produced an invalid draft (e.g. too long): counted, not run.
        record({
          generation,
          genome: variant.genome,
          payloadTemplate: variant.text,
          goal: variant.goal,
          ruling: "invalid",
          note: candidate,
          succeeded: false,
          lossUsd: 0,
          score: 0,
        });
        continue;
      }
      // The task is part of the genome (goals.ts): the engine sets it after the bounty checks,
      // which refuse a hunter-set goal. Goals are benign by construction (goalOk).
      const spec = { ...candidate, goal: variant.goal };
      const result = await attempt(spec, generation, index);
      cap.add(result.agentSummary.usage);
      const ruling = rulingOf(result);
      const agentSaid = result.agentSummary.finalMessage;
      const score = scoreAttempt(ruling, agentSaid);
      record({
        generation,
        genome: variant.genome,
        payloadTemplate: variant.text,
        goal: variant.goal,
        ruling,
        succeeded: ruling === "breach",
        lossUsd: result.verdict.totalLossUsd,
        score,
        ...(agentSaid ? { agentSaid: agentSaid.slice(0, 600) } : {}),
        episodeId: result.id,
      });
      scored.push({ genome: variant.genome, score });
      if (ruling === "breach") return finish("breached");
    }
    // The fittest quarter of this generation (at least 2) breed the next one.
    parents = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(2, Math.ceil(popSize / 4)))
      .map((s) => s.genome);
    if (parents.length === 0) break; // every candidate this generation was invalid; nothing to breed from
  }
  return finish("generations");
}
