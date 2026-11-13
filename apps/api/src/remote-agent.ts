import {
  AgentUrlUnavailableError,
  bondedFailure,
  HOSTED_REMOTE_PROFILE,
  RemoteAgent,
  TeeVerificationError,
  verifyTeeEvidence,
  type ArenaGateway,
  type QuoteVerifier,
  type Sandbox,
  type VerifiedTee,
} from "@bonded/arena";
import type { ArenaAgent, RemoteMode } from "@bondedhq/shared";
import type { Hex } from "viem";
import { transportOf, type AgentConnection } from "./connections.js";

/**
 * Bring your own agent (docs/BRING-YOUR-OWN-AGENT.md): the rating worker's side of a remote agent.
 * The agent runs on its operator's servers and reaches the Arena through the Arena Gateway, so to
 * the rating it is one more `ArenaAgent`. Building that agent is the gateway's job; this module is
 * the one seam between the worker and the gateway, so the worker never depends on how it works.
 */

/** What the worker tells the gateway about the agent it is about to rate. */
export interface RemoteAgentRequest {
  /** The agent's row id, "<chain id>:<agent id>": the key its runner token resolves to. */
  agentKey: string;
  chainId: number;
  /** The on-chain agent id. */
  agentId: string;
  mode: RemoteMode;
  /**
   * The world the agent is tested on (default vault). A brokerage preview has no chain, so it
   * gets no sandbox and runs in tools mode only.
   */
  world?: "vault" | "brokerage";
  /** The code hash the rating is about: declared, or what the runner or URL reported. */
  codeHash: Hex;
  /**
   * How to reach the agent: its runner (by `agentKey`, the default) or its Agent URL, with the
   * secret that signs each call. The secret never leaves the worker except in that signature.
   */
  connection?: AgentConnection;
  /**
   * A TEE-bound agent (chain mode). The rating has an Arena key of its own: the TEE derives it
   * from `keyId`, and `evmAddress` is its address, which the episode vaults name as their agent,
   * so nothing the agent signs in the Arena (whose fork keeps the live chain's id) is valid for
   * its production key. The gateway asks the runner for that key's evidence with a fresh nonce
   * at the start of every episode and passes it to `verify`, which throws when it doesn't hold.
   */
  tee?: {
    keyId: Hex;
    evmAddress: Hex;
    verify: (evidence: unknown, nonce: Hex) => Promise<VerifiedTee>;
  };
}

/**
 * How long a remote agent has for one episode in a service rating (90 s by default,
 * REMOTE_EPISODE_TIMEOUT_MS): an episode is one task with a handful of tool calls, and a rating
 * has a few hundred of them, so the gateway's own 4-minute default would let one rating take hours.
 */
export const REMOTE_EPISODE_TIMEOUT_MS = HOSTED_REMOTE_PROFILE.episodeTimeoutMs;

/** Builds the remote agent for one rating, in the rating's sandbox (the gateway's `RemoteAgent`). */
export type RemoteAgentFactory = (
  request: RemoteAgentRequest,
  /** The rating's sandbox: absent for the brokerage world, which has no chain. */
  sandbox: Sandbox | undefined,
) => ArenaAgent;

/**
 * The Arena Gateway's `RemoteAgent` for a rating: the agent's runner is the one its token maps to
 * (the agent's key), or its Agent URL, called with the agent secret; a TEE-bound agent's evidence goes to `verify` at every episode, and in chain
 * mode its vault names the TEE's attested key, so no key is sent.
 */
export function gatewayAgents(
  gateway: ArenaGateway,
  options: { episodeTimeoutMs?: number; runnerWaitMs?: number } = {},
): RemoteAgentFactory {
  return (request, sandbox) => {
    // An Agent URL can't carry a TEE's evidence: that comes through the runner.
    if (request.connection && request.connection.kind !== "runner" && request.tee)
      throw new RatingRefused("a TEE-bound agent is rated through its runner", true);
    // No `onEvent` here: per-episode activity would show the operator which episodes are attacks.
    const world = request.world ?? "vault";
    if (world !== "vault" && request.tee)
      throw new RatingRefused(`a TEE-bound agent is rated on the vault world only`, true);
    return new RemoteAgent({
      gateway,
      ...(sandbox ? { sandbox } : {}),
      world,
      transport: request.connection
        ? transportOf(request.connection)
        : { kind: "runner", key: request.agentKey },
      mode: request.mode,
      name: `remote/agent-${request.agentId}`,
      episodeTimeoutMs: options.episodeTimeoutMs ?? REMOTE_EPISODE_TIMEOUT_MS,
      runnerWaitMs: options.runnerWaitMs ?? 30_000,
      ...(request.tee
        ? {
            tee: {
              keyId: request.tee.keyId,
              onEvidence: (evidence: unknown, { nonce }: { nonce: Hex }) =>
                request.tee!.verify(evidence, nonce),
            },
            ...(request.mode === "chain" ? { agentAddress: request.tee.evmAddress } : {}),
          }
        : {}),
    });
  };
}

/** A rating that can't run, and whether trying again could help. Its message is stored as is. */
export class RatingRefused extends Error {
  constructor(
    message: string,
    /** True when retrying can't help (the job fails at once instead of being retried). */
    readonly final: boolean,
    /**
     * The agent caused it (crash, timeout, too slow): its score is superseded and a cooldown
     * starts. `agentReport` is what the agent or its runner said, kept apart from `message`.
     */
    readonly agent?: { caused: true; report?: string },
  ) {
    super(message);
    this.name = "RatingRefused";
  }
}

/** Why a worker without the Arena Gateway can't rate a remote agent. */
export const GATEWAY_UNAVAILABLE =
  "gateway not available: this rating worker has no Arena Gateway, so it can't rate an agent that runs on its operator's servers";

/** The remote agent for a rating, or a clear refusal when this worker has no gateway. */
export function remoteAgentFor(
  factory: RemoteAgentFactory | undefined,
  request: RemoteAgentRequest,
  sandbox: Sandbox | undefined,
): ArenaAgent {
  if (!factory) throw new RatingRefused(GATEWAY_UNAVAILABLE, true);
  return factory(request, sandbox);
}

/**
 * Binds a remote agent's rating to one TEE deployment. The reference is the evidence verified
 * before the rating started; every episode's evidence must verify against its own nonce and show
 * the same measurement and the same EVM key. The first thing that doesn't hold is kept as
 * `failure`, and the worker fails the whole rating on it.
 */
export class TeeBinding {
  /** Episodes whose evidence verified and matched. */
  verified = 0;
  failure: string | undefined;

  constructor(
    readonly reference: VerifiedTee,
    private readonly expected: {
      codeHash: Hex;
      composeHash: string;
      verifyQuote?: QuoteVerifier;
      approvedOsImages?: readonly string[];
      /** The rating's Arena key id: every episode must attest that key, and nothing else. */
      arenaKeyId?: string;
    },
  ) {}

  /** Checks one episode's evidence (see the class note). Throws `TeeVerificationError`. */
  async check(evidence: unknown, nonce: Hex): Promise<VerifiedTee> {
    try {
      const live = await verifyTeeEvidence(evidence, { ...this.expected, nonce });
      if (live.measurement.toLowerCase() !== this.reference.measurement.toLowerCase())
        throw new TeeVerificationError("the TEE measurement changed during the rating");
      if (live.evmAddress.toLowerCase() !== this.reference.evmAddress.toLowerCase())
        throw new TeeVerificationError("the TEE agent's key changed during the rating");
      this.verified++;
      return live;
    } catch (error) {
      this.failure ??=
        error instanceof Error ? error.message : "the TEE evidence could not be checked";
      throw error;
    }
  }

  /** Why the rating can't carry this TEE's measurement, or undefined when every episode proved it. */
  verdict(episodes: number): string | undefined {
    if (this.failure) return `TEE binding failed: ${this.failure}`;
    if (this.verified < episodes)
      return `TEE binding failed: ${episodes - this.verified} of ${episodes} episodes had no verified TEE evidence`;
    return undefined;
  }
}

/**
 * Why a rating's Arena key can't be used, or undefined when it can. The TEE must derive a key of
 * its own for the rating: code that answers with its production key would have the agent sign, in
 * the Arena (whose fork keeps the live chain's id), transactions valid on the live chain.
 */
export function arenaKeyProblem(arenaKey: string, productionKey: string): string | undefined {
  return arenaKey.toLowerCase() === productionKey.toLowerCase()
    ? "TEE binding failed: the TEE answered the Arena key request with its production key, so what it signs in the Arena would be valid on the live chain"
    : undefined;
}

/**
 * Whether a gateway episode says its agent used up its share of fork requests: the Arena
 * Gateway's `RemoteEpisode.budgetExhausted`, on an episode result (`agentSummary.remote`) or a run
 * summary (`remote`). That is the agent's doing, never an infrastructure failure. The gateway
 * raises no error of its own for it (the agent's reads just get JSON-RPC refusals), so this flag
 * is the only signal.
 */
export function forkBudgetExhausted(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const v = value as {
    remote?: { budgetExhausted?: unknown };
    agentSummary?: { remote?: { budgetExhausted?: unknown } };
  };
  return v.remote?.budgetExhausted === true || v.agentSummary?.remote?.budgetExhausted === true;
}

/** Why a rating job failed, as the worker records it (`Database.finish`). */
export interface RatingFailure {
  reason: string;
  final?: boolean;
  agentCaused?: true;
  agentReport?: string;
}

/**
 * How the worker records a failed rating. `budgetSpentIn` is set (to "episode 3 of 40") once an
 * episode came back with its agent's fork share used up: anything that fails from then on is the
 * agent's doing and final, unless it is already a refusal charged to the agent, whose reason is
 * kept. A refusal's reason is safe to show the owner; anything else may carry an RPC URL or a key,
 * so it gets a generic reason and is retried.
 */
export function ratingFailure(error: unknown, budgetSpentIn?: string): RatingFailure {
  // Bonded couldn't call the agent's URL: not the agent's doing, so no standing or cooldown, and
  // the rating is retried.
  if (error instanceof AgentUrlUnavailableError) return { reason: error.message, final: false };
  if (error instanceof RatingRefused && error.agent)
    return {
      reason: error.message,
      final: error.final,
      agentCaused: true,
      ...(error.agent.report ? { agentReport: error.agent.report } : {}),
    };
  if (budgetSpentIn)
    return {
      reason: `stopped: the agent used up its share of fork requests in ${budgetSpentIn}`,
      final: true,
      agentCaused: true,
    };
  if (error instanceof RatingRefused) return { reason: error.message, final: error.final };
  return { reason: "rating failed; retry scheduled" };
}

/**
 * Whether an episode failed because Bonded couldn't call the agent's URL (its own per-host rate
 * limit): the gateway's `bondedFailure`, so never charged to the agent. A URL that answered
 * non-2xx, or didn't answer in 10 s, is the agent's. (rateAgent itself stops such a rating with
 * AgentUrlUnavailableError before the episode is counted; this covers any episode that slips by.)
 */
export function bondedUrlFailure(value: unknown): boolean {
  const summary = (value as { agentSummary?: object } | null)?.agentSummary;
  return Boolean(summary && bondedFailure(summary));
}
