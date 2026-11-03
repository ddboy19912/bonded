import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { DataApiStore, type DataApiName, type Database } from "@bonded/db";
import { utcDay } from "@bondedhq/shared";
import { Refused, handle } from "./refused.js";
import { RateLimiter, clientAddress } from "./rate-limit.js";
import type { SessionWallet } from "./sessions.js";
import type { SecretBox } from "./secrets.js";
import type { PreviewRatingFlow } from "./previews.js";
import { modelRiskRoutes, type ModelRiskOptions } from "./model-risk.js";
import { ciRunRoutes, type CiRunOptions } from "./ci-runs.js";
import { attackDataRoutes, type AttackDataOptions } from "./attack-data.js";

/**
 * The data APIs (apps/api/DATA-API.md): model risk data from the Bonded Index (model-risk.ts),
 * testing in CI (ci-runs.ts) and attack data (attack-data.ts). A builder makes data API keys with
 * their wallet session (sessions.ts); a key is made and kept the way gate API keys are (gate.ts):
 * 32 random bytes, shown once, stored as its sha256. Each API checks the key itself, and counts
 * each keyed request on the key's meter. Every route under /data and /ci authenticates itself (a
 * session, a data API key, or none for the public Index), so the operator-token check in index.ts
 * lets them through (`dataOpen`).
 */

export const DATA_KEY_PREFIX = "bonded_dk_";

/** Routes under /data and /ci do their own authentication (see the module comment). */
export const dataOpen = (path: string) => /^\/(data|ci)(\/|$)/.test(path);

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** A new key: the key itself (shown once) and what is stored (its hash and a prefix). */
export const newDataKey = (label: string) => {
  const key = `${DATA_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return {
    key,
    stored: { id: randomUUID(), hash: sha256(key), prefix: key.slice(0, 14), label },
  };
};

/** Who is calling with a data API key. */
export interface DataCaller {
  keyId: string;
  owner: string;
}

/** Checks data API keys and counts their use. Shared by the three APIs. */
export class DataKeys {
  private readonly clients: RateLimiter;

  constructor(
    readonly store: DataApiStore,
    private readonly now: () => number,
    /** Keyed requests per client address per minute (default 1,200): no guessing keys. */
    perMinute = 1200,
  ) {
    this.clients = new RateLimiter({ perClient: perMinute, total: 100_000, windowMs: 60_000, now });
  }

  /** The bearer token, when it is a data API key. */
  private token(c: Context): string | undefined {
    const header = c.req.header("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    return token.startsWith(DATA_KEY_PREFIX) ? token : undefined;
  }

  /** The key's caller; refused without a valid, live key. */
  async required(c: Context): Promise<DataCaller> {
    const caller = await this.optional(c);
    if (!caller) throw new Refused(401, "Send your data API key.");
    return caller;
  }

  /** The key's caller, or undefined when no data API key was sent. A bad key is refused. */
  async optional(c: Context): Promise<DataCaller | undefined> {
    const token = this.token(c);
    if (!token) return undefined;
    if (!this.clients.allow(clientAddress(c.req.raw.headers)))
      throw new Refused(429, "Too many requests. Try again in a few minutes.");
    const found = /^bonded_dk_[A-Za-z0-9_-]{43}$/.test(token)
      ? await this.store.keyOwner(sha256(token))
      : undefined;
    if (!found) throw new Refused(401, "That data API key isn't valid or was revoked.");
    return found;
  }

  /** One request on the key's meter, for `api`. */
  count(caller: DataCaller, api: DataApiName): Promise<void> {
    return this.store.countUsage(caller.keyId, api, utcDay(new Date(this.now())));
  }
}

export interface DataApiOptions {
  db: Database;
  wallet: SessionWallet;
  /** The owner routes' limiters (index.ts). */
  writes: RateLimiter;
  reads: RateLimiter;
  now: () => number;
  /** The preview rating flow (previews.ts), which CI runs reuse. */
  previewRating: PreviewRatingFlow;
  secrets?: SecretBox | undefined;
  ownDomains: readonly string[];
  allowLoopbackUrls?: boolean | undefined;
  /** Live data API keys per wallet (default 10). */
  maxKeysPerOwner?: number;
  /** Keyed requests per client address per minute (default 1,200). */
  keyRequestsPerMinute?: number;
  modelRisk?: Partial<ModelRiskOptions>;
  ci?: Partial<CiRunOptions>;
  attacks?: Partial<AttackDataOptions>;
}

/** Register the data API keys' routes and the three APIs. */
export function dataApiRoutes(app: Hono, options: DataApiOptions) {
  const { db, wallet, now } = options;
  const store = new DataApiStore(db);
  const keys = new DataKeys(store, now, options.keyRequestsPerMinute);
  const maxKeys = options.maxKeysPerOwner ?? 10;
  const limited = (c: Context, limiter: RateLimiter) => {
    if (!limiter.allow(clientAddress(c.req.raw.headers)))
      throw new Refused(429, "Too many requests. Try again in a few minutes.");
  };
  const keyView = (k: Awaited<ReturnType<DataApiStore["keys"]>>[number]) => ({
    id: k.id,
    prefix: k.prefix,
    label: k.label,
    createdAt: k.createdAt.toISOString(),
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    revokedAt: k.revokedAt?.toISOString() ?? null,
  });
  /** The signed-in owner's key named in the path, or "not found" for anyone else. */
  const ownKey = async (c: Context, owner: string) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    const found = id.success ? (await store.keys(owner)).find((k) => k.id === id.data) : undefined;
    if (!found) throw new Refused(404, "No such data API key.");
    return found;
  };

  // Data API keys (owner session). A key is shown once, when it is made.

  app.post(
    "/data/keys",
    handle(async (c) => {
      limited(c, options.writes);
      const owner = (await wallet(c)).toLowerCase();
      const { label } = z
        .strictObject({
          label: z
            .string()
            .trim()
            .min(1)
            .max(80)
            .regex(/^[^\p{Cc}]*$/u)
            .optional(),
        })
        .parse(await c.req.json());
      const { key, stored } = newDataKey(label ?? "");
      const made = await store.createKey(owner, stored, maxKeys);
      if ("refused" in made)
        throw new Refused(409, "This wallet has as many live data API keys as it may.", {
          limit: maxKeys,
        });
      c.header("Cache-Control", "no-store");
      return c.json({ ...keyView(made), key }, 201);
    }),
  );
  app.get(
    "/data/keys",
    handle(async (c) => {
      limited(c, options.reads);
      const owner = (await wallet(c)).toLowerCase();
      return c.json({ items: (await store.keys(owner)).map(keyView) });
    }),
  );
  /** Revoke a key: it stops working at once, and its webhooks stop too. */
  app.delete(
    "/data/keys/:id",
    handle(async (c) => {
      limited(c, options.writes);
      const owner = (await wallet(c)).toLowerCase();
      const k = await ownKey(c, owner);
      if (!(await store.revokeKey(owner, k.id))) throw new Refused(404, "No such data API key.");
      return c.json({ revoked: true });
    }),
  );
  /** Requests per UTC day and API (the meter), `?days=` back from today (default 30). */
  app.get(
    "/data/keys/:id/usage",
    handle(async (c) => {
      limited(c, options.reads);
      const owner = (await wallet(c)).toLowerCase();
      const k = await ownKey(c, owner);
      const { days } = z
        .strictObject({ days: z.coerce.number().int().min(1).max(400).default(30) })
        .parse(c.req.query());
      const items = await store.usage(k.id, utcDay(new Date(now() - (days - 1) * 86_400_000)));
      return c.json({ items, total: items.reduce((sum, d) => sum + d.requests, 0) });
    }),
  );

  modelRiskRoutes(app, {
    keys,
    now,
    ...(options.secrets ? { secrets: options.secrets } : {}),
    ownDomains: options.ownDomains,
    ...(options.allowLoopbackUrls ? { allowLoopbackUrls: true } : {}),
    ...options.modelRisk,
  });
  ciRunRoutes(app, { keys, db, now, previewRating: options.previewRating, ...options.ci });
  attackDataRoutes(app, { keys, db, now, ...options.attacks });
  return { store, keys };
}
