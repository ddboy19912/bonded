import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { OFFCHAIN_ATTACK_CLASSES, safeRequest } from "@bonded/arena";
import { DataApiStore, type Database, type IndexChange } from "@bonded/db";
import {
  BondedIndex,
  OFFCHAIN_LIBRARY_VERSION,
  indexModelSlug,
  lossPerThousandRuns,
  signAgentUrlRequest,
  type BondedIndexEntry,
} from "@bondedhq/shared";
import { Refused, handle } from "./refused.js";
import { RateLimiter, clientAddress } from "./rate-limit.js";
import { outboundUrlProblem } from "./outbound.js";
import { maskUrl } from "./notifications.js";
import { SECRET_KEY_MISSING, WEBHOOK_SECRET_PREFIX, newSecret, type SecretBox } from "./secrets.js";
import type { DataKeys } from "./data-keys.js";

/**
 * Model risk data (apps/api/DATA-API.md): the Bonded Index (config/bonded-index.json, written by
 * the Arena's sweep) as an API. Each model's Security and Task scores with their intervals, its
 * failures by attack class and by channel, its dollars at risk with their assumptions, the
 * off-chain library version it was rated on and when. Public, with a per-address limit; a data API
 * key gets a higher one and is counted. Only fields the Index page publishes are served, picked one
 * by one: never a held-out attack or anything the sweep keeps private.
 *
 * A key holder can register a webhook to be told when a model's score changes. The Index changes
 * with a deploy, so the keeper compares it with the last one it saw (`IndexWebhooks.sync`) and
 * queues a signed delivery per change and webhook, retried with backoff (`deliverDue`).
 */

/** The published Index. */
export const INDEX_FILE = fileURLToPath(
  new URL("../../../config/bonded-index.json", import.meta.url),
);

/** The Index and the sha256 of its file, so a change is seen whatever changed in it. */
export function readBondedIndex(path: string = INDEX_FILE): { index: BondedIndex; hash: string } {
  const text = readFileSync(path, "utf8");
  return {
    index: BondedIndex.parse(JSON.parse(text)),
    hash: createHash("sha256").update(text).digest("hex"),
  };
}

export interface ModelRiskOptions {
  keys: DataKeys;
  now: () => number;
  /** The Index file (default config/bonded-index.json). Read once: it changes with a deploy. */
  indexFile: string;
  secrets?: SecretBox;
  ownDomains: readonly string[];
  allowLoopbackUrls?: boolean;
  /** Index requests per client address per 10 minutes without a key (default 60). */
  publicPerTenMinutes: number;
  /** Index requests per key per 10 minutes (default 1,200). */
  keyedPerTenMinutes: number;
  /** Webhook changes per key per 10 minutes (default 30). */
  webhookWritesPerTenMinutes: number;
  /** Live webhooks per key (default 5). */
  maxWebhooksPerKey: number;
}

const sum = (e: BondedIndexEntry, f: (r: BondedIndexEntry["rows"][number]) => number) =>
  e.rows.reduce((n, r) => n + f(r), 0);
const rowOf = (e: BondedIndexEntry, mandate: "shown" | "hidden") =>
  e.rows.find((r) => r.mandate === mandate);
const className = (c: string) => OFFCHAIN_ATTACK_CLASSES[c as keyof typeof OFFCHAIN_ATTACK_CLASSES];

/** The Task score: the entry's own, else every run's job pooled (as the Index page reads it). */
export function taskScoreOf(e: BondedIndexEntry): number | null {
  if (e.task) return e.task.score;
  const total = sum(e, (r) => r.tasksTotal);
  return total === 0 ? 0 : Math.round((100 * sum(e, (r) => r.tasksDone)) / total);
}

/** Lost plus overpaid per 1,000 runs, with what it rests on (docs/SCORING.md, "Dollars at risk"). */
function dollarsAtRisk(e: BondedIndexEntry) {
  const lostUsd = sum(e, (r) => r.lossUsd);
  const overpaidUsd = sum(e, (r) => r.overpaidUsd);
  const runs = sum(e, (r) => r.tasksTotal);
  const attackRuns = sum(e, (r) => r.attackEpisodes);
  return {
    perThousandRunsUsd: lossPerThousandRuns(lostUsd, overpaidUsd, runs),
    lostUsd,
    overpaidUsd,
    runs,
    attackRuns,
    assumptions: [
      `The attacks are Bonded's off-chain library (version ${e.libraryVersion ?? 1}), each run as often as the others, not as often as they happen in the real world.`,
      `Every run counts, attacked or not: ${attackRuns} with an attack, ${Math.max(0, runs - attackRuns)} without.`,
      "Test money in a simulated accounts-payable ledger, with Bonded's own vendors and invoices.",
      "Lost is money paid to accounts outside the vendor list; overpaid is money paid to real vendors beyond what they were owed.",
      "Both briefings pooled: the agent told the mandate's rules, and told only its job.",
    ],
  };
}

/** Attack episodes and how many fell, by key, in each briefing and in all. */
function split(
  e: BondedIndexEntry,
  of: (r: BondedIndexEntry["rows"][number]) => Record<string, { episodes: number; fell: number }>,
) {
  const keys = [...new Set(e.rows.flatMap((r) => Object.keys(of(r))))];
  return keys.map((key) => {
    const shown = rowOf(e, "shown");
    const hidden = rowOf(e, "hidden");
    const s = shown ? (of(shown)[key] ?? null) : null;
    const h = hidden ? (of(hidden)[key] ?? null) : null;
    return {
      key,
      episodes: (s?.episodes ?? 0) + (h?.episodes ?? 0),
      fell: (s?.fell ?? 0) + (h?.fell ?? 0),
      shown: s && { episodes: s.episodes, fell: s.fell },
      hidden: h && { episodes: h.episodes, fell: h.fell },
    };
  });
}

/** The headline numbers of one model, for the list. */
export function modelSummary(e: BondedIndexEntry) {
  const slug = indexModelSlug(e.model);
  return {
    model: e.model,
    slug,
    label: e.label,
    provider: e.provider,
    family: e.family,
    version: e.version,
    libraryVersion: e.libraryVersion ?? 1,
    ranAt: e.ranAt,
    securityScore: e.score,
    securityInterval: e.scoreInterval,
    taskScore: taskScoreOf(e),
    dollarsAtRiskPerThousandRunsUsd: dollarsAtRisk(e).perThousandRunsUsd,
    url: `/data/index/models/${encodeURIComponent(slug)}`,
  };
}

/** One model in full: every number the Index page shows for it, and nothing else. */
export function modelView(e: BondedIndexEntry) {
  const w = e.worstClass;
  return {
    ...modelSummary(e),
    listed: e.listed,
    vision: e.vision,
    rail: e.rail,
    agent: e.agent,
    runsPerScenario: e.runsPerScenario,
    attacks: {
      seeds: e.attacks.seeds,
      variants: e.attacks.variants,
      hash: e.attacks.hash,
      notShown: e.attacks.notShown,
    },
    provenance: e.provenance ?? null,
    security: {
      score: e.score,
      interval: e.scoreInterval,
      attacksTested: e.attacksTested ?? null,
      riskCeiling: e.riskCeiling ?? null,
      worstBriefing: e.worst,
      setBy: w
        ? {
            class: w.class,
            name: className(w.class) ?? w.class,
            briefing: w.mandate,
            episodes: w.episodes,
            fell: w.fell,
            underSampled: w.underSampled ?? false,
          }
        : null,
    },
    task: {
      score: taskScoreOf(e),
      source: e.task?.source ?? "totals",
      part: e.task?.part ?? null,
    },
    dollarsAtRisk: dollarsAtRisk(e),
    failures: {
      byClass: split(e, (r) => r.byClass).map(({ key, ...rest }) => ({
        class: key,
        name: className(key) ?? key,
        ...rest,
      })),
      byChannel: split(e, (r) => r.byVector ?? {}).map(({ key, ...rest }) => ({
        channel: key,
        ...rest,
      })),
      breaches: Object.fromEntries(
        [...new Set(e.rows.flatMap((r) => Object.keys(r.breaches ?? {})))].map((type) => [
          type,
          {
            count: sum(e, (r) => r.breaches?.[type]?.count ?? 0),
            lossUsd: sum(e, (r) => r.breaches?.[type]?.lossUsd ?? 0),
            overpaidUsd: sum(e, (r) => r.breaches?.[type]?.overpaidUsd ?? 0),
          },
        ]),
      ),
    },
    briefings: e.rows.map((r) => ({
      mandate: r.mandate,
      attackEpisodes: r.attackEpisodes,
      fell: r.fell,
      manipulationRate: r.manipulationRate,
      interval: r.interval,
      lossUsd: r.lossUsd,
      overpaidUsd: r.overpaidUsd,
      tasksDone: r.tasksDone,
      tasksTotal: r.tasksTotal,
      taskParts: r.taskParts ?? null,
      errors: r.errors,
      ownErrors: r.ownErrors ?? null,
    })),
  };
}

/** What a webhook is told about a model: its scores, as they were and as they are. */
export const modelScores = (e: BondedIndexEntry) => ({
  label: e.label,
  securityScore: e.score,
  securityInterval: e.scoreInterval,
  taskScore: taskScoreOf(e),
  libraryVersion: e.libraryVersion ?? 1,
  ranAt: e.ranAt,
});
type ModelScores = ReturnType<typeof modelScores>;

/**
 * The changes from one Index to the next, by model: added, removed, or a Security or Task score
 * that moved. A new run with the same scores is not a change. Event ids carry the new snapshot's
 * id (`snapshot`), so the same Index seen again after another (A, B, A, B) is told again.
 */
export function indexChanges(
  before: Readonly<Record<string, ModelScores>>,
  after: Readonly<Record<string, ModelScores>>,
  ids: { from: string; to: string; updatedAt: string; snapshot: string },
): IndexChange[] {
  const out: IndexChange[] = [];
  for (const slug of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const was = before[slug];
    const now = after[slug];
    const change = !was ? "added" : !now ? "removed" : undefined;
    if (!change && was!.securityScore === now!.securityScore && was!.taskScore === now!.taskScore)
      continue;
    const eventId = `index:${ids.snapshot}:${ids.to.slice(0, 16)}:${slug}`;
    out.push({
      eventId,
      slug,
      payload: {
        id: eventId,
        type: "index.score_changed",
        change: change ?? "changed",
        model: slug,
        label: (now ?? was)!.label,
        before: was ?? null,
        after: now ?? null,
        index: { hash: ids.to, previous: ids.from, updatedAt: ids.updatedAt },
        url: `/data/index/models/${encodeURIComponent(slug)}`,
      },
    });
  }
  return out;
}

/** When a failed delivery is tried again: 1 minute, 5, 30, 2 hours, 12 hours; then it fails. */
export const WEBHOOK_RETRY_MS = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000] as const;
/** Where a webhook's signing secret is bound: its row. */
export const indexWebhookContext = (id: string) => `index-webhook:${id}`;

/**
 * The keeper's side of the webhooks: notice a new Index and queue its changes (`sync`), and send
 * what is due (`deliverDue`). Sending never throws; each failure is recorded on its delivery
 * without the URL or the secret, and tried again later.
 */
export class IndexWebhooks {
  private readonly store: DataApiStore;

  constructor(
    db: Database,
    private readonly options: {
      secrets?: SecretBox;
      /** Webhooks to plain http on this machine (tests only). */
      allowLoopback?: boolean;
      indexFile?: string;
      now?: () => number;
      post?: typeof safeRequest;
      log?: (line: string) => void;
    } = {},
  ) {
    this.store = new DataApiStore(db);
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }

  /** Record the Index if it is new and queue its changes. Returns the deliveries queued. */
  async sync(): Promise<number> {
    const { index, hash } = readBondedIndex(this.options.indexFile);
    const models = Object.fromEntries(
      index.entries.map((e) => [indexModelSlug(e.model), modelScores(e)]),
    );
    const queued = await this.store.recordIndex(
      { hash, models, updatedAt: index.updatedAt },
      (before, snapshot) =>
        indexChanges(before.models as Record<string, ModelScores>, models, {
          from: before.hash,
          to: hash,
          updatedAt: index.updatedAt,
          snapshot,
        }),
    );
    return queued ?? 0;
  }

  /** Send up to `limit` due deliveries. Returns how many were answered with a 2xx. */
  async deliverDue(limit = 20): Promise<number> {
    const due = await this.store.claimDue(limit, new Date(this.now()), 120_000);
    let delivered = 0;
    for (const d of due) {
      if (d.revoked || !this.options.secrets) {
        await this.store.finishDelivery(d.id, {
          status: "failed",
          httpStatus: null,
          error: d.revoked ? "the webhook was removed" : "webhooks are off on this service",
        });
        continue;
      }
      let httpStatus: number | null = null;
      let error: string;
      try {
        const secret = this.options.secrets.decrypt(
          d.secretCiphertext,
          indexWebhookContext(d.webhookId),
        );
        const body = JSON.stringify({ ...(d.payload as object), sentAt: new Date(this.now()) });
        const post = this.options.post ?? safeRequest;
        const answer = await post(new URL(d.url), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "bonded-event-id": d.eventId,
            ...(await signAgentUrlRequest(secret, body, this.now())),
          },
          body,
          timeoutMs: 10_000,
          maxBytes: 64 * 1024,
          ...(this.options.allowLoopback ? { allowLoopback: true } : {}),
        });
        httpStatus = answer.status;
        if (answer.status >= 200 && answer.status < 300) {
          await this.store.finishDelivery(d.id, { status: "delivered", httpStatus });
          delivered++;
          continue;
        }
        error = `the webhook answered ${answer.status}`;
      } catch (e) {
        // The error's name only: a message could carry the URL.
        error = `the webhook couldn't be reached (${e instanceof Error ? e.name : "error"})`;
      }
      const wait = WEBHOOK_RETRY_MS[d.attempts];
      await this.store.finishDelivery(
        d.id,
        wait === undefined
          ? { status: "failed", httpStatus, error }
          : { status: "pending", retryAt: new Date(this.now() + wait), httpStatus, error },
      );
      (this.options.log ?? ((l: string) => console.error(l)))(
        `index webhook ${d.webhookId}: ${error}`,
      );
    }
    return delivered;
  }

  async tick(): Promise<void> {
    await this.sync();
    await this.deliverDue();
  }
}

const modelInput = z
  .string()
  .min(1)
  .max(120)
  .transform((m) => indexModelSlug(m))
  .pipe(z.string().regex(/^[a-z0-9._-]{1,80}$/));
const webhookInput = z.strictObject({
  url: z.string().min(1).max(2048),
  /** Model ids or addresses to hear about; none (the default) for every model. */
  models: z.array(modelInput).max(50).default([]),
});

export function modelRiskRoutes(
  app: Hono,
  options: Partial<ModelRiskOptions> & Pick<ModelRiskOptions, "keys" | "now" | "ownDomains">,
) {
  const { keys, now } = options;
  const { index, hash } = readBondedIndex(options.indexFile);
  const bySlug = new Map(index.entries.map((e) => [indexModelSlug(e.model), e]));
  const publicClients = new RateLimiter({
    perClient: options.publicPerTenMinutes ?? 60,
    total: 6000,
    windowMs: 600_000,
    now,
  });
  const keyed = new RateLimiter({
    perClient: options.keyedPerTenMinutes ?? 1200,
    total: 100_000,
    windowMs: 600_000,
    now,
  });
  const webhookWrites = new RateLimiter({
    perClient: options.webhookWritesPerTenMinutes ?? 30,
    total: 10_000,
    windowMs: 600_000,
    now,
  });
  const maxWebhooks = options.maxWebhooksPerKey ?? 5;

  /** Anyone may read; a key raises the limit and is counted. */
  const reader = async (c: Context) => {
    const caller = await keys.optional(c);
    if (caller) {
      if (!keyed.allow(caller.keyId))
        throw new Refused(429, "Too many Index requests for this key. Try again in a few minutes.");
      await keys.count(caller, "index");
    } else if (!publicClients.allow(clientAddress(c.req.raw.headers)))
      throw new Refused(
        429,
        "Too many Index requests from here. Send a data API key for a higher limit, or try again in a few minutes.",
      );
    c.header("Cache-Control", "public, max-age=60");
  };
  const writer = async (c: Context) => {
    const caller = await keys.required(c);
    if (!webhookWrites.allow(caller.keyId))
      throw new Refused(429, "Too many requests. Try again in a few minutes.");
    await keys.count(caller, "webhooks");
    return caller;
  };
  const ownWebhook = async (c: Context, keyId: string) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    const found = id.success ? await keys.store.webhook(keyId, id.data) : undefined;
    if (!found || found.revokedAt) throw new Refused(404, "No such webhook on this key.");
    return found;
  };
  const webhookView = (w: { id: string; url: string; models: string[]; createdAt: Date }) => ({
    id: w.id,
    url: maskUrl(w.url),
    models: w.models,
    createdAt: w.createdAt.toISOString(),
  });

  /** Every model's headline numbers. */
  app.get(
    "/data/index",
    handle(async (c) => {
      await reader(c);
      return c.json({
        version: index.version,
        updatedAt: index.updatedAt,
        method: index.method,
        hash,
        offchainLibraryVersion: OFFCHAIN_LIBRARY_VERSION,
        count: index.entries.length,
        models: index.entries.map(modelSummary),
      });
    }),
  );
  /** One model in full, by its id's last part (`/index/<this>` on the site). */
  app.get(
    "/data/index/models/:slug",
    handle(async (c) => {
      await reader(c);
      const entry = bySlug.get((c.req.param("slug") ?? "").toLowerCase());
      if (!entry) throw new Refused(404, "No such model in the Bonded Index.");
      return c.json({
        ...modelView(entry),
        index: { updatedAt: index.updatedAt, hash, method: index.method },
      });
    }),
  );

  // Webhooks (data API key): told when a model's score changes.

  /** Register a webhook. Its signing secret is returned once. */
  app.post(
    "/data/webhooks",
    handle(async (c) => {
      const caller = await writer(c);
      if (!options.secrets) throw new Refused(409, SECRET_KEY_MISSING);
      const input = webhookInput.parse(await c.req.json());
      const problem = outboundUrlProblem(input.url, options.ownDomains, options.allowLoopbackUrls);
      if (problem) throw new Refused(400, problem);
      const id = randomUUID();
      const secret = newSecret(WEBHOOK_SECRET_PREFIX);
      const made = await keys.store.createWebhook(
        {
          id,
          keyId: caller.keyId,
          url: input.url,
          secretCiphertext: options.secrets.encrypt(secret, indexWebhookContext(id)),
          models: [...new Set(input.models)],
        },
        maxWebhooks,
      );
      if ("refused" in made)
        throw new Refused(409, "This key has as many webhooks as it may.", {
          limit: maxWebhooks,
        });
      c.header("Cache-Control", "no-store");
      return c.json({ ...webhookView(made), secret }, 201);
    }),
  );
  app.get(
    "/data/webhooks",
    handle(async (c) => {
      const caller = await keys.required(c);
      await keys.count(caller, "webhooks");
      return c.json({ items: (await keys.store.webhooks(caller.keyId)).map(webhookView) });
    }),
  );
  /** A webhook's latest deliveries, newest first: status, attempts, the last answer. */
  app.get(
    "/data/webhooks/:id/deliveries",
    handle(async (c) => {
      const caller = await keys.required(c);
      await keys.count(caller, "webhooks");
      const hook = await ownWebhook(c, caller.keyId);
      const items = await keys.store.deliveries(hook.id);
      return c.json({
        items: items.map((d) => ({
          id: d.id,
          eventId: d.eventId,
          status: d.status,
          attempts: d.attempts,
          nextAt: d.status === "pending" ? d.nextAt.toISOString() : null,
          lastStatus: d.lastStatus,
          lastError: d.lastError,
          createdAt: d.createdAt.toISOString(),
          deliveredAt: d.deliveredAt?.toISOString() ?? null,
        })),
      });
    }),
  );
  app.delete(
    "/data/webhooks/:id",
    handle(async (c) => {
      const caller = await writer(c);
      const hook = await ownWebhook(c, caller.keyId);
      await keys.store.revokeWebhook(caller.keyId, hook.id);
      return c.json({ revoked: true });
    }),
  );
}
