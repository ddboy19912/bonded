import type pg from "pg";
import type { Connection, Database } from "./index.js";

/**
 * The payment gate's payout route (migration 0028): each gate account's payout link (its provider
 * credential, stored only sealed to the payout proxy in the TEE) and every payout. The API's payout
 * routes (apps/api/src/gate-payout.ts) decide; this only stores. Amounts are whole cents (USD).
 */

type Queryable = pg.Pool | Connection;

export interface GatePayoutLinkRecord {
  accountId: string;
  provider: "stripe";
  /** Sealed to the proxy's seal key: the API can't open it. */
  sealedCredential: unknown;
  sealedTo: string;
  teeMeasurement: string | null;
  teeComposeHash: string;
  keyHint: string;
  financialAccount: string;
  livemode: boolean;
  /** Encrypted with the API's secret box; never returned. */
  eventsSecretCiphertext: string;
  linkedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export type GatePayoutStatus =
  "pending" | "not_sent" | "unknown" | "processing" | "posted" | "failed" | "returned" | "canceled";

/** Statuses after which no money left (or it came back): the invoice is released. */
export const RELEASED_PAYOUT_STATUSES: readonly GatePayoutStatus[] = [
  "not_sent",
  "failed",
  "returned",
  "canceled",
];

export interface GatePayoutRecord {
  id: string;
  accountId: string;
  decisionId: string | null;
  keyId: string | null;
  paymentId: string | null;
  provider: string;
  providerPayoutId: string | null;
  status: GatePayoutStatus;
  /** False for a payout the provider reported that the gate never approved. */
  gateApproved: boolean;
  amountCents: number;
  payee: string;
  destination: string;
  vendorId: string | null;
  reference: string;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const link = (r: Record<string, unknown>): GatePayoutLinkRecord => ({
  accountId: r.account_id as string,
  provider: r.provider as "stripe",
  sealedCredential: r.sealed_credential,
  sealedTo: r.sealed_to as string,
  teeMeasurement: (r.tee_measurement as string | null) ?? null,
  teeComposeHash: r.tee_compose_hash as string,
  keyHint: r.key_hint as string,
  financialAccount: r.financial_account as string,
  livemode: r.livemode as boolean,
  eventsSecretCiphertext: r.events_secret_ciphertext as string,
  linkedBy: r.linked_by as string,
  createdAt: r.created_at as Date,
  updatedAt: r.updated_at as Date,
});

const payout = (r: Record<string, unknown>): GatePayoutRecord => ({
  id: r.id as string,
  accountId: r.account_id as string,
  decisionId: (r.decision_id as string | null) ?? null,
  keyId: (r.key_id as string | null) ?? null,
  paymentId: r.payment_id === null || r.payment_id === undefined ? null : String(r.payment_id),
  provider: r.provider as string,
  providerPayoutId: (r.provider_payout_id as string | null) ?? null,
  status: r.status as GatePayoutStatus,
  gateApproved: r.gate_approved as boolean,
  amountCents: Number(r.amount_cents),
  payee: r.payee as string,
  destination: r.destination as string,
  vendorId: (r.vendor_id as string | null) ?? null,
  reference: r.reference as string,
  error: (r.error as string | null) ?? null,
  createdAt: r.created_at as Date,
  updatedAt: r.updated_at as Date,
});

export class GatePayoutStore {
  constructor(private readonly db: Database) {}

  private get pool() {
    return this.db.pool;
  }

  // The payout link.

  async link(accountId: string, q: Queryable = this.pool) {
    const r = await q.query("SELECT * FROM gate_payout_links WHERE account_id=$1", [accountId]);
    return r.rows[0] ? link(r.rows[0]) : undefined;
  }

  /** Link (or relink) a gate account's payout provider account. */
  async setLink(
    l: Omit<GatePayoutLinkRecord, "createdAt" | "updatedAt">,
  ): Promise<GatePayoutLinkRecord> {
    const r = await this.pool.query(
      `INSERT INTO gate_payout_links(account_id,provider,sealed_credential,sealed_to,
         tee_measurement,tee_compose_hash,key_hint,financial_account,livemode,
         events_secret_ciphertext,linked_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT(account_id) DO UPDATE SET provider=EXCLUDED.provider,
         sealed_credential=EXCLUDED.sealed_credential, sealed_to=EXCLUDED.sealed_to,
         tee_measurement=EXCLUDED.tee_measurement, tee_compose_hash=EXCLUDED.tee_compose_hash,
         key_hint=EXCLUDED.key_hint, financial_account=EXCLUDED.financial_account,
         livemode=EXCLUDED.livemode, events_secret_ciphertext=EXCLUDED.events_secret_ciphertext,
         linked_by=EXCLUDED.linked_by, updated_at=now()
       RETURNING *`,
      [
        l.accountId,
        l.provider,
        JSON.stringify(l.sealedCredential),
        l.sealedTo,
        l.teeMeasurement,
        l.teeComposeHash,
        l.keyHint,
        l.financialAccount,
        l.livemode,
        l.eventsSecretCiphertext,
        l.linkedBy,
      ],
    );
    return link(r.rows[0]);
  }

  /** Cut the gate account off from its provider account: no payout can be made through the gate. */
  async unlink(accountId: string): Promise<boolean> {
    const r = await this.pool.query("DELETE FROM gate_payout_links WHERE account_id=$1", [
      accountId,
    ]);
    return (r.rowCount ?? 0) > 0;
  }

  // Payouts.

  async addPayout(
    c: Connection,
    p: Omit<GatePayoutRecord, "createdAt" | "updatedAt" | "error"> & { createdAt: Date },
  ): Promise<GatePayoutRecord> {
    const r = await c.query(
      `INSERT INTO gate_payouts(id,account_id,decision_id,key_id,payment_id,provider,
         provider_payout_id,status,gate_approved,amount_cents,payee,destination,vendor_id,
         reference,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15) RETURNING *`,
      [
        p.id,
        p.accountId,
        p.decisionId,
        p.keyId,
        p.paymentId,
        p.provider,
        p.providerPayoutId,
        p.status,
        p.gateApproved,
        p.amountCents,
        p.payee,
        p.destination,
        p.vendorId,
        p.reference,
        p.createdAt,
      ],
    );
    return payout(r.rows[0]);
  }

  async payout(
    accountId: string,
    id: string,
    q: Queryable = this.pool,
  ): Promise<GatePayoutRecord | undefined> {
    const r = await q.query("SELECT * FROM gate_payouts WHERE account_id=$1 AND id=$2", [
      accountId,
      id,
    ]);
    return r.rows[0] ? payout(r.rows[0]) : undefined;
  }

  async payoutByDecision(q: Queryable, decisionId: string): Promise<GatePayoutRecord | undefined> {
    const r = await q.query("SELECT * FROM gate_payouts WHERE decision_id=$1", [decisionId]);
    return r.rows[0] ? payout(r.rows[0]) : undefined;
  }

  async payoutByProvider(
    q: Queryable,
    accountId: string,
    providerPayoutId: string,
  ): Promise<GatePayoutRecord | undefined> {
    const r = await q.query(
      "SELECT * FROM gate_payouts WHERE account_id=$1 AND provider_payout_id=$2",
      [accountId, providerPayoutId],
    );
    return r.rows[0] ? payout(r.rows[0]) : undefined;
  }

  /** An account's payouts, newest first; `before` is the id of the last one on the page before. */
  async payouts(
    accountId: string,
    options: { limit?: number; before?: string } = {},
  ): Promise<{ items: GatePayoutRecord[]; next: string | null }> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 25), 1), 100);
    const r = await this.pool.query(
      `SELECT * FROM gate_payouts WHERE account_id=$1 AND ($2::uuid IS NULL OR
         (created_at, id) < (SELECT created_at, id FROM gate_payouts WHERE id=$2))
       ORDER BY created_at DESC, id DESC LIMIT $3`,
      [accountId, options.before ?? null, limit],
    );
    const items = r.rows.map(payout);
    return { items, next: items.length === limit ? items.at(-1)!.id : null };
  }

  /** Move a payout on: its status, and the provider's id or an error when given. */
  async update(
    q: Queryable,
    id: string,
    u: { status: GatePayoutStatus; providerPayoutId?: string; error?: string | null },
  ): Promise<GatePayoutRecord> {
    const r = await q.query(
      `UPDATE gate_payouts SET status=$2, provider_payout_id=COALESCE($3, provider_payout_id),
         error=CASE WHEN $4::boolean THEN $5 ELSE error END, updated_at=now()
       WHERE id=$1 RETURNING *`,
      [id, u.status, u.providerPayoutId ?? null, u.error !== undefined, u.error ?? null],
    );
    return payout(r.rows[0]);
  }

  /**
   * Release the payout's invoice: delete the payment that holds it, so the duplicate and daily
   * rules no longer count money that never left (or came back).
   */
  async release(c: Connection, p: GatePayoutRecord): Promise<void> {
    if (!p.paymentId) return;
    await c.query("UPDATE gate_payouts SET payment_id=NULL, updated_at=now() WHERE id=$1", [p.id]);
    await c.query("DELETE FROM gate_payments WHERE id=$1 AND account_id=$2", [
      p.paymentId,
      p.accountId,
    ]);
  }

  /** The payout's invoice is held again by `paymentId` (money the gate thought unsent went out). */
  async hold(c: Connection, id: string, paymentId: string): Promise<void> {
    await c.query("UPDATE gate_payouts SET payment_id=$2, updated_at=now() WHERE id=$1", [
      id,
      paymentId,
    ]);
  }

  /** The payment a check recorded for a decision, if any. */
  async paymentOf(c: Connection, decisionId: string): Promise<string | null> {
    const r = await c.query("SELECT id FROM gate_payments WHERE decision_id=$1", [decisionId]);
    return r.rows[0] ? String(r.rows[0].id) : null;
  }

  /** Every link, locked, for re-encrypting the events secrets with a new key (reencrypt.ts). */
  async allLinks(c: Connection): Promise<GatePayoutLinkRecord[]> {
    const r = await c.query("SELECT * FROM gate_payout_links ORDER BY account_id FOR UPDATE");
    return r.rows.map(link);
  }
}
