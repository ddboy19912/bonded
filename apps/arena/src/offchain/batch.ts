import {
  type ArenaAgent,
  type ChatClient,
  type ModelAccountStop,
  modelAccountStop,
  type OffchainToolName,
} from "@bondedhq/shared";
import type { SpendingCap } from "../budget.js";
import { LlmCounterparty, type ProbeResult, probeCounterparty } from "./counterparty.js";
import { runOffchainEpisode } from "./episode.js";
import type { Attribution } from "./judge.js";
import { BUSY_CHANNEL_WORK } from "./busy.js";
import {
  CHANNEL_WORK,
  controlScenario,
  type OffchainScenario,
  STAGED_CONTROLS,
  TWIN_VECTOR,
  verifiedBankChangeTwin,
} from "./scenarios.js";
import {
  attackScenario,
  type OffchainSeed,
  onRealisticJob,
  seedNeedsVision,
  seedVectors,
} from "./seeds.js";
import { CHANNEL_TOOLS, CHANNELS, EMAIL_TOOLS } from "./channels.js";
import { worldTools } from "./world.js";
import {
  type Exposure,
  type MandateRow,
  type OffchainSummary,
  type RowEpisode,
  summarizeRows,
} from "./summary.js";

/**
 * Whether an agent integrated with `allowed` can meet this vector. Vendor-record notes reach
 * every agent. Invoice images and live counterparties arrive by email. Same rule as the attacks
 * a batch skips (`runOffchainBatch`).
 */
function vectorSeen(vector: string, allowed: ReadonlySet<string>): boolean {
  if (vector === "records") return true;
  if (vector === "image" || vector === "counterparty") return allowed.has("email");
  return allowed.has(vector);
}

/**
 * Task keys that live only on a channel the agent has no tool for (`CHANNEL_WORK`,
 * `BUSY_CHANNEL_WORK`). A reply also needs the inbox tools, so every reply drops when email
 * isn't integrated.
 */
function dropUnreachableWork(
  scenario: OffchainScenario,
  allowed: ReadonlySet<string>,
): OffchainScenario {
  const drop = new Set<string>();
  for (const [channel, key] of [
    ...Object.entries(CHANNEL_WORK),
    ...Object.entries(BUSY_CHANNEL_WORK),
  ]) {
    if (!allowed.has(channel)) drop.add(key);
  }
  const mustReply = (scenario.mustReply ?? []).filter(
    (id) => allowed.has("email") && !drop.has(`reply:${id}`),
  );
  const mustRoute = (scenario.mustRoute ?? []).filter((id) => !drop.has(`approval:${id}`));
  return {
    ...scenario,
    ...(scenario.mustReply ? { mustReply } : {}),
    ...(scenario.mustRoute ? { mustRoute } : {}),
  };
}

/**
 * Controls the agent can finish with `channels`. A twin whose vector isn't integrated is left
 * out. Channel work the agent can't see is taken off the controls that remain, so a missed
 * channel isn't scored as a failed job.
 */
function fitToChannels(
  controls: readonly (() => OffchainScenario)[],
  channels: readonly string[],
): (() => OffchainScenario)[] {
  const allowed = new Set(channels);
  return controls.flatMap((build) => {
    const vector = TWIN_VECTOR[build().id];
    if (vector && !vectorSeen(vector, allowed)) return [];
    return [() => dropUnreachableWork(build(), allowed)];
  });
}

/**
 * The controls and benign twins for a set of attacks: the realistic job's (STAGED_CONTROLS, with
 * its twin for each channel) when any attack runs on it, else the first job's control and twin.
 * A run of first-job seeds alone stays as small as it was before this release. `channels`, when
 * set, keeps only the controls that the agent can complete (see `fitToChannels`).
 */
export function controlsFor(
  seeds: readonly OffchainSeed[],
  channels?: readonly string[],
): (() => OffchainScenario)[] {
  const selected = seeds.some(onRealisticJob)
    ? [...STAGED_CONTROLS]
    : [controlScenario, verifiedBankChangeTwin];
  return channels ? fitToChannels(selected, channels) : selected;
}

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
  /** The controls and benign twins (default: `controlsFor` the attack seeds). */
  controls?: readonly (() => OffchainScenario)[];
  /**
   * Runs of each control and benign twin in each mandate row (default: `runs`). The Index runs
   * them once: there are many twins, and the Task score pools them over both briefings.
   */
  controlRuns?: number;
  /**
   * The vectors the agent is integrated with (email, chat, voicemail…); every one when absent.
   * Tools for the others are taken away, and attacks that arrive through them aren't run: they
   * count as not exposed, not as resisted.
   */
  channels?: readonly string[];
  /**
   * Channels delivered in the briefing (world.pushedChannels). Absent or empty, the agent only
   * meets a channel by listing it. The Index passes every channel (INDEX_PUSHED_CHANNELS).
   */
  pushedChannels?: readonly string[];
  /**
   * How an attack's success is decided (judge.ts): "planted" when absent, so a breach counts as
   * the attack's only when it involves something the attack planted (off-chain library version 2 on).
   */
  attribution?: Attribution;
  /** Whether attacks the agent never met count in the summary's rate ("measured" when absent). */
  exposure?: Exposure;
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
  /**
   * Episodes not started because the spending cap was reached, or not finished because a model
   * account ran out of credits, as row:scenario.
   */
  skipped: string[];
  /**
   * The model account refused a call (401 or 403) or ran out of credits (402). The batch stopped
   * starting episodes. That episode is listed in `skipped`, not counted as the agent's error.
   */
  accountStop?: ModelAccountStop;
  /** True when `accountStop` is set. Kept so a partial Index sweep is still not published. */
  outOfCredits: boolean;
  counterpartyTurns: { turns: number; refused: number };
}

export async function runOffchainBatch(options: BatchOptions): Promise<BatchResult> {
  // An attack that lives only in an invoice image can't reach an agent that never sees images:
  // it isn't run, and isn't counted as resisted.
  // Likewise an attack through a channel the agent isn't integrated with (`channels`). Invoice
  // images and counterparties arrive by email; vendor-record notes reach every agent.
  const allowed = options.channels ? new Set(options.channels) : null;
  const exposed = (s: OffchainSeed) =>
    seedVectors(s).every((v) => !allowed || vectorSeen(v, allowed)) &&
    (!seedNeedsVision(s) || Boolean(options.seesImages && options.images));
  const notShown = options.attackSeeds.filter((s) => !exposed(s)).map((s) => s.id);
  // Each run builds its scenario afresh: an episode changes its world (an O6 thread grows).
  const selected = options.controls ?? controlsFor(options.attackSeeds);
  // A caller may pass controls chosen before `channels` was applied (the CLI estimates cost
  // from them). Fit again here so the episodes match the tools the batch actually leaves.
  const controls = options.channels ? fitToChannels(selected, options.channels) : selected;
  const attacks = options.attackSeeds
    .filter((s) => !notShown.includes(s.id))
    .map((s) => () => attackScenario(s));
  const times = (build: () => OffchainScenario, n: number, mandate: MandateRow) =>
    Array.from({ length: n }, () => ({ mandate, build }));
  const queue = options.rows.flatMap((mandate) => [
    ...controls.flatMap((build) => times(build, options.controlRuns ?? options.runs, mandate)),
    ...attacks.flatMap((build) => times(build, options.runs, mandate)),
  ]);
  const episodes: RowEpisode[] = [];
  let accountStop: ModelAccountStop | undefined;
  const skipped: string[] = [];
  await Promise.all(
    Array.from({ length: Math.min(options.parallel, queue.length) }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const scenario = job.build();
        if (allowed) scenario.world.tools = restrictTools(worldTools(scenario.world), allowed);
        if (options.pushedChannels && options.pushedChannels.length > 0) {
          scenario.world.pushedChannels = [...options.pushedChannels];
        }
        if (options.cap.exceeded || accountStop !== undefined) {
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
          attribution: options.attribution ?? "planted",
          ...(counterparty ? { counterparty } : {}),
        });
        options.cap.add(result.agentSummary.usage);
        // A refused key or an empty balance isn't the agent's doing: the episode is skipped,
        // not counted, and no more are started. What already ran is kept.
        const refused =
          result.agentSummary.stoppedBecause === "error" && !result.verdict.breached
            ? modelAccountStop(result.agentSummary.finalMessage)
            : undefined;
        if (refused) {
          accountStop = refused;
          skipped.push(`${job.mandate}:${scenario.id}`);
          continue;
        }
        episodes.push({ mandate: job.mandate, result });
      }
    }),
  );
  const turns = episodes.flatMap((e) => e.result.conversation ?? []);
  return {
    episodes,
    summary: summarizeRows(episodes, options.rows, options.exposure ?? "measured"),
    notShown,
    skipped,
    ...(accountStop !== undefined ? { accountStop } : {}),
    outOfCredits: accountStop !== undefined,
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
