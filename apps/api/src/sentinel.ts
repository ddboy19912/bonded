import type { Context, Hono } from "hono";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { keccak256, recoverMessageAddress, stringToBytes, type Hex } from "viem";
import type { Database } from "@bonded/db";
import type { RatingSentinel } from "@bonded/arena";
import {
  GuardedAgent,
  CascadeSentinel,
  DecisionModelSentinel,
  LlmDecisionModel,
  LayaSentinel,
  SentinelGuard,
  SentinelAssessmentError,
  mergeUsage,
  type ModelUsage,
  createHardenedAgent,
  createPartialAgent,
  createVulnerableAgent,
  type SentinelModel,
} from "@bonded/demo-agents";
import {
  SENTINEL_CHECK_MAX_AGE_SECONDS,
  SENTINEL_INPUT_CHARS,
  SENTINEL_SERVING,
  OpenAICompatibleClient,
  llmConfigForModel,
  canonicalHash,
  sentinelCascadePolicySchema,
  sentinelCascadePolicyHash,
  verifySentinelCascadeEvidence,
  mandateModuleFactoryAbi,
  mandateVaultAbi,
  mandateVaultFactoryAbi,
  sentinelCheckDigest,
  sentinelCheckMessage,
} from "@bondedhq/shared";
import type { ArenaAgent } from "@bondedhq/shared";
import type { ServiceChain } from "@bonded/keeper";
import { RateLimiter, clientAddress } from "./rate-limit.js";

/**
 * Sentinel in the product (docs/SENTINEL.md): the guard a rating runs with when an operator
 * opts in, and the check agents call before each trade. Its answers are advisory: they can
 * stop an action the agent was about to take, but payouts are decided by the vault alone.
 */
export interface SentinelService {
  model: SentinelModel;
  /** What a report records about this guard. */
  info: RatingSentinel;
  /** Whether the service answers its health probe (optional; without it, assumed up). */
  health?: () => Promise<boolean>;
  /**
   * Waits up to `timeoutMs` for the health probe to pass, probing at least once: true once it
   * does. On Railway, Sentinel sleeps when idle and the first request wakes it in about 15 s
   * (docs/SENTINEL.md). Optional; without it, the service is taken to be awake.
   */
  wake?: (timeoutMs: number) => Promise<boolean>;
}

/** How long a rating waits for a sleeping Sentinel; it usually wakes in about 15 s. */
export const SENTINEL_WAKE_MS = 120_000;
/** How often a rating pings Sentinel; Railway puts it to sleep after 5 minutes without traffic. */
export const SENTINEL_PING_MS = 60_000;

/**
 * Wakes Sentinel for a rating and keeps it awake until the returned function is called. A guard
 * that gets no answer blocks the trade (it fails closed), so a rating must never meet a sleeping
 * Sentinel, and a rating can go longer than Railway's idle time between guarded actions.
 */
export async function keepSentinelAwake(
  sentinel: SentinelService,
  { wakeMs = SENTINEL_WAKE_MS, pingMs = SENTINEL_PING_MS } = {},
): Promise<() => void> {
  const wake = sentinel.wake;
  if (!wake) return () => {};
  if (!(await wake(wakeMs)))
    throw new Error(`Sentinel didn't answer within ${wakeMs / 1000} s; the rating will be retried`);
  const timer = setInterval(() => void wake(0).catch(() => false), pingMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * The production Sentinel from the environment: `SENTINEL_URL` (Railway's private network,
 * `http://sentinel.railway.internal:8000`) and `LAYA_API_KEY`, the bearer key the Sentinel
 * service checks. Undefined when it isn't configured, so the features that need it refuse
 * clearly instead of running without it.
 */
export function sentinelFromEnv(env: NodeJS.ProcessEnv = process.env): SentinelService | undefined {
  const mode = z.enum(["laya", "cascade"]).parse(env.SENTINEL_MODE ?? "laya");
  const url = env.SENTINEL_URL?.trim().replace(/\/+$/, "");
  if (!url) {
    if (mode === "cascade") throw new Error("cascade mode requires SENTINEL_URL");
    return undefined;
  }
  const repo = env.SENTINEL_MODEL_REPO?.trim();
  const revision = env.SENTINEL_MODEL_REVISION?.trim();
  const probe = async () => {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(3_000),
    }).catch(() => undefined);
    if (!response?.ok) return false;
    return mode !== "cascade" || Boolean(revision && (await response.text()).includes(revision));
  };
  let healthCache: { expires: number; result: Promise<boolean> } | undefined;
  const health = () => {
    if (!healthCache || healthCache.expires <= Date.now()) {
      healthCache = { expires: Date.now() + 30_000, result: probe().catch(() => false) };
    }
    return healthCache.result;
  };
  const wake = async (timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await probe().catch(() => false)) {
        // A "down" answer cached while it slept would refuse the cascade's next checks.
        healthCache = undefined;
        return true;
      }
      if (Date.now() + 2_000 > deadline) return false;
      await delay(2_000);
    }
  };
  const primary = new LayaSentinel({
    url,
    apiKey: env.LAYA_API_KEY,
    questions: SENTINEL_SERVING.questions,
  });
  const info: RatingSentinel = {
    model: "laya/typed-decisions",
    // The service's own pin (Railway references it), so a report names the checkpoint.
    ...(repo ? { repo } : {}),
    ...(revision ? { revision } : {}),
    questions: SENTINEL_SERVING.questions,
    blockThreshold: SENTINEL_SERVING.blockThreshold,
  };
  let model: SentinelModel = primary;
  if (mode === "cascade") {
    if (!env.SENTINEL_CASCADE_POLICY_FILE || !env.SENTINEL_CASCADE_EVALUATION_FILE)
      throw new Error("cascade mode requires frozen policy and passing evaluation files");
    const policy = sentinelCascadePolicySchema.parse(
      JSON.parse(readFileSync(env.SENTINEL_CASCADE_POLICY_FILE, "utf8")),
    );
    verifySentinelCascadeEvidence(
      policy,
      JSON.parse(readFileSync(env.SENTINEL_CASCADE_EVALUATION_FILE, "utf8")),
    );
    const config = llmConfigForModel(policy.fallback.model, env);
    if (
      policy.primary.repo !== repo ||
      policy.primary.revision !== revision ||
      policy.fallback.baseUrl.replace(/\/+$/, "") !== config.baseUrl
    )
      throw new Error(
        "cascade evaluation does not match the configured checkpoint or LLM endpoint",
      );
    info.fallback = {
      model: policy.fallback.model,
      questions: "v1",
      unsureBand: policy.unsureBand,
      minRiskConfidence: policy.minRiskConfidence,
    };
    info.pipelineHash = sentinelCascadePolicyHash(policy);
    const verifiedPrimary: SentinelModel = {
      name: primary.name,
      get usage() {
        return primary.usage;
      },
      async assess(fields, options) {
        const started = performance.now();
        if (!(await health()))
          throw new Error("Sentinel health does not confirm the evaluated checkpoint");
        options?.signal?.throwIfAborted();
        const answer = await primary.assess(fields, options);
        return { ...answer, latencyMs: performance.now() - started };
      },
    };
    model = new CascadeSentinel(
      verifiedPrimary,
      new DecisionModelSentinel(
        new LlmDecisionModel({
          model: policy.fallback.model,
          // A live check has its own deadline: keep retries short.
          client: new OpenAICompatibleClient(config, { maxRetries: 2 }),
        }),
      ),
      { unsureBand: policy.unsureBand, minRiskConfidence: policy.minRiskConfidence },
    );
  }
  return {
    model,
    info,
    health,
    wake,
  };
}

/**
 * The code hash a rating with Sentinel in front attests: the agent's own code hash combined
 * with Sentinel, so a score earned with it never shares a hash with the agent alone.
 */
export function sentinelCodeHash(codeHash: Hex, info?: RatingSentinel): Hex {
  const suffix = info?.fallback
    ? `+sentinel:${info.pipelineHash ?? canonicalHash(JSON.stringify(info))}`
    : "+sentinel";
  return keccak256(stringToBytes(`${codeHash.toLowerCase()}${suffix}`));
}

/** One of Bonded's built-in scripted designs, with Sentinel in front of it when given. */
export function ratedAgent(
  kind: "hardened" | "partial" | "vulnerable",
  sentinel?: SentinelService,
): ArenaAgent {
  const guards = sentinel ? [new SentinelGuard(sentinel.model, sentinel.info.blockThreshold)] : [];
  // The hardened design has its own guard chain; Sentinel joins it after the mandate check.
  if (kind === "hardened") return createHardenedAgent("scripted", {}, guards);
  const agent =
    kind === "partial" ? createPartialAgent("scripted") : createVulnerableAgent("scripted");
  return guards.length ? new GuardedAgent(agent, guards, "sentinel") : agent;
}

const uint = z
  .string()
  .regex(/^\d{1,78}$/)
  .transform((v) => BigInt(v).toString());
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
/**
 * The largest check body the API takes. The schema below allows a 4,000-character mandate, 20
 * arguments of 2,000 and 20 reads of 4,000 characters: about 125,000 characters, plus JSON
 * escaping, field names and the signature. 256 KB leaves room for escaped characters.
 */
export const SENTINEL_CHECK_MAX_BYTES = 256 * 1024;

const checkInput = z.strictObject({
  agentId: uint,
  vault: address,
  timestamp: z.number().int().positive(),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  mandate: z.string().min(1).max(4_000),
  proposedAction: z.strictObject({
    tool: z.string().min(1).max(64),
    args: z
      .record(z.string().max(64), z.string().max(2_000))
      .refine((a) => Object.keys(a).length <= 20, "at most 20 arguments"),
  }),
  untrustedInputs: z
    .array(
      z.strictObject({
        tool: z.string().min(1).max(64),
        output: z.string().max(SENTINEL_INPUT_CHARS),
      }),
    )
    .max(20),
});

export interface SentinelLimits {
  /** Checks per client and in total, per window. */
  requests: ConstructorParameters<typeof RateLimiter>[0];
  /** Checks per agent per window (the agent is the client that matters). */
  perAgent: number;
  /** Checks running at once; Sentinel on CPU takes about 2.5 s each. */
  concurrent: number;
  /** Longest a check may take before the API gives up, in milliseconds. */
  timeoutMs: number;
  /**
   * Longest a check waits for a sleeping Sentinel to wake, in milliseconds. With the answer it
   * stays inside the SDK's 15 s; a longer wake gets a 503 the agent can retry.
   */
  wakeMs: number;
  now?: () => number;
}

export const DEFAULT_SENTINEL_LIMITS: SentinelLimits = {
  requests: { perClient: 60, total: 600, windowMs: 60_000 },
  perAgent: 30,
  concurrent: 4,
  timeoutMs: 20_000,
  wakeMs: 10_000,
};

class Refused extends Error {
  constructor(
    readonly status: 400 | 403 | 429 | 503,
    message: string,
  ) {
    super(message);
  }
}

/**
 * GET /sentinel: whether Sentinel is running here, its model and threshold, and checks in the
 * last day. GET /sentinel/agents/:id: one agent's checks in the last 7 days.
 * POST /sentinel/check: an agent asks about one proposed action, signed with its own key.
 */
export function sentinelRoutes(
  app: Hono,
  options: {
    db: Database;
    chain: ServiceChain;
    sentinel?: SentinelService;
    limits?: Partial<SentinelLimits>;
  },
) {
  const { db, chain, sentinel } = options;
  const d = chain.deployment;
  const limits = { ...DEFAULT_SENTINEL_LIMITS, ...options.limits };
  const now = () => (limits.now ?? Date.now)();
  const pipelineHash =
    sentinel?.info.pipelineHash ?? canonicalHash(JSON.stringify(sentinel?.info ?? null));
  const requests = new RateLimiter({ ...limits.requests, now });
  const agents = new RateLimiter({
    perClient: limits.perAgent,
    total: Number.MAX_SAFE_INTEGER,
    windowMs: limits.requests.windowMs,
    now,
  });
  let running = 0;

  // Which agent a vault belongs to never changes (factory membership and agentId are set at
  // creation), so that is cached. The signing key is not: the guardian can rotate it at any
  // time (rotateAgent), so it is read on every check. A MandateModule (the mandate on a smart
  // account) counts like a vault: it comes from the deployment's MandateModuleFactory and has
  // the same agentId and agent.
  const owners = new Map<string, string | null>();
  async function vaultOwner(vault: Hex): Promise<string | null> {
    const key = vault.toLowerCase();
    if (owners.has(key)) return owners.get(key)!;
    const member =
      (await chain.read.readContract({
        address: d.factory,
        abi: mandateVaultFactoryAbi,
        functionName: "isVault",
        args: [vault],
      })) ||
      (d.moduleFactory !== undefined &&
        (await chain.read.readContract({
          address: d.moduleFactory,
          abi: mandateModuleFactoryAbi,
          functionName: "isModule",
          args: [vault],
        })));
    const owner = member
      ? (
          await chain.read.readContract({
            address: vault,
            abi: mandateVaultAbi,
            functionName: "agentId",
          })
        ).toString()
      : null;
    if (owners.size > 5_000) owners.clear();
    owners.set(key, owner);
    return owner;
  }
  async function agentKey(vault: Hex, agentId: string): Promise<string | undefined> {
    if ((await vaultOwner(vault)) !== agentId) return undefined;
    const signer = await chain.read.readContract({
      address: vault,
      abi: mandateVaultAbi,
      functionName: "agent",
    });
    return signer.toLowerCase();
  }

  // Whether Sentinel answers, not just whether it's configured: a probe of its health route,
  // reused for 30 seconds, and down for 2 minutes after a check failed to get an answer.
  let probe: { at: number; ok: boolean } | undefined;
  let failedAt = -Infinity;
  async function healthy(): Promise<boolean> {
    if (!sentinel) return false;
    if (now() - failedAt < 120_000) return false;
    if (!probe || now() - probe.at >= 30_000)
      probe = {
        at: now(),
        ok: sentinel.health ? await sentinel.health().catch(() => false) : true,
      };
    return probe.ok;
  }

  const handle = (fn: (c: Context) => Promise<Response>) => async (c: Context) => {
    try {
      return await fn(c);
    } catch (e) {
      if (e instanceof Refused) return c.json({ error: e.message }, e.status);
      throw e;
    }
  };

  app.get("/sentinel", async (c) => {
    const day = await db.sentinelCheckCounts(d.chainId, new Date(now() - 86_400_000));
    return c.json({
      configured: Boolean(sentinel),
      available: await healthy(),
      ...(sentinel ? sentinel.info : {}),
      last24h: { checks: day.checks, blocked: day.blocked },
      ...(sentinel
        ? {
            metrics24h: await db.sentinelMetrics(
              d.chainId,
              new Date(now() - 86_400_000),
              pipelineHash,
            ),
          }
        : {}),
    });
  });

  app.get("/sentinel/agents/:id", async (c) => {
    const agentId = uint.parse(c.req.param("id"));
    const week = await db.sentinelCheckCounts(d.chainId, new Date(now() - 7 * 86_400_000), agentId);
    return c.json({
      last7d: { checks: week.checks, blocked: week.blocked },
      lastCheckAt: week.lastAt ? week.lastAt.toISOString() : null,
    });
  });

  app.post(
    "/sentinel/check",
    handle(async (c) => {
      if (!sentinel) throw new Refused(503, "Sentinel isn't running on this API");
      if (!requests.allow(clientAddress(c.req.raw.headers)))
        throw new Refused(429, "too many checks; slow down");
      const input = checkInput.parse(await c.req.json());
      const age = Math.floor(now() / 1000) - input.timestamp;
      if (age > SENTINEL_CHECK_MAX_AGE_SECONDS || age < -60)
        throw new Refused(400, "the signed check has expired; sign it again");
      const body = {
        mandate: input.mandate,
        proposedAction: input.proposedAction,
        untrustedInputs: input.untrustedInputs,
      };
      const signer = await recoverMessageAddress({
        message: sentinelCheckMessage({
          chainId: d.chainId,
          agentId: input.agentId,
          vault: input.vault,
          digest: sentinelCheckDigest(body),
          timestamp: input.timestamp,
        }),
        signature: input.signature as Hex,
      }).catch(() => undefined);
      if (!signer) throw new Refused(400, "the signature is not valid");
      const expected = await agentKey(input.vault as Hex, input.agentId);
      if (!expected) throw new Refused(400, "that vault doesn't belong to this agent");
      if (signer.toLowerCase() !== expected)
        throw new Refused(403, "sign with the vault's agent key");
      if (!agents.allow(input.agentId)) throw new Refused(429, "too many checks for this agent");
      if (running >= limits.concurrent)
        throw new Refused(503, "Sentinel is busy; try again in a few seconds");
      // A check holds its slot while it waits, so a burst during a wake still keeps the limit.
      running++;
      // Sentinel sleeps when idle: the first check after a quiet spell wakes it.
      if (sentinel.wake && !(await sentinel.wake(limits.wakeMs).catch(() => false))) {
        running--;
        throw new Refused(503, "Sentinel is waking up; try again in a few seconds");
      }
      const started = performance.now();
      const usageParts: ModelUsage[] = [];
      let assessment: Awaited<ReturnType<SentinelModel["assess"]>>;
      try {
        assessment = await sentinel.model.assess(body, {
          signal: AbortSignal.timeout(limits.timeoutMs),
          onUsage: (usage) => usageParts.push(usage),
        });
      } catch (e) {
        // No answer from Sentinel: the status shows it down for a while.
        failedAt = now();
        const usage = mergeUsage(...usageParts);
        await db.recordSentinelCheck(d.chainId, input.agentId, {
          status: "error",
          manipulated: null,
          blocked: null,
          latencyMs: performance.now() - started,
          pipelineHash,
          model: sentinel.model.name,
          ...(e instanceof SentinelAssessmentError ? e.metrics : {}),
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          // Failed calls may have unreported charges; never claim their cost is complete.
        });
        if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError"))
          throw new Refused(503, "Sentinel took too long; try again");
        throw new Refused(503, "Sentinel didn't answer; try again");
      } finally {
        running--;
      }
      const blocked = assessment.manipulated >= sentinel.info.blockThreshold;
      await db.recordSentinelCheck(d.chainId, input.agentId, {
        manipulated: assessment.manipulated,
        blocked,
        latencyMs: assessment.latencyMs,
        pipelineHash,
        model: assessment.model,
        escalated: assessment.escalated ?? false,
        primaryLatencyMs: assessment.primaryLatencyMs ?? assessment.latencyMs,
        fallbackLatencyMs: assessment.fallbackLatencyMs,
        inputTokens: assessment.usage?.inputTokens,
        outputTokens: assessment.usage?.outputTokens,
        llmCostUsd: assessment.usage?.costUsd,
      });
      return c.json({
        blocked,
        manipulated: assessment.manipulated,
        injection: assessment.injection,
        blockThreshold: sentinel.info.blockThreshold,
        model: assessment.model,
        latencyMs: Math.round(assessment.latencyMs),
        escalated: assessment.escalated ?? false,
        primaryLatencyMs: Math.round(assessment.primaryLatencyMs ?? assessment.latencyMs),
        ...(assessment.fallbackLatencyMs === undefined
          ? {}
          : { fallbackLatencyMs: Math.round(assessment.fallbackLatencyMs) }),
        // Advisory: the agent decides whether to go ahead; the vault still enforces the mandate.
        advice: blocked
          ? "Don't take this action: it looks driven by what the agent read, not its mandate."
          : "No sign of manipulation.",
      });
    }),
  );
}
