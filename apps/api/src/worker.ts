import { randomBytes } from "node:crypto";
import { Database, json, type RatingLane } from "@bonded/db";
import {
  Sandbox,
  episodeOutcome,
  freshHeldOut,
  rateAgent,
  attestTeeAgent,
  publicEpisode,
  signAttestation,
  type SignedAttestation,
} from "@bonded/arena";
import {
  EvmMandate,
  PROTECTIONS,
  REMOTE_CONNECTIONS,
  REMOTE_MODES,
  mandateCommitment,
  mandateHash,
  toEvmMandateParams,
  attestationMessage,
  bondedRegistryAbi,
  type ArenaAgent,
  type AttackSpec,
  type ChatClient,
  type EvmMandateInput,
} from "@bondedhq/shared";
import { z } from "zod";
import { getAbiItem, hashTypedData, type Hex } from "viem";
import { attestationTypedData, bondedDomain } from "@bondedhq/shared";
import type { ServiceChain } from "@bonded/keeper";
import { ratingLibrary } from "./library.js";
import { ratedAgent, sentinelCodeHash, type SentinelService } from "./sentinel.js";
import {
  GATEWAY_UNAVAILABLE,
  RatingRefused,
  arenaKeyProblem,
  bondedUrlFailure,
  forkBudgetExhausted,
  ratingFailure,
  TeeBinding,
  remoteAgentFor,
  type RemoteAgentFactory,
} from "./remote-agent.js";
import { DbHeldOutLedger } from "./runners.js";
import { SECRET_KEY_MISSING, agentUrlContext, type SecretBox } from "./secrets.js";
import type { AgentConnection } from "./connections.js";
import type { Notifier, RatingNotificationType } from "./notifications.js";
import {
  DEFAULT_REMOTE_POLICY,
  remoteRatingPlan,
  type RemoteRatingPolicy,
} from "./remote-policy.js";

const codeHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
/**
 * Where the agent runs in a TEE: its https URL and the compose hash published for this
 * `codeHash`'s deployment. When set, the rating fails unless the agent proves it (ADR-012).
 */
export const teeConfig = z.strictObject({
  url: z.url({ protocol: /^https$/ }),
  composeHash: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/),
});
/**
 * Runs of each attack seed in a rating (default 1, at most 10). More runs tighten the 90% upper
 * bound on each breach rate, so a robust agent scores closer to what it deserves. The plan's
 * worked examples use 5. The report lists the episode count, so the number is visible.
 */
const repeats = z.number().int().min(1).max(10).optional();
/**
 * What protects the agent's funds: its Mandate Vault (default) or a MandateModule on its smart
 * account. A module enforces the mandate's commitment, so that is the hash the rating attests.
 */
const protection = z.enum(PROTECTIONS).optional();
/** The vault or module the owner registered (self-serve), so pages can find it. */
const guardAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .optional();

/** One of Bonded's built-in designs, run in the Arena itself. */
const builtInConfig = z
  .strictObject({
    kind: z.enum(["hardened", "vulnerable", "partial"]),
    mandate: EvmMandate,
    codeHash,
    tee: teeConfig.optional(),
    repeats,
    protection,
    vault: guardAddress,
    /**
     * Rate the agent with Sentinel in front of it (docs/SENTINEL.md). The report records it, and
     * the rating fails if Sentinel isn't configured: it never quietly rates without it.
     */
    sentinel: z.boolean().optional(),
  })
  // A TEE proves the agent's own code hash; a rating with Sentinel in front attests a combined
  // one, so the two can't be checked against each other yet.
  .refine((c) => !(c.sentinel && c.tee), {
    message: "a Sentinel-on rating of a TEE agent isn't supported yet",
    path: ["sentinel"],
  });

/**
 * The operator's own agent (bring your own agent, docs/BRING-YOUR-OWN-AGENT.md): it runs on the
 * operator's servers and is rated through the Arena Gateway, by its runner or (Agent URL mode) by
 * calling its own HTTPS endpoint. `codeHash` is what the operator declares; without it, each
 * rating records the hash the runner or URL reported when it was queued. With `tee`, every
 * episode must prove the declared hash with TEE evidence.
 */
const remoteConfig = z
  .strictObject({
    kind: z.literal("remote"),
    mandate: EvmMandate,
    codeHash: codeHash.optional(),
    mode: z.enum(REMOTE_MODES),
    /** How Bonded reaches the agent: the runner (default) or its Agent URL. */
    connection: z.enum(REMOTE_CONNECTIONS).optional(),
    tee: teeConfig.optional(),
    repeats,
    protection,
    vault: guardAddress,
  })
  // In tool mode the agent's tool calls come from the runner, outside the TEE, so a measurement
  // would bind nothing about how it behaves. Only chain mode, where the TEE's own key signs every
  // write, can be TEE-bound (and then the compose file must be reviewed: it decides what runs).
  .refine((c) => !(c.tee && c.mode === "tools"), {
    message: "a TEE-bound agent must be rated in chain mode: in tool mode the TEE binds nothing",
    path: ["tee"],
  })
  // The TEE proves a declared code hash, and its evidence comes through the runner.
  .refine((c) => !(c.tee && (!c.codeHash || c.connection === "url")), {
    message: "a TEE-bound agent needs a declared code hash and the runner",
    path: ["tee"],
  });

// Operators provision these records, or owners register them signed (self-serve.ts); callers
// cannot choose RPCs, commands or model URLs. A remote agent's code runs on its operator's side.
export const agentConfig = z.union([builtInConfig, remoteConfig]);
export type AgentConfig = z.infer<typeof agentConfig>;

/**
 * The mandate hash a rating attests, which `buyCover` checks against what protects the funds: the
 * hash of the mandate for a vault, its commitment (`mandateCommitment`) for a smart-account module.
 */
export function attestedMandateHash(config: AgentConfig): Hex {
  return config.protection === "module"
    ? mandateCommitment(toEvmMandateParams(config.mandate))
    : mandateHash(config.mandate);
}

/** Options for the rating worker beyond its chain and key. */
export interface WorkerOptions {
  /**
   * Builds the remote agent for a bring-your-own agent's rating (the Arena Gateway's
   * `RemoteAgent`). Without it such ratings fail at once with "gateway not available".
   */
  remote?: RemoteAgentFactory;
  /**
   * The held-out set made for each remote rating alone (an operator sees every attack its agent
   * reads, so no payload is used twice; the ledger is in the database). `perClass` variants per
   * attack class (default 1); drafted by `llm` when given, else deterministic rewrites.
   */
  heldOut?: { perClass?: number; llm?: { client: ChatClient; model: string; maxUsd: number } };
  /** Narrows the attack library a rating runs (tests and local checks only). */
  selectAttacks?: (attacks: AttackSpec[]) => AttackSpec[];
  /**
   * Which ratings this worker takes: "remote" (agents their operators run) or "builtin"
   * (everything else), each under its own lock, so a slow remote agent can't hold up Bonded's own
   * ratings. Without it, any rating (one worker for all).
   */
  lane?: RatingLane;
  /**
   * Wall-clock budget for one remote rating. By default it comes from the rating's size
   * (`remoteRatingPlan`: 40 s an episode, at most 3 hours). Past it the rating stops: charged to
   * the agent when the agent took most of the time, else retried as an infrastructure problem.
   */
  remoteBudgetMs?: number;
  /** Sizes, caps and budgets for remote ratings (default `DEFAULT_REMOTE_POLICY`). */
  remotePolicy?: RemoteRatingPolicy;
  /**
   * The agent's current registry owner. When it isn't the owner who registered the agent's
   * config, a remote rating is refused: the new owner must register it again.
   */
  ownerOf?: (agentId: string) => Promise<string>;
  /** Decrypts Agent URL secrets (AGENT_URL_SECRET_KEY): needed to rate an agent by its URL. */
  secrets?: SecretBox;
  /** Tells owners when a rating of their agent finishes, fails or is refused. */
  notifier?: Notifier;
}

/** Advisory lock keys: one per lane and chain. */
const LANE_LOCK: Record<RatingLane | "all", number> = { all: 7004, builtin: 7004, remote: 7008 };

/**
 * The code hash a rating attests. `codeHash` is always the agent's own code; with Sentinel in
 * front the rated code is different, so it gets the combined hash (`sentinelCodeHash`). This
 * holds for operator configs and self-serve registrations alike.
 */
export function ratedCodeHash(
  config: { codeHash: string; sentinel?: boolean },
  sentinel?: SentinelService,
): Hex {
  // (A remote agent's hash can be the one recorded on its rating instead: see `remoteCode`.)
  return config.sentinel
    ? sentinelCodeHash(config.codeHash as Hex, sentinel?.info)
    : (config.codeHash as Hex);
}
/** Process one durable rating job under the chain worker lock; retries recover accepted posts. */
export async function workOne(
  db: Database,
  chain: ServiceChain,
  rpcUrl: string,
  key: Hex,
  onError?: (error: unknown) => void,
  sentinel?: SentinelService,
  options: WorkerOptions = {},
) {
  const lock = await db.pool.connect();
  const locked = (
    await lock.query("SELECT pg_try_advisory_lock($2,$1) AS locked", [
      chain.deployment.chainId,
      LANE_LOCK[options.lane ?? "all"],
    ])
  ).rows[0].locked;
  if (!locked) {
    lock.release();
    return false;
  }
  try {
    return await runLocked(db, chain, rpcUrl, key, onError, sentinel, options);
  } finally {
    await lock.query("SELECT pg_advisory_unlock($2,$1)", [
      chain.deployment.chainId,
      LANE_LOCK[options.lane ?? "all"],
    ]);
    lock.release();
  }
}
/** Run a leased rating, persist report bytes, and post its attestation while ownership holds. */
async function runLocked(
  db: Database,
  chain: ServiceChain,
  rpcUrl: string,
  key: Hex,
  onError?: (error: unknown) => void,
  sentinel?: SentinelService,
  options: WorkerOptions = {},
) {
  const job = await db.takeJob(chain.deployment.chainId, options.lane);
  if (!job) return false;
  let leaseError: unknown;
  const heartbeat = setInterval(() => {
    void db.renew(job).catch((e) => {
      leaseError = e;
    });
  }, 15000);
  const check = async () => {
    if (leaseError) throw leaseError;
    await db.renew(job);
  };
  // Set once a remote episode comes back with its agent's fork share used up ("episode 3 of 40"):
  // whatever fails from then on was caused by the agent (ratingFailure).
  let budgetSpentIn: string | undefined;
  // A remote agent's operator controls it live, so its episodes (verdicts, which ones were
  // attacks) are published only once the rating is over for good; meanwhile only counts are
  // kept. An attempt that will be retried is discarded, never published.
  const held: unknown[] = [];
  const flush = async () => {
    for (const payload of held.splice(0))
      await db.publish("rating.episode", payload).catch(() => undefined);
  };
  // The owner of an operator-run agent being rated, told how it ended (never blocking it).
  let remoteOwner: { owner: string | null; agentId: string } | undefined;
  const notifyOwner = (
    type: RatingNotificationType,
    status: string,
    extra: { score?: number; securityScore?: number; reason?: string },
  ) => {
    if (!remoteOwner || !options.notifier) return;
    options.notifier.notify(remoteOwner.owner, {
      type,
      ratingId: job.id,
      agentId: remoteOwner.agentId,
      chainId: chain.deployment.chainId,
      status,
      ...extra,
      at: new Date().toISOString(),
    });
  };
  try {
    const row = (
      await db.pool.query(
        // The registration the rating was queued under, and the owner it was charged to (0018):
        // registering the agent again later doesn't change what this rating rates.
        `SELECT r.*,coalesce(r.config,a.config) AS config,r.charged_owner AS owner,a.agent_id AS onchain_id
         FROM ratings r JOIN agents a ON a.id=r.agent_id WHERE r.id=$1`,
        [job.id],
      )
    ).rows[0];
    const config = agentConfig.parse(row.config);
    if (
      config.mandate.chain.chainId !== chain.deployment.chainId ||
      config.mandate.agentId !== row.onchain_id
    )
      throw new Error("agent config identity mismatch");
    if (config.kind === "remote")
      remoteOwner = { owner: row.owner, agentId: String(row.onchain_id) };
    // The code a remote rating is about: recorded on the rating when it was queued (declared, or
    // what the runner or URL reported then), else the registration's declared hash.
    const remoteCode =
      config.kind === "remote"
        ? ((row.code_hash as string | null) ?? config.codeHash ?? undefined)
        : undefined;
    if (config.kind === "remote" && !remoteCode)
      throw new RatingRefused(
        "no code hash: the runner (or Agent URL) reported none when the rating was queued; update @bondedhq/runner or declare a code hash, then rate again",
        true,
      );
    const withSentinel = config.kind !== "remote" && config.sentinel === true;
    if (withSentinel && !sentinel)
      throw new Error("this agent is rated with Sentinel on, but SENTINEL_URL isn't set");
    // A remote agent is rated through its runner: with none connected, the rating can't start.
    // It is retried, in case the runner is only reconnecting.
    // A config registered by an earlier owner isn't the new owner's to be rated under.
    if (
      config.kind === "remote" &&
      options.ownerOf &&
      (await options.ownerOf(String(row.onchain_id))).toLowerCase() !==
        String(row.owner ?? "").toLowerCase()
    )
      throw new RatingRefused(
        "the agent changed hands since it was registered; its owner must register it again",
        true,
      );
    const connection =
      config.kind === "remote" ? await db.connectionOf(row.agent_id, config) : undefined;
    if (connection === "runner" && !(await db.runnerIsConnected(row.agent_id)))
      throw new RatingRefused(
        "the agent's runner is not connected; start it and rate again",
        false,
      );
    let reach: AgentConnection | undefined;
    if (connection === "url") {
      const live = await db.agentUrl(row.agent_id);
      if (!live?.verifiedAt)
        throw new RatingRefused(
          "the agent's URL isn't set and verified; verify it and rate again",
          true,
        );
      if (!options.secrets) throw new RatingRefused(SECRET_KEY_MISSING, true);
      let secret: string;
      try {
        secret = options.secrets.decrypt(live.ciphertext, agentUrlContext(live.id));
      } catch {
        throw new RatingRefused(
          "the agent's URL secret can't be used; set the Agent URL again",
          true,
        );
      }
      reach = { kind: "url", url: live.url, secret, registration: row.agent_id };
    } else if (connection === "runner") reach = { kind: "runner", key: row.agent_id };
    // Reported code must still be what runs: a runner restarted with other code (or a URL that
    // now reports another version) isn't what this rating was queued for.
    if (connection && row.code_source && row.code_source !== "declared") {
      const now = await db.currentConnection(row.agent_id, connection);
      if (now.code?.hash.toLowerCase() !== String(row.code_hash).toLowerCase())
        throw new RatingRefused(
          "the agent now reports different code than when this rating was queued; run a connection check and rate again",
          true,
        );
    }
    // Setting up (TEE checks, the sandbox, the held-out set): "starting", then "running".
    await db.markStarting(job);
    let signed = row.attestation as SignedAttestation | null;
    if (!signed) {
      // A TEE that doesn't verify fails the job. It never falls back to an unmeasured rating.
      const tee = config.tee
        ? await attestTeeAgent({
            url: config.tee.url,
            codeHash: config.codeHash as Hex,
            composeHash: config.tee.composeHash,
          })
        : undefined;
      await check();
      // A rating restarted after a crash or a lost lease runs again from the first episode. The
      // episodes an abandoned attempt published would stay in the Arena twice over, so they go.
      await db.withLease(job, (c) => db.clearRunEpisodes(job.id, c));
      // The published seeds, accepted bounties and the active held-out set (library.ts).
      const library = await ratingLibrary(db, chain.deployment.chainId);
      const publishedAs = (attackId: string | null) => {
        const spec = attackId ? library.attacks.find((a) => a.id === attackId) : undefined;
        return spec && !library.unpublished.has(spec.id)
          ? { published: true, title: spec.title }
          : { published: false };
      };
      // A remote agent's TEE (chain mode only) signs in the Arena with a key of its own for this
      // rating, never its production key: the fork keeps the live chain's id. Its address comes
      // from the TEE's attestation for a fresh key id, and every episode must prove that same
      // key, from the same deployment (same measurement).
      const arena =
        config.kind === "remote" && tee && config.tee
          ? await (async () => {
              const keyId = `0x${randomBytes(32).toString("hex")}` as Hex;
              const verified = await attestTeeAgent({
                url: config.tee!.url,
                codeHash: config.codeHash as Hex,
                composeHash: config.tee!.composeHash,
                arenaKeyId: keyId,
              });
              const sameKey = arenaKeyProblem(verified.evmAddress, tee.evmAddress);
              if (sameKey) throw new RatingRefused(sameKey, true, { caused: true });
              if (verified.measurement.toLowerCase() !== tee.measurement.toLowerCase())
                throw new RatingRefused(
                  "TEE binding failed: the Arena key's evidence came from another deployment",
                  false,
                );
              return { keyId, verified };
            })()
          : undefined;
      const binding =
        arena && config.tee
          ? new TeeBinding(arena.verified, {
              codeHash: config.codeHash as Hex,
              composeHash: config.tee.composeHash,
              arenaKeyId: arena.keyId,
            })
          : undefined;
      if (config.kind === "remote" && !options.remote)
        throw new RatingRefused(GATEWAY_UNAVAILABLE, true);
      // A remote agent's operator sees every attack its agent reads. So it never gets the shared
      // held-out set or accepted bounties (that would leak them, and they'd no longer be unseen
      // by the next agent): only the published library, and a held-out set made for it alone.
      const selected = options.selectAttacks?.(library.attacks) ?? library.attacks;
      const attacks =
        config.kind === "remote"
          ? selected.filter((a) => !library.unpublished.has(a.id))
          : selected;
      const sandbox = await Sandbox.start({ forkUrl: rpcUrl, forkDeployment: chain.deployment });
      try {
        const agent: ArenaAgent =
          config.kind === "remote"
            ? remoteAgentFor(
                options.remote,
                {
                  agentKey: row.agent_id,
                  chainId: chain.deployment.chainId,
                  agentId: String(row.onchain_id),
                  mode: config.mode,
                  codeHash: remoteCode as Hex,
                  ...(reach ? { connection: reach } : {}),
                  ...(binding && arena
                    ? {
                        tee: {
                          keyId: arena.keyId,
                          evmAddress: arena.verified.evmAddress,
                          verify: (evidence: unknown, nonce: Hex) => binding.check(evidence, nonce),
                        },
                      }
                    : {}),
                },
                sandbox,
              )
            : ratedAgent(config.kind, withSentinel ? sentinel : undefined);
        // A remote agent's operator sees every attack its agent reads, so each of its ratings
        // also runs a held-out set made for it alone, from the published seeds.
        const perClass = config.kind === "remote" ? (options.heldOut?.perClass ?? 1) : 0;
        const fresh =
          perClass > 0
            ? await freshHeldOut({
                library: attacks.filter((a) => !library.unpublished.has(a.id)),
                perClass,
                sandbox,
                ledger: new DbHeldOutLedger(db),
                ...(options.heldOut?.llm ? { llm: options.heldOut.llm } : {}),
              })
            : undefined;
        await check();
        let remoteStop: RatingRefused | undefined;
        const ratingStarted = Date.now();
        let agentMs = 0;
        const remoteBudget =
          options.remoteBudgetMs ??
          remoteRatingPlan(options.remotePolicy ?? DEFAULT_REMOTE_POLICY, {
            publishedAttacks: attacks.length,
            heldOut: fresh?.attacks.length ?? 0,
            ...(config.repeats ? { repeats: config.repeats } : {}),
          }).budgetMs;
        await db.markRunning(job);
        const result = await rateAgent(sandbox, {
          agent,
          ...(withSentinel && sentinel ? { sentinel: sentinel.info } : {}),
          attacks: [...attacks, ...(fresh?.attacks ?? [])],
          unpublished:
            config.kind === "remote"
              ? new Set((fresh?.attacks ?? []).map((a) => a.id))
              : library.unpublished,
          ...(fresh ? { heldOut: fresh.heldOut } : {}),
          // A remote rating's unpublished attacks are its own held-out set, each payload used once:
          // its report may show their text. Bounties and the shared set never are.
          ...(config.kind === "remote" ? { revealUnpublished: true } : {}),
          codeHash:
            config.kind === "remote" ? (remoteCode as Hex) : ratedCodeHash(config, sentinel),
          ...(config.repeats ? { repeats: config.repeats } : {}),
          // An operator-run agent could skip its work, or its reading, when it suspects an
          // attack: only episodes where it was exposed count as trials (rate.ts, `exercise`).
          ...(config.kind === "remote" ? { exercise: "exposed" as const } : {}),
          ...(tee ? { tee } : {}),
          vault: { mandate: config.mandate as EvmMandateInput },
          // A remote rating's total shows at once, before its first episode.
          onProgress: async (p) => {
            if (config.kind === "remote" && p.done === 0)
              await db.setRatingProgress(job, {
                done: 0,
                total: p.total,
                startedAt: new Date(ratingStarted),
              });
          },
          onEpisode: async (episode, index, total) => {
            await check();
            // A remote rating stops at the first episode its agent fails (crash, exit, timeout,
            // runner gone) and at its time budget: the attempt is recorded and not retried, so an
            // operator can neither hold the worker nor choose which run counts by crashing.
            if (config.kind === "remote") {
              const remoteEpisode = (episode.agentSummary as { remote?: { durationMs?: number } })
                .remote;
              agentMs += remoteEpisode?.durationMs ?? 0;
              const elapsed = Date.now() - ratingStarted;
              if (forkBudgetExhausted(episode)) {
                budgetSpentIn = `episode ${index + 1} of ${total}`;
                remoteStop = new RatingRefused(
                  `stopped: the agent used up its share of fork requests in ${budgetSpentIn}`,
                  true,
                  { caused: true },
                );
              } else if (bondedUrlFailure(episode)) {
                // Bonded couldn't call the agent's URL: not the agent's doing; retried.
                remoteStop = new RatingRefused(
                  `stopped: Bonded couldn't reach the agent's URL in episode ${index + 1} of ${total}, not because of the agent; it will be retried`,
                  false,
                );
              } else if (episodeOutcome(episode) === "agent_error") {
                const report = (episode.agentSummary.finalMessage ?? "").slice(0, 500);
                remoteStop = new RatingRefused(
                  `stopped: the agent failed in episode ${index + 1} of ${total}`,
                  true,
                  report ? { caused: true, report } : { caused: true },
                );
              } else if (elapsed > remoteBudget) {
                const budget =
                  remoteBudget >= 60_000
                    ? `${Math.round(remoteBudget / 60_000)}-minute`
                    : `${Math.ceil(remoteBudget / 1000)}-second`;
                // Charged to the agent only if it was the agent that took the time.
                remoteStop =
                  agentMs > elapsed / 2
                    ? new RatingRefused(
                        `stopped: the rating ran past its ${budget} budget after ${index + 1} of ${total} episodes; the agent took ${Math.round((100 * agentMs) / elapsed)}% of the time`,
                        true,
                        { caused: true },
                      )
                    : new RatingRefused(
                        `stopped: the rating ran past its ${budget} budget after ${index + 1} of ${total} episodes, not because of the agent; it will be retried`,
                        false,
                      );
              }
            }
            // Verdict only: planted text and traces can carry a private bounty payload.
            const payload = {
              runId: job.id,
              index,
              total,
              // A library attack's text is public in attacks/; held-out and bounty text never is.
              episode: publicEpisode(episode, publishedAs(episode.attackId)),
            };
            if (config.kind === "remote") {
              held.push(payload);
              await db.setRatingProgress(job, {
                done: index + 1,
                total,
                startedAt: new Date(ratingStarted),
              });
            } else await db.publish("rating.episode", payload);
            if (remoteStop) throw remoteStop;
          },
        });
        // Every episode must have shown the same TEE deployment, or the measurement isn't earned.
        // Checked first: a failed TEE check also ends its episode, and this says why.
        const unbound = binding?.verdict(result.report.episodes.total);
        if (unbound) throw new RatingRefused(unbound, false);
        if (result.report.stoppedEarly || result.report.episodes.agentErrors)
          throw config.kind === "remote"
            ? new RatingRefused("stopped: the agent failed an episode", true, { caused: true })
            : new Error("incomplete rating");
        // A guard that couldn't answer refused the write to stay safe, but that's no evidence the
        // guard works: never attest a score that leaned on it.
        if (result.report.guardFailures)
          throw new Error(
            `incomplete rating: a guard failed to answer ${result.report.guardFailures} times`,
          );
        // An agent that doesn't do its task in the controls can't be breached either: never
        // attest a score it got by doing nothing (rate.ts, LIVENESS_MIN_RATE).
        // The report is kept, so the owner can see the controls; the reason is stored on the
        // rating and shown as is. Running it again won't change a deterministic judgement.
        if (result.refused || !result.attestation) {
          await db.withLease(job, (c) =>
            c.query("UPDATE ratings SET report=$2,report_json=$3 WHERE id=$1", [
              job.id,
              json(result.report),
              `${JSON.stringify(result.report, null, 2)}\n`,
            ]),
          );
          // For an operator-run agent this is the agent's doing (it didn't do its task), so it
          // counts like a crash: the old score is superseded, and the cooldown starts.
          throw new RatingRefused(
            `not attested: ${result.refused ?? "no measured attack trials"}`,
            true,
            config.kind === "remote" ? { caused: true } : undefined,
          );
        }
        const current = await chain.read.readContract({
          address: chain.deployment.registry,
          abi: bondedRegistryAbi,
          functionName: "scoreOf",
          args: [BigInt(row.onchain_id)],
        });
        // Registry versions are strictly increasing, including two ratings in one block.
        const now = Math.max(
          Number((await chain.read.getBlock()).timestamp),
          Number(current.issuedAt) + 1,
        );
        signed = await signAttestation(
          {
            ...result.attestation.attestation,
            agentId: row.onchain_id,
            mandateHash: attestedMandateHash(config),
            issuedAt: now,
            expiresAt: now + 30 * 86400,
          },
          {
            chainId: chain.deployment.chainId,
            registry: chain.deployment.registry,
            attesterKey: key,
          },
        );
        await check();
        await db.withLease(job, (c) =>
          c.query("UPDATE ratings SET report=$2,attestation=$3,report_json=$4 WHERE id=$1", [
            job.id,
            json(result.report),
            json(signed),
            `${JSON.stringify(result.report, null, 2)}\n`,
          ]),
        );
      } finally {
        await sandbox.stop();
      }
    }
    await check();
    // A retried post is safe: recover its receipt via ScorePosted logs if already accepted.
    const previous = await db.pool.query("SELECT 1 FROM attestations WHERE id=$1", [job.id]);
    if (!previous.rowCount) {
      const digest = hashTypedData(
        attestationTypedData(
          bondedDomain(chain.deployment.chainId, chain.deployment.registry),
          signed.attestation,
        ),
      );
      const logs = await chain.read.getLogs({
        address: chain.deployment.registry,
        event: getAbiItem({ abi: bondedRegistryAbi, name: "ValidationResponse" }),
        args: { requestHash: digest },
        fromBlock: BigInt(chain.deployment.deployedAtBlock),
        toBlock: "latest",
        strict: true,
      });
      const hash =
        logs[0]?.transactionHash ??
        (await chain.send(chain.deployment.registry, bondedRegistryAbi, "postScore", [
          attestationMessage(signed.attestation),
          signed.signature,
        ]));
      await check();
      const reportTee = (
        await db.pool.query("SELECT report->'tee' AS tee FROM ratings WHERE id=$1", [job.id])
      ).rows[0]?.tee as { evmAddress?: string } | null;
      await db.withLease(job, async (c) => {
        await c.query(
          "INSERT INTO attestations(id,agent_id,signed,tx_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [job.id, row.agent_id, json(signed), hash],
        );
        // The posted score replaces whatever an earlier TEE failure was about (ADR-013): record its
        // key and measurement, or drop the TEE row if this rating has no TEE.
        const agentKey = `${chain.deployment.chainId}:${row.onchain_id}`;
        if (reportTee?.evmAddress)
          await db.recordTeeRating(
            {
              agentId: agentKey,
              ratedMeasurement: signed.attestation.teeMeasurement,
              ratedReportHash: signed.attestation.reportHash,
              evmAddress: reportTee.evmAddress,
            },
            c,
          );
        else await db.recordTeeRating({ agentId: agentKey }, c);
      });
    }
    // A complete rating posted: any standing from earlier stops resets.
    await db.finish(job);
    await flush();
    notifyOwner("rating_finished", "done", {
      score: signed.attestation.score,
      securityScore: signed.attestation.securityScore,
    });
  } catch (error) {
    onError?.(error);
    const failure = ratingFailure(error, budgetSpentIn);
    await db.finish(job, failure.reason, {
      ...(failure.final !== undefined ? { final: failure.final } : {}),
      ...(failure.agentCaused ? { agentCaused: true } : {}),
      ...(failure.agentReport ? { agentReport: failure.agentReport } : {}),
    });
    // Only an attempt that is over: a retried one is still on its way.
    const status = (await db.pool.query("SELECT status FROM ratings WHERE id=$1", [job.id])).rows[0]
      ?.status;
    // Over for good: its episodes go to the feed. Retried: this attempt's are dropped.
    if (status === "failed") await flush();
    else held.length = 0;
    if (status === "failed")
      notifyOwner(
        failure.reason.startsWith("not attested") ? "rating_refused" : "rating_failed",
        "failed",
        { reason: failure.reason },
      );
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
