import { keccak256, stringToBytes } from "viem";
import { z } from "zod";
import type { AgentTask } from "./agent.js";
import { evmAddress } from "./schemas/common.js";

/**
 * The runner protocol: how an agent running on its operator's own servers is rated by the Arena
 * (bring your own agent). The runner (`@bondedhq/runner`) connects out to the Arena Gateway over a
 * WebSocket, and the gateway hands it one episode at a time. For each episode the runner launches
 * the operator's agent command with the episode's endpoints in its environment; the agent then
 * talks to the gateway directly (MCP, plain HTTP, or in chain mode a JSON-RPC endpoint).
 *
 * Both sides parse every message with these schemas, so a malformed message is refused at the
 * edge instead of half-handled.
 */

/**
 * Bumped when a message changes in a way an older runner or gateway can't read. Version 2 adds
 * brokerage episodes (`BrokerageEpisodeMessage`), which have no chain, vault or contracts.
 */
export const RUNNER_PROTOCOL_VERSION = 2;
/**
 * The oldest runner protocol the gateway still accepts. A version 1 runner is rated on the vault
 * world only: the gateway never sends it a brokerage episode.
 */
export const RUNNER_MIN_PROTOCOL_VERSION = 1;
/** The first protocol version that can run brokerage episodes. */
export const BROKERAGE_PROTOCOL_VERSION = 2;
/** The runner pings this often; the gateway drops a runner silent for three intervals. */
export const RUNNER_HEARTBEAT_MS = 15_000;
/** Most of an agent's stdout and stderr the runner sends back, from the end of each. */
export const RUNNER_TAIL_BYTES = 4_096;
/** After SIGTERM, how long an agent gets to exit before SIGKILL. */
export const RUNNER_KILL_GRACE_MS = 5_000;
/** Largest WebSocket message either side accepts. */
export const RUNNER_MAX_MESSAGE_BYTES = 1024 * 1024;
/** Every runner token starts with this, so one is recognisable in a config file or a log. */
export const RUNNER_TOKEN_PREFIX = "bonded_rt_";

/**
 * Whether text is shaped like a runner token (the prefix, then base64url). The gateway only spends
 * a token check, and per-address budget, on well-formed tokens.
 */
export function isWellFormedRunnerToken(token: string): boolean {
  return /^bonded_rt_[A-Za-z0-9_-]{16,128}$/.test(token);
}

/** Path of the runner's WebSocket on the gateway. */
export const RUNNER_CONNECT_PATH = "/runner/connect";

/**
 * Close codes the gateway uses, so the runner can tell "try again" from "stop".
 * - replaced: another runner connected with the same token (the newer one wins).
 * - protocol: a message didn't parse, or the runner's protocol version is unsupported.
 * - heartbeat: the runner went quiet for too long.
 * - revoked: the runner token is no longer valid.
 * - rateLimited: too many messages; the runner may reconnect after backing off.
 */
export const RUNNER_CLOSE = {
  replaced: 4000,
  protocol: 4002,
  heartbeat: 4003,
  revoked: 4004,
  /** The runner sent messages faster than any runner needs to (it may reconnect). */
  rateLimited: 4005,
};

/**
 * How the agent acts:
 * - tools: reads and writes are tool calls (MCP or HTTP); the Arena sends each write through the
 *   vault with its own sandbox key, exactly as for an in-process agent.
 * - chain: reads are still tool calls (that is where attacks are planted), but writes are
 *   transactions the agent signs itself and sends to its vault's `execute` through the gateway's
 *   JSON-RPC endpoint, as it would in production.
 */
export const AgentMode = z.enum(["tools", "chain"]);
export type AgentMode = z.infer<typeof AgentMode>;

const hex = z
  .string()
  .regex(/^0x[0-9a-fA-F]*$/, "hex string")
  .transform((value) => value as `0x${string}`);
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x address")
  .transform((value) => value as `0x${string}`);
const url = z.url({ protocol: /^https?$/ });
const id = z.string().min(1).max(128);
/** Free text an agent or runner sends: capped, so it can't flood logs or the database. */
const text = (max: number) => z.string().max(max);

/** The task as the runner receives it: `AgentTask` from the agent contract. */
export const AgentTaskSchema = z.object({
  goal: z.string(),
  mandate: z.string(),
  policy: z
    .object({
      tokens: z.array(z.string()),
      maxTradeUsd: z.number(),
      maxDailyUsd: z.number(),
      transferAllowlist: z.array(address),
      approvalAllowlist: z.array(address),
    })
    .optional(),
  maxSteps: z.number().int().positive(),
}) satisfies z.ZodType<AgentTask>;

/** Where the agent reaches the gateway for one episode. Each URL carries the episode's capability. */
export const EpisodeEndpoints = z.object({
  /** MCP over streamable HTTP. */
  mcp: url,
  /** Plain HTTP: GET lists the tools, POST {tools}/{name} calls one. */
  tools: url,
  /** OpenAPI 3.1 description of the plain HTTP endpoints. */
  openapi: url,
  /** Chain mode only: JSON-RPC to the episode's chain (a read allowlist plus signed vault calls). */
  rpc: url.optional(),
  /** POST here when finished (optional: the process exiting also ends the episode). */
  done: url,
});
export type EpisodeEndpoints = z.infer<typeof EpisodeEndpoints>;

/** The deployment the agent trades on: what a production agent has in its own config. */
export const EpisodeContracts = z.object({
  /** The exchange router whose `swap` the mandate allows. */
  exchange: address,
  tokens: z.array(z.object({ symbol: z.string(), address, decimals: z.number().int() })),
});
export type EpisodeContracts = z.infer<typeof EpisodeContracts>;

// Server → runner.

/**
 * What an episode puts in front of the agent:
 * - vault: the on-chain market, trading from a Mandate Vault (the original episode, and the
 *   default when a message doesn't say);
 * - brokerage: a simulated brokerage account, with stocks, filings and cash withdrawals
 *   (docs/BROKERAGE.md). Tools mode only; no chain.
 */
export const EpisodeWorld = z.enum(["vault", "brokerage"]);
export type EpisodeWorld = z.infer<typeof EpisodeWorld>;

export const EpisodeMessage = z.object({
  type: z.literal("episode"),
  /** Absent in protocol 1, which had only the vault world. */
  world: z.literal("vault").optional(),
  episodeId: id,
  task: AgentTaskSchema,
  mode: AgentMode,
  endpoints: EpisodeEndpoints,
  chainId: z.number().int().positive(),
  vault: address,
  contracts: EpisodeContracts,
  /**
   * Chain mode without a TEE: a fresh private key made for this episode only. The episode's
   * vault names its address as the agent, and it holds test gas on the sandbox chain only.
   */
  sessionKey: hex.optional(),
  /** Milliseconds the agent has, from when the runner receives this message. */
  deadlineMs: z.number().int().positive(),
  /** TEE-bound agents: a fresh challenge the runner gets the TEE to sign (`tee_evidence`). */
  nonce: hex.optional(),
  /**
   * TEE-bound agents in chain mode: the rating's Arena key id. The TEE derives a key for it, the
   * evidence attests that key, and the agent signs episode transactions with it (never its
   * production key).
   */
  teeKeyId: hex.optional(),
});
export type EpisodeMessage = z.infer<typeof EpisodeMessage>;

/**
 * A brokerage episode (protocol 2): the same task, endpoints and deadline, with no chain, vault
 * or contracts. Writes (orders, withdrawals) are tool calls, so it runs in tools mode only.
 */
export const BrokerageEpisodeMessage = z.object({
  type: z.literal("episode"),
  world: z.literal("brokerage"),
  episodeId: id,
  task: AgentTaskSchema,
  mode: z.literal("tools"),
  endpoints: EpisodeEndpoints,
  deadlineMs: z.number().int().positive(),
  nonce: hex.optional(),
});
export type BrokerageEpisodeMessage = z.infer<typeof BrokerageEpisodeMessage>;

/** Either kind of episode. A message that names no world is a vault episode. */
export const AnyEpisodeMessage = z.union([BrokerageEpisodeMessage, EpisodeMessage]);
export type AnyEpisodeMessage = z.infer<typeof AnyEpisodeMessage>;

/** The world an episode message is for. */
export const episodeWorld = (episode: { world?: EpisodeWorld }): EpisodeWorld =>
  episode.world ?? "vault";

/** Stop the episode's agent: SIGTERM, then SIGKILL after RUNNER_KILL_GRACE_MS. */
export const CancelMessage = z.object({ type: z.literal("cancel"), episodeId: id });
export const PongMessage = z.object({ type: z.literal("pong"), at: z.number().optional() });

export const ServerToRunner = z.union([AnyEpisodeMessage, CancelMessage, PongMessage]);
export type ServerToRunner = z.infer<typeof ServerToRunner>;

/**
 * Where an agent's code hash came from, when it wasn't declared:
 * - flag, env: the runner's `--code-hash` or BONDED_CODE_HASH (passed through as given);
 * - image: BONDED_IMAGE_DIGEST, a container image digest;
 * - git: the commit of the agent's working tree; git-dirty: the same, with uncommitted changes;
 * - unpinned: nothing better, so the command line and the bytes of its entry file;
 * - url: the `version` an Agent URL answered verify with.
 */
export const CodeSource = z.enum(["flag", "env", "image", "git", "git-dirty", "unpinned", "url"]);
export type CodeSource = z.infer<typeof CodeSource>;

/** A derived code hash: keccak256 of `"<source>:<value>"` (the value as UTF-8, or raw bytes). */
export function codeHashOf(source: CodeSource, value: string | Uint8Array): `0x${string}` {
  if (typeof value === "string") return keccak256(stringToBytes(`${source}:${value}`));
  const prefix = stringToBytes(`${source}:`);
  const bytes = new Uint8Array(prefix.length + value.length);
  bytes.set(prefix, 0);
  bytes.set(value, prefix.length);
  return keccak256(bytes);
}

// Runner → server.

export const HelloMessage = z.object({
  type: z.literal("hello"),
  runnerVersion: text(64),
  protocol: z.number().int().positive(),
  mode: AgentMode,
  teeUrl: url.optional(),
  /**
   * The code version the runner launches, as a code hash it worked out (runner `codeIdentity`):
   * used when the operator declared none. Older runners don't send it.
   */
  codeHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "must be 32 bytes of hex")
    .transform((value) => value as `0x${string}`)
    .optional(),
  /** Where `codeHash` came from (a git commit, an image digest, ...). */
  codeSource: CodeSource.optional(),
  /**
   * What it was made from: the commit for git and git-dirty, the digest for image, a label
   * otherwise. Reported by the runner, never verified.
   */
  codeDetail: text(200).optional(),
});
export const PingMessage = z.object({ type: z.literal("ping"), at: z.number().optional() });
/**
 * The agent TEE's answer to the episode's nonce, forwarded as-is: the gateway verifies it, the
 * runner never does. `error` when the runner couldn't get it.
 */
export const TeeEvidenceMessage = z.object({
  type: z.literal("tee_evidence"),
  episodeId: id,
  evidence: z.unknown().optional(),
  error: text(1_000).optional(),
});
export const EpisodeStartedMessage = z.object({
  type: z.literal("episode_started"),
  episodeId: id,
});
export const EpisodeDoneMessage = z.object({
  type: z.literal("episode_done"),
  episodeId: id,
  /** The agent's exit code, or null when it was killed by a signal or never started. */
  exitCode: z.number().int().nullable(),
  signal: text(32).nullable().optional(),
  durationMs: z.number().nonnegative(),
  /** The last RUNNER_TAIL_BYTES of each stream (the runner may trim a little more). */
  stdoutTail: text(RUNNER_TAIL_BYTES * 2).optional(),
  stderrTail: text(RUNNER_TAIL_BYTES * 2).optional(),
  /** Why the runner couldn't run the episode (couldn't launch the command, already busy). */
  error: text(1_000).optional(),
});

export const RunnerToServer = z.discriminatedUnion("type", [
  HelloMessage,
  PingMessage,
  TeeEvidenceMessage,
  EpisodeStartedMessage,
  EpisodeDoneMessage,
]);
export type RunnerToServer = z.infer<typeof RunnerToServer>;
export type HelloMessage = z.infer<typeof HelloMessage>;
export type TeeEvidenceMessage = z.infer<typeof TeeEvidenceMessage>;
export type EpisodeDoneMessage = z.infer<typeof EpisodeDoneMessage>;

/** Body of `POST {done}`: the agent says it is finished. */
export const DoneRequest = z.object({
  finalMessage: text(4_000).optional(),
  /** The agent's own model usage, as it reports it (recorded, never trusted for limits). */
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      costUsd: z.number().nonnegative().optional(),
    })
    .optional(),
});
export type DoneRequest = z.infer<typeof DoneRequest>;

/** Parses one WebSocket message; returns undefined for anything that isn't valid. */
export function parseRunnerMessage<T>(schema: z.ZodType<T>, data: string): T | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return undefined;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The environment the runner gives the agent command for an episode. Every value is a string;
 * the task is JSON. The session key is only present in chain mode without a TEE.
 */
export function episodeEnv(episode: AnyEpisodeMessage): Record<string, string> {
  if (episode.world === "brokerage") {
    return {
      BONDED_WORLD: "brokerage",
      BONDED_EPISODE_ID: episode.episodeId,
      BONDED_MODE: episode.mode,
      BONDED_TASK: JSON.stringify(episode.task),
      BONDED_MCP_URL: episode.endpoints.mcp,
      BONDED_TOOLS_URL: episode.endpoints.tools,
      BONDED_OPENAPI_URL: episode.endpoints.openapi,
      BONDED_DONE_URL: episode.endpoints.done,
      BONDED_DEADLINE_MS: String(episode.deadlineMs),
    };
  }
  return {
    BONDED_WORLD: "vault",
    BONDED_EPISODE_ID: episode.episodeId,
    BONDED_MODE: episode.mode,
    BONDED_TASK: JSON.stringify(episode.task),
    BONDED_MCP_URL: episode.endpoints.mcp,
    BONDED_TOOLS_URL: episode.endpoints.tools,
    BONDED_OPENAPI_URL: episode.endpoints.openapi,
    BONDED_DONE_URL: episode.endpoints.done,
    ...(episode.endpoints.rpc ? { BONDED_RPC_URL: episode.endpoints.rpc } : {}),
    ...(episode.sessionKey ? { BONDED_SESSION_KEY: episode.sessionKey } : {}),
    ...(episode.teeKeyId ? { BONDED_TEE_KEY_ID: episode.teeKeyId } : {}),
    BONDED_VAULT: episode.vault,
    BONDED_CHAIN_ID: String(episode.chainId),
    BONDED_CONTRACTS: JSON.stringify(episode.contracts),
    BONDED_DEADLINE_MS: String(episode.deadlineMs),
  };
}

/** An environment variable holding JSON, parsed and then checked with `schema`. */
const envJson = <T extends z.ZodType>(schema: T) =>
  z
    .string()
    .transform((text, ctx) => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "must be JSON" });
        return z.NEVER;
      }
    })
    .pipe(schema);

/**
 * The BONDED_* variables an agent reads, as `episodeEnv` writes them: the one schema for both
 * sides (the SDK's `fromBondedEnv` uses it). `BONDED_DEADLINE_MS` is a duration.
 */
export const EpisodeEnv = z
  .object({
    /** Set by protocol 2 runners; a vault episode when absent. */
    BONDED_WORLD: z.literal("vault").optional(),
    BONDED_EPISODE_ID: id,
    BONDED_MODE: AgentMode,
    BONDED_TASK: envJson(AgentTaskSchema),
    BONDED_MCP_URL: url,
    BONDED_TOOLS_URL: url,
    BONDED_OPENAPI_URL: url,
    BONDED_DONE_URL: url,
    BONDED_RPC_URL: url.optional(),
    BONDED_SESSION_KEY: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, "must be a 0x-prefixed 32-byte private key")
      .transform((value) => value as `0x${string}`)
      .optional(),
    BONDED_TEE_KEY_ID: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/, "must be 32 bytes of hex")
      .transform((value) => value as `0x${string}`)
      .optional(),
    BONDED_VAULT: evmAddress,
    BONDED_CHAIN_ID: z.coerce.number().int().positive(),
    BONDED_CONTRACTS: envJson(
      EpisodeContracts.extend({
        tokens: z
          .array(
            z.object({
              symbol: z.string().min(1),
              address: evmAddress,
              decimals: z.number().int().min(0).max(36),
            }),
          )
          .min(1),
        exchange: evmAddress,
      }),
    ),
    BONDED_DEADLINE_MS: z.coerce.number().int().positive(),
  })
  .refine((env) => env.BONDED_MODE !== "chain" || env.BONDED_RPC_URL, {
    message: "chain mode needs BONDED_RPC_URL",
    path: ["BONDED_RPC_URL"],
  });

/** An episode as its agent sees it: the `episode` message, read back from the environment. */
export type EpisodeFromEnv = Omit<EpisodeMessage, "type" | "nonce">;

/**
 * Reads an episode from BONDED_* variables (the inverse of `episodeEnv`). Addresses come back
 * checksummed. Returns every problem, by variable, when the environment isn't a valid episode.
 */
export function parseEpisodeEnv(
  env: Record<string, string | undefined>,
): { ok: true; episode: EpisodeFromEnv } | { ok: false; problems: string[] } {
  if (env.BONDED_WORLD === "brokerage")
    return {
      ok: false,
      problems: [
        "BONDED_WORLD is brokerage: this is a brokerage episode, with no vault (read it with parseBrokerageEpisodeEnv)",
      ],
    };
  const parsed = EpisodeEnv.safeParse(env);
  if (!parsed.success)
    return {
      ok: false,
      problems: parsed.error.issues.map((i) => `${i.path.join(".") || "environment"} ${i.message}`),
    };
  const e = parsed.data;
  return {
    ok: true,
    episode: {
      episodeId: e.BONDED_EPISODE_ID,
      task: e.BONDED_TASK,
      mode: e.BONDED_MODE,
      endpoints: {
        mcp: e.BONDED_MCP_URL,
        tools: e.BONDED_TOOLS_URL,
        openapi: e.BONDED_OPENAPI_URL,
        done: e.BONDED_DONE_URL,
        ...(e.BONDED_RPC_URL ? { rpc: e.BONDED_RPC_URL } : {}),
      },
      chainId: e.BONDED_CHAIN_ID,
      vault: e.BONDED_VAULT,
      contracts: e.BONDED_CONTRACTS,
      ...(e.BONDED_SESSION_KEY ? { sessionKey: e.BONDED_SESSION_KEY } : {}),
      ...(e.BONDED_TEE_KEY_ID ? { teeKeyId: e.BONDED_TEE_KEY_ID } : {}),
      deadlineMs: e.BONDED_DEADLINE_MS,
    },
  };
}

/** The BONDED_* variables of a brokerage episode, as `episodeEnv` writes them. */
export const BrokerageEpisodeEnv = z.object({
  BONDED_WORLD: z.literal("brokerage"),
  BONDED_EPISODE_ID: id,
  BONDED_MODE: z.literal("tools"),
  BONDED_TASK: envJson(AgentTaskSchema),
  BONDED_MCP_URL: url,
  BONDED_TOOLS_URL: url,
  BONDED_OPENAPI_URL: url,
  BONDED_DONE_URL: url,
  BONDED_DEADLINE_MS: z.coerce.number().int().positive(),
});

/** A brokerage episode as its agent sees it, read back from the environment. */
export type BrokerageEpisodeFromEnv = Omit<BrokerageEpisodeMessage, "type" | "nonce">;

/** Reads a brokerage episode from BONDED_* variables (the inverse of `episodeEnv`). */
export function parseBrokerageEpisodeEnv(
  env: Record<string, string | undefined>,
): { ok: true; episode: BrokerageEpisodeFromEnv } | { ok: false; problems: string[] } {
  const parsed = BrokerageEpisodeEnv.safeParse(env);
  if (!parsed.success)
    return {
      ok: false,
      problems: parsed.error.issues.map((i) => `${i.path.join(".") || "environment"} ${i.message}`),
    };
  const e = parsed.data;
  return {
    ok: true,
    episode: {
      world: "brokerage",
      episodeId: e.BONDED_EPISODE_ID,
      task: e.BONDED_TASK,
      mode: e.BONDED_MODE,
      endpoints: {
        mcp: e.BONDED_MCP_URL,
        tools: e.BONDED_TOOLS_URL,
        openapi: e.BONDED_OPENAPI_URL,
        done: e.BONDED_DONE_URL,
      },
      deadlineMs: e.BONDED_DEADLINE_MS,
    },
  };
}
