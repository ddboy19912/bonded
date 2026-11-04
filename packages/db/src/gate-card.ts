import type pg from "pg";
import type { Connection, Database } from "./index.js";

/**
 * The payment gate's card route (migration 0025): each gate account's linked Stripe account, the
 * single-use cards issued per invoice (intents), the authorizations and transactions Stripe
 * reported on them, and the Stripe events already handled. The API's card routes
 * (apps/api/src/gate-card.ts) decide; this only stores. Amounts are whole cents (USD); a capture
 * is stored as a positive amount (money out), a refund as a negative one.
 */

type Queryable = pg.Pool | Connection;

export interface GateStripeLinkRecord {
  accountId: string;
  /**
   * The account's own restricted key, encrypted with the API's secret box and never returned by
   * the API. Null for a connected account.
   */
  keyCiphertext: string | null;
  /** The Stripe account connected to Bonded's platform (`acct_`). Null with a key of its own. */
  connectedAccount: string | null;
  keyHint: string;
  livemode: boolean;
  cardholderId: string;
  authorizationSecretCiphertext: string | null;
  eventsSecretCiphertext: string | null;
  linkedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export type GateCardIntentStatus =
  "creating" | "issued" | "authorized" | "paid" | "released" | "canceled" | "failed";

/** Statuses that hold the invoice: no second card is issued for it meanwhile. */
export const OPEN_INTENT_STATUSES: readonly GateCardIntentStatus[] = [
  "creating",
  "issued",
  "authorized",
];

export interface GateCardIntentRecord {
  id: string;
  accountId: string;
  keyId: string | null;
  vendorId: string;
  reference: string;
  referenceNorm: string;
  amountCents: number;
  cardId: string | null;
  cardLast4: string | null;
  status: GateCardIntentStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface GateCardAuthorizationRecord {
  id: string;
  accountId: string;
  intentId: string;
  decisionId: string | null;
  gateApproved: boolean | null;
  stripeApproved: boolean | null;
  /** What the gate approved in total, increments included. */
  approvedCents: number;
  /** What is held: the gate's approval, or what Stripe last reported. */
  amountCents: number;
  merchantKey: string;
  vendorId: string | null;
  status: string;
  /** UTC day, YYYY-MM-DD. */
  day: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface GateCardTransactionRecord {
  id: string;
  accountId: string;
  intentId: string;
  authorizationId: string | null;
  type: "capture" | "refund";
  amountCents: number;
  decisionId: string | null;
  paymentId: string | null;
  createdAt: Date;
}

const num = (v: unknown) => Number(v);

const link = (r: Record<string, unknown>): GateStripeLinkRecord => ({
  accountId: r.account_id as string,
  keyCiphertext: (r.key_ciphertext as string | null) ?? null,
  connectedAccount: (r.connected_account as string | null) ?? null,
  keyHint: r.key_hint as string,
  livemode: r.livemode as boolean,
  cardholderId: r.cardholder_id as string,
  authorizationSecretCiphertext: (r.authorization_secret_ciphertext as string | null) ?? null,
  eventsSecretCiphertext: (r.events_secret_ciphertext as string | null) ?? null,
  linkedBy: r.linked_by as string,
  createdAt: r.created_at as Date,
  updatedAt: r.updated_at as Date,
});

const intent = (r: Record<string, unknown>): GateCardIntentRecord => ({
  id: r.id as string,
  accountId: r.account_id as string,
  keyId: (r.key_id as string | null) ?? null,
  vendorId: r.vendor_id as string,
  reference: r.reference as string,
  referenceNorm: r.reference_norm as string,
  amountCents: num(r.amount_cents),
  cardId: (r.card_id as string | null) ?? null,
  cardLast4: (r.card_last4 as string | null) ?? null,
  status: r.status as GateCardIntentStatus,
  createdAt: r.created_at as Date,
  updatedAt: r.updated_at as Date,
});

const authorization = (r: Record<string, unknown>): GateCardAuthorizationRecord => ({
  id: r.id as string,
  accountId: r.account_id as string,
  intentId: r.intent_id as string,
  decisionId: (r.decision_id as string | null) ?? null,
  gateApproved: (r.gate_approved as boolean | null) ?? null,
  stripeApproved: (r.stripe_approved as boolean | null) ?? null,
  approvedCents: num(r.approved_cents),
  amountCents: num(r.amount_cents),
  merchantKey: r.merchant_key as string,
  vendorId: (r.vendor_id as string | null) ?? null,
  status: r.status as string,
  day: r.day as string,
  createdAt: r.created_at as Date,
  updatedAt: r.updated_at as Date,
});

const transaction = (r: Record<string, unknown>): GateCardTransactionRecord => ({
  id: r.id as string,
  accountId: r.account_id as string,
  intentId: r.intent_id as string,
  authorizationId: (r.authorization_id as string | null) ?? null,
  type: r.type as "capture" | "refund",
  amountCents: num(r.amount_cents),
  decisionId: (r.decision_id as string | null) ?? null,
  paymentId: r.payment_id === null || r.payment_id === undefined ? null : String(r.payment_id),
  createdAt: r.created_at as Date,
});

const OPEN = OPEN_INTENT_STATUSES.map((s) => `'${s}'`).join(",");

export class GateCardStore {
  constructor(private readonly db: Database) {}

  private get pool() {
    return this.db.pool;
  }

  // The linked Stripe account.

  async link(
    accountId: string,
    q: Queryable = this.pool,
  ): Promise<GateStripeLinkRecord | undefined> {
    const r = await q.query("SELECT * FROM gate_stripe_links WHERE account_id=$1", [accountId]);
    return r.rows[0] ? link(r.rows[0]) : undefined;
  }

  /** Link (or relink) a gate account's Stripe account. */
  async setLink(
    l: Omit<GateStripeLinkRecord, "createdAt" | "updatedAt">,
  ): Promise<GateStripeLinkRecord> {
    const r = await this.pool.query(
      `INSERT INTO gate_stripe_links(account_id,key_ciphertext,key_hint,livemode,cardholder_id,
         authorization_secret_ciphertext,events_secret_ciphertext,linked_by,connected_account)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT(account_id) DO UPDATE SET key_ciphertext=EXCLUDED.key_ciphertext,
         connected_account=EXCLUDED.connected_account,
         key_hint=EXCLUDED.key_hint, livemode=EXCLUDED.livemode,
         cardholder_id=EXCLUDED.cardholder_id,
         authorization_secret_ciphertext=EXCLUDED.authorization_secret_ciphertext,
         events_secret_ciphertext=EXCLUDED.events_secret_ciphertext,
         linked_by=EXCLUDED.linked_by, updated_at=now()
       RETURNING *`,
      [
        l.accountId,
        l.keyCiphertext,
        l.keyHint,
        l.livemode,
        l.cardholderId,
        l.authorizationSecretCiphertext,
        l.eventsSecretCiphertext,
        l.linkedBy,
        l.connectedAccount,
      ],
    );
    return link(r.rows[0]);
  }

  /** Cut the gate account off from its Stripe account: no new cards can be issued. */
  async unlink(accountId: string): Promise<boolean> {
    const r = await this.pool.query("DELETE FROM gate_stripe_links WHERE account_id=$1", [
      accountId,
    ]);
    return (r.rowCount ?? 0) > 0;
  }

  /** Every link, locked, for re-encrypting with a new key (reencrypt.ts). */
  async allLinks(c: Connection): Promise<GateStripeLinkRecord[]> {
    const r = await c.query("SELECT * FROM gate_stripe_links ORDER BY account_id FOR UPDATE");
    return r.rows.map(link);
  }

  // Intents: one single-use card per approved invoice.

  /** The open intent for this invoice, if any (inside the caller's transaction). */
  async openIntent(
    c: Connection,
    accountId: string,
    vendorId: string,
    referenceNorm: string,
  ): Promise<GateCardIntentRecord | undefined> {
    const r = await c.query(
      `SELECT * FROM gate_card_intents WHERE account_id=$1 AND vendor_id=$2 AND reference_norm=$3
         AND status IN (${OPEN})`,
      [accountId, vendorId, referenceNorm],
    );
    return r.rows[0] ? intent(r.rows[0]) : undefined;
  }

  async addIntent(
    c: Connection,
    i: {
      id: string;
      accountId: string;
      keyId: string | null;
      vendorId: string;
      reference: string;
      referenceNorm: string;
      amountCents: number;
    },
  ): Promise<GateCardIntentRecord> {
    const r = await c.query(
      `INSERT INTO gate_card_intents(id,account_id,key_id,vendor_id,reference,reference_norm,
         amount_cents,status) VALUES($1,$2,$3,$4,$5,$6,$7,'creating') RETURNING *`,
      [i.id, i.accountId, i.keyId, i.vendorId, i.reference, i.referenceNorm, i.amountCents],
    );
    return intent(r.rows[0]);
  }

  /** The card Stripe made for an intent: only its id and last four digits are kept. */
  async issued(id: string, card: { id: string; last4: string }): Promise<GateCardIntentRecord> {
    const r = await this.pool.query(
      `UPDATE gate_card_intents SET card_id=$2, card_last4=$3, status='issued', updated_at=now()
       WHERE id=$1 RETURNING *`,
      [id, card.id, card.last4],
    );
    return intent(r.rows[0]);
  }

  async setIntentStatus(q: Queryable, id: string, status: GateCardIntentStatus): Promise<void> {
    await q.query("UPDATE gate_card_intents SET status=$2, updated_at=now() WHERE id=$1", [
      id,
      status,
    ]);
  }

  async intentByCard(q: Queryable, cardId: string): Promise<GateCardIntentRecord | undefined> {
    const r = await q.query("SELECT * FROM gate_card_intents WHERE card_id=$1", [cardId]);
    return r.rows[0] ? intent(r.rows[0]) : undefined;
  }

  async intent(accountId: string, id: string): Promise<GateCardIntentRecord | undefined> {
    const r = await this.pool.query(
      "SELECT * FROM gate_card_intents WHERE account_id=$1 AND id=$2",
      [accountId, id],
    );
    return r.rows[0] ? intent(r.rows[0]) : undefined;
  }

  /** An account's intents, newest first; `before` is the id of the last one on the page before. */
  async intents(
    accountId: string,
    options: { limit?: number; before?: string } = {},
  ): Promise<{ items: GateCardIntentRecord[]; next: string | null }> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 25), 1), 100);
    const r = await this.pool.query(
      `SELECT * FROM gate_card_intents WHERE account_id=$1 AND ($2::uuid IS NULL OR
         (created_at, id) < (SELECT created_at, id FROM gate_card_intents WHERE id=$2))
       ORDER BY created_at DESC, id DESC LIMIT $3`,
      [accountId, options.before ?? null, limit],
    );
    const items = r.rows.map(intent);
    return { items, next: items.length === limit ? items.at(-1)!.id : null };
  }

  // Authorizations and transactions (inside the caller's transaction, the account locked).

  async authorization(q: Queryable, id: string): Promise<GateCardAuthorizationRecord | undefined> {
    const r = await q.query(
      "SELECT *, day::text AS day FROM gate_card_authorizations WHERE id=$1",
      [id],
    );
    return r.rows[0] ? authorization(r.rows[0]) : undefined;
  }

  async authorizationsOf(q: Queryable, intentId: string): Promise<GateCardAuthorizationRecord[]> {
    const r = await q.query(
      "SELECT *, day::text AS day FROM gate_card_authorizations WHERE intent_id=$1 ORDER BY created_at, id",
      [intentId],
    );
    return r.rows.map(authorization);
  }

  /**
   * Record the gate's answer to an authorization request (the first, or an increment).
   * `amountCents` is what is held after it. A declined increment leaves the original approval
   * standing, as Stripe does.
   */
  async decided(
    c: Connection,
    a: {
      id: string;
      accountId: string;
      intentId: string;
      decisionId: string;
      gateApproved: boolean;
      amountCents: number;
      merchantKey: string;
      vendorId: string | null;
      day: string;
    },
  ): Promise<void> {
    await c.query(
      `INSERT INTO gate_card_authorizations(id,account_id,intent_id,decision_id,gate_approved,
         approved_cents,amount_cents,merchant_key,vendor_id,day)
       VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9)
       ON CONFLICT(id) DO UPDATE SET decision_id=EXCLUDED.decision_id,
         gate_approved=COALESCE(gate_card_authorizations.gate_approved, false)
           OR EXCLUDED.gate_approved,
         approved_cents=EXCLUDED.approved_cents, amount_cents=EXCLUDED.amount_cents,
         updated_at=now()`,
      [
        a.id,
        a.accountId,
        a.intentId,
        a.decisionId,
        a.gateApproved,
        a.amountCents,
        a.merchantKey,
        a.vendorId,
        a.day,
      ],
    );
  }

  /** What Stripe reports on an authorization (issuing_authorization.created/updated). */
  async reported(
    c: Connection,
    a: {
      id: string;
      accountId: string;
      intentId: string;
      stripeApproved: boolean;
      status: string;
      amountCents: number;
      merchantKey: string;
      day: string;
    },
  ): Promise<GateCardAuthorizationRecord> {
    const r = await c.query(
      `INSERT INTO gate_card_authorizations(id,account_id,intent_id,stripe_approved,status,
         amount_cents,merchant_key,day) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(id) DO UPDATE SET stripe_approved=EXCLUDED.stripe_approved,
         status=EXCLUDED.status, amount_cents=EXCLUDED.amount_cents, updated_at=now()
       RETURNING *, day::text AS day`,
      [
        a.id,
        a.accountId,
        a.intentId,
        a.stripeApproved,
        a.status,
        a.amountCents,
        a.merchantKey,
        a.day,
      ],
    );
    return authorization(r.rows[0]);
  }

  /**
   * What one card check reads (`GateCardInput` in @bondedhq/shared), in a stable order: the
   * vendors whose card merchant is this one, the approved invoices with this reference, the
   * payments made on `day` or against the reference plus the charges approved and still held
   * (both without `exceptAuthorization`'s own), and the verified tickets covering the card's
   * vendor and this merchant.
   */
  async cardState(
    c: Connection,
    accountId: string,
    q: {
      merchantKey: string;
      vendorId: string;
      referenceNorm: string;
      day: string;
      exceptAuthorization?: string | undefined;
    },
  ) {
    const payees = (
      await c.query(
        `SELECT id, card_merchant_norm FROM gate_vendors WHERE account_id=$1
         AND card_merchant_norm=$2 ORDER BY id`,
        [accountId, q.merchantKey],
      )
    ).rows.map((v) => ({ vendorId: v.id as string, account: v.card_merchant_norm as string }));
    const invoices = (
      await c.query(
        `SELECT reference, vendor_id, amount_cents FROM gate_invoices
         WHERE account_id=$1 AND reference_norm=$2 ORDER BY id`,
        [accountId, q.referenceNorm],
      )
    ).rows.map((i) => ({
      reference: i.reference as string,
      vendorId: i.vendor_id as string,
      amountCents: num(i.amount_cents),
    }));
    const settled = (
      await c.query(
        `SELECT payee_norm, vendor_id, amount_cents, reference, day::text AS day, kind
         FROM gate_payments p WHERE account_id=$1 AND (day=$2::date OR reference_norm=$3)
           AND NOT EXISTS (SELECT 1 FROM gate_card_transactions t
             WHERE t.payment_id=p.id AND t.authorization_id=$4)
         ORDER BY id`,
        [accountId, q.day, q.referenceNorm, q.exceptAuthorization ?? null],
      )
    ).rows.map((p) => ({
      account: p.payee_norm as string,
      vendorId: (p.vendor_id as string | null) ?? null,
      amountCents: num(p.amount_cents),
      reference: p.reference as string,
      day: p.day as string,
      kind: p.kind as "invoice" | "refund",
    }));
    const held = (
      await this.held(c, accountId, {
        day: q.day,
        vendorId: q.vendorId,
        referenceNorm: q.referenceNorm,
        exceptId: q.exceptAuthorization,
      })
    ).map((h) => ({ ...h, kind: "invoice" as const }));
    const tickets = (
      await c.query(
        `SELECT id, vendor_id, account_norm FROM gate_tickets
         WHERE account_id=$1 AND vendor_id=$2 AND account_norm=$3 AND used_by IS NULL ORDER BY id`,
        [accountId, q.vendorId, q.merchantKey],
      )
    ).rows.map((t) => ({
      id: t.id as string,
      vendorId: t.vendor_id as string,
      account: t.account_norm as string,
    }));
    return { payees, invoices, payments: [...settled, ...held], tickets };
  }

  /**
   * Charges approved and still held (status pending) on the account, on `day` or on this
   * invoice, except `exceptId`: they count like payments made, for the duplicate and daily rules.
   * A charge Stripe reports closed (captured) still counts, at what was approved or held, until
   * its transaction is recorded: Stripe doesn't send events in order, so the capture's
   * `issuing_transaction.created` can arrive after the authorization's `.updated`.
   */
  async held(
    c: Connection,
    accountId: string,
    q: { day: string; vendorId: string; referenceNorm: string; exceptId?: string | undefined },
  ): Promise<
    {
      account: string;
      vendorId: string | null;
      amountCents: number;
      reference: string;
      day: string;
    }[]
  > {
    const r = await c.query(
      `SELECT * FROM (SELECT a.merchant_key, a.vendor_id, a.day::text AS day, i.reference,
           CASE WHEN a.status='closed' THEN GREATEST(a.amount_cents, a.approved_cents)
             ELSE a.amount_cents END AS amount_cents, a.created_at, a.id
         FROM gate_card_authorizations a JOIN gate_card_intents i ON i.id=a.intent_id
         WHERE a.account_id=$1 AND a.status IN ('pending','closed')
           AND COALESCE(a.stripe_approved, a.gate_approved) AND a.id IS DISTINCT FROM $4
           AND NOT EXISTS (SELECT 1 FROM gate_card_transactions t WHERE t.authorization_id=a.id)
           AND (a.day=$2::date OR (i.vendor_id=$3 AND i.reference_norm=$5))) h
       WHERE h.amount_cents > 0
       ORDER BY h.created_at, h.id`,
      [accountId, q.day, q.vendorId, q.exceptId ?? null, q.referenceNorm],
    );
    return r.rows.map((h) => ({
      account: h.merchant_key,
      vendorId: h.vendor_id,
      amountCents: num(h.amount_cents),
      reference: h.reference,
      day: h.day,
    }));
  }

  /** Record a settled transaction once; undefined if it was already recorded. */
  async addTransaction(
    c: Connection,
    t: Omit<GateCardTransactionRecord, "createdAt">,
  ): Promise<GateCardTransactionRecord | undefined> {
    const r = await c.query(
      `INSERT INTO gate_card_transactions(id,account_id,intent_id,authorization_id,type,
         amount_cents,decision_id,payment_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT DO NOTHING RETURNING *`,
      [
        t.id,
        t.accountId,
        t.intentId,
        t.authorizationId,
        t.type,
        t.amountCents,
        t.decisionId,
        t.paymentId,
      ],
    );
    return r.rows[0] ? transaction(r.rows[0]) : undefined;
  }

  async hasTransaction(c: Connection, id: string): Promise<boolean> {
    const r = await c.query("SELECT 1 FROM gate_card_transactions WHERE id=$1", [id]);
    return (r.rowCount ?? 0) > 0;
  }

  /** The captures recorded against an authorization, in cents. */
  async captured(c: Connection, authorizationId: string): Promise<number> {
    const r = await c.query(
      `SELECT COALESCE(sum(amount_cents),0) AS n FROM gate_card_transactions
       WHERE authorization_id=$1 AND type='capture'`,
      [authorizationId],
    );
    return num(r.rows[0].n);
  }

  async transactions(intentId: string): Promise<GateCardTransactionRecord[]> {
    const r = await this.pool.query(
      "SELECT * FROM gate_card_transactions WHERE intent_id=$1 ORDER BY created_at, id",
      [intentId],
    );
    return r.rows.map(transaction);
  }

  // Stripe events already handled.

  /**
   * Claim an event id inside the caller's transaction (with the account locked): false if it was
   * handled before. `answer` is the gate's answer to an authorization request.
   */
  async claimEvent(
    c: Connection,
    e: { id: string; type: string; accountId: string | null; answer?: boolean },
  ): Promise<boolean> {
    const r = await c.query(
      `INSERT INTO gate_stripe_events(id,type,account_id,answer) VALUES($1,$2,$3,$4)
       ON CONFLICT DO NOTHING`,
      [e.id, e.type, e.accountId, e.answer ?? null],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** An event handled before: its type and, for an authorization request, the answer given. */
  async handledEvent(
    q: Queryable,
    id: string,
  ): Promise<{ type: string; answer: boolean | null } | undefined> {
    const r = await q.query("SELECT type, answer FROM gate_stripe_events WHERE id=$1", [id]);
    return r.rows[0] ? { type: r.rows[0].type, answer: r.rows[0].answer } : undefined;
  }

  /** Forget event ids older than `before` (Stripe retries an event for up to three days). */
  async pruneEvents(before: Date): Promise<number> {
    const r = await this.pool.query("DELETE FROM gate_stripe_events WHERE received_at < $1", [
      before,
    ]);
    return r.rowCount ?? 0;
  }
}
