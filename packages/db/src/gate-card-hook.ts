import type pg from "pg";
import type { Connection, Database } from "./index.js";

/**
 * Card hooks (migration 0031): a business's own card program asks the gate before each charge.
 * Bonded keeps only what proves a request is real: an encrypted signing secret (Stripe, Lithic)
 * or the hash of a password it made (Marqeta). The API (apps/api/src/gate-card-hook.ts) decides;
 * this only stores. Amounts are whole cents (USD).
 */

type Queryable = pg.Pool | Connection;

export type GateCardHookProvider = "stripe" | "lithic" | "marqeta";

export interface GateCardHookRecord {
  id: string;
  accountId: string;
  provider: GateCardHookProvider;
  label: string;
  secretCiphertext: string | null;
  secretHint: string;
  basicUser: string | null;
  basicPasswordHash: string | null;
  createdBy: string;
  createdAt: Date;
  lastRequestAt: Date | null;
}

const hook = (r: Record<string, unknown>): GateCardHookRecord => ({
  id: r.id as string,
  accountId: r.account_id as string,
  provider: r.provider as GateCardHookProvider,
  label: r.label as string,
  secretCiphertext: (r.secret_ciphertext as string | null) ?? null,
  secretHint: r.secret_hint as string,
  basicUser: (r.basic_user as string | null) ?? null,
  basicPasswordHash: (r.basic_password_hash as string | null) ?? null,
  createdBy: r.created_by as string,
  createdAt: r.created_at as Date,
  lastRequestAt: (r.last_request_at as Date | null) ?? null,
});

export class GateCardHookStore {
  constructor(private readonly db: Database) {}

  private get pool() {
    return this.db.pool;
  }

  /** Add a hook, unless the account has `max` already. */
  async add(
    h: Omit<GateCardHookRecord, "createdAt" | "lastRequestAt">,
    max: number,
  ): Promise<GateCardHookRecord | { refused: "too-many" }> {
    return this.db.transaction(async (c) => {
      await c.query("SELECT 1 FROM gate_accounts WHERE id=$1 FOR UPDATE", [h.accountId]);
      const n = (
        await c.query("SELECT count(*)::int AS n FROM gate_card_hooks WHERE account_id=$1", [
          h.accountId,
        ])
      ).rows[0].n as number;
      if (n >= max) return { refused: "too-many" as const };
      const r = await c.query(
        `INSERT INTO gate_card_hooks(id,account_id,provider,label,secret_ciphertext,secret_hint,
           basic_user,basic_password_hash,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          h.id,
          h.accountId,
          h.provider,
          h.label,
          h.secretCiphertext,
          h.secretHint,
          h.basicUser,
          h.basicPasswordHash,
          h.createdBy,
        ],
      );
      return hook(r.rows[0]);
    });
  }

  async hooks(accountId: string): Promise<GateCardHookRecord[]> {
    const r = await this.pool.query(
      "SELECT * FROM gate_card_hooks WHERE account_id=$1 ORDER BY created_at, id",
      [accountId],
    );
    return r.rows.map(hook);
  }

  /** The hook a request names, by its id alone (the card program doesn't know the account). */
  async hook(id: string): Promise<GateCardHookRecord | undefined> {
    const r = await this.pool.query("SELECT * FROM gate_card_hooks WHERE id=$1", [id]);
    return r.rows[0] ? hook(r.rows[0]) : undefined;
  }

  async remove(accountId: string, id: string): Promise<boolean> {
    const r = await this.pool.query("DELETE FROM gate_card_hooks WHERE account_id=$1 AND id=$2", [
      accountId,
      id,
    ]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Set (or replace) a Stripe or Lithic hook's signing secret. Undefined if there's no such hook. */
  async setSecret(
    accountId: string,
    id: string,
    secret: { ciphertext: string; hint: string },
  ): Promise<GateCardHookRecord | undefined> {
    const r = await this.pool.query(
      `UPDATE gate_card_hooks SET secret_ciphertext=$3, secret_hint=$4
       WHERE account_id=$1 AND id=$2 AND provider<>'marqeta' RETURNING *`,
      [accountId, id, secret.ciphertext, secret.hint],
    );
    return r.rows[0] ? hook(r.rows[0]) : undefined;
  }

  /** The program asked: shown on the Connect tab. */
  async asked(id: string, at: Date, c: Queryable = this.pool): Promise<void> {
    await c.query("UPDATE gate_card_hooks SET last_request_at=$2 WHERE id=$1", [id, at]);
  }

  /**
   * What a charge's rules read: the vendors whose card merchant on file is this merchant, and the
   * payments of the day (for the daily limit). A charge has no reference, so no duplicate check
   * reads more.
   */
  async chargeState(
    c: Connection,
    accountId: string,
    q: { merchantKey: string; day: string },
  ): Promise<{
    payees: { vendorId: string; account: string }[];
    payments: {
      account: string;
      vendorId: string | null;
      amountCents: number;
      reference: string;
      day: string;
      kind: "invoice" | "refund";
    }[];
  }> {
    const payees = (
      await c.query(
        `SELECT id, card_merchant_norm FROM gate_vendors WHERE account_id=$1
         AND card_merchant_norm=$2 ORDER BY id`,
        [accountId, q.merchantKey],
      )
    ).rows.map((v) => ({ vendorId: v.id as string, account: v.card_merchant_norm as string }));
    const payments = (
      await c.query(
        `SELECT payee_norm, vendor_id, amount_cents, reference, day::text AS day, kind
         FROM gate_payments WHERE account_id=$1 AND day=$2::date ORDER BY id`,
        [accountId, q.day],
      )
    ).rows.map((p) => ({
      account: p.payee_norm as string,
      vendorId: (p.vendor_id as string | null) ?? null,
      amountCents: Number(p.amount_cents),
      reference: p.reference as string,
      day: p.day as string,
      kind: p.kind as "invoice" | "refund",
    }));
    return { payees, payments };
  }
}
