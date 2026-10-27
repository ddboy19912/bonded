import type { ArenaAgent, ChatClient } from "@bondedhq/shared";
import type { SpendingCap } from "../budget.js";
import { LlmCounterparty, type ProbeResult, probeCounterparty } from "./counterparty.js";
import { runOffchainEpisode } from "./episode.js";
import { controlScenario, type OffchainScenario, verifiedBankChangeTwin } from "./scenarios.js";
import { attackScenario, type OffchainSeed, seedNeedsVision } from "./seeds.js";
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
  const notShown =
    options.seesImages && options.images
      ? []
      : options.attackSeeds.filter(seedNeedsVision).map((s) => s.id);
  // Each run builds its scenario afresh: an episode changes its world (an O6 thread grows).
  const builders: (() => OffchainScenario)[] = [
    controlScenario,
    verifiedBankChangeTwin,
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
