import {
  type AgentTask,
  EpisodeEnv,
  parseBrokerageEpisodeEnv,
  parseEpisodeEnv,
} from "@bondedhq/shared";
import { type Address, defineChain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BondedError } from "./errors.js";
import type { TokenInfo } from "./guarded.js";
import { BondedVault } from "./vault.js";

/**
 * An Arena episode, as the Bonded runner hands it to an agent it launches: the task, where the
 * episode's tools are, and in chain mode a fork RPC and the key to sign with. The agent acts
 * exactly as in production, against these endpoints, and the Arena judges it by the episode
 * vault's breach log.
 */
export interface BondedEpisode {
  episodeId: string;
  task: AgentTask;
  /** tools: writes are the `swap`/`transfer`/`approve` tools. chain: writes are signed `execute` txs to `endpoints.rpc`. */
  mode: "tools" | "chain";
  endpoints: {
    /** MCP over streamable HTTP. */
    mcp: string;
    /** Plain HTTP: `GET {tools}` lists them, `POST {tools}/{name}` with JSON args calls one. */
    tools: string;
    openapi: string;
    /** `POST` here when finished (`{ finalMessage? }`). */
    done: string;
    /** Chain mode: the episode's fork. Only signed `execute` calls to the episode vault are accepted. */
    rpc?: string;
  };
  vault: Address;
  chainId: number;
  /** The episode's market: the exchange (swap router) and the tokens the agent can trade. */
  contracts: { exchange: Address; tokens: TokenInfo[] };
  /** Chain mode: the episode's agent key. Absent when the agent's key lives in a TEE. */
  sessionKey?: Hex;
  /** How long the agent has, in milliseconds from when it starts. */
  deadlineMs: number;
}

/**
 * The BONDED_* variables the runner sets for each episode. The schema lives in @bondedhq/shared,
 * next to `episodeEnv` that writes them, so the runner, the gateway and the SDK can't drift.
 */
export const bondedEpisodeEnv = EpisodeEnv;

/**
 * Whether this process is running a Bonded episode: the runner set valid `BONDED_*` variables.
 * Lets an agent pick the episode's tools when it is being rated and its own otherwise:
 *
 * ```ts
 * const tools = isBondedEpisode() ? await bondedLangChainTools() : productionTools;
 * ```
 *
 * True in every world, so an agent under test never falls through to its production tools. In a
 * world the agent wasn't built for, the helpers then fail loudly: in a brokerage episode
 * `fromBondedEnv` and the vault tool helpers throw `EPISODE_ENV`. `bondedEpisodeWorld()` says
 * which world it is.
 */
export function isBondedEpisode(
  env: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env,
): boolean {
  return bondedEpisodeWorld(env) !== undefined;
}

/**
 * Reads the episode the Bonded runner set up from the environment. Throws `BondedError`
 * (`EPISODE_ENV`) naming every missing or malformed variable.
 *
 * ```ts
 * const episode = fromBondedEnv();
 * if (episode.mode === "chain") {
 *   const vault = new BondedVault({ vault: episode.vault, rpcUrl: episode.endpoints.rpc, ... });
 * }
 * ```
 */
export function fromBondedEnv(
  env: Record<string, string | undefined> = process.env,
): BondedEpisode {
  const parsed = parseEpisodeEnv(env);
  if (!parsed.ok)
    throw new BondedError(
      "EPISODE_ENV",
      `not a valid Bonded episode environment: ${parsed.problems.join("; ")}`,
    );
  const { contracts, ...episode } = parsed.episode;
  return { ...episode, contracts: { exchange: contracts.exchange, tokens: contracts.tokens } };
}

/**
 * Chain mode: the episode vault as a `BondedVault`, signing with the episode's session key
 * through the episode's fork RPC, and swapping on the episode's exchange. Writes are then signed
 * `execute` calls, exactly as in production. Throws `BondedError` (`EPISODE_MODE`) in tools mode
 * or when the key is held by a TEE (no session key): use your own signer there.
 */
export function episodeVault(episode: BondedEpisode): BondedVault {
  const rpc = episode.endpoints.rpc;
  if (episode.mode !== "chain" || !rpc)
    throw new BondedError(
      "EPISODE_MODE",
      "only a chain-mode episode has a vault to sign for; in tools mode, writes are tool calls",
    );
  if (!episode.sessionKey)
    throw new BondedError(
      "EPISODE_MODE",
      "this episode has no session key (the agent's key is in a TEE); build a BondedVault with your own signer",
    );
  return new BondedVault({
    vault: episode.vault,
    chain: defineChain({
      id: episode.chainId,
      name: `Bonded episode ${episode.episodeId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    }),
    rpcUrl: rpc,
    account: privateKeyToAccount(episode.sessionKey),
    router: episode.contracts.exchange,
  });
}

/**
 * A brokerage episode: the agent manages a simulated brokerage account (stocks, filings, orders,
 * cash withdrawals) through the episode's tools. There is no chain, vault or key: every read and
 * write is a tool call, and the Arena judges it by the brokerage ledger. Needs runner protocol 2
 * (the runner release after 0.1.3), started with `--world brokerage`.
 */
export interface BondedBrokerageEpisode {
  world: "brokerage";
  episodeId: string;
  task: AgentTask;
  mode: "tools";
  endpoints: {
    /** MCP over streamable HTTP. */
    mcp: string;
    /** Plain HTTP: `GET {tools}` lists them, `POST {tools}/{name}` with JSON args calls one. */
    tools: string;
    openapi: string;
    /** `POST` here when finished (`{ finalMessage? }`). */
    done: string;
  };
  /** How long the agent has, in milliseconds from when it starts. */
  deadlineMs: number;
}

/**
 * Which world the runner's episode is for: `vault` (on-chain trading from a Mandate Vault, read
 * with `fromBondedEnv`), `brokerage` (read with `fromBondedBrokerageEnv`), or undefined when this
 * process isn't running a Bonded episode.
 *
 * ```ts
 * const world = bondedEpisodeWorld();
 * const tools =
 *   world === "brokerage"
 *     ? await myBrokerageTools(fromBondedBrokerageEnv())
 *     : world === "vault"
 *       ? await bondedLangChainTools()
 *       : productionTools;
 * ```
 */
export function bondedEpisodeWorld(
  env: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env,
): "vault" | "brokerage" | undefined {
  // Fails closed: once the runner has named the brokerage world for an episode, that is the
  // answer even if another variable is malformed. `fromBondedBrokerageEnv` then names the bad
  // variable, where "not an episode" would send the agent to its production tools.
  if (env.BONDED_WORLD === "brokerage" && env.BONDED_EPISODE_ID?.trim()) return "brokerage";
  return parseEpisodeEnv(env).ok ? "vault" : undefined;
}

/**
 * Reads a brokerage episode the Bonded runner set up from the environment. Throws `BondedError`
 * (`EPISODE_ENV`) naming every missing or malformed variable.
 */
export function fromBondedBrokerageEnv(
  env: Record<string, string | undefined> = process.env,
): BondedBrokerageEpisode {
  const parsed = parseBrokerageEpisodeEnv(env);
  if (!parsed.ok)
    throw new BondedError(
      "EPISODE_ENV",
      `not a valid Bonded brokerage episode environment: ${parsed.problems.join("; ")}`,
    );
  return parsed.episode;
}
