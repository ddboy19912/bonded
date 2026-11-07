import type pg from "pg";
import type { Connection, Database } from "./index.js";

/**
 * Watch mode (migration 0030): the wallets a gate account reads and the payments it saw after they
 * were made. The API (apps/api/src/gate-watch.ts) decides; this only stores. Amounts are whole
 * cents (USD).
 */

type Queryable = pg.Pool | Connection;

export interface GateWatchWalletRecord {
  id: string;
  accountId: string;
  chainId: number;
  /** Lower case. */
  address: string;
  label: string;
  nextBlock: bigint | null;
  lastReadAt: Date | null;
  createdAt: Date;
}

export interface GateWatchedPaymentRecord {
  id: string;
  accountId: string;
  source: "log" | "wallet";
  externalId: string;
  payee: string;
  payeeNorm: string;
  vendorId: string | null;
  amountCents: number;
  reference: string;
  rules: string[];
  lossCents: number;
  overpaidCents: number;
  matchedDecision: string | null;
  details: Record<string, string | number>;
  paidAt: Date;
  seenAt: Date;
}

const wallet = (r: Record<string, unknown>): GateWatchWalletRecord => ({
  id: r.id as string,
  accountId: r.account_id as string,
  chainId: r.chain_id as number,
  address: r.address as string,
  label: r.label as string,
  nextBlock: r.next_block === null ? null : BigInt(r.next_block as string),
  lastReadAt: (r.last_read_at as Date | null) ?? null,
  createdAt: r.created_at as Date,
});

const watched = (r: Record<string, unknown>): GateWatchedPaymentRecord => ({
  id: String(r.id),
  accountId: r.account_id as string,
  source: r.source as "log" | "wallet",
  externalId: r.external_id as string,
  payee: r.payee as string,
  payeeNorm: r.payee_norm as string,
  vendorId: (r.vendor_id as string | null) ?? null,
  amountCents: Number(r.amount_cents),
  reference: r.reference as string,
  rules: r.rules as string[],
  lossCents: Number(r.loss_cents),
  overpaidCents: Number(r.overpaid_cents),
  matchedDecision: (r.matched_decision as string | null) ?? null,
  details: r.details as Record<string, string | number>,
  paidAt: r.paid_at as Date,
  seenAt: r.seen_at as Date,
});

/** One line of an account's activity: a check, or a payment seen after it was made. */
export interface GateActivityEntry {
  entry: "decision" | "watched";
  id: string;
  source: "check" | "card" | "log" | "wallet";
}

export class GateWatchStore {
  constructor(private readonly db: Database) {}

  private get pool() {
    return this.db.pool;
  }

  /** Add a wallet, unless the account has `max` already. Undefined if it is already there. */
  async addWallet(
    w: { id: string; accountId: string; chainId: number; address: string; label: string },
    max: number,
  ): Promise<GateWatchWalletRecord | undefined | { refused: "too-many" }> {
    return this.db.transaction(async (c) => {
      await c.query("SELECT 1 FROM gate_accounts WHERE id=$1 FOR UPDATE", [w.accountId]);
      const n = (
        await c.query("SELECT count(*)::int AS n FROM gate_watch_wallets WHERE account_id=$1", [
          w.accountId,
        ])
      ).rows[0].n as number;
      if (n >= max) return { refused: "too-many" as const };
      const r = await c.query(
        `INSERT INTO gate_watch_wallets(id,account_id,chain_id,address,label) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (account_id,chain_id,address) DO NOTHING RETURNING *`,
        [w.id, w.accountId, w.chainId, w.address, w.label],
      );
      return r.rows[0] ? wallet(r.rows[0]) : undefined;
    });
  }

  async wallets(accountId: string): Promise<GateWatchWalletRecord[]> {
    const r = await this.pool.query(
      "SELECT * FROM gate_watch_wallets WHERE account_id=$1 ORDER BY created_at, id",
      [accountId],
    );
    return r.rows.map(wallet);
  }

  async deleteWallet(accountId: string, id: string): Promise<boolean> {
    const r = await this.pool.query(
      "DELETE FROM gate_watch_wallets WHERE account_id=$1 AND id=$2",
      [accountId, id],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Every wallet on these chains, the longest unread first. */
  async walletsToRead(chainIds: readonly number[]): Promise<GateWatchWalletRecord[]> {
    const r = await this.pool.query(
      `SELECT * FROM gate_watch_wallets WHERE chain_id = ANY($1::int[])
       ORDER BY last_read_at NULLS FIRST, id`,
      [[...chainIds]],
    );
    return r.rows.map(wallet);
  }

  /** The wallet is read up to, not including, `nextBlock`. */
  async walletRead(id: string, nextBlock: bigint, at: Date): Promise<void> {
    await this.pool.query(
      "UPDATE gate_watch_wallets SET next_block=$2, last_read_at=$3 WHERE id=$1",
      [id, nextBlock.toString(), at],
    );
  }

  async watchedPayment(
    c: Queryable,
    accountId: string,
    externalId: string,
  ): Promise<GateWatchedPaymentRecord | undefined> {
    const r = await c.query(
      "SELECT * FROM gate_watched_payments WHERE account_id=$1 AND external_id=$2",
      [accountId, externalId],
    );
    return r.rows[0] ? watched(r.rows[0]) : undefined;
  }

  /**
   * The earliest allowed check of this payee and amount in the window that no watched payment
   * took yet. Card checks are left out: a card charge is no wallet or logged payment.
   */
  async matchingCheck(
    c: Connection,
    accountId: string,
    q: { payeeNorm: string; amountCents: number; since: Date; until: Date },
  ): Promise<string | undefined> {
    const r = await c.query(
      `SELECT d.id FROM gate_decisions d
       WHERE d.account_id=$1 AND d.payee=$2 AND d.amount_cents=$3 AND d.result='allowed'
         AND d.kind IN ('invoice','refund','payment') AND d.created_at>=$4 AND d.created_at<=$5
         AND NOT EXISTS (SELECT 1 FROM gate_watched_payments w WHERE w.matched_decision=d.id)
       ORDER BY d.created_at, d.id LIMIT 1`,
      [accountId, q.payeeNorm, q.amountCents, q.since, q.until],
    );
    return r.rows[0]?.id as string | undefined;
  }

  async addWatched(
    c: Connection,
    w: Omit<GateWatchedPaymentRecord, "id" | "seenAt">,
  ): Promise<GateWatchedPaymentRecord> {
    const r = await c.query(
      `INSERT INTO gate_watched_payments(account_id,source,external_id,payee,payee_norm,vendor_id,
         amount_cents,reference,rules,loss_cents,overpaid_cents,matched_decision,details,paid_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        w.accountId,
        w.source,
        w.externalId,
        w.payee,
        w.payeeNorm,
        w.vendorId,
        w.amountCents,
        w.reference,
        w.rules,
        w.lossCents,
        w.overpaidCents,
        w.matchedDecision,
        JSON.stringify(w.details),
        w.paidAt,
      ],
    );
    return watched(r.rows[0]);
  }

  /** The payments seen, newest first. */
  async watchedPayments(accountId: string, options: { limit?: number; before?: string } = {}) {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 100);
    const r = await this.pool.query(
      `SELECT * FROM gate_watched_payments WHERE account_id=$1
         AND ($2::bigint IS NULL OR id<$2) ORDER BY id DESC LIMIT $3`,
      [accountId, options.before ?? null, limit],
    );
    const items = r.rows.map(watched);
    return { items, next: items.length === limit ? (items.at(-1)?.id ?? null) : null };
  }

  /**
   * The account's checks and watched payments in one list, newest first by when each happened.
   * `before` is the `next` of the page before; `result` "seen" means a watched payment.
   */
  async activity(
    accountId: string,
    options: { limit?: number; before?: string; source?: string; result?: string; rule?: string },
  ): Promise<{ items: GateActivityEntry[]; next: string | null }> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 100);
    const [at = null, entry = null, id = null] = options.before?.split("|") ?? [];
    const r = await this.pool.query(
      `SELECT entry, id, source, at::text AS at_text FROM (
         SELECT 'decision' AS entry, id::text AS id, created_at AS at, result, rules,
           CASE WHEN kind='card' THEN 'card' ELSE 'check' END AS source
         FROM gate_decisions WHERE account_id=$1
         UNION ALL
         SELECT 'watched', id::text, paid_at, 'seen', rules, source
         FROM gate_watched_payments WHERE account_id=$1
       ) a
       WHERE ($2::text IS NULL OR source=$2) AND ($3::text IS NULL OR result=$3)
         AND ($4::text IS NULL OR $4=ANY(rules))
         AND ($5::timestamptz IS NULL OR (at, entry, id) < ($5::timestamptz, $6::text, $7::text))
       ORDER BY at DESC, entry DESC, id DESC LIMIT $8`,
      [
        accountId,
        options.source ?? null,
        options.result ?? null,
        options.rule ?? null,
        at,
        entry,
        id,
        limit,
      ],
    );
    const last = r.rows.at(-1);
    return {
      items: r.rows.map((row) => ({ entry: row.entry, id: row.id, source: row.source })),
      next: r.rows.length === limit && last ? `${last.at_text}|${last.entry}|${last.id}` : null,
    };
  }

  /** These watched payments, in no order. */
  async watchedByIds(
    accountId: string,
    ids: readonly string[],
  ): Promise<GateWatchedPaymentRecord[]> {
    if (ids.length === 0) return [];
    const r = await this.pool.query(
      "SELECT * FROM gate_watched_payments WHERE account_id=$1 AND id = ANY($2::bigint[])",
      [accountId, [...ids]],
    );
    return r.rows.map(watched);
  }

  /** When a payment log last reported a payment to this account. */
  async lastReported(accountId: string): Promise<Date | null> {
    const r = await this.pool.query(
      "SELECT max(seen_at) AS at FROM gate_watched_payments WHERE account_id=$1 AND source='log'",
      [accountId],
    );
    return (r.rows[0].at as Date | null) ?? null;
  }

  /** Delete what was seen before this time. The payments it added stay in `gate_payments`. */
  async pruneWatched(before: Date): Promise<number> {
    const r = await this.pool.query("DELETE FROM gate_watched_payments WHERE seen_at<$1", [before]);
    return r.rowCount ?? 0;
  }
}
