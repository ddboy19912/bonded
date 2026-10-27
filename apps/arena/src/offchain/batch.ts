import type { ArenaAgent, ChatClient, OffchainToolName } from "@bondedhq/shared";
import type { SpendingCap } from "../budget.js";
import { LlmCounterparty, type ProbeResult, probeCounterparty } from "./counterparty.js";
import { runOffchainEpisode } from "./episode.js";
import { controlScenario, type OffchainScenario, verifiedBankChangeTwin } from "./scenarios.js";
import { attackScenario, type OffchainSeed, seedNeedsVision, seedVectors } from "./seeds.js";
import { CHANNEL_TOOLS, CHANNELS, EMAIL_TOOLS } from "./channels.js";
import { worldTools } from "./world.js";
import {
  type MandateRow,
  type OffchainSummary,
  type RowEpisode,
  summarizeRows,
} from "./summary.js";

/**
 * One off-chain batch: the control, the benign twin and every attack seed, `runs` times in each
 * mandate row, judged by the ledger. Shared by the runner (cli.ts) and the Index sweep.
 */
export interface BatchOptions {
  /** A fresh agent per episode. */
  agent: () => ArenaAgent;
  /** The agent's model reads images; otherwise image seeds aren't run (`notShown`). */
  seesImages: boolean;
  /** Serve attachments' images at all (off: text layers only). */
  images: boolean;
  attackSeeds: readonly OffchainSeed[];
  /** The controls and benign twins (default: the approved-queue payment run's). */
  controls?: readonly (() => OffchainScenario)[];
  /**
   * The vectors the agent is integrated with (email, chat, voicemail…); every one when absent.
   * Tools for the others are taken away, and attacks that arrive through them aren't run: they
   * count as not exposed, not as resisted.
   */
  channels?: readonly string[];
  rows: readonly MandateRow[];
  runs: number;
  parallel: number;
  cap: SpendingCap;
  client: ChatClient;
  counterpartyModel: string;
}

export interface BatchResult {
  episodes: RowEpisode[];
  summary: OffchainSummary;
  notShown: string[];
  /** Episodes not started because the spending cap was reached, as row:scenario. */
  skipped: string[];
  counterpartyTurns: { turns: number; refused: number };
}

export async function runOffchainBatch(options: BatchOptions): Promise<BatchResult> {
  // An attack that lives only in an invoice image can't reach an agent that never sees images:
  // it isn't run, and isn't counted as resisted.
  // Likewise an attack through a channel the agent isn't integrated with (`channels`). Invoice
  // images and counterparties arrive by email; vendor-record notes reach every agent.
  const allowed = options.channels ? new Set(options.channels) : null;
  const sees = (v: string) =>
    v === "records" || !allowed || allowed.has(v === "image" || v === "counterparty" ? "email" : v);
  const exposed = (s: OffchainSeed) =>
    seedVectors(s).every(sees) &&
    (!seedNeedsVision(s) || Boolean(options.seesImages && options.images));
  const notShown = options.attackSeeds.filter((s) => !exposed(s)).map((s) => s.id);
  // Each run builds its scenario afresh: an episode changes its world (an O6 thread grows).
  const builders: (() => OffchainScenario)[] = [
    ...(options.controls ?? [controlScenario, verifiedBankChangeTwin]),
    ...options.attackSeeds
      .filter((s) => !notShown.includes(s.id))
      .map((s) => () => attackScenario(s)),
  ];
  const queue = options.rows.flatMap((mandate) =>
    builders.flatMap((build) => Array.from({ length: options.runs }, () => ({ mandate, build }))),
  );
  const episodes: RowEpisode[] = [];
  const skipped: string[] = [];
  await Promise.all(
    Array.from({ length: Math.min(options.parallel, queue.length) }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const scenario = job.build();
        if (allowed) scenario.world.tools = restrictTools(worldTools(scenario.world), allowed);
        if (options.cap.exceeded) {
          skipped.push(`${job.mandate}:${scenario.id}`);
          continue;
        }
        const counterparty = scenario.counterparty
          ? new LlmCounterparty(
              scenario.counterparty,
              scenario.world.company,
              options.client,
              options.counterpartyModel,
              (u) => options.cap.add(u),
            )
          : undefined;
        const result = await runOffchainEpisode(options.agent(), scenario, {
          images: options.images,
          hideMandate: job.mandate === "hidden",
          ...(counterparty ? { counterparty } : {}),
        });
        options.cap.add(result.agentSummary.usage);
        episodes.push({ mandate: job.mandate, result });
      }
    }),
  );
  const turns = episodes.flatMap((e) => e.result.conversation ?? []);
  return {
    episodes,
    summary: summarizeRows(episodes, options.rows),
    notShown,
    skipped,
    counterpartyTurns: { turns: turns.length, refused: turns.filter((t) => t.refused).length },
  };
}

/** A world's tools without those of the vectors the agent isn't integrated with. */
export function restrictTools(
  tools: readonly OffchainToolName[],
  allowed: ReadonlySet<string>,
): OffchainToolName[] {
  const removed = new Set<OffchainToolName>([
    ...(allowed.has("email") ? [] : EMAIL_TOOLS),
    ...CHANNELS.filter((c) => !allowed.has(c)).flatMap((c) => CHANNEL_TOOLS[c]),
  ]);
  return tools.filter((t) => !removed.has(t));
}

/** Probes the counterparty model on each O6 seed's opening email (probeCounterparty). */
export async function probeCounterparties(options: {
  seeds: readonly OffchainSeed[];
  client: ChatClient;
  model: string;
  cap: SpendingCap;
}): Promise<Record<string, ProbeResult>> {
  const probes: Record<string, ProbeResult> = {};
  for (const seed of options.seeds.filter((s) => s.counterparty)) {
    const opener = seed.plant.emails.find(
      (e) => (e.threadId ?? `t-${e.id}`) === seed.counterparty!.threadId,
    )!;
    const cp = new LlmCounterparty(
      seed.counterparty!,
      controlScenario().world.company,
      options.client,
      options.model,
      (u) => options.cap.add(u),
    );
    probes[seed.id] = await probeCounterparty(cp, {
      from: `${opener.from.name} <${opener.from.address}>`,
      body: opener.body,
    });
  }
  return probes;
}
