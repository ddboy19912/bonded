import { randomBytes, randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  previewKey,
  type CheckConfig,
  type ConnectionCheckRecord,
  type ConnectionKind,
  type Database,
  type PreviewRecord,
  type PreviewToolNames,
  type PreviewWorld,
  type RatedCode,
} from "@bonded/db";
import {
  brokeragePreviewSize,
  HOSTED_BUDGET,
  HostedBudgetError,
  INSPECT_BUSY,
  inspectCodeAgent,
} from "@bonded/arena";
import {
  HOSTED_MODELS,
  HOSTED_PREVIEW_CONCURRENCY,
  HostedAgentSpec,
  REMOTE_KIND,
  SELF_SERVE_MAX_AGE_SECONDS,
  bondedRegistryAbi,
  byoaMessage,
  hostedCodeHash,
  problemCode,
  type AgentMode,
  type ByoaAction,
} from "@bondedhq/shared";
import type { ServiceChain } from "@bonded/keeper";
import { recoverMessageAddress, type Hex } from "viem";
import { Refused, handle } from "./refused.js";
import { RateLimiter, clientAddress } from "./rate-limit.js";
import { signedRequestKey, type SessionWallet } from "./sessions.js";
import { RUNNER_TOKEN_PREFIX, helloProblem, newRunnerToken, runnerTokenHash } from "./runners.js";
import { SIGNING_KEY_MISSING, type SecretBox } from "./secrets.js";
import {
  NEEDS_CHECK,
  checkSummary,
  codeInfo,
  urlCodeHash,
  type AgentUrlVerifier,
  type ConnectionCheckResult,
} from "./connections.js";
import {
  previewRatingPlan,
  previewRefusalMessage,
  type RemoteRatingPolicy,
} from "./remote-policy.js";
import { expectedRating, publishedLibrary } from "./self-serve.js";
import { PollStreams } from "./poll-stream.js";
import { outboundUrlProblem } from "./outbound.js";
import {
  notificationInput,
  notificationView,
  saveNotifications,
  type EmailSender,
} from "./notifications.js";

export { outboundUrlProblem, ownDomainsFrom } from "./outbound.js";

/**
 * Bring your own agent, round 2 (docs/BRING-YOUR-OWN-AGENT.md): previews, Agent URLs, connection
 * checks, cost estimates, live progress and notification settings. A preview's calls are made with
 * its wallet's session (sessions.ts); a registered agent's writes are signed by its owner's
 * wallet (`byoaMessage`, each signature used once) or made with the owner's session. Every route
 * is rate-limited; ownership is the preview's wallet, or the agent's owner in the registry now.
 */

/** A message as a full sentence: capitalised, ending with a stop. */
export const sentence = (text: string) => {
  const t = text.trim();
  const s = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
};

/** Shown with every preview and its report. */
export const PREVIEW_LABEL = "Preview: not on chain, not insurable";

export interface OwnerRouteOptions {
  db: Database;
  chain: ServiceChain;
  policy: RemoteRatingPolicy;
  wallet: SessionWallet;
  now: () => number;
  /** Writes per client address (and in all) per window. */
  writes: RateLimiter;
  /** Reads per client address per window. */
  reads: RateLimiter;
  secrets?: SecretBox;
  email?: EmailSender;
  /** Whether this service can sign calls to agents (AGENT_URL_SIGNING_KEY): Agent URL mode is off without. */
  agentUrls: boolean;
  verifyAgentUrl: AgentUrlVerifier;
  /** The gateway's own rules for an Agent URL (ports, hosts), checked when it is registered. */
  urlProblem?: (url: string) => string | undefined;
  ownDomains: readonly string[];
  gatewayUrl?: string;
  /** Agent URLs may be plain http on this machine (local demos and tests only). */
  allowLoopbackUrls?: boolean;
  streams: PollStreams;
  /** Connection checks one client address may ask for per hour (default 30). */
  checksPerClientHourly?: number;
}

/** An agent or a preview, as these routes act on it. */
interface Subject {
  key: string;
  kind: "preview" | "agent";
  /** The preview's id, or the on-chain agent id. */
  id: string;
  owner: string;
  mode: AgentMode;
  /** The world it is tested on: a registered agent is always rated on the vault. */
  world: PreviewWorld;
  /** Whose tool names its agent is offered: a broker's only in the brokerage world. */
  toolNames: PreviewToolNames;
  connection: ConnectionKind;
  declaredCode?: string;
  preview?: PreviewRecord;
}

const uuid = z.uuid();
const uint = z
  .string()
  .regex(/^\d{1,78}$/)
  .transform((v) => BigInt(v).toString());
const codeHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const previewInput = z.strictObject({
  mode: z.enum(["tools", "chain"]),
  /**
   * The world the agent is tested on (default vault). The brokerage world (a simulated brokerage
   * account; docs/BROKERAGE.md) has no chain, so it is tools mode only.
   */
  world: z.enum(["vault", "brokerage"]).optional(),
  /**
   * Whose tool names the brokerage world's tools are offered under (default bonded, the world's
   * own): alpaca offers Alpaca's Trading MCP names, for an agent built on that server.
   */
  toolNames: z.enum(["bonded", "alpaca"]).optional(),
  /** How Bonded reaches the agent (default runner). hosted: Bonded runs it (brokerage only). */
  connection: z.enum(["runner", "url", "hosted"]).optional(),
  /** Advanced: the owner's own code hash. Without it the runner's or URL's reported one is used. */
  codeHash: codeHash.optional(),
});
const urlInput = z.strictObject({ url: z.string().min(1).max(2048) });
const empty = z.strictObject({});
const signed = z.object({
  timestamp: z.number().int().positive(),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});
/** Connection checks one client address may ask for per hour, across wallets. */
const CHECKS_PER_CLIENT_HOURLY = 30;
/** At most this many Agent URL verifications per URL host per hour: each one calls out. */
const VERIFY_PER_HOST_HOURLY = 10;

export function ownerRoutes(app: Hono, options: OwnerRouteOptions) {
  const { db, chain, policy, now } = options;
  const chainId = chain.deployment.chainId;
  const notifyOptions = {
    secrets: options.secrets,
    email: options.email,
    ownDomains: options.ownDomains,
    allowLoopbackUrls: options.allowLoopbackUrls,
  };
  // Orders a preview's runner token requests (the session authenticates them): strictly
  // increasing, so two in the same millisecond don't look like a replay.
  let lastStamp = 0;
  const stamp = () => (lastStamp = Math.max(lastStamp + 1, now()));
  const verifies = new RateLimiter({
    perClient: VERIFY_PER_HOST_HOURLY,
    total: 500,
    windowMs: 3_600_000,
    now,
  });
  // Checks from one client address per hour, whichever wallets it signs in with.
  const checkClients = new RateLimiter({
    perClient: options.checksPerClientHourly ?? CHECKS_PER_CLIENT_HOURLY,
    total: Number.MAX_SAFE_INTEGER,
    windowMs: 3_600_000,
    now,
  });
  // Each registration or verification is an outbound POST: capped per wallet and in all too.
  const walletVerifies = new RateLimiter({
    perClient: policy.urlVerifiesPerWalletHourly,
    total: policy.urlVerifiesHourly,
    windowMs: 3_600_000,
    now,
  });

  const limited = (c: Context, limiter: RateLimiter) => {
    if (!limiter.allow(clientAddress(c.req.raw.headers)))
      throw new Refused(429, "Too many requests. Try again in a few minutes.");
  };
  /** The request body as an object (empty when there is none). */
  const bodyOf = async (c: Context): Promise<Record<string, unknown>> => {
    const text = await c.req.text();
    const value: unknown = text ? JSON.parse(text) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError();
    return value as Record<string, unknown>;
  };
  const hasBearer = (c: Context) => (c.req.header("Authorization") ?? "").startsWith("Bearer ");

  const ownerOf = async (agentId: string) =>
    (
      await chain.read.readContract({
        address: chain.deployment.registry,
        abi: bondedRegistryAbi,
        functionName: "agentOwner",
        args: [BigInt(agentId)],
      })
    ).toLowerCase();

  /** A preview by its id: another wallet's is "not found", so ids can't be probed. */
  async function previewSubject(id: string | undefined, wallet?: string): Promise<Subject> {
    const parsed = uuid.safeParse(id);
    const preview = parsed.success ? await db.preview(parsed.data) : undefined;
    if (
      !preview ||
      preview.chainId !== chainId ||
      (wallet !== undefined && preview.owner !== wallet)
    )
      throw new Refused(404, "That preview wasn't found.");
    return {
      key: previewKey(preview.id),
      kind: "preview",
      id: preview.id,
      owner: preview.owner,
      mode: preview.mode as AgentMode,
      world: preview.world,
      toolNames: preview.toolNames,
      connection: preview.connection,
      ...(preview.codeHash ? { declaredCode: preview.codeHash } : {}),
      preview,
    };
  }
  /** A registered own agent. With `wallet`, only its owner in the registry, now. */
  async function agentSubject(id: string | undefined, wallet?: string): Promise<Subject> {
    const agentId = uint.parse(id);
    const key = `${chainId}:${agentId}`;
    const record = await db.agentRecord(key);
    const config = record?.config as
      { kind?: string; mode?: AgentMode; codeHash?: string } | undefined;
    if (!record?.enabled || record.source !== "user" || config?.kind !== REMOTE_KIND)
      throw new Refused(404, "This agent isn't registered as your own agent.");
    if (wallet !== undefined && ((await ownerOf(agentId)) !== wallet || record.owner !== wallet))
      throw new Refused(403, "Only the agent's owner can do that.");
    return {
      key,
      kind: "agent",
      id: agentId,
      owner: record.owner ?? "",
      mode: config.mode ?? "tools",
      world: "vault",
      toolNames: "bonded",
      connection: await db.connectionOf(key, config),
      ...(config.codeHash ? { declaredCode: config.codeHash } : {}),
    };
  }
  type Kind = "preview" | "agent";
  const subjectOf = (kind: Kind, id: string | undefined, wallet?: string) =>
    kind === "preview" ? previewSubject(id, wallet) : agentSubject(id, wallet);

  /**
   * Who is asking, for a write: the session's wallet, or for a registered agent a fresh
   * signature of `action` (with `fields`) by its owner, used once. Returns the wallet and the
   * body without the signature.
   */
  async function writer(
    c: Context,
    kind: Kind,
    action: ByoaAction,
    fields: (body: Record<string, unknown>) => Record<string, string> = () => ({}),
  ): Promise<{ wallet: string; body: Record<string, unknown> }> {
    limited(c, options.writes);
    const raw = await bodyOf(c);
    const { timestamp, signature, ...body } = raw;
    if (hasBearer(c) || kind === "preview" || signature === undefined)
      return { wallet: await options.wallet(c), body };
    const proof = signed.parse({ timestamp, signature });
    const age = Math.floor(now() / 1000) - proof.timestamp;
    if (age > SELF_SERVE_MAX_AGE_SECONDS || age < -60)
      throw new Refused(400, "The signed request has expired. Sign it again.");
    const message = byoaMessage({
      action,
      chainId,
      agentId: uint.parse(c.req.param("id")),
      fields: fields(body),
      timestamp: proof.timestamp,
    });
    const recovered = await recoverMessageAddress({
      message,
      signature: proof.signature as Hex,
    }).catch(() => undefined);
    if (!recovered) throw new Refused(400, "The signature isn't valid.");
    if (!(await db.useSignature(signedRequestKey(recovered, message))))
      throw new Refused(409, "That signed request was already used. Sign it again.");
    return { wallet: recovered.toLowerCase(), body };
  }
  /**
   * The caller's own subject, for a read: another owner's agent or preview is "not found" (agent
   * ids are public numbers, so a 403 would confirm what can't be read).
   */
  const ownedForRead = async (kind: Kind, id: string | undefined, wallet: string) => {
    try {
      return await subjectOf(kind, id, wallet);
    } catch (e) {
      if (e instanceof Refused && e.status === 403) throw new Refused(404, "That wasn't found.");
      throw e;
    }
  };
  const reader = async (c: Context) => {
    limited(c, options.reads);
    return options.wallet(c);
  };

  /** The code a check or rating of this subject is about now, and the connection's state. */
  async function connectionNow(subject: Subject) {
    const current = await db.currentConnection(subject.key, subject.connection);
    const code: RatedCode | undefined = subject.declaredCode
      ? { hash: subject.declaredCode, source: "declared" }
      : current.code;
    const config: CheckConfig = {
      mode: subject.mode,
      world: subject.world,
      toolNames: subject.toolNames,
      connection: subject.connection,
      credentialId: current.credentialId,
      codeHash: code?.hash ?? null,
    };
    return { current, code, config };
  }
  /** Why the subject can't be reached right now, in words for its owner, or undefined. */
  async function connectionProblem(subject: Subject): Promise<string | undefined> {
    const { current } = await connectionNow(subject);
    if (current.ready) {
      // A hosted agent runs on Bonded's model key: past the day's budget, or the owner's share of
      // it, nothing starts, so a check or rating isn't spent on tests that would stop at once.
      if (subject.connection === "hosted")
        try {
          await HOSTED_BUDGET.check(subject.owner);
        } catch (error) {
          if (error instanceof HostedBudgetError) return error.message;
          throw error;
        }
      return undefined;
    }
    if (subject.connection === "hosted")
      return "Save your agent first: its instructions, or its code file.";
    if (subject.connection === "url")
      return current.credentialId
        ? "Verify your Agent URL first: Bonded hasn't had an answer to its challenge yet."
        : "Set your Agent URL first.";
    if (!current.credentialId) return "Create a runner token first, then start the runner.";
    const status = await db.runnerStatus(subject.key);
    const wrongMode = status.runner?.mode
      ? helloProblem({ mode: subject.mode }, { mode: status.runner.mode })
      : undefined;
    return wrongMode
      ? `The runner is connected in the wrong mode: ${wrongMode}.`
      : "The runner isn't connected. Start it with the command on this page, then check again.";
  }

  /** The live Agent URL, with the wallet its calls are signed for (the handler's owner). */
  async function agentUrlInfo(key: string) {
    const u = await db.agentUrl(key);
    return u
      ? {
          agentUrlId: u.id,
          url: u.url,
          owner: u.createdBy,
          verified: Boolean(u.verifiedAt),
          verifiedAt: u.verifiedAt?.toISOString() ?? null,
          version: u.version,
          codeHash: u.codeHash,
          createdAt: u.createdAt.toISOString(),
        }
      : null;
  }
  /**
   * What a preview runs. A brokerage preview runs the control, every staged attack and every
   * benign twin once (findings, not a score); a vault preview, the rating plan.
   */
  const previewPlan = (world: PreviewWorld = "vault") => {
    if (world === "brokerage") {
      const episodes = brokeragePreviewSize("plain");
      const budgetMs = Math.min(policy.previewBudgetCeilingMs, episodes * policy.episodeBudgetMs);
      return { episodes, budgetSeconds: Math.round(budgetMs / 1000) };
    }
    const library = publishedLibrary();
    const plan = previewRatingPlan(policy, {
      publishedAttacks: library.attacks,
      heldOut: library.classes * policy.heldOutPerClass,
    });
    return { episodes: plan.episodes, budgetSeconds: Math.round(plan.budgetMs / 1000) };
  };

  /**
   * Everything a connection's page shows, for a preview or a registered agent: the runner or
   * Agent URL (never a token or secret), the code hash and its source, and the last check.
   */
  async function connectionRecord(subject: Subject) {
    const [status, agentUrl, checks, now_] = await Promise.all([
      db.runnerStatus(subject.key),
      agentUrlInfo(subject.key),
      db.checksOf(subject.key, 1),
      connectionNow(subject),
    ]);
    const passing = await db.passingCheck(subject.key, now_.config);
    return {
      connection: subject.connection,
      agentUrl,
      codeHash: codeInfo(now_.code, agentUrl?.version),
      hasRunnerToken: Boolean(status.token),
      runner: status.runner,
      problem: status.runner?.mode
        ? (helloProblem({ mode: subject.mode }, { mode: status.runner.mode }) ?? null)
        : null,
      gatewayUrl: options.gatewayUrl ?? null,
      lastCheck: checks[0] ? checkSummary(checks[0]) : null,
      passingCheck: passing ? checkSummary(passing) : null,
      ready: now_.current.ready,
      code: now_.code ?? null,
      hosted: subject.connection === "hosted" ? await hostedInfo(subject.key) : null,
    };
  }
  /** A hosted preview's saved agent, without its text. */
  async function hostedInfo(key: string) {
    const h = await db.hostedAgent(key);
    return h
      ? {
          kind: h.kind,
          model: h.model,
          language: h.language,
          codeHash: h.codeHash,
          savedAt: h.createdAt.toISOString(),
        }
      : null;
  }
  async function previewRecord(p: PreviewRecord) {
    const subject = await previewSubject(p.id);
    const connection = await connectionRecord(subject);
    const rating = p.ratingId ? await ratingSummary(p.ratingId) : null;
    return {
      id: p.id,
      chainId: p.chainId,
      owner: p.owner,
      mode: p.mode,
      world: p.world,
      toolNames: p.toolNames,
      status: p.status,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      ratingId: p.ratingId,
      ...connection,
      declaredCodeHash: p.codeHash,
      queue:
        p.status === "queued" && p.ratingId
          ? { position: await db.remoteQueue(chainId, p.ratingId) }
          : null,
      reason: p.error,
      reasonCode: p.error ? problemCode(p.error) : null,
      rating,
      upgradedTo: p.upgradedTo,
      expectedRating: previewPlan(p.world),
      // The brokerage world has no official rating yet: its attacks are staged (findings only).
      upgrade:
        p.world === "brokerage"
          ? null
          : {
              kind: REMOTE_KIND,
              mode: p.mode,
              connection: p.connection,
              agentUrl: p.connection === "url" ? (connection.agentUrl?.url ?? null) : null,
              runner: p.connection === "runner",
              // Declared code carries over as declared; reported code stays automatic.
              codeHash: p.codeHash,
              reportedCode:
                connection.code && connection.code.source !== "declared" ? connection.code : null,
              previewId: p.id,
              previewRatingId: p.ratingId,
              note: "An official rating always runs again, attested, after you register the agent and stake its bond; this preview's report stays linked.",
            },
      label: PREVIEW_LABEL,
      attested: false,
      insurable: false,
    };
  }

  /** A rating's state for its owner: status, progress (counts only), its result once over. */
  async function ratingSummary(runId: string) {
    const r = (
      await db.pool.query(
        `SELECT id,status,error,agent_caused,agent_report,code_hash,code_source,created_at,
           report->'scoring'->>'score' AS score, report->'scoring'->>'tier' AS tier,
           report->>'world' AS world, report->'findings'->'attacks' AS findings_attacks,
           report->'findings'->'job' AS findings_job,
           report->'findings'->'episodes' AS findings_episodes
         FROM ratings WHERE id=$1`,
        [runId],
      )
    ).rows[0];
    if (!r) return null;
    const over = r.status === "done" || r.status === "failed";
    return {
      runId: r.id,
      status: r.status,
      error: r.error,
      errorCode: r.error ? problemCode(r.error) : null,
      agentCaused: r.agent_caused,
      agentReport: r.agent_report,
      codeHash: r.code_hash,
      codeSource: r.code_source,
      createdAt: r.created_at.toISOString(),
      progress: await progressOf(runId, r.status),
      // No score until the rating is over: an operator controls their agent live.
      ...(over && r.score !== null ? { score: Number(r.score), tier: r.tier } : {}),
      // A brokerage preview has findings instead of a score (its attacks are staged).
      ...(over && r.world === "brokerage" && r.findings_attacks
        ? {
            findings: {
              attacks: r.findings_attacks,
              job: r.findings_job,
              episodes: r.findings_episodes,
            },
          }
        : {}),
    };
  }

  // Previews.

  /**
   * Whether a wallet may start a preview rating now, and if not, when. No sign-in needed. Each
   * world has its own daily preview per wallet (`world`, default vault).
   */
  app.get(
    "/previews/allowance",
    handle(async (c) => {
      limited(c, options.reads);
      const wallet = z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/)
        .parse(c.req.query("wallet"))
        .toLowerCase();
      const world = z.enum(["vault", "brokerage"]).default("vault").parse(c.req.query("world"));
      const { refusal, queued } = await db.previewAllowance(
        wallet,
        chainId,
        {
          nowMs: now(),
          perWalletDaily: policy.previewPerWalletDaily,
          daily: policy.previewDaily,
        },
        world,
      );
      return c.json({
        allowed: !refusal,
        reason: refusal ? previewRefusalMessage(refusal, policy) : null,
        retryAt: refusal && "nextAt" in refusal ? refusal.nextAt.toISOString() : null,
        queued,
        plan: previewPlan(),
        brokeragePlan: previewPlan("brokerage"),
        hostedModels: HOSTED_MODELS,
      });
    }),
  );

  /** Start a preview: no vault, no bond, no registration; the wallet's session is enough. */
  app.post(
    "/previews",
    handle(async (c) => {
      const { wallet, body } = await writer(c, "preview", "sign-in");
      const input = previewInput.parse(body);
      const connection = input.connection ?? "runner";
      const world = input.world ?? "vault";
      if (world === "brokerage" && input.mode !== "tools")
        throw new Refused(
          400,
          "The brokerage world runs in tools mode only: it has no chain to sign for.",
        );
      const toolNames = input.toolNames ?? "bonded";
      if (toolNames !== "bonded" && world !== "brokerage")
        throw new Refused(
          400,
          "Only the brokerage world is offered under a broker's tool names: the vault world has its own.",
        );
      if (connection === "url" && !options.agentUrls) throw new Refused(409, SIGNING_KEY_MISSING);
      if (connection === "hosted" && world !== "brokerage")
        throw new Refused(
          400,
          "Bonded can run an agent for you on the stock-trading world only, for now.",
        );
      if (connection === "hosted" && input.codeHash)
        throw new Refused(400, "A hosted agent's code hash is worked out from what you save.");
      const made = await db.createPreview(
        {
          chainId,
          owner: wallet,
          mode: input.mode,
          world,
          toolNames,
          connection,
          ...(input.codeHash ? { codeHash: input.codeHash } : {}),
        },
        { nowMs: now(), perWalletDaily: policy.previewCreatesPerWalletDaily },
      );
      if ("refused" in made)
        throw new Refused(
          429,
          `You can start at most ${policy.previewCreatesPerWalletDaily} previews a day. Try again after ${made.nextAt.toISOString()}.`,
          { retryAt: made.nextAt.toISOString() },
        );
      return c.json(await previewRecord(made), 201);
    }),
  );

  /**
   * Save what a hosted preview runs: its instructions on a model, or one code file. A code file is
   * loaded in the sandbox first (it reads, its top-level code runs, it has a default export), so a
   * broken file is refused here with the reason, not in a check. Each save is a new agent: it
   * needs a new connection check before it can be rated.
   */
  app.put(
    "/previews/:id/hosted-agent",
    handle(async (c) => {
      const { wallet, body } = await writer(c, "preview", "sign-in");
      const subject = await previewSubject(c.req.param("id"), wallet);
      if (subject.preview!.status === "stopped")
        throw new Refused(409, "This preview was stopped.");
      if (subject.connection !== "hosted")
        throw new Refused(409, "This preview runs your agent on your side, not on Bonded.");
      if (["queued", "running", "starting"].includes(subject.preview!.status))
        throw new Refused(409, "Its rating has started. Wait for it to finish, then change it.");
      const parsed = HostedAgentSpec.safeParse(body);
      if (!parsed.success)
        throw new Refused(400, parsed.error.issues[0]?.message ?? "That agent can't be saved.");
      const spec = parsed.data;
      if (spec.kind === "code") {
        const inspected = await inspectCodeAgent(spec.code, spec.language);
        if (!inspected.ok)
          throw inspected.busy
            ? new Refused(503, INSPECT_BUSY)
            : new Refused(422, `Your file can't run: ${inspected.problem}.`);
      }
      const saved = await db.saveHostedAgent(
        subject.key,
        { ...spec, codeHash: hostedCodeHash(spec), createdBy: wallet },
        subject.id,
      );
      // Checked again under the lock: a rating may have been queued since.
      if ("refused" in saved)
        throw new Refused(
          409,
          saved.refused === "stopped"
            ? "This preview was stopped."
            : "Its rating has started. Wait for it to finish, then change it.",
        );
      // A changed agent needs a new check: back to "created" if it had passed one.
      await db.pool.query(
        "UPDATE previews SET status='created',updated_at=now() WHERE id=$1 AND status='ready'",
        [subject.id],
      );
      return c.json(
        {
          kind: saved.kind,
          model: saved.model,
          language: saved.language,
          codeHash: saved.codeHash,
          savedAt: saved.createdAt.toISOString(),
        },
        200,
      );
    }),
  );

  /** What a hosted preview runs, with its text: its owner's only. */
  app.get(
    "/previews/:id/hosted-agent",
    handle(async (c) => {
      const wallet = await reader(c);
      const subject = await previewSubject(c.req.param("id"), wallet);
      const h = await db.hostedAgent(subject.key);
      if (!h) throw new Refused(404, "Nothing is saved for this preview yet.");
      c.header("Cache-Control", "no-store");
      return c.json({
        kind: h.kind,
        model: h.model,
        ...(h.kind === "instructions"
          ? { instructions: h.instructions }
          : { language: h.language, code: h.code }),
        codeHash: h.codeHash,
        savedAt: h.createdAt.toISOString(),
      });
    }),
  );

  /** The wallet's previews, newest first. */
  app.get(
    "/previews",
    handle(async (c) => {
      const wallet = await reader(c);
      const q = z
        .strictObject({
          page: z.coerce.number().int().min(1).max(1_000_000).optional(),
          limit: z.coerce.number().int().min(1).max(50).optional(),
        })
        .parse(c.req.query());
      const page = await db.previewsOf(wallet, chainId, q);
      return c.json({ ...page, items: await Promise.all(page.items.map(previewRecord)) });
    }),
  );

  /** One preview, with everything its page shows and what "Make it official" fills in. */
  app.get(
    "/previews/:id",
    handle(async (c) => {
      const wallet = await reader(c);
      const subject = await previewSubject(c.req.param("id"), wallet);
      return c.json(await previewRecord(subject.preview!));
    }),
  );

  /** Stop a preview: a queued rating is cancelled, and its token and Agent URL stop working. */
  app.post(
    "/previews/:id/stop",
    handle(async (c) => {
      const { wallet } = await writer(c, "preview", "sign-in");
      const subject = await previewSubject(c.req.param("id"), wallet);
      const stopped = await db.stopPreview(subject.id);
      if ("refused" in stopped)
        throw new Refused(409, "Its rating is running. It stops at the first failed episode.");
      return c.json({ stopped: true });
    }),
  );

  /** A preview's runner token, shown once (it replaces the preview's current one). */
  app.post(
    "/previews/:id/runner-token",
    handle(async (c) => {
      const { wallet, body } = await writer(c, "preview", "runner-token");
      empty.parse(body);
      const subject = await previewSubject(c.req.param("id"), wallet);
      if (subject.preview!.status === "stopped")
        throw new Refused(409, "This preview was stopped.");
      if (subject.connection !== "runner")
        throw new Refused(
          409,
          subject.connection === "hosted"
            ? "Bonded runs this preview's agent, so it has no runner."
            : "This preview connects by its Agent URL, not with a runner.",
        );
      const token = newRunnerToken();
      const made = await db.createRunnerToken(subject.key, {
        hash: runnerTokenHash(token),
        createdBy: wallet,
        signedAt: stamp(),
      });
      if ("refused" in made) throw new Refused(409, "A newer token request came first. Try again.");
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
  app.delete(
    "/previews/:id/runner-token",
    handle(async (c) => {
      const { wallet } = await writer(c, "preview", "runner-token");
      const subject = await previewSubject(c.req.param("id"), wallet);
      const done = await db.revokeRunnerToken(subject.key, stamp());
      if ("refused" in done) throw new Refused(409, "A newer token request came first. Try again.");
      return c.json({ revoked: done.revoked });
    }),
  );

  /** Checks from one client address per hour: refused past the cap. */
  const clientCheckAllowed = (c: Context) => {
    if (!checkClients.allow(clientAddress(c.req.raw.headers)))
      throw new Refused(429, "Too many checks from here this hour. Try again later.", {
        retryAt: new Date(now() + 3_600_000).toISOString(),
      });
  };
  /**
   * Queue a connection check of `subject` for `wallet` (its owner), under the per-wallet and
   * global caps. When the agent can't be reached at all, the check fails at once saying why.
   */
  async function startCheck(subject: Subject, wallet: string): Promise<ConnectionCheckRecord> {
    if (subject.preview?.status === "stopped") throw new Refused(409, "This preview was stopped.");
    const { current, code } = await connectionNow(subject);
    const problem = await connectionProblem(subject);
    const made = await db.createCheck(
      {
        subject: subject.key,
        chainId,
        owner: wallet,
        mode: subject.mode,
        world: subject.world,
        toolNames: subject.toolNames,
        connection: subject.connection,
        credentialId: current.credentialId,
        code,
      },
      { perWalletHourly: policy.checksPerWalletHourly, hourly: policy.checksHourly },
      problem
        ? ({
            passed: false,
            problems: [problem],
            taskCompleted: false,
            toolsCalled: 0,
            surfacesRead: [],
          } satisfies ConnectionCheckResult)
        : undefined,
    );
    if ("refused" in made)
      throw made.refused === "busy"
        ? new Refused(409, "A check is already running for this agent. Wait for its result.")
        : new Refused(
            429,
            made.refused === "wallet-hourly"
              ? `You can run at most ${policy.checksPerWalletHourly} checks an hour. Try again after ${made.nextAt.toISOString()}.`
              : `Connection checks are busy right now. Try again after ${made.nextAt.toISOString()}.`,
            { retryAt: made.nextAt.toISOString() },
          );
    if (
      subject.preview &&
      !problem &&
      ["created", "ready", "failed"].includes(subject.preview.status)
    )
      await db.setPreviewStatus(subject.id, "checking");
    return made;
  }

  // Agent URLs, checks, estimates and notification settings: for a preview or a registered agent.

  /**
   * Verification: send the `verify` challenge, signed for `owner` (the wallet that saved the URL);
   * the agent must answer with the challenge and that owner. The gateway's verifier checks it.
   */
  async function challenge(url: string, owner: string, wallet: string) {
    let host: string;
    try {
      host = new URL(url).host.toLowerCase();
    } catch {
      throw new Refused(400, "That isn't a URL.");
    }
    if (!walletVerifies.allow(wallet))
      throw new Refused(
        429,
        `Agent URLs can be checked at most ${policy.urlVerifiesPerWalletHourly} times an hour per wallet (and ${policy.urlVerifiesHourly} in all). Try again later.`,
        { retryAt: new Date(now() + 3_600_000).toISOString() },
      );
    if (!verifies.allow(host))
      throw new Refused(
        429,
        "Your URL has been checked too often this hour. Try again in an hour.",
        {
          retryAt: new Date(now() + 3_600_000).toISOString(),
        },
      );
    const answer = await options
      .verifyAgentUrl(url, owner)
      .catch(() => ({ ok: false as const, problem: "The verification couldn't run; try again." }));
    if (!answer.ok) throw new Refused(422, sentence(answer.problem));
    const version = answer.version?.slice(0, 200) ?? null;
    return { version, codeHash: version ? urlCodeHash(version) : null };
  }

  for (const [kind, base] of [
    ["preview", "/previews/:id"],
    ["agent", "/self/agents/:id"],
  ] as const) {
    /**
     * Save the agent's HTTPS endpoint (after the URL rules: https, a public host, not one of
     * Bonded's). Every call to it is signed by Bonded's key for the wallet saving it, and the
     * agent's handler names that wallet as its owner; there is no secret. The URL is verified by a
     * separate call (…/agent-url/verify), so a URL can be saved before its handler is deployed.
     * Until then it can't be used for checks or ratings. A registered agent reached by its runner
     * switches to Agent URL mode.
     */
    app.post(
      `${base}/agent-url`,
      handle(async (c) => {
        const { wallet, body } = await writer(c, kind, "agent-url", (b) => ({
          url: String(b.url ?? ""),
        }));
        const subject = await subjectOf(kind, c.req.param("id"), wallet);
        if (subject.preview?.status === "stopped")
          throw new Refused(409, "This preview was stopped.");
        if (subject.kind === "preview" && subject.connection !== "url")
          throw new Refused(
            409,
            subject.connection === "hosted"
              ? "Bonded runs this preview's agent, so it has no Agent URL."
              : "This preview connects with the runner, so it has no Agent URL.",
          );
        if (
          subject.kind === "agent" &&
          ((await db.agentRecord(subject.key))?.config as { tee?: unknown } | undefined)?.tee
        )
          throw new Refused(
            409,
            "A TEE-bound agent is rated through its runner, not an Agent URL.",
          );
        if (!options.agentUrls) throw new Refused(409, SIGNING_KEY_MISSING);
        const { url } = urlInput.parse(body);
        const problem =
          outboundUrlProblem(url, options.ownDomains, options.allowLoopbackUrls) ??
          options.urlProblem?.(url);
        if (problem) throw new Refused(400, sentence(problem));
        const made = await db.createAgentUrl(subject.key, {
          id: randomUUID(),
          url,
          createdBy: wallet,
        });
        return c.json(
          {
            agentUrlId: made.id,
            url,
            // The wallet calls are signed for: the handler's `owner`.
            owner: wallet.toLowerCase(),
            // Not yet: deploy the handler, then call …/agent-url/verify.
            verified: false,
            verifiedAt: null,
            version: null,
            codeHash: subject.declaredCode
              ? codeInfo({ hash: subject.declaredCode, source: "declared" })
              : null,
            createdAt: made.createdAt.toISOString(),
          },
          201,
        );
      }),
    );
    /**
     * Prove the URL is the owner's: Bonded sends it a `verify` challenge signed for the wallet that
     * saved it, and it must answer within 10 s naming that wallet (422 with the reason otherwise).
     * Again after a redeploy, say. Capped per URL host, per wallet and in all: each one calls out.
     */
    app.post(
      `${base}/agent-url/verify`,
      handle(async (c) => {
        const live0 =
          kind === "agent"
            ? await db.agentUrl(`${chainId}:${uint.parse(c.req.param("id"))}`)
            : undefined;
        const { wallet } = await writer(c, kind, "agent-url", () => ({ url: live0?.url ?? "" }));
        const subject = await subjectOf(kind, c.req.param("id"), wallet);
        if (!options.agentUrls) throw new Refused(409, SIGNING_KEY_MISSING);
        const live = await db.agentUrl(subject.key);
        if (!live) throw new Refused(404, "Set your Agent URL first.");
        const reported = await challenge(live.url, live.createdBy, wallet);
        await db.markAgentUrlVerified(live.id, reported);
        const info = await agentUrlInfo(subject.key);
        return c.json({
          verified: true,
          url: live.url,
          verifiedAt: info?.verifiedAt ?? null,
          version: reported.version,
          codeHash: subject.declaredCode
            ? codeInfo({ hash: subject.declaredCode, source: "declared" })
            : codeInfo(
                reported.codeHash ? { hash: reported.codeHash, source: "url" } : undefined,
                reported.version,
              ),
        });
      }),
    );
    /** Remove the Agent URL (a registered agent goes back to its runner). */
    app.delete(
      `${base}/agent-url`,
      handle(async (c) => {
        const { wallet } = await writer(c, kind, "agent-url", () => ({ url: "none" }));
        const subject = await subjectOf(kind, c.req.param("id"), wallet);
        return c.json({ revoked: await db.revokeAgentUrls(subject.key) });
      }),
    );
    app.get(
      `${base}/agent-url`,
      handle(async (c) => {
        const wallet = await reader(c);
        const subject = await subjectOf(kind, c.req.param("id"), wallet);
        return c.json({
          connection: subject.connection,
          agentUrl: await agentUrlInfo(subject.key),
        });
      }),
    );

    /**
     * Run a connection check: one benign episode, live. When the agent can't be reached at all
     * (no runner connected, URL not verified) the check fails at once with that problem.
     */
    app.post(
      `${base}/checks`,
      handle(async (c) => {
        const { wallet, body } = await writer(c, kind, "check");
        empty.parse(body);
        clientCheckAllowed(c);
        const subject = await subjectOf(kind, c.req.param("id"), wallet);
        return c.json(await checkView(await startCheck(subject, wallet)), 201);
      }),
    );
    app.get(
      `${base}/checks`,
      handle(async (c) => {
        const wallet = await reader(c);
        const subject = await subjectOf(kind, c.req.param("id"), wallet);
        return c.json({ items: (await db.checksOf(subject.key, 10)).map(checkSummary) });
      }),
    );

    /**
     * What a rating will cost the owner in their own model spend and time, from the latest
     * passing check: an estimate, honest when the agent didn't report its usage. Its owner's
     * session only.
     */
    app.get(
      `${base}/estimate`,
      handle(async (c) => {
        const subject = await ownedForRead(kind, c.req.param("id"), await reader(c));
        // The passing check of this connection as it is now, the one a rating would need.
        const check = await db.passingCheck(subject.key, (await connectionNow(subject)).config);
        if (!check)
          throw new Refused(
            409,
            "Run a connection check of this connection first: the estimate comes from it.",
          );
        const episodes =
          kind === "preview"
            ? previewPlan(subject.world).episodes
            : expectedRating(policy.repeats, policy).maxEpisodes;
        return c.json(
          costEstimate(
            check,
            episodes,
            subject.connection === "hosted" ? HOSTED_PREVIEW_CONCURRENCY : 1,
          ),
        );
      }),
    );

    /** Where results are sent: masked, never the webhook secret. Its owner's session only. */
    app.get(
      `${base}/notifications`,
      handle(async (c) => {
        const subject = await ownedForRead(kind, c.req.param("id"), await reader(c));
        return c.json(await notificationView(db, subject.owner, notifyOptions));
      }),
    );
    /**
     * Set or clear the webhook and the email (null clears). A new webhook gets a signing secret,
     * shown once as `webhookSecret`. The settings are the owner's, for all their ratings.
     */
    const saveSettings = handle(async (c) => {
      const { wallet, body } = await writer(c, kind, "notifications", (b) => ({
        webhook: typeof b.webhookUrl === "string" ? b.webhookUrl : "none",
        email: typeof b.email === "string" ? b.email : "none",
      }));
      await subjectOf(kind, c.req.param("id"), wallet);
      const input = notificationInput.parse(body);
      c.header("Cache-Control", "no-store");
      return c.json(await saveNotifications(db, wallet, input, notifyOptions));
    });
    app.put(`${base}/notifications`, saveSettings);
    app.post(`${base}/notifications`, saveSettings);
  }

  /** A check as GET /checks/:id answers: its summary, result and events so far. */
  async function checkView(k: ConnectionCheckRecord) {
    return {
      ...checkSummary(k),
      checkId: k.id,
      queued: k.status === "queued",
      mode: k.mode,
      codeHash: k.codeHash,
      codeSource: k.codeSource,
      // Never verified by Bonded: declared by the owner, or reported by the runner or agent.
      codeReportedBy: !k.codeHash
        ? null
        : k.codeSource === "declared"
          ? "owner"
          : k.codeSource === "url"
            ? "agent"
            : "runner",
      result: k.result,
      startedAt: k.startedAt?.toISOString() ?? null,
      finishedAt: k.finishedAt?.toISOString() ?? null,
      eventsUrl: `/checks/${k.id}/events`,
      events: (await db.checkEvents(k.id, "0", 300)).map((e) => e.event),
    };
  }

  /**
   * Who may read a check or a rating's stream: the owner's session (Authorization), or for an
   * EventSource, which can't send headers, a stream token from POST /streams/token (`?token=`):
   * good for that one check or rating, for a few minutes, so the browser's reconnects work.
   */
  async function streamViewer(c: Context, kind: "check" | "rating" | "preview", id: string) {
    const token = c.req.query("token");
    if (token) {
      const held = streamTokens.get(token);
      if (!held || held.expires < Date.now() || held.kind !== kind || held.id !== id) {
        if (held && held.expires < Date.now()) streamTokens.delete(token);
        throw new Refused(401, "That stream token has expired. Ask for a new one.");
      }
      return held.wallet;
    }
    return options.wallet(c);
  }
  /** Stream tokens: whose, what they open, when they expire (this process's memory). */
  const streamTokens = new Map<
    string,
    { wallet: string; kind: "check" | "rating" | "preview"; id: string; expires: number }
  >();
  const STREAM_TOKEN_MS = 5 * 60_000;
  /** The owner of a check, or "not found" for anyone else. */
  async function ownCheck(c: Context, wallet: string) {
    const id = uuid.safeParse(c.req.param("id"));
    const check = id.success ? await db.check(id.data) : undefined;
    if (!check || check.chainId !== chainId || check.owner !== wallet)
      throw new Refused(404, "That check wasn't found.");
    return check;
  }
  /** The owner of a rating (the wallet it is charged to), or "not found" for anyone else. */
  async function ownRating(id: string | undefined, wallet: string) {
    const parsed = uuid.safeParse(id);
    const row = parsed.success
      ? (
          await db.pool.query("SELECT id,charged_owner,status FROM ratings WHERE id=$1", [
            parsed.data,
          ])
        ).rows[0]
      : undefined;
    if (!row || row.charged_owner !== wallet) throw new Refused(404, "That rating wasn't found.");
    return row as { id: string; status: string };
  }

  /**
   * A token to open the live stream of one check or rating with EventSource (`?token=`): for one
   * the session's wallet owns, for five minutes.
   */
  app.post(
    "/streams/token",
    handle(async (c) => {
      const { wallet, body } = await writer(c, "preview", "sign-in");
      const input = z
        .union([
          z.strictObject({ checkId: uuid }),
          z.strictObject({ runId: uuid }),
          z.strictObject({ previewId: uuid }),
        ])
        .parse(body);
      if ("checkId" in input) {
        const check = await db.check(input.checkId);
        if (!check || check.chainId !== chainId || check.owner !== wallet)
          throw new Refused(404, "That check wasn't found.");
      } else if ("runId" in input) await ownRating(input.runId, wallet);
      else await previewSubject(input.previewId, wallet);
      if (streamTokens.size > 10_000)
        for (const [k, v] of streamTokens) if (v.expires < Date.now()) streamTokens.delete(k);
      const token = randomBytes(24).toString("base64url");
      const expires = Date.now() + STREAM_TOKEN_MS;
      streamTokens.set(
        token,
        "checkId" in input
          ? { wallet, kind: "check", id: input.checkId, expires }
          : "runId" in input
            ? { wallet, kind: "rating", id: input.runId, expires }
            : { wallet, kind: "preview", id: input.previewId, expires },
      );
      return c.json({ token, expiresAt: new Date(expires).toISOString() }, 201);
    }),
  );

  /**
   * Start a connection check from the terminal with the runner token alone
   * (`Authorization: Bearer bonded_rt_…`; `npx @bondedhq/runner init`). It checks exactly the
   * registration the token belongs to, a preview or an agent, for its owner, under the same caps
   * as the page (per address, per owner wallet, in all). A revoked token, a stopped or expired
   * preview's, or an agent's that changed hands since the token was made is refused. Answers the
   * check with a stream token for `GET /checks/:id/events?token=`.
   */
  app.post(
    "/runner/check",
    handle(async (c) => {
      limited(c, options.writes);
      const header = c.req.header("Authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      if (!token.startsWith(RUNNER_TOKEN_PREFIX) || token.length > 128)
        throw new Refused(401, "Send your runner token as Authorization: Bearer bonded_rt_….");
      empty.parse(await bodyOf(c));
      const record = await db.runnerToken(runnerTokenHash(token));
      if (!record || record.chainId !== chainId)
        throw new Refused(
          401,
          "That runner token isn't valid: it was revoked, replaced or its preview ended. Create a new one.",
        );
      clientCheckAllowed(c);
      let subject: Subject;
      let wallet: string;
      if (record.preview) {
        wallet = record.preview.owner;
        subject = await previewSubject(record.preview.id, wallet);
      } else {
        wallet = record.createdBy.toLowerCase();
        // The token stops working when the agent changes hands (as at the gateway).
        subject = await agentSubject(record.agentId, wallet).catch((e) => {
          if (e instanceof Refused)
            throw new Refused(
              401,
              "That runner token isn't valid: it was revoked, replaced or its preview ended. Create a new one.",
            );
          throw e;
        });
      }
      if (subject.connection !== "runner")
        throw new Refused(409, "This agent is reached by its Agent URL, so it has no runner.");
      const made = await startCheck(subject, wallet);
      const expires = Date.now() + STREAM_TOKEN_MS;
      const streamToken = randomBytes(24).toString("base64url");
      streamTokens.set(streamToken, { wallet, kind: "check", id: made.id, expires });
      c.header("Cache-Control", "no-store");
      return c.json(
        {
          ...(await checkView(made)),
          subject: subject.kind === "preview" ? { previewId: subject.id } : { agentId: subject.id },
          streamToken,
          streamExpiresAt: new Date(expires).toISOString(),
        },
        201,
      );
    }),
  );

  /** A check: its owner's only (session), "not found" to anyone else. */
  app.get(
    "/checks/:id",
    handle(async (c) => {
      const check = await ownCheck(c, await reader(c));
      return c.json(await checkView(check));
    }),
  );
  /**
   * A check's live events as server-sent events (each a plain `message` whose data has its
   * `type`), from the start or from Last-Event-ID; the stream ends after the `result`. The
   * owner's only: a session, or a stream token.
   */
  app.get(
    "/checks/:id/events",
    handle(async (c) => {
      limited(c, options.reads);
      const raw = c.req.param("id");
      const check = await ownCheck(c, await streamViewer(c, "check", raw ?? ""));
      let cursor = /^\d{1,18}$/.test(c.req.header("Last-Event-ID") ?? "")
        ? c.req.header("Last-Event-ID")!
        : "0";
      return options.streams.open(
        c,
        async () => {
          const events = await db.checkEvents(check.id, cursor);
          if (events.length) cursor = events.at(-1)!.id;
          // The worker always ends a check with a `result` event; a reconnect after it ends at once.
          const state = events.length ? undefined : (await db.check(check.id))?.status;
          const over =
            events.some((e) => (e.event as { type?: string }).type === "result") ||
            (state !== undefined && state !== "queued" && state !== "running");
          return { events: events.map((e) => ({ id: e.id, data: e.event })), done: over };
        },
        {
          intervalMs: 500,
          maxMs: 5 * 60_000,
          client: clientAddress(c.req.raw.headers),
          key: `check:${check.id}`,
        },
      );
    }),
  );

  /**
   * A preview's status as server-sent events (plain messages), so its page needn't poll:
   * `{ status, ratingId, reason, queue, progress }` each time it changes (created, checking,
   * ready, queued, starting, running, done, failed, refused, stopped). Progress is counts and an
   * ETA only. The owner's only: a session, or a stream token for the preview.
   */
  app.get(
    "/previews/:id/events",
    handle(async (c) => {
      limited(c, options.reads);
      const raw = c.req.param("id") ?? "";
      const subject = await previewSubject(raw, await streamViewer(c, "preview", raw));
      let last = "";
      let quietSince = Date.now();
      return options.streams.open(
        c,
        async () => {
          const p = (await db.preview(subject.id))!;
          const rating = p.ratingId
            ? ((await db.pool.query("SELECT status FROM ratings WHERE id=$1", [p.ratingId])).rows[0]
                ?.status as string | undefined)
            : undefined;
          const state = {
            status: p.status,
            ratingId: p.ratingId,
            reason: p.error,
            queue:
              p.status === "queued" && p.ratingId
                ? { position: await db.remoteQueue(chainId, p.ratingId) }
                : null,
            progress:
              p.ratingId && rating
                ? { ...(await progressOf(p.ratingId, rating)), status: rating }
                : null,
          };
          const key = JSON.stringify(state);
          const changed = key !== last;
          last = key;
          if (changed) quietSince = Date.now();
          const over = ["done", "failed", "refused", "stopped"].includes(p.status);
          return {
            events: changed ? [{ data: state }] : [],
            // Ends when the preview is over, or after 10 quiet minutes (the browser reconnects).
            done: over || Date.now() - quietSince > 10 * 60_000,
          };
        },
        {
          intervalMs: 1000,
          maxMs: 60 * 60_000,
          client: clientAddress(c.req.raw.headers),
          key: `preview:${subject.id}`,
        },
      );
    }),
  );

  // Preview ratings.

  /**
   * Queue the preview's rating. It needs a passing check of this exact connection in the last 24
   * hours, and fits in the preview caps; it runs after official ratings, one preview at a time.
   * The page's route and testing in CI (ci-runs.ts) both queue through here.
   */
  async function queuePreviewRating(subject: Subject): Promise<{ runId: string }> {
    if (subject.preview!.status === "stopped") throw new Refused(409, "This preview was stopped.");
    const problem = await connectionProblem(subject);
    if (problem) throw new Refused(409, problem);
    const { code, config } = await connectionNow(subject);
    if (!(await db.passingCheck(subject.key, config))) throw new Refused(409, NEEDS_CHECK);
    const queued = await db.enqueuePreviewRating(
      subject.id,
      {
        nowMs: now(),
        perWalletDaily: policy.previewPerWalletDaily,
        daily: policy.previewDaily,
      },
      code,
    );
    if ("refused" in queued)
      throw new Refused(
        queued.refused === "busy" ? 409 : 429,
        previewRefusalMessage(queued, policy),
        "nextAt" in queued ? { retryAt: queued.nextAt.toISOString() } : {},
      );
    return queued;
  }
  app.post(
    "/previews/:id/rate",
    handle(async (c) => {
      const { wallet } = await writer(c, "preview", "sign-in");
      const subject = await previewSubject(c.req.param("id"), wallet);
      const queued = await queuePreviewRating(subject);
      return c.json(
        {
          runId: queued.runId,
          queue: { position: await db.remoteQueue(chainId, queued.runId) },
          expectedRating: previewPlan(subject.world),
        },
        202,
      );
    }),
  );

  /** The preview's report, labelled: never attested, never insurable. */
  app.get(
    "/previews/:id/report",
    handle(async (c) => {
      const wallet = await reader(c);
      const subject = await previewSubject(c.req.param("id"), wallet);
      const runId = subject.preview!.ratingId;
      const row = runId
        ? (
            await db.pool.query("SELECT status,report FROM ratings WHERE id=$1 AND preview_id=$2", [
              runId,
              subject.id,
            ])
          ).rows[0]
        : undefined;
      if (!row?.report) return c.json({ status: row?.status ?? "none", report: null }, 202);
      return c.json({
        label: PREVIEW_LABEL,
        attested: false,
        insurable: false,
        report: row.report,
      });
    }),
  );

  // Progress.

  async function progressOf(runId: string, status: string) {
    const p = await db.runProgress(runId);
    // Measured from the first episode: setting up says nothing about the pace of episodes.
    const from = p.episodesStartedAt;
    const elapsed = from && p.lastAt ? p.lastAt.getTime() - from.getTime() : 0;
    const etaSeconds =
      status === "running" && p.total && p.done > 0
        ? Math.round(((elapsed / p.done) * (p.total - p.done)) / 1000)
        : null;
    return {
      done: p.done,
      total: p.total,
      etaSeconds,
      startedAt: p.startedAt?.toISOString() ?? null,
    };
  }
  /**
   * A rating's progress as server-sent events (plain messages): counts and an ETA only, never a
   * verdict, with the rating's status; the stream ends when the rating does. The owner's only (the
   * wallet it is charged to): a session, or a stream token.
   */
  app.get(
    "/ratings/:id/progress",
    handle(async (c) => {
      limited(c, options.reads);
      const raw = c.req.param("id") ?? "";
      const rating = await ownRating(raw, await streamViewer(c, "rating", raw));
      let last = "";
      let quietSince = Date.now();
      return options.streams.open(
        c,
        async () => {
          const status = (
            await db.pool.query("SELECT status FROM ratings WHERE id=$1", [rating.id])
          ).rows[0]?.status as string;
          const progress = { ...(await progressOf(rating.id, status)), status };
          const key = JSON.stringify(progress);
          const changed = key !== last;
          last = key;
          if (changed) quietSince = Date.now();
          // Nothing new for 10 minutes (a long wait in the queue): end; the client reconnects.
          const idle = Date.now() - quietSince > 10 * 60_000;
          return {
            events: changed ? [{ data: progress }] : [],
            done: status === "done" || status === "failed" || idle,
          };
        },
        {
          intervalMs: 2000,
          // Waiting in the queue says little: a short stream. Running: up to the rating's ceiling.
          maxMs: rating.status === "queued" ? 10 * 60_000 : 3 * 3_600_000,
          client: clientAddress(c.req.raw.headers),
          key: `rating:${rating.id}`,
        },
      );
    }),
  );

  return {
    connectionRecord: (kind: Kind, id: string) => subjectOf(kind, id).then(connectionRecord),
    /**
     * The preview rating flow, as the page runs it, for testing in CI (ci-runs.ts): the same
     * checks, the same caps and the same refusals.
     */
    previewRating: {
      /** The wallet's own preview, or "not found". */
      subject: (id: string, wallet: string): Promise<PreviewSubject> => previewSubject(id, wallet),
      /** Why the preview's agent can't be reached now, or undefined. */
      problem: (subject: PreviewSubject) => connectionProblem(subject),
      /** Whether this exact connection passed a check in the last 24 hours. */
      passing: async (subject: PreviewSubject) =>
        Boolean(await db.passingCheck(subject.key, (await connectionNow(subject)).config)),
      /** Start a connection check, under the per-address, per-wallet and global caps. */
      startCheck: (c: Context, subject: PreviewSubject, wallet: string) => {
        clientCheckAllowed(c);
        return startCheck(subject, wallet);
      },
      queue: (subject: PreviewSubject) => queuePreviewRating(subject),
    },
  };
}

/** A preview as the preview rating flow acts on it. */
export type PreviewSubject = Subject;
export type PreviewRatingFlow = ReturnType<typeof ownerRoutes>["previewRating"];

/** The cost estimate for `episodes` episodes, extrapolated from one check (see the route). */
/**
 * What a rating will take, from a passing check. `atOnce`: episodes run at the same time (a hosted
 * agent's preview runs several), which divides the time, not the cost.
 */
export function costEstimate(check: ConnectionCheckRecord, episodes: number, atOnce = 1) {
  const result = (check.result ?? {}) as Partial<ConnectionCheckResult>;
  const seconds = Math.max(1, Math.round((result.durationMs ?? 0) / 1000));
  const usage = result.usage;
  const cost = usage?.costUsd;
  const round = (n: number) => Math.round(n * 10_000) / 10_000;
  return {
    estimate: true,
    episodes,
    perEpisode: {
      toolCalls: result.toolsCalled ?? 0,
      seconds,
      ...(cost !== undefined ? { costUsd: round(cost) } : {}),
      ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}),
    },
    total: {
      seconds: Math.ceil(episodes / Math.max(1, atOnce)) * seconds,
      ...(cost !== undefined ? { costUsd: round(cost * episodes) } : {}),
      ...(usage
        ? {
            inputTokens: usage.inputTokens * episodes,
            outputTokens: usage.outputTokens * episodes,
          }
        : {}),
    },
    basis: `connection check ${check.id}`,
    usageReported: Boolean(usage),
    note: !usage
      ? "Your agent didn't report its model usage when it finished the check, so this gives time only. Send usage ({ inputTokens, outputTokens, costUsd }) with POST done to see a cost."
      : cost === undefined
        ? "Your agent reported tokens but no cost, so the cost isn't estimated: multiply the tokens by your model's price."
        : "An estimate from one benign episode: attacked episodes can take more or less.",
  };
}
