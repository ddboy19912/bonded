import type { QueryResultRow } from "pg";
import type { Database } from "./index.js";

/**
 * The data APIs' state (migration 0027): data API keys and their meter, the Bonded Index webhooks
 * with the snapshots they are compared against and their deliveries, and testing-in-CI runs. The
 * API's routes (apps/api/src/data-keys.ts, model-risk.ts, ci-runs.ts, attack-data.ts) decide;
 * this only stores.
 */

export type DataApiName = "index" | "attacks" | "ci" | "webhooks";

export interface DataKeyRecord {
  id: string;
  prefix: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface IndexWebhookRecord {
  id: string;
  keyId: string;
  url: string;
  models: string[];
  createdAt: Date;
  revokedAt: Date | null;
}

export interface IndexSnapshot {
  id: string;
  hash: string;
  /** Each model's scores, by its address (`indexModelSlug`). */
  models: Record<string, unknown>;
  updatedAt: string;
  seenAt: Date;
}

/** One change to deliver: who it is about (`slug`), its id and its body. */
export interface IndexChange {
  eventId: string;
  slug: string;
  payload: unknown;
}

export interface WebhookDeliveryRecord {
  id: string;
  webhookId: string;
  eventId: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  nextAt: Date;
  lastStatus: number | null;
  lastError: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
}

/** A delivery claimed for an attempt, with what is needed to send it. */
export interface DueDelivery {
  id: string;
  webhookId: string;
  eventId: string;
  payload: unknown;
  attempts: number;
  url: string;
  secretCiphertext: string;
  revoked: boolean;
}

export type CiRunStatus = "checking" | "rating" | "passed" | "failed" | "error";

export interface CiRunRecord {
  id: string;
  keyId: string;
  owner: string;
  previewId: string;
  minScore: number;
  minTaskScore: number | null;
  status: CiRunStatus;
  checkId: string | null;
  ratingId: string | null;
  score: number | null;
  taskScore: number | null;
  reason: string | null;
  label: string;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

const key = (k: QueryResultRow): DataKeyRecord => ({
  id: k.id,
  prefix: k.prefix,
  label: k.label,
  createdAt: k.created_at,
  lastUsedAt: k.last_used_at,
  revokedAt: k.revoked_at,
});
const webhook = (w: QueryResultRow): IndexWebhookRecord => ({
  id: w.id,
  keyId: w.key_id,
  url: w.url,
  models: w.models,
  createdAt: w.created_at,
  revokedAt: w.revoked_at,
});
const delivery = (d: QueryResultRow): WebhookDeliveryRecord => ({
  id: String(d.id),
  webhookId: d.webhook_id,
  eventId: d.event_id,
  status: d.status,
  attempts: d.attempts,
  nextAt: d.next_at,
  lastStatus: d.last_status,
  lastError: d.last_error,
  createdAt: d.created_at,
  deliveredAt: d.delivered_at,
});
const ciRun = (r: QueryResultRow): CiRunRecord => ({
  id: r.id,
  keyId: r.key_id,
  owner: r.owner,
  previewId: r.preview_id,
  minScore: r.min_score,
  minTaskScore: r.min_task_score,
  status: r.status,
  checkId: r.check_id,
  ratingId: r.rating_id,
  score: r.score,
  taskScore: r.task_score,
  reason: r.reason,
  label: r.label,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  finishedAt: r.finished_at,
});

/** What moving a run on changes. */
export interface CiRunPatch {
  status: CiRunStatus;
  ratingId?: string;
  score?: number | null;
  taskScore?: number | null;
  reason?: string | null;
}

/** The update that moves run `id` on from `from`, returning the run. */
const patchCiRun = (id: string, from: CiRunStatus, patch: CiRunPatch): [string, unknown[]] => [
  `UPDATE ci_runs SET status=$3, rating_id=coalesce($4,rating_id), score=coalesce($5,score),
     task_score=coalesce($6,task_score), reason=coalesce($7,reason), updated_at=now(),
     finished_at=CASE WHEN $8 THEN now() ELSE finished_at END
   WHERE id=$1 AND status=$2 RETURNING *`,
  [
    id,
    from,
    patch.status,
    patch.ratingId ?? null,
    patch.score ?? null,
    patch.taskScore ?? null,
    patch.reason ?? null,
    patch.status !== "checking" && patch.status !== "rating",
  ],
];

export class DataApiStore {
  constructor(private readonly db: Database) {}

  private get pool() {
    return this.db.pool;
  }

  // Keys and the meter.

  /** Make a key for `owner`, unless the owner already has `maxLive` live keys. */
  async createKey(
    owner: string,
    k: { id: string; hash: string; prefix: string; label: string },
    maxLive: number,
  ): Promise<DataKeyRecord | { refused: "too-many" }> {
    return this.db.transaction(async (c) => {
      // One owner's key creations in turn, so two at once can't both pass the count.
      await c.query("SELECT pg_advisory_xact_lock(7027, hashtext($1))", [owner]);
      const n = (
        await c.query(
          "SELECT count(*)::int AS n FROM data_api_keys WHERE owner=$1 AND revoked_at IS NULL",
          [owner],
        )
      ).rows[0].n as number;
      if (n >= maxLive) return { refused: "too-many" as const };
      const r = await c.query(
        "INSERT INTO data_api_keys(id,owner,key_hash,prefix,label) VALUES($1,$2,$3,$4,$5) RETURNING *",
        [k.id, owner, k.hash, k.prefix, k.label],
      );
      return key(r.rows[0]);
    });
  }

  async keys(owner: string): Promise<DataKeyRecord[]> {
    const r = await this.pool.query(
      "SELECT * FROM data_api_keys WHERE owner=$1 ORDER BY created_at, id",
      [owner],
    );
    return r.rows.map(key);
  }

  /** Revoke a key and the webhooks it registered. */
  async revokeKey(owner: string, keyId: string): Promise<boolean> {
    return this.db.transaction(async (c) => {
      const r = await c.query(
        "UPDATE data_api_keys SET revoked_at=now() WHERE owner=$1 AND id=$2 AND revoked_at IS NULL",
        [owner, keyId],
      );
      if (!r.rowCount) return false;
      await c.query(
        "UPDATE index_webhooks SET revoked_at=now() WHERE key_id=$1 AND revoked_at IS NULL",
        [keyId],
      );
      return true;
    });
  }

  /** The live key with this hash and its owner; marks it used. */
  async keyOwner(hash: string): Promise<{ keyId: string; owner: string } | undefined> {
    const r = await this.pool.query(
      `UPDATE data_api_keys SET last_used_at=now() WHERE key_hash=$1 AND revoked_at IS NULL
       RETURNING id, owner`,
      [hash],
    );
    return r.rows[0] ? { keyId: r.rows[0].id, owner: r.rows[0].owner } : undefined;
  }

  async countUsage(keyId: string, api: DataApiName, day: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO data_api_usage_daily(key_id,day,api,requests) VALUES($1,$2::date,$3,1)
       ON CONFLICT(key_id,day,api) DO UPDATE SET requests=data_api_usage_daily.requests+1`,
      [keyId, day, api],
    );
  }

  /** Requests per UTC day and API from `sinceDay` on, oldest first. */
  async usage(
    keyId: string,
    sinceDay: string,
  ): Promise<{ day: string; api: DataApiName; requests: number }[]> {
    const r = await this.pool.query(
      `SELECT day::text AS day, api, requests FROM data_api_usage_daily
       WHERE key_id=$1 AND day>=$2::date ORDER BY day, api`,
      [keyId, sinceDay],
    );
    return r.rows.map((u) => ({ day: u.day, api: u.api, requests: u.requests }));
  }

  // Index webhooks.

  async createWebhook(
    w: { id: string; keyId: string; url: string; secretCiphertext: string; models: string[] },
    maxLive: number,
  ): Promise<IndexWebhookRecord | { refused: "too-many" }> {
    return this.db.transaction(async (c) => {
      await c.query("SELECT id FROM data_api_keys WHERE id=$1 FOR UPDATE", [w.keyId]);
      const n = (
        await c.query(
          "SELECT count(*)::int AS n FROM index_webhooks WHERE key_id=$1 AND revoked_at IS NULL",
          [w.keyId],
        )
      ).rows[0].n as number;
      if (n >= maxLive) return { refused: "too-many" as const };
      const r = await c.query(
        `INSERT INTO index_webhooks(id,key_id,url,secret_ciphertext,models)
         VALUES($1,$2,$3,$4,$5) RETURNING *`,
        [w.id, w.keyId, w.url, w.secretCiphertext, w.models],
      );
      return webhook(r.rows[0]);
    });
  }

  async webhooks(keyId: string): Promise<IndexWebhookRecord[]> {
    const r = await this.pool.query(
      "SELECT * FROM index_webhooks WHERE key_id=$1 AND revoked_at IS NULL ORDER BY created_at, id",
      [keyId],
    );
    return r.rows.map(webhook);
  }

  async webhook(keyId: string, id: string): Promise<IndexWebhookRecord | undefined> {
    const r = await this.pool.query("SELECT * FROM index_webhooks WHERE key_id=$1 AND id=$2", [
      keyId,
      id,
    ]);
    return r.rows[0] ? webhook(r.rows[0]) : undefined;
  }

  async revokeWebhook(keyId: string, id: string): Promise<boolean> {
    const r = await this.pool.query(
      "UPDATE index_webhooks SET revoked_at=now() WHERE key_id=$1 AND id=$2 AND revoked_at IS NULL",
      [keyId, id],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** A webhook's deliveries, newest first. */
  async deliveries(webhookId: string, limit = 25): Promise<WebhookDeliveryRecord[]> {
    const r = await this.pool.query(
      "SELECT * FROM index_webhook_deliveries WHERE webhook_id=$1 ORDER BY id DESC LIMIT $2",
      [webhookId, Math.min(Math.max(limit, 1), 100)],
    );
    return r.rows.map(delivery);
  }

  /** The latest Index the keeper has seen. */
  async latestSnapshot(): Promise<IndexSnapshot | undefined> {
    const r = await this.pool.query("SELECT * FROM index_snapshots ORDER BY id DESC LIMIT 1");
    const s = r.rows[0];
    return s
      ? {
          id: String(s.id),
          hash: s.hash,
          models: s.models,
          updatedAt: s.updated_at,
          seenAt: s.seen_at,
        }
      : undefined;
  }

  /**
   * Record the Index with `hash`, unless it is the latest seen. The changes `changes` finds
   * against the one seen before are queued for every live webhook that asked for their model.
   * The first Index ever seen is the baseline: nothing is queued. `changes` is also given the new
   * snapshot's id, which no other snapshot has, so an Index seen again later (a rollback, then the
   * deploy again) gets new event ids instead of being dropped as a repeat. Returns the deliveries
   * queued, or undefined when the Index was already seen. One keeper at a time (an advisory lock).
   */
  async recordIndex(
    snapshot: { hash: string; models: Record<string, unknown>; updatedAt: string },
    changes: (before: IndexSnapshot, snapshotId: string) => IndexChange[],
  ): Promise<number | undefined> {
    return this.db.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(7027)");
      const latest = (await c.query("SELECT * FROM index_snapshots ORDER BY id DESC LIMIT 1"))
        .rows[0];
      if (latest?.hash === snapshot.hash) return undefined;
      const made = await c.query(
        "INSERT INTO index_snapshots(hash,models,updated_at) VALUES($1,$2,$3) RETURNING id",
        [snapshot.hash, JSON.stringify(snapshot.models), snapshot.updatedAt],
      );
      if (!latest) return 0;
      const found = changes(
        {
          id: String(latest.id),
          hash: latest.hash,
          models: latest.models,
          updatedAt: latest.updated_at,
          seenAt: latest.seen_at,
        },
        String(made.rows[0].id),
      );
      if (!found.length) return 0;
      const hooks = (
        await c.query(
          `SELECT w.id, w.models FROM index_webhooks w JOIN data_api_keys k ON k.id=w.key_id
           WHERE w.revoked_at IS NULL AND k.revoked_at IS NULL`,
        )
      ).rows as { id: string; models: string[] }[];
      let queued = 0;
      for (const change of found)
        for (const hook of hooks) {
          if (hook.models.length && !hook.models.includes(change.slug)) continue;
          const r = await c.query(
            `INSERT INTO index_webhook_deliveries(webhook_id,event_id,payload) VALUES($1,$2,$3)
             ON CONFLICT(webhook_id,event_id) DO NOTHING`,
            [hook.id, change.eventId, JSON.stringify(change.payload)],
          );
          queued += r.rowCount ?? 0;
        }
      return queued;
    });
  }

  /**
   * Claim up to `limit` deliveries whose next attempt is due: each is pushed `leaseMs` ahead, so
   * another keeper (or a crash mid-send) doesn't send it twice at once.
   */
  async claimDue(limit: number, now: Date, leaseMs: number): Promise<DueDelivery[]> {
    const r = await this.pool.query(
      `WITH due AS (
         SELECT id FROM index_webhook_deliveries WHERE status='pending' AND next_at<=$1
         ORDER BY next_at, id LIMIT $2 FOR UPDATE SKIP LOCKED
       )
       UPDATE index_webhook_deliveries d SET next_at=$3 FROM due WHERE d.id=due.id
       RETURNING d.id, d.webhook_id, d.event_id, d.payload, d.attempts`,
      [now, limit, new Date(now.getTime() + leaseMs)],
    );
    if (!r.rowCount) return [];
    const hooks = new Map(
      (
        await this.pool.query(
          `SELECT w.id, w.url, w.secret_ciphertext,
             (w.revoked_at IS NOT NULL OR k.revoked_at IS NOT NULL) AS revoked
           FROM index_webhooks w JOIN data_api_keys k ON k.id=w.key_id WHERE w.id=ANY($1::uuid[])`,
          [[...new Set(r.rows.map((d) => d.webhook_id))]],
        )
      ).rows.map((w) => [w.id as string, w]),
    );
    return r.rows.map((d) => {
      const w = hooks.get(d.webhook_id)!;
      return {
        id: String(d.id),
        webhookId: d.webhook_id,
        eventId: d.event_id,
        payload: d.payload,
        attempts: d.attempts,
        url: w.url,
        secretCiphertext: w.secret_ciphertext,
        revoked: w.revoked,
      };
    });
  }

  /** Record an attempt: delivered, tried again at `retryAt`, or failed for good. */
  async finishDelivery(
    id: string,
    outcome:
      | { status: "delivered"; httpStatus: number }
      | { status: "pending"; retryAt: Date; httpStatus: number | null; error: string }
      | { status: "failed"; httpStatus: number | null; error: string },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE index_webhook_deliveries SET status=$2, attempts=attempts+1, last_status=$3,
         last_error=$4, next_at=coalesce($5,next_at),
         delivered_at=CASE WHEN $2='delivered' THEN now() ELSE delivered_at END
       WHERE id=$1`,
      [
        id,
        outcome.status,
        outcome.httpStatus,
        outcome.status === "delivered" ? null : outcome.error,
        outcome.status === "pending" ? outcome.retryAt : null,
      ],
    );
  }

  // Testing in CI.

  async createCiRun(r: {
    id: string;
    keyId: string;
    owner: string;
    previewId: string;
    minScore: number;
    minTaskScore: number | null;
    status: CiRunStatus;
    checkId?: string | null;
    ratingId?: string | null;
    reason?: string | null;
    label: string;
  }): Promise<CiRunRecord> {
    const done = r.status !== "checking" && r.status !== "rating";
    const row = await this.pool.query(
      `INSERT INTO ci_runs(id,key_id,owner,preview_id,min_score,min_task_score,status,check_id,
         rating_id,reason,label,finished_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $12 THEN now() END) RETURNING *`,
      [
        r.id,
        r.keyId,
        r.owner,
        r.previewId,
        r.minScore,
        r.minTaskScore,
        r.status,
        r.checkId ?? null,
        r.ratingId ?? null,
        r.reason ?? null,
        r.label,
        done,
      ],
    );
    return ciRun(row.rows[0]);
  }

  async ciRun(id: string): Promise<CiRunRecord | undefined> {
    const r = await this.pool.query("SELECT * FROM ci_runs WHERE id=$1", [id]);
    return r.rows[0] ? ciRun(r.rows[0]) : undefined;
  }

  /** The owner's runs, newest first; `before` is the id of the last run of the page before. */
  async ciRuns(owner: string, limit: number, before?: string): Promise<CiRunRecord[]> {
    const r = await this.pool.query(
      `SELECT * FROM ci_runs WHERE owner=$1
         AND ($2::uuid IS NULL OR (created_at,id) < (SELECT created_at,id FROM ci_runs WHERE id=$2))
       ORDER BY created_at DESC, id DESC LIMIT $3`,
      [owner, before ?? null, limit],
    );
    return r.rows.map(ciRun);
  }

  /**
   * Move a run on from `from` (so two readers advancing it at once change it once). Returns the
   * run as it is now.
   */
  async advanceCiRun(
    id: string,
    from: CiRunStatus,
    patch: CiRunPatch,
  ): Promise<CiRunRecord | undefined> {
    await this.pool.query(...patchCiRun(id, from, patch));
    return this.ciRun(id);
  }

  /**
   * Move a run on from `from` by `step`, one reader at a time: the run's row is locked while `step`
   * runs, and a reader that finds it locked (or moved on) gets undefined at once without running
   * `step`. For a step with an effect outside the run, such as queueing its rating, so two readers
   * at once can't both act, or one record the other's refusal over the other's success.
   */
  async advanceCiRunOnce(
    id: string,
    from: CiRunStatus,
    step: (run: CiRunRecord) => Promise<CiRunPatch>,
  ): Promise<CiRunRecord | undefined> {
    return this.db.transaction(async (c) => {
      const row = (
        await c.query("SELECT * FROM ci_runs WHERE id=$1 AND status=$2 FOR UPDATE SKIP LOCKED", [
          id,
          from,
        ])
      ).rows[0];
      if (!row) return undefined;
      const r = await c.query(...patchCiRun(id, from, await step(ciRun(row))));
      return ciRun(r.rows[0]);
    });
  }

  // The held-out guard for the attack data export.

  /**
   * Every held-out attack this database has held, active or retired, on any chain: its id and
   * its spec. The export leaves out anything that matches one.
   */
  async heldOutAttacks(): Promise<{ id: string; spec: unknown }[]> {
    const r = await this.pool.query("SELECT attack_id, spec FROM held_out_attacks");
    return r.rows.map((h) => ({ id: h.attack_id, spec: h.spec }));
  }
}
