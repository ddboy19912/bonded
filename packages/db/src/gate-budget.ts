import type pg from "pg";
import type { Connection, Database } from "./index.js";

/**
 * Budgets (migration 0033): one check covering many small payments to one payee, and the payments
 * reported against it. The API (apps/api/src/gate-budget.ts) decides; this only stores. Amounts
 * are micro-dollars (millionths of a US dollar).
 */

type Queryable = pg.Pool | Connection;

export interface GateBudgetRecord {
  /** The budget decision's id. */
  id: string;
  accountId: string;
  keyId: string | null;
  payee: string;
  payeeNorm: string;
  vendorId: string | null;
  budgetMicros: number;
  maxPaymentMicros: number;
  maxPayments: number | null;
  startsAt: Date;
  expiresAt: Date;
  /** The terms as signed (the decision input's `terms`). */
  terms: unknown;
  spentMicros: number;
  payments: number;
  closedAt: Date | null;
  closeDecision: string | null;
  createdAt: Date;
}

export interface GateBudgetSpendRecord {
  id: string;
  budgetId: string;
  spendId: string;
  amountMicros: number;
  reference: string;
  paidAt: Date;
  problem: string | null;
  recordedAt: Date;
}

const num = (v: unknown) => Number(v);

const budget = (r: Record<string, unknown>): GateBudgetRecord => ({
  id: r.id as string,
  accountId: r.account_id as string,
  keyId: (r.key_id as string | null) ?? null,
  payee: r.payee as string,
  payeeNorm: r.payee_norm as string,
  vendorId: (r.vendor_id as string | null) ?? null,
  budgetMicros: num(r.budget_micros),
  maxPaymentMicros: num(r.max_payment_micros),
  maxPayments: r.max_payments === null ? null : num(r.max_payments),
  startsAt: r.starts_at as Date,
  expiresAt: r.expires_at as Date,
  terms: r.terms,
  spentMicros: num(r.spent_micros),
  payments: num(r.payments),
  closedAt: (r.closed_at as Date | null) ?? null,
  closeDecision: (r.close_decision as string | null) ?? null,
  createdAt: r.created_at as Date,
});

const spend = (r: Record<string, unknown>): GateBudgetSpendRecord => ({
  id: String(r.id),
  budgetId: r.budget_id as string,
  spendId: r.spend_id as string,
  amountMicros: num(r.amount_micros),
  reference: r.reference as string,
  paidAt: r.paid_at as Date,
  problem: (r.problem as string | null) ?? null,
  recordedAt: r.recorded_at as Date,
});

export class GateBudgetStore {
  constructor(private readonly db: Database) {}

  private get pool() {
    return this.db.pool;
  }

  async add(
    c: Connection,
    b: Omit<
      GateBudgetRecord,
      "spentMicros" | "payments" | "closedAt" | "closeDecision" | "createdAt"
    >,
  ): Promise<GateBudgetRecord> {
    const r = await c.query(
      `INSERT INTO gate_budgets(id,account_id,key_id,payee,payee_norm,vendor_id,budget_micros,
         max_payment_micros,max_payments,starts_at,expires_at,terms)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        b.id,
        b.accountId,
        b.keyId,
        b.payee,
        b.payeeNorm,
        b.vendorId,
        b.budgetMicros,
        b.maxPaymentMicros,
        b.maxPayments,
        b.startsAt,
        b.expiresAt,
        JSON.stringify(b.terms),
      ],
    );
    return budget(r.rows[0]);
  }

  async budget(accountId: string, id: string, q: Queryable = this.pool) {
    const r = await q.query("SELECT * FROM gate_budgets WHERE account_id=$1 AND id=$2", [
      accountId,
      id,
    ]);
    return r.rows[0] ? budget(r.rows[0]) : undefined;
  }

  /** The account's budgets, newest first; `open` for the ones not closed yet. */
  async budgets(
    accountId: string,
    options: { open?: boolean; limit?: number; before?: string } = {},
  ): Promise<{ items: GateBudgetRecord[]; next: string | null }> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 25), 1), 100);
    const r = await this.pool.query(
      `SELECT * FROM gate_budgets WHERE account_id=$1
         AND ($2::boolean IS NOT TRUE OR closed_at IS NULL)
         AND ($3::timestamptz IS NULL OR created_at<$3)
       ORDER BY created_at DESC, id DESC LIMIT $4`,
      [accountId, options.open ?? false, options.before ?? null, limit + 1],
    );
    const items = r.rows.slice(0, limit).map(budget);
    return {
      items,
      next: r.rows.length > limit ? items[items.length - 1]!.createdAt.toISOString() : null,
    };
  }

  /** Open budgets of the account that expired before `before`, oldest first. */
  async expired(c: Connection, accountId: string, before: Date): Promise<GateBudgetRecord[]> {
    const r = await c.query(
      `SELECT * FROM gate_budgets WHERE account_id=$1 AND closed_at IS NULL AND expires_at<$2
       ORDER BY expires_at, id`,
      [accountId, before],
    );
    return r.rows.map(budget);
  }

  /** Accounts with an open budget that expired before `before`, for the sweep. */
  async accountsWithExpired(before: Date, limit = 100): Promise<string[]> {
    const r = await this.pool.query(
      `SELECT DISTINCT account_id FROM gate_budgets WHERE closed_at IS NULL AND expires_at<$1
       LIMIT $2`,
      [before, limit],
    );
    return r.rows.map((row) => row.account_id as string);
  }

  /**
   * Payments open budgets may still make (those with a payment count), for the hourly limit. A
   * budget past its end makes none.
   */
  async reservedPayments(c: Connection, accountId: string, at: Date): Promise<number> {
    const r = await c.query(
      `SELECT coalesce(sum(greatest(max_payments - payments, 0)), 0)::int AS n FROM gate_budgets
       WHERE account_id=$1 AND closed_at IS NULL AND max_payments IS NOT NULL AND expires_at>$2`,
      [accountId, at],
    );
    return r.rows[0].n as number;
  }

  /** Payments reported against budgets since then, for the hourly limit. */
  async spendsSince(c: Connection, accountId: string, since: Date): Promise<number> {
    const r = await c.query(
      "SELECT count(*)::int AS n FROM gate_budget_spends WHERE account_id=$1 AND paid_at>=$2",
      [accountId, since],
    );
    return r.rows[0].n as number;
  }

  /** The budget's spends in the order they were recorded. */
  async spends(q: Queryable, budgetId: string): Promise<GateBudgetSpendRecord[]> {
    const r = await q.query("SELECT * FROM gate_budget_spends WHERE budget_id=$1 ORDER BY id", [
      budgetId,
    ]);
    return r.rows.map(spend);
  }

  /** Record a spend; undefined when its id was recorded before. Updates the budget's totals. */
  async addSpend(
    c: Connection,
    s: {
      budgetId: string;
      accountId: string;
      spendId: string;
      amountMicros: number;
      reference: string;
      paidAt: Date;
      problem: string | null;
    },
  ): Promise<GateBudgetSpendRecord | undefined> {
    const r = await c.query(
      `INSERT INTO gate_budget_spends(budget_id,account_id,spend_id,amount_micros,reference,
         paid_at,problem)
       VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(budget_id,spend_id) DO NOTHING RETURNING *`,
      [s.budgetId, s.accountId, s.spendId, s.amountMicros, s.reference, s.paidAt, s.problem],
    );
    if (!r.rows[0]) return undefined;
    await c.query(
      "UPDATE gate_budgets SET spent_micros=spent_micros+$2, payments=payments+1 WHERE id=$1",
      [s.budgetId, s.amountMicros],
    );
    return spend(r.rows[0]);
  }

  async close(c: Connection, id: string, closeDecision: string, at: Date): Promise<void> {
    await c.query("UPDATE gate_budgets SET closed_at=$2, close_decision=$3 WHERE id=$1", [
      id,
      at,
      closeDecision,
    ]);
  }

  /**
   * The reported payment a watched payment is: same payee, the exact amount, paid within the drift
   * of when it was reported as paid, and no other watched payment is it yet. Open or closed budget.
   */
  async matchingSpend(
    c: Connection,
    accountId: string,
    q: { payeeNorm: string; amountMicros: number; paidAt: Date; driftMs: number },
  ): Promise<{ budgetId: string; spendId: string } | undefined> {
    const r = await c.query(
      `SELECT s.id, s.budget_id FROM gate_budget_spends s JOIN gate_budgets b ON b.id=s.budget_id
       WHERE s.account_id=$1 AND b.payee_norm=$2 AND s.amount_micros=$5
         AND s.paid_at BETWEEN $3::timestamptz - make_interval(secs => $4::double precision / 1000)
                           AND $3::timestamptz + make_interval(secs => $4::double precision / 1000)
         AND NOT EXISTS (SELECT 1 FROM gate_watched_payments w WHERE w.matched_spend=s.id)
       ORDER BY abs(extract(epoch FROM s.paid_at - $3::timestamptz)), s.id LIMIT 1`,
      [accountId, q.payeeNorm, q.paidAt, q.driftMs, q.amountMicros],
    );
    return r.rows[0]
      ? { budgetId: r.rows[0].budget_id as string, spendId: String(r.rows[0].id) }
      : undefined;
  }

  /**
   * A payment just reported takes the watched payment waiting under its budget with the same
   * exact amount, paid within the drift, if Watch saw it first.
   */
  async linkSpend(
    c: Connection,
    q: { budgetId: string; spendId: string; amountMicros: number; paidAt: Date; driftMs: number },
  ): Promise<void> {
    await c.query(
      `UPDATE gate_watched_payments SET matched_spend=$2 WHERE id=(
         SELECT id FROM gate_watched_payments
         WHERE matched_budget=$1 AND matched_spend IS NULL AND amount_micros=$3
           AND paid_at BETWEEN $4::timestamptz - make_interval(secs => $5::double precision / 1000)
                           AND $4::timestamptz + make_interval(secs => $5::double precision / 1000)
         ORDER BY abs(extract(epoch FROM paid_at - $4::timestamptz)), id LIMIT 1)`,
      [q.budgetId, q.spendId, q.amountMicros, q.paidAt, q.driftMs],
    );
  }

  /** Watched payments under the budget that no reported payment is: unreported so far. */
  async unreported(c: Connection, budgetId: string): Promise<string[]> {
    const r = await c.query(
      `SELECT id FROM gate_watched_payments WHERE matched_budget=$1 AND matched_spend IS NULL
       ORDER BY id`,
      [budgetId],
    );
    return r.rows.map((row) => String(row.id));
  }

  /**
   * The open budget a watched payment may fall under while its reported payment hasn't come yet:
   * same payee, paid while it was open (with clock drift), and room for the payment by count and
   * by exact amount, counting the watched payments already under it.
   */
  async matching(
    c: Connection,
    accountId: string,
    q: { payeeNorm: string; amountMicros: number; paidAt: Date; driftMs: number },
  ): Promise<string | undefined> {
    const r = await c.query(
      `SELECT b.id FROM gate_budgets b
       WHERE b.account_id=$1 AND b.payee_norm=$2 AND b.closed_at IS NULL
         AND b.starts_at - make_interval(secs => $4::double precision / 1000) <= $3
         AND b.expires_at + make_interval(secs => $4::double precision / 1000) >= $3
         AND $5 <= b.max_payment_micros
         AND (SELECT coalesce(sum(w.amount_micros), 0) FROM gate_watched_payments w
              WHERE w.matched_budget=b.id) + $5 <= b.budget_micros
         AND (b.max_payments IS NULL OR (SELECT count(*) FROM gate_watched_payments w
              WHERE w.matched_budget=b.id) < b.max_payments)
       ORDER BY b.starts_at, b.id LIMIT 1`,
      [accountId, q.payeeNorm, q.paidAt, q.driftMs, q.amountMicros],
    );
    return r.rows[0]?.id as string | undefined;
  }

  /** Delete budgets closed before `before`, and their spends. */
  async prune(before: Date): Promise<number> {
    const r = await this.pool.query(
      "DELETE FROM gate_budgets WHERE closed_at IS NOT NULL AND closed_at<$1",
      [before],
    );
    return r.rowCount ?? 0;
  }
}
