import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Database, RatedCode } from "@bonded/db";
import {
  bondedRegistryAbi,
  EvmMandate,
  mandateHash,
  mandateVaultAbi,
  mandateVaultFactoryAbi,
  mandateCommitment,
  mandateModuleAbi,
  mandateModuleFactoryAbi,
  PROTECTIONS,
  REMOTE_CONNECTIONS,
  REMOTE_KIND,
  REMOTE_MODES,
  SELF_SERVE_KINDS,
  SELF_SERVE_MAX_AGE_SECONDS,
  UNDERWRITING_COVER_CAP_USD,
  selfServeMessage,
  toEvmMandateParams,
  type EvmMandate as EvmMandateType,
  type AgentMode,
  type BindingLevel,
  type SelfServeKind,
  type SelfServeRequest,
} from "@bondedhq/shared";
import type { ServiceChain } from "@bonded/keeper";
import {
  decodeFunctionData,
  getAbiItem,
  keccak256,
  recoverMessageAddress,
  stringToBytes,
  type Hex,
} from "viem";
import { RateLimiter, clientAddress } from "./rate-limit.js";
import { Refused, handle } from "./refused.js";
import type { AgentStatusReader } from "./agent-status.js";
import { SIGNING_KEY_MISSING } from "./secrets.js";
import { NEEDS_CHECK, codeInfo, publicCheckSummary } from "./connections.js";
import {
  DEFAULT_REMOTE_POLICY,
  remoteQuota,
  remoteRatingPlan,
  remoteRefusalMessage,
  type RemoteRatingPolicy,
} from "./remote-policy.js";
import { remoteRatingProblem } from "./eligibility.js";
import { loadAttackLibrary } from "@bonded/arena";
import { helloProblem, newRunnerToken, runnerTokenHash } from "./runners.js";
import { agentConfig, teeConfig } from "./worker.js";

/**
 * Self-serve routes (docs/SPECIFICATION.md, Day 14 workstream 7): an agent's owner registers their agent
 * for ratings and asks for ratings by signing a message in their wallet, with no operator token.
 * What gets rated is one of Bonded's built-in scripted agent designs, run against the owner's own
 * vault and mandate (docs/AGENTS.md), or the owner's own agent, running on their servers and
 * connected to the Arena Gateway by `@bondedhq/runner` with a runner token made here
 * (docs/BRING-YOUR-OWN-AGENT.md).
 */

/**
 * The code hash of each design, as for the operator's agents. With Sentinel on, the worker
 * attests a combined hash instead (`ratedCodeHash` in worker.ts).
 */
export function selfServeCodeHash(kind: SelfServeKind): Hex {
  return keccak256(stringToBytes(`bonded/scripted-${kind}/v0`));
}

export interface SelfServeLimits {
  /** Runs of each attack in a self-serve rating (default 5, like the published scores). */
  repeats: number;
  /**
   * One rating of a built-in design per agent per this many milliseconds (default one hour). An
   * operator-run agent's comes from `remote.perAgentMs`.
   */
  perAgentMs: number;
  /** Self-serve ratings per chain per 24 hours (default 40). */
  dailyRatings: number;
  /** Requests per client and in total, per window, across the self-serve routes. */
  requests: ConstructorParameters<typeof RateLimiter>[0];
  /** Sizes, caps and budgets for ratings of the owner's own agent (remote-policy.ts). */
  remote: RemoteRatingPolicy;
  now?: () => number;
}

export const DEFAULT_SELF_SERVE_LIMITS: SelfServeLimits = {
  repeats: 5,
  perAgentMs: 60 * 60_000,
  dailyRatings: 40,
  requests: { perClient: 30, total: 600, windowMs: 10 * 60_000 },
  remote: DEFAULT_REMOTE_POLICY,
};

const uint = z
  .string()
  .regex(/^\d{1,78}$/)
  .transform((v) => BigInt(v).toString());
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/);
const registerInput = z.union([
  z.strictObject({
    agentId: uint,
    vault: address,
    kind: z.enum(SELF_SERVE_KINDS),
    mandate: EvmMandate,
    /** Rate with Sentinel in front of the design (docs/SENTINEL.md). */
    sentinel: z.boolean().optional(),
    protection: z.enum(PROTECTIONS).optional(),
    timestamp: z.number().int().positive(),
    signature,
  }),
  // The owner's own agent: what it declares about its code, how it acts, and its TEE if any.
  z.strictObject({
    agentId: uint,
    vault: address,
    kind: z.literal(REMOTE_KIND),
    mandate: EvmMandate,
    /** Optional (Advanced): without it, the runner's or URL's reported hash is used. */
    codeHash: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .optional(),
    mode: z.enum(REMOTE_MODES),
    /** How Bonded reaches the agent: the runner (default) or its Agent URL. */
    connection: z.enum(REMOTE_CONNECTIONS).optional(),
    tee: teeConfig.optional(),
    protection: z.enum(PROTECTIONS).optional(),
    /** "Make it official": the preview this registration comes from, linked to it. Not signed. */
    previewId: z.uuid().optional(),
    timestamp: z.number().int().positive(),
    signature,
  }),
]);
/** A signed request with nothing else in it: rate, create or revoke a runner token. */
const signedInput = z.strictObject({ timestamp: z.number().int().positive(), signature });

export function selfServeRoutes(
  app: Hono,
  options: {
    db: Database;
    chain: ServiceChain;
    limits?: Partial<SelfServeLimits>;
    /** The Arena Gateway's public URL, for the runner command the owner copies. */
    gatewayUrl?: string;
    /** Underwriting policy's cover caps by binding, shown with a remote agent's registration. */
    coverCaps?: Readonly<Record<BindingLevel, number>>;
    /** Whether Agent URL mode can be used here (AGENT_URL_SECRET_KEY is set). */
    agentUrls?: boolean;
    /**
     * The owner session's wallet (sessions.ts): runner tokens and ratings of an owned agent can be
     * asked for with it instead of a fresh signature, so the agent page needs one sign-in. The
     * registry is still asked who owns the agent, each time.
     */
    wallet?: (c: Context) => Promise<string>;
    /** Reads the registered vault's trading, gas and cover from the chain (agent-status.ts). */
    status?: AgentStatusReader;
  },
) {
  const { db, chain } = options;
  const d = chain.deployment;
  const limits = { ...DEFAULT_SELF_SERVE_LIMITS, ...options.limits };
  const now = () => (limits.now ?? Date.now)();
  const requests = new RateLimiter({ ...limits.requests, now });
  const rowId = (agentId: string) => `${d.chainId}:${agentId}`;

  /** The signer of `request`, if the signature is valid and recent. */
  async function signer(request: SelfServeRequest, sig: string): Promise<string> {
    const age = Math.floor(now() / 1000) - request.timestamp;
    if (age > SELF_SERVE_MAX_AGE_SECONDS || age < -60)
      throw new Refused(400, "the signed request has expired; sign it again");
    const recovered = await recoverMessageAddress({
      message: selfServeMessage(request),
      signature: sig as Hex,
    }).catch(() => undefined);
    if (!recovered) throw new Refused(400, "the signature is not valid");
    return recovered.toLowerCase();
  }

  /**
   * Whether the vault was created with exactly this mandate's enforced parameters. A matching
   * mandate hash isn't enough: the factory takes the hash and the parameters separately, so a
   * vault can carry the hash of one mandate while enforcing another (mode, limits, allowlists).
   * The creation call is the complete record of what the vault enforces, since its rules can't
   * change afterwards, so it is decoded and compared field by field.
   */
  async function createdWith(vault: Hex, mandate: EvmMandateType): Promise<string | undefined> {
    const [log] = await chain.read.getLogs({
      address: d.factory,
      event: getAbiItem({ abi: mandateVaultFactoryAbi, name: "VaultCreated" }),
      args: { vault },
      fromBlock: BigInt(d.deployedAtBlock),
      toBlock: "latest",
      strict: true,
    });
    if (!log) return "the vault's creation wasn't found";
    const tx = await chain.read.getTransaction({ hash: log.transactionHash });
    if (tx.to?.toLowerCase() !== d.factory.toLowerCase())
      return "create the vault by calling the factory directly, so its parameters can be checked";
    let call;
    try {
      call = decodeFunctionData({ abi: mandateVaultFactoryAbi, data: tx.input });
    } catch {
      return "the vault's creation call couldn't be read";
    }
    if (call.functionName !== "createVault") return "the vault's creation call couldn't be read";
    const norm = (v: unknown): unknown =>
      typeof v === "string"
        ? v.toLowerCase()
        : typeof v === "bigint"
          ? v.toString()
          : Array.isArray(v)
            ? v.map(norm)
            : v && typeof v === "object"
              ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]))
              : v;
    const expected = toEvmMandateParams(mandate);
    const actual = call.args[0] as Record<string, unknown>;
    const mismatched = (Object.keys(expected) as (keyof typeof expected)[]).filter(
      (k) => JSON.stringify(norm(expected[k])) !== JSON.stringify(norm(actual[k])),
    );
    return mismatched.length
      ? `the vault enforces different rules from this mandate (${mismatched.join(", ")})`
      : undefined;
  }

  /**
   * A Mandate Vault, for this agent, guarded by the signer, enforcing exactly this mandate: its
   * on-chain mandate hash, and the parameters its creation call passed (`createdWith`).
   */
  async function checkVault(
    vault: Hex,
    agentId: string,
    who: string,
    mandate: EvmMandateType,
    hash: string,
  ) {
    const [isVault, vaultAgentId, guardian, onchainHash] = await Promise.all([
      chain.read.readContract({
        address: d.factory,
        abi: mandateVaultFactoryAbi,
        functionName: "isVault",
        args: [vault],
      }),
      chain.read
        .readContract({ address: vault, abi: mandateVaultAbi, functionName: "agentId" })
        .catch(() => undefined),
      chain.read
        .readContract({ address: vault, abi: mandateVaultAbi, functionName: "guardian" })
        .catch(() => undefined),
      chain.read
        .readContract({ address: vault, abi: mandateVaultAbi, functionName: "mandateHash" })
        .catch(() => undefined),
    ]);
    if (!isVault) throw new Refused(400, "that address is not a Bonded vault");
    if (vaultAgentId?.toString() !== agentId)
      throw new Refused(400, "the vault belongs to another agent");
    if (guardian?.toLowerCase() !== who)
      throw new Refused(403, "only the vault's guardian can register it");
    if (onchainHash?.toLowerCase() !== hash.toLowerCase())
      throw new Refused(400, "the mandate doesn't match the vault's on-chain mandate");
    const mismatch = await createdWith(vault, mandate);
    if (mismatch) throw new Refused(400, mismatch);
  }

  /**
   * A MandateModule on a smart account (ERC-7579), deployed by the module factory, for this agent,
   * guarded by the signer. The factory only creates a module whose mandate hash is the commitment
   * to the rules it enforces, so matching the commitment proves the module enforces this mandate.
   */
  async function checkModule(module: Hex, agentId: string, who: string, mandate: EvmMandateType) {
    if (!d.moduleFactory)
      throw new Refused(400, "smart-account modules aren't deployed on this chain yet");
    const [isModule, moduleAgentId, guardian, onchainHash] = await Promise.all([
      chain.read.readContract({
        address: d.moduleFactory,
        abi: mandateModuleFactoryAbi,
        functionName: "isModule",
        args: [module],
      }),
      chain.read
        .readContract({ address: module, abi: mandateModuleAbi, functionName: "agentId" })
        .catch(() => undefined),
      chain.read
        .readContract({ address: module, abi: mandateModuleAbi, functionName: "guardian" })
        .catch(() => undefined),
      chain.read
        .readContract({ address: module, abi: mandateModuleAbi, functionName: "mandateHash" })
        .catch(() => undefined),
    ]);
    if (!isModule) throw new Refused(400, "that address is not a Bonded mandate module");
    if (moduleAgentId?.toString() !== agentId)
      throw new Refused(400, "the module belongs to another agent");
    if (guardian?.toLowerCase() !== who)
      throw new Refused(403, "only the module's guardian can register it");
    const commitment = mandateCommitment(toEvmMandateParams(mandate));
    if (onchainHash?.toLowerCase() !== commitment.toLowerCase())
      throw new Refused(400, "the mandate doesn't match the rules the module enforces");
  }

  const ownerOf = async (agentId: string) =>
    (
      await chain.read.readContract({
        address: d.registry,
        abi: bondedRegistryAbi,
        functionName: "agentOwner",
        args: [BigInt(agentId)],
      })
    ).toLowerCase();

  const limit = (c: Context) => {
    if (!requests.allow(clientAddress(c.req.raw.headers)))
      throw new Refused(429, "too many requests; try again in a few minutes");
  };

  /** Whether an agent is registered for self-serve ratings, and when it can be rated next. */
  app.get(
    "/self/agents/:id",
    handle(async (c) => {
      const agentId = uint.parse(c.req.param("id"));
      const record = await db.agentRecord(rowId(agentId));
      if (!record?.enabled) return c.json({ registered: false });
      const config = record.config as {
        kind: string;
        sentinel?: boolean;
        codeHash?: string;
        mode?: string;
        connection?: "runner" | "url";
        tee?: { url: string; composeHash: string };
      };
      const connection = await db.connectionOf(rowId(agentId), config);
      const current =
        config.kind === REMOTE_KIND
          ? await db.currentConnection(rowId(agentId), connection)
          : undefined;
      const fromPreview =
        config.kind === REMOTE_KIND ? await db.previewUpgradedTo(rowId(agentId)) : undefined;
      const last = record.last_rating_at?.getTime();
      const vault = (record.config as { vault?: string }).vault;
      // Public chain data about the registered vault (cached briefly): never fails the page.
      const onchain =
        vault && options.status ? await options.status.read(vault).catch(() => null) : null;
      return c.json({
        registered: true,
        // The vault's (or module's) trades through execute, the agent key's gas and the cover.
        vaultActivity: onchain?.vaultActivity ?? null,
        coverWithoutVaultTrades: onchain?.coverWithoutVaultTrades ?? false,
        agentGas: onchain?.agentGas ?? null,
        cover: onchain?.cover ?? null,
        frozen: onchain?.frozen ?? null,
        source: record.source,
        kind: config.kind,
        sentinel: config.sentinel === true,
        // What protects the funds: a vault, or a module on the agent's smart account.
        protection: (record.config as { protection?: string }).protection ?? "vault",
        vault: (record.config as { vault?: string }).vault ?? null,
        // The owner's own agent: what was declared, so the page can show it.
        ...(config.kind === REMOTE_KIND
          ? {
              // Declared, or null: then each rating records what the runner or URL reports.
              codeHash: config.codeHash ?? null,
              codeSource: config.codeHash ? "declared" : "auto",
              reportedCode: current?.code ?? null,
              mode: config.mode,
              connection,
              // Ready to be reached: runner connected, or Agent URL verified (never the URL here).
              connectionReady: current?.ready ?? false,
              tee: config.tee ?? null,
              // Made official from a preview: whether, not which (the owner's session lists theirs).
              fromPreview: Boolean(fromPreview),
              // Underwriting policy, not score: the most cover it can hold, by binding.
              coverCaps: options.coverCaps ?? UNDERWRITING_COVER_CAP_USD,
              // The most a rating will be, before the owner asks for one.
              expectedRating: expectedRating(
                (config as { repeats?: number }).repeats ?? limits.remote.repeats,
                limits.remote,
              ),
              // After a stop the agent caused: superseded score and the cooldown.
              standing: await db.agentStanding(rowId(agentId)),
            }
          : {}),
        owner: record.owner,
        lastRatingAt: last ? new Date(last).toISOString() : null,
        nextRatingAt:
          record.source === "user" && last
            ? new Date(
                last + (config.kind === REMOTE_KIND ? limits.remote.perAgentMs : limits.perAgentMs),
              ).toISOString()
            : null,
      });
    }),
  );

  /**
   * Register an agent for self-serve ratings. The owner signs which vault and which built-in
   * design, or for their own agent its declared code hash, mode and TEE; the mandate must hash to
   * the vault's on-chain mandate hash, so the rating is about exactly the rules that vault enforces.
   */
  app.post(
    "/self/agents",
    handle(async (c) => {
      limit(c);
      const input = registerInput.parse(await c.req.json());
      if (input.kind === REMOTE_KIND && input.tee && input.mode === "tools")
        throw new Refused(
          400,
          "a TEE-bound agent must be rated in chain mode: in tool mode its tool calls come from the runner, outside the TEE, so the TEE would bind nothing",
        );
      if (
        input.kind === REMOTE_KIND &&
        input.tee &&
        (!input.codeHash || input.connection === "url")
      )
        throw new Refused(
          400,
          "A TEE-bound agent needs a declared code hash (the one its TEE reports) and the runner, which forwards its evidence.",
        );
      if (input.kind === REMOTE_KIND && input.connection === "url" && !options.agentUrls)
        throw new Refused(409, SIGNING_KEY_MISSING);
      const hash = mandateHash(input.mandate);
      const module = input.protection === "module";
      const base = {
        action: "register" as const,
        chainId: d.chainId,
        agentId: input.agentId,
        vault: input.vault,
        mandateHash: hash,
        ...(module ? { protection: "module" as const } : {}),
        timestamp: input.timestamp,
      };
      const who = await signer(
        input.kind === REMOTE_KIND
          ? {
              ...base,
              kind: REMOTE_KIND,
              remote: {
                ...(input.codeHash ? { codeHash: input.codeHash } : {}),
                mode: input.mode,
                ...(input.connection === "url" ? { connection: "url" as const } : {}),
                ...(input.tee ? { tee: input.tee } : {}),
              },
            }
          : { ...base, kind: input.kind, ...(input.sentinel ? { sentinel: true } : {}) },
        input.signature,
      );
      if (input.mandate.chain.chainId !== d.chainId || input.mandate.agentId !== input.agentId)
        throw new Refused(400, "the mandate is for another chain or agent");
      if ((await ownerOf(input.agentId)) !== who)
        throw new Refused(403, "only the agent's owner can register it");
      const vault = input.vault as Hex;
      if (module) await checkModule(vault, input.agentId, who, input.mandate);
      else await checkVault(vault, input.agentId, who, input.mandate, hash);
      const config = agentConfig.parse(
        input.kind === REMOTE_KIND
          ? {
              kind: REMOTE_KIND,
              mandate: input.mandate,
              ...(input.codeHash ? { codeHash: input.codeHash } : {}),
              mode: input.mode,
              ...(input.connection === "url" ? { connection: "url" } : {}),
              ...(input.tee ? { tee: input.tee } : {}),
              repeats: limits.remote.repeats,
              ...(module ? { protection: "module" } : {}),
              vault: input.vault,
            }
          : {
              kind: input.kind,
              mandate: input.mandate,
              codeHash: selfServeCodeHash(input.kind),
              repeats: limits.repeats,
              ...(input.sentinel ? { sentinel: true } : {}),
              ...(module ? { protection: "module" } : {}),
              vault: input.vault,
            },
      );
      const previous = await db.agentRecord(rowId(input.agentId));
      const stored = await db.upsertUserAgent(d.chainId, input.agentId, who, config);
      if (!stored) throw new Refused(409, "this agent is managed by Bonded's operator");
      // A new registration (another mode, another owner, other code) starts with no runner
      // token: the gateway drops a connected runner at its next heartbeat, and the owner makes
      // a new token. No token outlives the registration it was made for.
      const before = previous?.config as { kind?: string } | undefined;
      if (before?.kind === REMOTE_KIND) {
        await db.revokeAllRunnerTokens(rowId(input.agentId));
        await db.revokeAgentUrls(rowId(input.agentId));
      }
      // "Make it official": link the preview it came from (the signer's own only).
      if (input.kind === REMOTE_KIND && input.previewId)
        await db.linkPreviewUpgrade(input.previewId, who, rowId(input.agentId));
      return c.json(
        {
          registered: true,
          agentId: input.agentId,
          kind: input.kind,
          sentinel: input.kind !== REMOTE_KIND && input.sentinel === true,
          ...(input.kind === REMOTE_KIND
            ? {
                mode: input.mode,
                connection: input.connection ?? "runner",
                codeSource: input.codeHash ? "declared" : "auto",
                tee: Boolean(input.tee),
              }
            : {}),
        },
        201,
      );
    }),
  );

  /** Queue a rating of a self-serve agent, signed by its owner. */
  app.post(
    "/self/agents/:id/rate",
    handle(async (c) => {
      limit(c);
      const agentId = uint.parse(c.req.param("id"));
      let who: string;
      if (withSession(c)) who = await options.wallet!(c);
      else {
        const input = signedInput.parse(await c.req.json());
        who = await signer(
          { action: "rate", chainId: d.chainId, agentId, timestamp: input.timestamp },
          input.signature,
        );
      }
      const record = await db.agentRecord(rowId(agentId));
      if (!record?.enabled || record.source !== "user")
        throw new Refused(404, "register the agent for ratings first");
      // The registry is the authority on ownership: an agent transferred since it was registered
      // can only be rated by its new owner.
      if ((await ownerOf(agentId)) !== who)
        throw new Refused(403, "only the agent's owner can ask for a rating");
      const remote = (record.config as { kind?: string }).kind === REMOTE_KIND;
      // Skin in the game, and the registered owner's own config: read from the chain now.
      if (remote) {
        const problem = await remoteRatingProblem(chain, agentId, record.owner);
        if (problem) throw new Refused(409, problem);
      }
      // The owner's own agent is rated through its runner (or its Agent URL), so it must be
      // reachable now, and a passing connection check of exactly this connection must exist.
      let code: RatedCode | undefined;
      if (remote) {
        const config = record.config as {
          mode: string;
          connection?: "runner" | "url";
          codeHash?: string;
        };
        const connection = await db.connectionOf(rowId(agentId), config);
        const current = await db.currentConnection(rowId(agentId), connection);
        if (!current.ready)
          throw new Refused(
            409,
            connection === "url"
              ? "The agent's URL isn't verified yet. Verify it, then rate."
              : "no runner is connected for this agent; start it, then rate",
          );
        code = config.codeHash ? { hash: config.codeHash, source: "declared" } : current.code;
        if (!code)
          throw new Refused(
            409,
            connection === "url"
              ? "The Agent URL reported no version, so there is no code hash. Report a version when you answer the verify challenge, or register a code hash."
              : "The runner reported no code hash. Update @bondedhq/runner, or register a code hash.",
          );
        const passing = await db.passingCheck(rowId(agentId), {
          mode: config.mode,
          connection,
          credentialId: current.credentialId,
          codeHash: code.hash,
        });
        if (!passing) throw new Refused(409, NEEDS_CHECK);
      }
      // One rating per agent per interval (an hour by default): an operator-run agent's comes
      // from its policy.
      const perAgentMs = remote ? limits.remote.perAgentMs : limits.perAgentMs;
      const queued = await db.enqueueUserRating(rowId(agentId), d.chainId, {
        nowMs: now(),
        perAgentMs,
        dailyCap: limits.dailyRatings,
        ...(remote ? { remote: remoteQuota(limits.remote, now()) } : {}),
        ...(code ? { code } : {}),
      });
      if ("refused" in queued)
        throw new Refused(
          429,
          queued.refused === "hourly"
            ? `one rating ${perInterval(perAgentMs)} per agent; next at ${queued.nextAt.toISOString()}`
            : queued.refused === "daily"
              ? "today's self-serve ratings are used up; try again tomorrow"
              : remoteRefusalMessage(queued, limits.remote),
        );
      return c.json({ runId: queued.runId }, 202);
    }),
  );

  /**
   * The owner's own agent, ready for a runner token: registered as remote, and asked for by the
   * agent's owner (the registry's, not whoever registered it) with a fresh signature.
   */
  /** With a session: its wallet. Otherwise the signer of a fresh signed request. */
  const withSession = (c: Context) =>
    Boolean(options.wallet) && (c.req.header("Authorization") ?? "").startsWith("Bearer ");
  async function remoteOwner(c: Context, action: "runner-token" | "revoke-runner-token") {
    limit(c);
    const agentId = uint.parse(c.req.param("id"));
    let who: string;
    let timestamp: number;
    if (withSession(c)) {
      who = await options.wallet!(c);
      // Ordered after every request on record, signed or not.
      timestamp = Math.max(
        Math.floor(now() / 1000),
        (await db.lastRunnerRequestAt(rowId(agentId))) + 1,
      );
    } else {
      const input = signedInput.parse(await c.req.json());
      who = await signer(
        { action, chainId: d.chainId, agentId, timestamp: input.timestamp },
        input.signature,
      );
      timestamp = input.timestamp;
    }
    const record = await db.agentRecord(rowId(agentId));
    if (!record?.enabled) throw new Refused(404, "register the agent for ratings first");
    if ((record.config as { kind?: string }).kind !== REMOTE_KIND)
      throw new Refused(409, "runner tokens are for agents registered as your own agent");
    if ((record.config as { connection?: string }).connection === "url")
      throw new Refused(409, "This agent is reached by its Agent URL, so it has no runner.");
    if ((await ownerOf(agentId)) !== who)
      throw new Refused(403, "only the agent's owner can manage its runner token");
    return { agentId, who, timestamp };
  }

  /**
   * Create a runner token, shown once. It replaces the agent's current token, and a runner
   * connected with the old one is dropped at its next heartbeat.
   */
  app.post(
    "/self/agents/:id/runner-token",
    handle(async (c) => {
      const { agentId, who, timestamp } = await remoteOwner(c, "runner-token");
      const token = newRunnerToken();
      const made = await db.createRunnerToken(rowId(agentId), {
        hash: runnerTokenHash(token),
        createdBy: who,
        signedAt: timestamp,
      });
      if ("refused" in made)
        throw new Refused(409, "that signed request was already used; sign again");
      c.header("Cache-Control", "no-store");
      return c.json(
        {
          token,
          tokenId: made.id,
          createdAt: made.createdAt.toISOString(),
          gatewayUrl: options.gatewayUrl ?? null,
        },
        201,
      );
    }),
  );

  /** Revoke the agent's runner token; a connected runner is dropped. */
  app.delete(
    "/self/agents/:id/runner-token",
    handle(async (c) => {
      const { agentId, timestamp } = await remoteOwner(c, "revoke-runner-token");
      const done = await db.revokeRunnerToken(rowId(agentId), timestamp);
      if ("refused" in done)
        throw new Refused(409, "that signed request was already used; sign again");
      return c.json({ revoked: done.revoked });
    }),
  );

  /**
   * The agent's runner token (whether there is one, never the token) and its runner: connected or
   * not, its version, mode and TEE URL, and the last rating the live loop had to skip.
   */
  app.get(
    "/self/agents/:id/runner",
    handle(async (c) => {
      const agentId = uint.parse(c.req.param("id"));
      const record = await db.agentRecord(rowId(agentId));
      if (!record?.enabled || (record.config as { kind?: string }).kind !== REMOTE_KIND)
        return c.json({ error: "this agent isn't registered as your own agent" }, 404);
      const status = await db.runnerStatus(rowId(agentId));
      const mode = (record.config as { mode: AgentMode }).mode;
      // How it is reached (runner or Agent URL, never the secret), its code and its last check.
      const connection = await db.connectionOf(rowId(agentId), record.config);
      const [current, url, checks] = await Promise.all([
        db.currentConnection(rowId(agentId), connection),
        db.agentUrl(rowId(agentId)),
        db.checksOf(rowId(agentId), 1),
      ]);
      const declared = (record.config as { codeHash?: string }).codeHash;
      return c.json({
        ...status,
        connection,
        // Public: that a URL is set and answered, never the URL itself (the owner's session
        // shows it at GET …/agent-url); the last check's outcome, never its id or its output.
        agentUrl: url
          ? {
              configured: true,
              verifiedAt: url.verifiedAt?.toISOString() ?? null,
              version: url.version,
            }
          : null,
        lastCheck: checks[0] ? publicCheckSummary(checks[0]) : null,
        codeHash: codeInfo(
          declared ? { hash: declared, source: "declared" } : current.code,
          url?.version,
        ),
        // Every rating of the agent, failed ones included, so a stopped attempt is visible.
        attempts: (await db.ratingAttempts(rowId(agentId))).items,
        // Why a runner that is there doesn't count, e.g. it was started in the other mode.
        problem: status.runner?.mode
          ? (helloProblem({ mode }, { mode: status.runner.mode }) ?? null)
          : null,
        gatewayUrl: options.gatewayUrl ?? null,
      });
    }),
  );

  /** Every rating of an agent, newest first, a numbered page at a time: failed ones included. */
  app.get(
    "/self/agents/:id/ratings",
    handle(async (c) => {
      const agentId = uint.parse(c.req.param("id"));
      const q = z
        .strictObject({
          page: z.coerce.number().int().min(1).max(1_000_000).optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
        })
        .parse(c.req.query());
      return c.json(await db.ratingAttempts(rowId(agentId), q));
    }),
  );
}

/** "an hour", "every 10 minutes": how often an agent may be rated, in words. */
export function perInterval(ms: number): string {
  if (ms === 3_600_000) return "an hour";
  const minutes = Math.round(ms / 60_000);
  return minutes >= 120 && minutes % 60 === 0
    ? `every ${minutes / 60} hours`
    : `every ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/** The published library, read once: the base of every remote rating's size. */
let published: { attacks: number; classes: number } | undefined;
/** The published library's size: its attacks and attack classes. */
export function publishedLibrary(): { attacks: number; classes: number } {
  published ??= (() => {
    const library = loadAttackLibrary();
    return { attacks: library.length, classes: new Set(library.map((a) => a.class)).size };
  })();
  return published;
}
/**
 * The most a remote rating will be, and its time budget, before it is asked for
 * (remote-policy.ts). Its held-out set is at most `heldOutPerClass` variants for each attack class
 * the library has seeds for; a variant that can't be made is left out, so a rating can be smaller.
 * The rating's progress counts its real size once the set is made.
 */
export function expectedRating(
  repeats: number,
  policy: RemoteRatingPolicy = DEFAULT_REMOTE_POLICY,
) {
  const published = publishedLibrary();
  const plan = remoteRatingPlan(policy, {
    publishedAttacks: published.attacks,
    heldOut: published.classes * policy.heldOutPerClass,
    repeats,
  });
  return { maxEpisodes: plan.episodes, budgetSeconds: Math.round(plan.budgetMs / 1000) };
}
