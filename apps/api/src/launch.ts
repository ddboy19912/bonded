import type { Context, Hono } from "hono";
import { z } from "zod";
import { previewKey, type Database } from "@bonded/db";
import type { ServiceChain } from "@bonded/keeper";
import {
  REMOTE_KIND,
  bondedRegistryAbi,
  mergeTrading,
  suggestMandate,
  type TradingSummary,
} from "@bondedhq/shared";
import { Refused, handle } from "./refused.js";
import { clientAddress, type RateLimiter } from "./rate-limit.js";
import type { SessionWallet } from "./sessions.js";
import type { AgentStatusReader } from "./agent-status.js";
import {
  healthProblems,
  latestScore,
  nextRating,
  pendingRating,
  type HealthInput,
} from "./agent-health.js";

/**
 * Bring your own agent, launch round: the suggested mandate (from what the agent did in its
 * passing check and its preview or rating), the before/after comparison of two ratings, the
 * vault's trading status and the agent's health panel. Owner data needs the owner's session;
 * everything is rate-limited.
 */

const uint = z
  .string()
  .regex(/^\d{1,78}$/)
  .transform((v) => BigInt(v).toString());

export interface LaunchRouteOptions {
  db: Database;
  chain: ServiceChain;
  wallet: SessionWallet;
  reads: RateLimiter;
  status: AgentStatusReader;
  now?: () => number;
}

/** The market a suggested mandate draws on: the deployment's tokens and exchange. */
export function deploymentMarket(chain: ServiceChain) {
  const d = chain.deployment;
  return {
    usdg: d.usdg,
    router: d.router,
    tokens: { tUSDG: d.usdg, tTSLA: d.tsla, tAMZN: d.amzn, tNVDA: d.nvda } as Record<
      string,
      string
    >,
  };
}

/** Several summaries as one, or null when there are none. */
const mergeOrNull = (...list: (TradingSummary | null)[]) =>
  list.some(Boolean) ? mergeTrading(list) : null;

export function launchRoutes(app: Hono, options: LaunchRouteOptions) {
  const { db, chain } = options;
  const chainId = chain.deployment.chainId;
  const now = options.now ?? Date.now;
  const limited = (c: Context) => {
    if (!options.reads.allow(clientAddress(c.req.raw.headers)))
      throw new Refused(429, "Too many requests. Try again in a few minutes.");
  };
  const ownerOf = async (agentId: string) =>
    (
      await chain.read.readContract({
        address: chain.deployment.registry,
        abi: bondedRegistryAbi,
        functionName: "agentOwner",
        args: [BigInt(agentId)],
      })
    ).toLowerCase();

  /** The caller's own registered agent (in the registry now): anyone else's is "not found". */
  async function ownAgent(c: Context) {
    limited(c);
    const wallet = await options.wallet(c);
    const agentId = uint.parse(c.req.param("id"));
    const key = `${chainId}:${agentId}`;
    const record = await db.agentRecord(key);
    if (!record?.enabled || record.owner !== wallet) throw new Refused(404, "That wasn't found.");
    if ((await ownerOf(agentId).catch(() => "")) !== wallet)
      throw new Refused(404, "That wasn't found.");
    return { wallet, agentId, key, record, config: record.config as AgentConfigView };
  }
  /** The caller's own preview: another wallet's is "not found". */
  async function ownPreview(c: Context) {
    limited(c);
    const wallet = await options.wallet(c);
    const id = z.uuid().safeParse(c.req.param("id"));
    const preview = id.success ? await db.preview(id.data) : undefined;
    if (!preview || preview.chainId !== chainId || preview.owner !== wallet)
      throw new Refused(404, "That preview wasn't found.");
    return { wallet, preview };
  }

  /** What the subject's passing checks saw it trade (newest five checks). */
  async function checkTrading(subject: string): Promise<TradingSummary | null> {
    const checks = await db.checksOf(subject, 5);
    const passed = checks.find(
      (k) => k.status === "passed" && (k.result as { trading?: unknown })?.trading,
    );
    return passed ? ((passed.result as { trading: TradingSummary }).trading ?? null) : null;
  }
  /** What a rating's report says the agent traded (`report.trading`). */
  async function ratingTrading(where: string, value: string): Promise<TradingSummary | null> {
    const r = await db.pool.query(
      `SELECT report->'trading' AS trading FROM ratings WHERE ${where}=$1 AND report ? 'trading'
       ORDER BY created_at DESC LIMIT 1`,
      [value],
    );
    return (r.rows[0]?.trading as TradingSummary | undefined) ?? null;
  }
  function suggestion(
    check: TradingSummary | null,
    rated: TradingSummary | null,
    from: "preview" | "rating",
  ) {
    return suggestMandate({
      chainId,
      market: deploymentMarket(chain),
      trading: mergeTrading([check, rated]),
      sources: [...(check ? (["check"] as const) : []), ...(rated ? [from] : [])],
    });
  }

  app.get(
    "/previews/:id/suggested-mandate",
    handle(async (c) => {
      const { preview } = await ownPreview(c);
      const [check, rated] = await Promise.all([
        checkTrading(previewKey(preview.id)),
        ratingTrading("preview_id", preview.id),
      ]);
      return c.json(suggestion(check, rated, "preview"));
    }),
  );
  app.get(
    "/self/agents/:id/suggested-mandate",
    handle(async (c) => {
      const { key } = await ownAgent(c);
      const fromPreview = await db.previewUpgradedTo(key);
      const [check, rated, previewCheck, previewRated] = await Promise.all([
        checkTrading(key),
        ratingTrading("agent_id", key),
        fromPreview ? checkTrading(previewKey(fromPreview.id)) : null,
        fromPreview ? ratingTrading("preview_id", fromPreview.id) : null,
      ]);
      return c.json(
        suggestion(mergeOrNull(check, previewCheck), mergeOrNull(rated, previewRated), "rating"),
      );
    }),
  );

  /**
   * Before and after: two finished ratings' score, expected loss and per-class breaches side by
   * side. A preview's rating can be compared only by its owner (anyone else gets "not found").
   */
  const compare = handle(async (c) => {
    limited(c);
    const q = z.strictObject({ from: z.uuid(), to: z.uuid() }).parse(c.req.query());
    const rows = await db.pool.query(
      `SELECT id,status,created_at,charged_owner,(preview_id IS NOT NULL) AS preview,
           coalesce(agent_id, 'preview:'||preview_id::text) AS subject,
           report->'scoring' AS scoring, report->'classes' AS classes
         FROM ratings WHERE id=ANY($1::uuid[])`,
      [[q.from, q.to]],
    );
    const viewer = rows.rows.some((r) => r.preview)
      ? await options.wallet(c).catch(() => undefined)
      : undefined;
    const side = (id: string) => {
      const r = rows.rows.find((x) => x.id === id);
      if (!r || (r.preview && (!viewer || viewer !== r.charged_owner)))
        throw new Refused(404, "That rating wasn't found.");
      if (!r.scoring)
        throw new Refused(409, "Its rating is running. Compare once both ratings are finished.");
      const classes = (r.classes ?? []) as {
        class: string;
        name: string;
        episodes: number;
        breaches: number;
        lossUsd: number;
      }[];
      return {
        runId: r.id as string,
        subject: r.subject as string,
        status: r.status as string,
        createdAt: (r.created_at as Date).toISOString(),
        score: Number(r.scoring.score),
        tier: String(r.scoring.tier),
        expectedLossBps: Number(r.scoring.expectedLossBps),
        classes: classes.map((k) => ({
          class: k.class,
          name: k.name,
          episodes: k.episodes,
          breaches: k.breaches,
          lossUsd: k.lossUsd,
        })),
      };
    };
    const from = side(q.from);
    const to = side(q.to);
    const ids = [...new Set([...from.classes, ...to.classes].map((k) => k.class))];
    const classes = ids.map((id) => {
      const a = from.classes.find((k) => k.class === id);
      const b = to.classes.find((k) => k.class === id);
      return {
        class: id,
        name: (b ?? a)!.name,
        from: a ? { episodes: a.episodes, breaches: a.breaches } : null,
        to: b ? { episodes: b.episodes, breaches: b.breaches } : null,
        breaches: (b?.breaches ?? 0) - (a?.breaches ?? 0),
      };
    });
    return c.json({
      from,
      to,
      sameAgent: from.subject === to.subject,
      classes,
      diff: {
        score: to.score - from.score,
        expectedLossBps: to.expectedLossBps - from.expectedLossBps,
        classes,
      },
    });
  });
  app.get("/arena/runs/compare", compare);
  app.get("/ratings/compare", compare);

  /** The vault's trading status, gas and cover (public chain data, cached briefly). */
  app.get(
    "/self/agents/:id/vault-activity",
    handle(async (c) => {
      limited(c);
      const agentId = uint.parse(c.req.param("id"));
      const record = await db.agentRecord(`${chainId}:${agentId}`);
      const vault = (record?.config as AgentConfigView | undefined)?.vault;
      if (!record?.enabled || !vault) throw new Refused(404, "This agent has no registered vault.");
      const st = await options.status.read(vault);
      return c.json({
        ...st.vaultActivity,
        vault: st.vault,
        agentKey: st.agentKey,
        frozen: st.frozen,
        coverWithoutVaultTrades: st.coverWithoutVaultTrades,
        agentGas: st.agentGas,
        cover: st.cover,
      });
    }),
  );

  /** Everything about the owner's agent at a glance, with what is wrong and what to do. */
  app.get(
    "/self/agents/:id/health",
    handle(async (c) => {
      const { key, agentId, config } = await ownAgent(c);
      const remote = config.kind === REMOTE_KIND;
      const connection = await db.connectionOf(key, config);
      const [score, standing, runner, url, pending, current] = await Promise.all([
        latestScore(db, key),
        db.agentStanding(key),
        db.runnerStatus(key),
        db.agentUrl(key),
        pendingRating(db, key),
        db.currentConnection(key, connection),
      ]);
      const chainStatus = config.vault
        ? await options.status.read(config.vault).catch(() => null)
        : null;
      const breaches = config.vault
        ? (await db.vaultBreaches(chainId, config.vault, 50)).filter(
            (b) => b.occurredAt && now() - b.occurredAt.getTime() < 7 * 86_400_000,
          ).length
        : 0;
      const input: HealthInput = {
        nowMs: now(),
        score: score ? { expiresAtSeconds: score.expiresAtSeconds } : null,
        superseded: standing.superseded ? { reason: standing.superseded.reason } : null,
        connection: remote ? connection : "bonded",
        runner: runner.runner
          ? { connected: runner.runner.connected, lastHeartbeatAt: runner.runner.lastHeartbeatAt }
          : null,
        hasRunnerToken: Boolean(runner.token),
        url: { set: Boolean(url), verified: Boolean(url?.verifiedAt) },
        pending,
        chain: chainStatus,
        recentBreaches: breaches,
      };
      const problems = healthProblems(input);
      const next = nextRating({ ...input, ready: remote ? current.ready : true });
      const cover = chainStatus?.cover ?? null;
      const gas = chainStatus?.agentGas ?? null;
      return c.json({
        agentId,
        score: score
          ? {
              value: score.score,
              securityScore: score.securityScore,
              tier: score.tier,
              expiresAt: score.expiresAt,
              valid: score.expiresAtSeconds * 1000 > now() && !standing.superseded,
              status:
                score.expiresAtSeconds * 1000 <= now()
                  ? "expired"
                  : score.expiresAtSeconds * 1000 - now() <= 7 * 86_400_000
                    ? "expiring"
                    : "current",
              issuedAt: score.issuedAt,
              runId: score.runId,
              txHash: score.txHash,
              superseded: standing.superseded,
            }
          : null,
        runner: !remote
          ? { status: "bonded" }
          : connection === "url"
            ? { status: "url", verified: Boolean(url?.verifiedAt) }
            : runner.runner
              ? {
                  status: runner.runner.connected ? "connected" : "offline",
                  lastSeenAt: runner.runner.lastHeartbeatAt.toISOString(),
                  version: runner.runner.runnerVersion,
                  mode: runner.runner.mode,
                }
              : { status: "never" },
        vault: chainStatus
          ? {
              address: chainStatus.vault,
              protection: config.protection ?? "vault",
              agentKey: chainStatus.agentKey,
              frozen: chainStatus.frozen,
              activity: chainStatus.vaultActivity,
            }
          : null,
        gas: gas
          ? {
              address: chainStatus!.agentKey,
              balance: gas.balanceWei,
              balanceEth: gas.balanceEth,
              low: gas.low,
              estimatedTradesLeft: gas.estimatedTradesLeft,
              basis: gas.basis,
            }
          : null,
        cover:
          !cover || !["active", "lapsed"].includes(cover.status)
            ? { status: "none" }
            : {
                ...cover,
                policyStatus: cover.status,
                status:
                  cover.status === "lapsed"
                    ? "lapsed"
                    : !cover.pastDueSince
                      ? "active"
                      : cover.lapsesAt && Date.parse(cover.lapsesAt) <= now()
                        ? "past-due"
                        : "grace",
                amount: cover.coverAmount,
              },
        nextRatingAt: next.at,
        nextRating: next,
        coverWithoutVaultTrades: chainStatus?.coverWithoutVaultTrades ?? false,
        problems: problems.map((p) => ({
          code: p.code,
          severity: p.severity,
          message: p.text,
          ...(p.fix ? { action: p.fix } : {}),
        })),
        ok: problems.every((p) => p.severity !== "problem"),
      });
    }),
  );
}

/** The parts of an agent's registration these routes read. */
interface AgentConfigView {
  kind?: string;
  vault?: string;
  protection?: string;
  connection?: "runner" | "url";
  mode?: string;
}
