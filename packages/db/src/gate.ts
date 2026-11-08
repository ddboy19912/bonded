import type pg from "pg";
import type { Connection, Database } from "./index.js";

/**
 * The payment gate's state (migration 0024): gate accounts, their versioned mandates, API keys,
 * vendor master, approved invoices and refunds, verified bank-change tickets, payments made, the
 * decision log and the meter. The API's gate routes (apps/api/src/gate.ts) decide; this only
 * stores. Accounts and references arrive already normalised (`normalAccount`, `normalReference`
 * in @bondedhq/shared) next to the text as given. Amounts are whole cents.
 */

type Queryable = pg.Pool | Connection;
export type GateModeName = "monitor" | "enforce";

export interface GateAccountRecord {
  id: string;
  owner: string;
  name: string;
  mode: GateModeName;
  maxPaymentCents: number;
  maxDailyCents: number;
  freezeOnBreach: boolean;
  /** Off when payments have no invoices to match (migration 0029). */
  invoiceMatching: boolean;
  maxPaymentsPerHour: number | null;
  /** A watched payment with no check before it raises an alert (migration 0030). */
  expectChecks: boolean;
  frozenAt: Date | null;
  /** The decision whose breach froze the account, while it is still in the log. */
  frozenBy: string | null;
  mandateVersion: number;
  mandateHash: string;
  createdAt: Date;
  updatedAt: Date;
}

/** What a mandate version holds (`GateMandate` in @bondedhq/shared). */
export interface GateMandateSnapshot {
  mode: GateModeName;
  maxPaymentCents: number;
  maxDailyCents: number;
  freezeOnBreach: boolean;
  /** Only when off (migration 0029), so a mandate hashes as it did before the setting existed. */
  invoiceMatching?: false;
  /** Only when set (migration 0029). */
  maxPaymentsPerHour?: number;
  vendors: {
    id: string;
    name: string;
    account: string;
    /** Only when the vendor has a card merchant (migration 0025). */
    cardMerchant?: { name: string; networkId: string };
  }[];
}

/** A vendor's card merchant: its name and Stripe network id, and the key the rules compare. */
export interface GateCardMerchant {
  name: string;
  networkId: string;
  /** "CARD:<network id>", no spaces, upper case (`cardMerchantKey` in @bondedhq/shared). */
  key: string;
}

/** Where and when a hash was posted to GateAnchor (migration 0026). */
export interface GateAnchorPost {
  chainId: number;
  contract: string;
  /** Null when the keeper found the hash already posted. */
  txHash: string | null;
  postedAt: Date;
}

export interface GateMandateVersion {
  version: number;
  hash: string;
  mandate: GateMandateSnapshot;
  createdBy: string;
  createdAt: Date;
  /** Null until the keeper posts it on chain. */
  posted: GateAnchorPost | null;
  /** Why the last post failed, while it isn't posted. */
  postError: string | null;
}

/** One account's log root for one UTC day (`gateLogRoot`, migration 0026). */
export interface GateLogRootRecord {
  accountId: string;
  /** UTC day, YYYY-MM-DD. */
  day: string;
  root: string;
  receipts: number;
  createdAt: Date;
  posted: GateAnchorPost | null;
  postError: string | null;
}

export interface GateKeyRecord {
  id: string;
  prefix: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface GateVendorRecord {
  id: string;
  name: string;
  account: string;
  accountNorm: string;
  /** The card merchant on file, or null when the vendor isn't paid by card. */
  cardMerchant: GateCardMerchant | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GateInvoiceRecord {
  id: string;
  vendorId: string;
  reference: string;
  amountCents: number;
  createdAt: Date;
}

export interface GateRefundRecord {
  id: string;
  reference: string;
  name: string;
  account: string;
  amountCents: number;
  reason: string;
  createdAt: Date;
}

export interface GateTicketRecord {
  id: string;
  vendorId: string;
  account: string;
  verifiedBy: string;
  /** The decision that applied this ticket's change; null until then. A ticket covers one change. */
  usedBy: string | null;
  createdAt: Date;
}

export interface GatePaymentRecord {
  id: string;
  decisionId: string | null;
  source: "check" | "import" | "card" | "payout" | "watch" | "hook";
  kind: "invoice" | "refund";
  payee: string;
  vendorId: string | null;
  amountCents: number;
  reference: string;
  /** UTC day, YYYY-MM-DD. */
  day: string;
  createdAt: Date;
}

export interface GateDecisionRecord {
  id: string;
  /** The log's order, and its page cursor. */
  seq: string;
  accountId: string;
  keyId: string | null;
  requestId: string | null;
  requestHash: string | null;
  kind: "invoice" | "refund" | "bank_change" | "card" | "payment" | "budget" | "budget_close";
  decision: "pass" | "breach" | "frozen";
  result: "allowed" | "blocked" | "refused";
  mode: GateModeName;
  rules: string[];
  amountCents: number;
  lossCents: number;
  overpaidCents: number;
  payee: string;
  vendorId: string | null;
  reference: string;
  inputHash: string;
  /** What the rules were given (`GateInput`); null for decisions made before migration 0026. */
  input: unknown;
  mandateHash: string;
  mandateVersion: number;
  receipt: unknown;
  createdAt: Date;
}

/** What one check reads: the parts of the account's state the rules look at. */
export interface GateCheckState {
  /** Vendors whose verified account is the one being paid. */
  payees: { vendorId: string; account: string }[];
  invoices: { reference: string; vendorId: string; amountCents: number }[];
  refunds: { reference: string; account: string; amountCents: number }[];
  /** Payments made on `day`, or against the reference. */
  payments: {
    account: string;
    vendorId: string | null;
    amountCents: number;
    reference: string;
    day: string;
    kind: "invoice" | "refund";
  }[];
  tickets: { vendorId: string; account: string }[];
}

const num = (v: unknown) => Number(v);

const account = (r: Record<string, unknown>): GateAccountRecord => ({
  id: r.id as string,
  owner: r.owner as string,
  name: r.name as string,
  mode: r.mode as GateModeName,
  maxPaymentCents: num(r.max_payment_cents),
  maxDailyCents: num(r.max_daily_cents),
  freezeOnBreach: r.freeze_on_breach as boolean,
  invoiceMatching: r.invoice_matching as boolean,
  maxPaymentsPerHour: (r.max_payments_per_hour as number | null) ?? null,
  expectChecks: r.expect_checks as boolean,
  frozenAt: (r.frozen_at as Date | null) ?? null,
  frozenBy: (r.frozen_by as string | null) ?? null,
  mandateVersion: r.mandate_version as number,
  mandateHash: r.mandate_hash as string,
  createdAt: r.created_at as Date,
  updatedAt: r.updated_at as Date,
});

const vendor = (r: Record<string, unknown>): GateVendorRecord => ({
  id: r.id as string,
  name: r.name as string,
  account: r.account as string,
  accountNorm: r.account_norm as string,
  cardMerchant: r.card_merchant_id
    ? {
        name: r.card_merchant_name as string,
        networkId: r.card_merchant_id as string,
        key: r.card_merchant_norm as string,
      }
    : null,
  createdAt: r.created_at as Date,
  updatedAt: r.updated_at as Date,
});

const decision = (r: Record<string, unknown>): GateDecisionRecord => ({
  id: r.id as string,
  seq: String(r.seq),
  accountId: r.account_id as string,
  keyId: (r.key_id as string | null) ?? null,
  requestId: (r.request_id as string | null) ?? null,
  requestHash: (r.request_hash as string | null) ?? null,
  kind: r.kind as GateDecisionRecord["kind"],
  decision: r.decision as GateDecisionRecord["decision"],
  result: r.result as GateDecisionRecord["result"],
  mode: r.mode as GateModeName,
  rules: r.rules as string[],
  amountCents: num(r.amount_cents),
  lossCents: num(r.loss_cents),
  overpaidCents: num(r.overpaid_cents),
  payee: r.payee as string,
  vendorId: (r.vendor_id as string | null) ?? null,
  reference: r.reference as string,
  inputHash: r.input_hash as string,
  input: r.input ?? null,
  mandateHash: r.mandate_hash as string,
  mandateVersion: r.mandate_version as number,
  receipt: r.receipt,
  createdAt: r.created_at as Date,
});

/** The anchor columns of a gate_mandates or gate_log_roots row. */
const anchorPost = (r: Record<string, unknown>): GateAnchorPost | null =>
  r.anchored_at
    ? {
        chainId: r.anchor_chain_id as number,
        contract: r.anchor_contract as string,
        txHash: (r.anchor_tx as string | null) ?? null,
        postedAt: r.anchored_at as Date,
      }
    : null;

const mandateVersion = (r: Record<string, unknown>): GateMandateVersion => ({
  version: r.version as number,
  hash: r.hash as string,
  mandate: r.mandate as GateMandateSnapshot,
  createdBy: r.created_by as string,
  createdAt: r.created_at as Date,
  posted: anchorPost(r),
  postError: (r.anchor_error as string | null) ?? null,
});

const logRoot = (r: Record<string, unknown>): GateLogRootRecord => ({
  accountId: r.account_id as string,
  day: r.day as string,
  root: r.root as string,
  receipts: r.receipts as number,
  createdAt: r.created_at as Date,
  posted: anchorPost(r),
  postError: (r.anchor_error as string | null) ?? null,
});

const payment = (r: Record<string, unknown>): GatePaymentRecord => ({
  id: String(r.id),
  decisionId: (r.decision_id as string | null) ?? null,
  source: r.source as GatePaymentRecord["source"],
  kind: r.kind as GatePaymentRecord["kind"],
  payee: r.payee as string,
  vendorId: (r.vendor_id as string | null) ?? null,
  amountCents: num(r.amount_cents),
  reference: r.reference as string,
  day: r.day as string,
  createdAt: r.created_at as Date,
});

/** A page of a list, newest first: `next` is the cursor for the page after, if there is one. */
export interface GatePage<T> {
  items: T[];
  next: string | null;
}

const limitOf = (limit?: number) => Math.min(Math.max(Math.trunc(limit ?? 25), 1), 100);
const page = <T>(
  items: T[],
  limit: number,
  cursor: (t: T) => string = (t) => (t as { id: string }).id,
): GatePage<T> => ({
  items,
  next: items.length === limit ? cursor(items.at(-1)!) : null,
});

/** The gate's tables. Mandate changes (settings or vendors) run under the account's row lock. */
export class GateStore {
  constructor(
    private readonly db: Database,
    /** `gateMandateHash` from @bondedhq/shared. */
    private readonly hashMandate: (mandate: GateMandateSnapshot) => string,
  ) {}

  private get pool() {
    return this.db.pool;
  }

  // Accounts and their mandates.

  /**
   * Create an account with its first mandate version and its first API key, unless the owner
   * already has `maxPerOwner` accounts.
   */
  async createAccount(
    a: {
      id: string;
      owner: string;
      name: string;
      mode: GateModeName;
      maxPaymentCents: number;
      maxDailyCents: number;
      freezeOnBreach: boolean;
      key: { id: string; hash: string; prefix: string; label: string };
    },
    maxPerOwner: number,
  ): Promise<GateAccountRecord | { refused: "too-many" }> {
    const owner = a.owner.toLowerCase();
    return this.db.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(7024, hashtext($1))", [owner]);
      const n = (
        await c.query("SELECT count(*)::int AS n FROM gate_accounts WHERE owner=$1", [owner])
      ).rows[0].n as number;
      if (n >= maxPerOwner) return { refused: "too-many" as const };
      const mandate: GateMandateSnapshot = {
        mode: a.mode,
        maxPaymentCents: a.maxPaymentCents,
        maxDailyCents: a.maxDailyCents,
        freezeOnBreach: a.freezeOnBreach,
        vendors: [],
      };
      const hash = this.hashMandate(mandate);
      await c.query(
        `INSERT INTO gate_accounts(id,owner,name,mode,max_payment_cents,max_daily_cents,
           freeze_on_breach,mandate_version,mandate_hash) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8)`,
        [a.id, owner, a.name, a.mode, a.maxPaymentCents, a.maxDailyCents, a.freezeOnBreach, hash],
      );
      await c.query(
        "INSERT INTO gate_mandates(account_id,version,mandate,hash,created_by) VALUES($1,1,$2,$3,$4)",
        [a.id, JSON.stringify(mandate), hash, owner],
      );
      await c.query(
        "INSERT INTO gate_api_keys(id,account_id,key_hash,prefix,label) VALUES($1,$2,$3,$4,$5)",
        [a.key.id, a.id, a.key.hash, a.key.prefix, a.key.label],
      );
      return (await this.account(a.id, c))!;
    });
  }

  async account(id: string, q: Queryable = this.pool): Promise<GateAccountRecord | undefined> {
    const r = await q.query("SELECT * FROM gate_accounts WHERE id=$1", [id]);
    return r.rows[0] ? account(r.rows[0]) : undefined;
  }

  async accountsOf(owner: string): Promise<GateAccountRecord[]> {
    const r = await this.pool.query(
      "SELECT * FROM gate_accounts WHERE owner=$1 ORDER BY created_at, id",
      [owner.toLowerCase()],
    );
    return r.rows.map(account);
  }

  /** Lock the account's row for the rest of the caller's transaction (every check and change). */
  async lockAccount(c: Connection, id: string): Promise<GateAccountRecord | undefined> {
    const r = await c.query("SELECT * FROM gate_accounts WHERE id=$1 FOR UPDATE", [id]);
    return r.rows[0] ? account(r.rows[0]) : undefined;
  }

  /** Change an account's name, mode, limits or settings; a new mandate version if needed. */
  async updateAccount(
    id: string,
    patch: {
      name?: string;
      mode?: GateModeName;
      maxPaymentCents?: number;
      maxDailyCents?: number;
      freezeOnBreach?: boolean;
      invoiceMatching?: boolean;
      /** null removes the limit. */
      maxPaymentsPerHour?: number | null;
      expectChecks?: boolean;
    },
    by: string,
  ): Promise<GateAccountRecord | undefined> {
    return this.db.transaction(async (c) => {
      const current = await this.lockAccount(c, id);
      if (!current) return undefined;
      await c.query(
        `UPDATE gate_accounts SET name=$2, mode=$3, max_payment_cents=$4, max_daily_cents=$5,
           freeze_on_breach=$6, invoice_matching=$7, max_payments_per_hour=$8, expect_checks=$9,
           updated_at=now() WHERE id=$1`,
        [
          id,
          patch.name ?? current.name,
          patch.mode ?? current.mode,
          patch.maxPaymentCents ?? current.maxPaymentCents,
          patch.maxDailyCents ?? current.maxDailyCents,
          patch.freezeOnBreach ?? current.freezeOnBreach,
          patch.invoiceMatching ?? current.invoiceMatching,
          patch.maxPaymentsPerHour === undefined
            ? current.maxPaymentsPerHour
            : patch.maxPaymentsPerHour,
          patch.expectChecks ?? current.expectChecks,
        ],
      );
      await this.newVersion(c, id, by);
      return this.account(id, c);
    });
  }

  /** Lift a freeze. Returns the account, or undefined if there is none. */
  async unfreeze(id: string): Promise<GateAccountRecord | undefined> {
    const r = await this.pool.query(
      "UPDATE gate_accounts SET frozen_at=NULL, frozen_by=NULL, updated_at=now() WHERE id=$1 RETURNING *",
      [id],
    );
    return r.rows[0] ? account(r.rows[0]) : undefined;
  }

  /** Freeze an account after a breach, inside the check's transaction. */
  async freeze(c: Connection, id: string, decisionId: string | null): Promise<void> {
    await c.query(
      "UPDATE gate_accounts SET frozen_at=now(), frozen_by=$2, updated_at=now() WHERE id=$1",
      [id, decisionId],
    );
  }

  /** The mandate as it stands, read inside the caller's transaction. */
  async currentMandate(c: Queryable, id: string): Promise<GateMandateSnapshot> {
    const a = (await this.account(id, c))!;
    const vendors = (
      await c.query(
        `SELECT id,name,account_norm,card_merchant_name,card_merchant_id FROM gate_vendors
         WHERE account_id=$1 ORDER BY id`,
        [id],
      )
    ).rows.map((v) => ({
      id: v.id as string,
      name: v.name as string,
      account: v.account_norm as string,
      ...(v.card_merchant_id
        ? { cardMerchant: { name: v.card_merchant_name, networkId: v.card_merchant_id } }
        : {}),
    }));
    return {
      mode: a.mode,
      maxPaymentCents: a.maxPaymentCents,
      maxDailyCents: a.maxDailyCents,
      freezeOnBreach: a.freezeOnBreach,
      ...(a.invoiceMatching ? {} : { invoiceMatching: false as const }),
      ...(a.maxPaymentsPerHour === null ? {} : { maxPaymentsPerHour: a.maxPaymentsPerHour }),
      vendors,
    };
  }

  /**
   * Record a new mandate version if the mandate changed (the account's row must be locked). A
   * change that leaves the mandate as it was (a rename, the same limit again) makes none.
   */
  private async newVersion(c: Connection, id: string, by: string): Promise<void> {
    const mandate = await this.currentMandate(c, id);
    const hash = this.hashMandate(mandate);
    const r = await c.query(
      `UPDATE gate_accounts SET mandate_version=mandate_version+1, mandate_hash=$2
       WHERE id=$1 AND mandate_hash<>$2 RETURNING mandate_version`,
      [id, hash],
    );
    if (!r.rowCount) return;
    await c.query(
      "INSERT INTO gate_mandates(account_id,version,mandate,hash,created_by) VALUES($1,$2,$3,$4,$5)",
      [id, r.rows[0].mandate_version, JSON.stringify(mandate), hash, by],
    );
  }

  /** Mandate versions, newest first. */
  async mandates(id: string, options: { limit?: number; before?: number } = {}) {
    const limit = limitOf(options.limit);
    const r = await this.pool.query(
      `SELECT * FROM gate_mandates WHERE account_id=$1 AND ($2::int IS NULL OR version<$2)
       ORDER BY version DESC LIMIT $3`,
      [id, options.before ?? null, limit],
    );
    return page(r.rows.map(mandateVersion), limit, (v) => String(v.version));
  }

  // API keys.

  /** Add an API key, unless the account already has `maxLive` live ones. */
  async createKey(
    accountId: string,
    key: { id: string; hash: string; prefix: string; label: string },
    maxLive: number,
  ): Promise<GateKeyRecord | { refused: "too-many" }> {
    return this.db.transaction(async (c) => {
      await this.lockAccount(c, accountId);
      const n = (
        await c.query(
          "SELECT count(*)::int AS n FROM gate_api_keys WHERE account_id=$1 AND revoked_at IS NULL",
          [accountId],
        )
      ).rows[0].n as number;
      if (n >= maxLive) return { refused: "too-many" as const };
      await c.query(
        "INSERT INTO gate_api_keys(id,account_id,key_hash,prefix,label) VALUES($1,$2,$3,$4,$5)",
        [key.id, accountId, key.hash, key.prefix, key.label],
      );
      return (await this.keys(accountId, c)).find((k) => k.id === key.id)!;
    });
  }

  async keys(accountId: string, q: Queryable = this.pool): Promise<GateKeyRecord[]> {
    const r = await q.query(
      "SELECT * FROM gate_api_keys WHERE account_id=$1 ORDER BY created_at, id",
      [accountId],
    );
    return r.rows.map((k) => ({
      id: k.id,
      prefix: k.prefix,
      label: k.label,
      createdAt: k.created_at,
      lastUsedAt: k.last_used_at,
      revokedAt: k.revoked_at,
    }));
  }

  async revokeKey(accountId: string, keyId: string): Promise<boolean> {
    const r = await this.pool.query(
      "UPDATE gate_api_keys SET revoked_at=now() WHERE account_id=$1 AND id=$2 AND revoked_at IS NULL",
      [accountId, keyId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** The live key with this hash and its account. */
  async keyAccount(hash: string): Promise<{ keyId: string; accountId: string } | undefined> {
    const r = await this.pool.query(
      "SELECT id, account_id FROM gate_api_keys WHERE key_hash=$1 AND revoked_at IS NULL",
      [hash],
    );
    return r.rows[0] ? { keyId: r.rows[0].id, accountId: r.rows[0].account_id } : undefined;
  }

  async keyUsed(c: Connection, keyId: string): Promise<void> {
    await c.query("UPDATE gate_api_keys SET last_used_at=now() WHERE id=$1", [keyId]);
  }

  // The vendor master (part of the mandate).

  async vendors(accountId: string): Promise<GateVendorRecord[]> {
    const r = await this.pool.query("SELECT * FROM gate_vendors WHERE account_id=$1 ORDER BY id", [
      accountId,
    ]);
    return r.rows.map(vendor);
  }

  async addVendor(
    accountId: string,
    v: {
      id: string;
      name: string;
      account: string;
      accountNorm: string;
      cardMerchant?: GateCardMerchant | undefined;
    },
    by: string,
  ): Promise<GateVendorRecord | "exists"> {
    return this.db.transaction(async (c) => {
      await this.lockAccount(c, accountId);
      const r = await c.query(
        `INSERT INTO gate_vendors(account_id,id,name,account,account_norm,card_merchant_name,
           card_merchant_id,card_merchant_norm) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT DO NOTHING RETURNING *`,
        [
          accountId,
          v.id,
          v.name,
          v.account,
          v.accountNorm,
          v.cardMerchant?.name ?? null,
          v.cardMerchant?.networkId ?? null,
          v.cardMerchant?.key ?? null,
        ],
      );
      if (!r.rowCount) return "exists" as const;
      await this.newVersion(c, accountId, by);
      return vendor(r.rows[0]);
    });
  }

  /**
   * Change a vendor's name, verified account or card merchant: the owner's edit, or (inside a
   * check's transaction, `c`) a bank or merchant change a verified ticket covers. A vendor's card
   * merchant, once on file, changes to another merchant only with `ticket`: a verified ticket
   * whose vendor is this one and whose account is the new merchant's key ("needs-ticket"
   * otherwise). Setting the first merchant, or removing it (null), needs none.
   */
  /**
   * Mark the unused tickets covering this vendor and account as applied by `decisionId`, inside
   * the check's transaction. A ticket covers one change, not every later switch back to it.
   */
  async useTickets(
    c: Connection,
    accountId: string,
    vendorId: string,
    accountNorm: string,
    decisionId: string,
  ): Promise<void> {
    await c.query(
      `UPDATE gate_tickets SET used_by=$4
       WHERE account_id=$1 AND vendor_id=$2 AND account_norm=$3 AND used_by IS NULL`,
      [accountId, vendorId, accountNorm, decisionId],
    );
  }

  async updateVendor(
    accountId: string,
    id: string,
    patch: {
      name?: string;
      account?: string;
      accountNorm?: string;
      cardMerchant?: GateCardMerchant | null;
      ticket?: string;
    },
    by: string,
    c?: Connection,
  ): Promise<GateVendorRecord | "needs-ticket" | undefined> {
    const run = async (tx: Connection) => {
      if (!c) await this.lockAccount(tx, accountId);
      const merchant = patch.cardMerchant;
      // The ticket that covers a merchant change, used up once the change is made.
      let ticketUsed: string | undefined;
      if (merchant) {
        const current = await tx.query(
          "SELECT card_merchant_norm FROM gate_vendors WHERE account_id=$1 AND id=$2",
          [accountId, id],
        );
        if (!current.rowCount) return undefined;
        const onFile = current.rows[0].card_merchant_norm as string | null;
        if (onFile !== null && onFile !== merchant.key) {
          const covered = patch.ticket
            ? await tx.query(
                `SELECT 1 FROM gate_tickets
                 WHERE account_id=$1 AND id=$2 AND vendor_id=$3 AND account_norm=$4
                   AND used_by IS NULL`,
                [accountId, patch.ticket, id, merchant.key],
              )
            : undefined;
          if (!covered?.rowCount) return "needs-ticket" as const;
          ticketUsed = patch.ticket;
        }
      }
      const r = await tx.query(
        `UPDATE gate_vendors SET name=COALESCE($3,name), account=COALESCE($4,account),
           account_norm=COALESCE($5,account_norm),
           card_merchant_name=CASE WHEN $6::boolean THEN $7 ELSE card_merchant_name END,
           card_merchant_id=CASE WHEN $6::boolean THEN $8 ELSE card_merchant_id END,
           card_merchant_norm=CASE WHEN $6::boolean THEN $9 ELSE card_merchant_norm END,
           updated_at=now()
         WHERE account_id=$1 AND id=$2 RETURNING *`,
        [
          accountId,
          id,
          patch.name ?? null,
          patch.account ?? null,
          patch.accountNorm ?? null,
          merchant !== undefined,
          merchant?.name ?? null,
          merchant?.networkId ?? null,
          merchant?.key ?? null,
        ],
      );
      if (!r.rowCount) return undefined;
      if (ticketUsed)
        await tx.query(
          "UPDATE gate_tickets SET used_by=$3 WHERE account_id=$1 AND id=$2 AND used_by IS NULL",
          [accountId, ticketUsed, by],
        );
      await this.newVersion(tx, accountId, by);
      return vendor(r.rows[0]);
    };
    return c ? run(c) : this.db.transaction(run);
  }

  /** One vendor, read inside the caller's transaction. */
  async vendor(q: Queryable, accountId: string, id: string): Promise<GateVendorRecord | undefined> {
    const r = await q.query("SELECT * FROM gate_vendors WHERE account_id=$1 AND id=$2", [
      accountId,
      id,
    ]);
    return r.rows[0] ? vendor(r.rows[0]) : undefined;
  }

  async deleteVendor(accountId: string, id: string, by: string): Promise<boolean> {
    return this.db.transaction(async (c) => {
      await this.lockAccount(c, accountId);
      const r = await c.query("DELETE FROM gate_vendors WHERE account_id=$1 AND id=$2", [
        accountId,
        id,
      ]);
      if (!r.rowCount) return false;
      await this.newVersion(c, accountId, by);
      return true;
    });
  }

  async vendorExists(c: Queryable, accountId: string, id: string): Promise<boolean> {
    const r = await c.query("SELECT 1 FROM gate_vendors WHERE account_id=$1 AND id=$2", [
      accountId,
      id,
    ]);
    return (r.rowCount ?? 0) > 0;
  }

  // Approved invoices and refunds, and verified tickets.

  async invoices(accountId: string, options: { limit?: number; before?: string } = {}) {
    const limit = limitOf(options.limit);
    const r = await this.pool.query(
      `SELECT * FROM gate_invoices WHERE account_id=$1 AND ($2::bigint IS NULL OR id<$2)
       ORDER BY id DESC LIMIT $3`,
      [accountId, options.before ?? null, limit],
    );
    return page(
      r.rows.map((i): GateInvoiceRecord => ({
        id: String(i.id),
        vendorId: i.vendor_id,
        reference: i.reference,
        amountCents: num(i.amount_cents),
        createdAt: i.created_at,
      })),
      limit,
    );
  }

  async addInvoice(
    accountId: string,
    i: { vendorId: string; reference: string; referenceNorm: string; amountCents: number },
  ): Promise<GateInvoiceRecord | "exists" | "no-vendor"> {
    if (!(await this.vendorExists(this.pool, accountId, i.vendorId))) return "no-vendor";
    const r = await this.pool.query(
      `INSERT INTO gate_invoices(account_id,vendor_id,reference,reference_norm,amount_cents)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *`,
      [accountId, i.vendorId, i.reference, i.referenceNorm, i.amountCents],
    );
    if (!r.rowCount) return "exists";
    const row = r.rows[0];
    return {
      id: String(row.id),
      vendorId: row.vendor_id,
      reference: row.reference,
      amountCents: num(row.amount_cents),
      createdAt: row.created_at,
    };
  }

  async deleteInvoice(accountId: string, id: string): Promise<boolean> {
    const r = await this.pool.query("DELETE FROM gate_invoices WHERE account_id=$1 AND id=$2", [
      accountId,
      id,
    ]);
    return (r.rowCount ?? 0) > 0;
  }

  async refunds(accountId: string, options: { limit?: number; before?: string } = {}) {
    const limit = limitOf(options.limit);
    const r = await this.pool.query(
      `SELECT * FROM gate_refunds WHERE account_id=$1 AND ($2::bigint IS NULL OR id<$2)
       ORDER BY id DESC LIMIT $3`,
      [accountId, options.before ?? null, limit],
    );
    return page(r.rows.map(refund), limit);
  }

  async addRefund(
    accountId: string,
    f: {
      reference: string;
      referenceNorm: string;
      name: string;
      account: string;
      accountNorm: string;
      amountCents: number;
      reason: string;
    },
  ): Promise<GateRefundRecord | "exists"> {
    const r = await this.pool.query(
      `INSERT INTO gate_refunds(account_id,reference,reference_norm,name,account,account_norm,
         amount_cents,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING *`,
      [
        accountId,
        f.reference,
        f.referenceNorm,
        f.name,
        f.account,
        f.accountNorm,
        f.amountCents,
        f.reason,
      ],
    );
    return r.rowCount ? refund(r.rows[0]) : "exists";
  }

  async deleteRefund(accountId: string, id: string): Promise<boolean> {
    const r = await this.pool.query("DELETE FROM gate_refunds WHERE account_id=$1 AND id=$2", [
      accountId,
      id,
    ]);
    return (r.rowCount ?? 0) > 0;
  }

  async tickets(accountId: string): Promise<GateTicketRecord[]> {
    const r = await this.pool.query(
      "SELECT * FROM gate_tickets WHERE account_id=$1 ORDER BY created_at DESC, id",
      [accountId],
    );
    return r.rows.map(ticket);
  }

  async addTicket(
    accountId: string,
    t: { id: string; vendorId: string; account: string; accountNorm: string; verifiedBy: string },
  ): Promise<GateTicketRecord | "exists" | "no-vendor"> {
    if (!(await this.vendorExists(this.pool, accountId, t.vendorId))) return "no-vendor";
    const r = await this.pool.query(
      `INSERT INTO gate_tickets(account_id,id,vendor_id,account,account_norm,verified_by)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING *`,
      [accountId, t.id, t.vendorId, t.account, t.accountNorm, t.verifiedBy],
    );
    return r.rowCount ? ticket(r.rows[0]) : "exists";
  }

  async deleteTicket(accountId: string, id: string): Promise<boolean> {
    const r = await this.pool.query("DELETE FROM gate_tickets WHERE account_id=$1 AND id=$2", [
      accountId,
      id,
    ]);
    return (r.rowCount ?? 0) > 0;
  }

  // Payments made.

  async payments(accountId: string, options: { limit?: number; before?: string } = {}) {
    const limit = limitOf(options.limit);
    const r = await this.pool.query(
      `SELECT *, day::text AS day FROM gate_payments WHERE account_id=$1
         AND ($2::bigint IS NULL OR id<$2) ORDER BY id DESC LIMIT $3`,
      [accountId, options.before ?? null, limit],
    );
    return page(r.rows.map(payment), limit);
  }

  /**
   * Record a payment: one the gate let through (inside the check's transaction, `c`), or one the
   * owner imports because it was made before the gate (`source` "import"). An imported invoice
   * payment is matched to the vendor whose verified account it paid, as a check would be.
   */
  async addPayment(
    accountId: string,
    p: {
      decisionId?: string | null;
      source: "check" | "import" | "card" | "payout" | "watch" | "hook" | "budget";
      kind: "invoice" | "refund";
      payee: string;
      payeeNorm: string;
      vendorId?: string | null;
      amountCents: number;
      reference: string;
      referenceNorm: string;
      day: string;
    },
    c: Queryable = this.pool,
  ): Promise<GatePaymentRecord> {
    let vendorId = p.vendorId ?? null;
    if (p.source === "import" && p.kind === "invoice")
      vendorId =
        ((
          await c.query(
            "SELECT id FROM gate_vendors WHERE account_id=$1 AND account_norm=$2 ORDER BY id LIMIT 1",
            [accountId, p.payeeNorm],
          )
        ).rows[0]?.id as string | undefined) ?? null;
    const r = await c.query(
      `INSERT INTO gate_payments(account_id,decision_id,source,kind,payee,payee_norm,vendor_id,
         amount_cents,reference,reference_norm,day)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *, day::text AS day`,
      [
        accountId,
        p.decisionId ?? null,
        p.source,
        p.kind,
        p.payee,
        p.payeeNorm,
        vendorId,
        p.amountCents,
        p.reference,
        p.referenceNorm,
        p.day,
      ],
    );
    return payment(r.rows[0]);
  }

  // The check (inside the caller's transaction, with the account's row locked).

  /** The part of the state one check reads (see `GateCheckState`), in a stable order. */
  async checkState(
    c: Connection,
    accountId: string,
    q:
      | {
          kind: "invoice" | "refund" | "payment";
          accountNorm: string;
          referenceNorm: string;
          day: string;
        }
      | { kind: "bank_change"; vendorId: string; accountNorm: string },
  ): Promise<GateCheckState> {
    const state: GateCheckState = {
      payees: [],
      invoices: [],
      refunds: [],
      payments: [],
      tickets: [],
    };
    if (q.kind === "bank_change") {
      state.tickets = (
        await c.query(
          `SELECT vendor_id, account_norm FROM gate_tickets
           WHERE account_id=$1 AND vendor_id=$2 AND account_norm=$3 AND used_by IS NULL ORDER BY id`,
          [accountId, q.vendorId, q.accountNorm],
        )
      ).rows.map((t) => ({ vendorId: t.vendor_id, account: t.account_norm }));
      return state;
    }
    state.payees = (
      await c.query(
        "SELECT id, account_norm FROM gate_vendors WHERE account_id=$1 AND account_norm=$2 ORDER BY id",
        [accountId, q.accountNorm],
      )
    ).rows.map((v) => ({ vendorId: v.id, account: v.account_norm }));
    if (q.kind === "invoice")
      state.invoices = (
        await c.query(
          `SELECT reference, vendor_id, amount_cents FROM gate_invoices
           WHERE account_id=$1 AND reference_norm=$2 ORDER BY id`,
          [accountId, q.referenceNorm],
        )
      ).rows.map((i) => ({
        reference: i.reference,
        vendorId: i.vendor_id,
        amountCents: num(i.amount_cents),
      }));
    else if (q.kind === "refund")
      state.refunds = (
        await c.query(
          `SELECT reference, account_norm, amount_cents FROM gate_refunds
           WHERE account_id=$1 AND account_norm=$2 ORDER BY id`,
          [accountId, q.accountNorm],
        )
      ).rows.map((f) => ({
        reference: f.reference,
        account: f.account_norm,
        amountCents: num(f.amount_cents),
      }));
    state.payments = (
      await c.query(
        `SELECT payee_norm, vendor_id, amount_cents, reference, day::text AS day, kind
         FROM gate_payments
         WHERE account_id=$1 AND (day=$2::date OR ($3<>'' AND reference_norm=$3)) ORDER BY id`,
        [accountId, q.day, q.referenceNorm],
      )
    ).rows.map((p) => ({
      account: p.payee_norm,
      vendorId: p.vendor_id,
      amountCents: num(p.amount_cents),
      reference: p.reference,
      day: p.day,
      kind: p.kind,
    }));
    return state;
  }

  /**
   * Payments that went out through a check, were watched, or were reported against a budget since
   * then, for the hourly limit. A budget's reservation isn't a payment: its spends are.
   */
  async paymentsSince(c: Connection, accountId: string, since: Date): Promise<number> {
    const r = await c.query(
      `SELECT (SELECT count(*) FROM gate_payments
                WHERE account_id=$1 AND source NOT IN ('import','budget') AND created_at>=$2)
            + (SELECT count(*) FROM gate_budget_spends WHERE account_id=$1 AND paid_at>=$2)
              AS n`,
      [accountId, since],
    );
    return Number(r.rows[0].n);
  }

  /**
   * A budget's reservation becomes what it spent, in whole cents rounded up; with nothing spent,
   * it goes. The day it counts against doesn't change.
   */
  async settleBudgetPayment(c: Connection, budgetId: string, cents: number): Promise<void> {
    if (cents > 0)
      await c.query(
        "UPDATE gate_payments SET amount_cents=$2 WHERE decision_id=$1 AND source='budget'",
        [budgetId, cents],
      );
    else
      await c.query("DELETE FROM gate_payments WHERE decision_id=$1 AND source='budget'", [
        budgetId,
      ]);
  }

  /** The decision an earlier check with this request id made, if it is still in the log. */
  async decisionByRequest(
    c: Connection,
    accountId: string,
    requestId: string,
  ): Promise<GateDecisionRecord | undefined> {
    const r = await c.query("SELECT * FROM gate_decisions WHERE account_id=$1 AND request_id=$2", [
      accountId,
      requestId,
    ]);
    return r.rows[0] ? decision(r.rows[0]) : undefined;
  }

  async addDecision(
    c: Connection,
    d: Omit<GateDecisionRecord, "seq" | "createdAt"> & { createdAt: Date },
  ): Promise<GateDecisionRecord> {
    const r = await c.query(
      `INSERT INTO gate_decisions(id,account_id,key_id,request_id,request_hash,kind,decision,result,
         mode,rules,amount_cents,loss_cents,overpaid_cents,payee,vendor_id,reference,input_hash,
         mandate_hash,mandate_version,receipt,created_at,input)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING *`,
      [
        d.id,
        d.accountId,
        d.keyId,
        d.requestId,
        d.requestHash,
        d.kind,
        d.decision,
        d.result,
        d.mode,
        d.rules,
        d.amountCents,
        d.lossCents,
        d.overpaidCents,
        d.payee,
        d.vendorId,
        d.reference,
        d.inputHash,
        d.mandateHash,
        d.mandateVersion,
        JSON.stringify(d.receipt),
        d.createdAt,
        d.input === null || d.input === undefined ? null : JSON.stringify(d.input),
      ],
    );
    return decision(r.rows[0]);
  }

  /** Count one check toward the account's day (the meter). */
  async countCheck(c: Connection, accountId: string, day: string): Promise<void> {
    await c.query(
      `INSERT INTO gate_usage_daily(account_id,day,checks) VALUES($1,$2::date,1)
       ON CONFLICT(account_id,day) DO UPDATE SET checks=gate_usage_daily.checks+1`,
      [accountId, day],
    );
  }

  /** Checks per UTC day from `sinceDay` on, oldest first. */
  async usage(accountId: string, sinceDay: string): Promise<{ day: string; checks: number }[]> {
    const r = await this.pool.query(
      `SELECT day::text AS day, checks FROM gate_usage_daily
       WHERE account_id=$1 AND day>=$2::date ORDER BY day`,
      [accountId, sinceDay],
    );
    return r.rows.map((u) => ({ day: u.day, checks: u.checks }));
  }

  // The decision log.

  /** The account's decisions, newest first; `before` is the `next` cursor of the page before. */
  async decisions(
    accountId: string,
    options: { limit?: number; before?: string; result?: GateDecisionRecord["result"] } = {},
  ): Promise<GatePage<GateDecisionRecord>> {
    const limit = limitOf(options.limit);
    const r = await this.pool.query(
      `SELECT * FROM gate_decisions WHERE account_id=$1 AND ($2::bigint IS NULL OR seq<$2)
         AND ($3::text IS NULL OR result=$3) ORDER BY seq DESC LIMIT $4`,
      [accountId, options.before ?? null, options.result ?? null, limit],
    );
    return page(r.rows.map(decision), limit, (d) => d.seq);
  }

  /** These decisions, in no order. */
  async decisionsByIds(accountId: string, ids: readonly string[]): Promise<GateDecisionRecord[]> {
    if (ids.length === 0) return [];
    const r = await this.pool.query(
      "SELECT * FROM gate_decisions WHERE account_id=$1 AND id = ANY($2::uuid[])",
      [accountId, [...ids]],
    );
    return r.rows.map(decision);
  }

  async decision(accountId: string, id: string): Promise<GateDecisionRecord | undefined> {
    const r = await this.pool.query("SELECT * FROM gate_decisions WHERE account_id=$1 AND id=$2", [
      accountId,
      id,
    ]);
    return r.rows[0] ? decision(r.rows[0]) : undefined;
  }

  /**
   * Delete decisions made before `before`'s UTC day, oldest first, in bounded batches (as
   * `pruneEvents`). Whole days only: a day cut part way would leave the keeper a partial day to
   * make a log root over, or a sealed day whose remaining receipts can't be proved. Payments stay:
   * the duplicate rule needs them for as long as the account exists.
   */
  async pruneDecisions(before: Date, batchSize = 10_000): Promise<number> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1)
      throw new RangeError("batchSize must be a positive integer");
    before = new Date(Math.floor(before.getTime() / 86_400_000) * 86_400_000);
    let deleted = 0;
    for (;;) {
      const r = await this.pool.query(
        `DELETE FROM gate_decisions WHERE id IN
           (SELECT id FROM gate_decisions WHERE created_at < $1 ORDER BY seq LIMIT $2)`,
        [before, batchSize],
      );
      deleted += r.rowCount ?? 0;
      if ((r.rowCount ?? 0) < batchSize) return deleted;
    }
  }

  // Log roots and what is posted to GateAnchor (migration 0026).

  /**
   * The account days with decisions in [since, until) that have no log root yet, oldest first.
   * `until` should be a day's start that has passed by a margin, so no check of that day is
   * still being written.
   */
  async daysWithoutRoot(
    since: Date,
    until: Date,
    limit = 500,
  ): Promise<{ accountId: string; day: string }[]> {
    const r = await this.pool.query(
      `SELECT d.account_id, d.day::text AS day FROM (
         SELECT account_id, (created_at AT TIME ZONE 'UTC')::date AS day FROM gate_decisions
         WHERE created_at >= $1 AND created_at < $2 GROUP BY 1, 2) d
       WHERE NOT EXISTS
         (SELECT 1 FROM gate_log_roots l WHERE l.account_id=d.account_id AND l.day=d.day)
       ORDER BY d.day, d.account_id LIMIT $3`,
      [since, until, limit],
    );
    return r.rows.map((row) => ({ accountId: row.account_id, day: row.day }));
  }

  /** An account's decisions on one UTC day, in decision order: the leaves of its log root. */
  async dayDecisions(accountId: string, day: string): Promise<GateDecisionRecord[]> {
    const start = new Date(`${day}T00:00:00Z`);
    const r = await this.pool.query(
      `SELECT * FROM gate_decisions WHERE account_id=$1 AND created_at >= $2 AND created_at < $3
       ORDER BY seq`,
      [accountId, start, new Date(start.getTime() + 86_400_000)],
    );
    return r.rows.map(decision);
  }

  /** Record a day's log root. A day's root is made once: false if it already has one. */
  async addLogRoot(root: {
    accountId: string;
    day: string;
    root: string;
    receipts: number;
  }): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO gate_log_roots(account_id,day,root,receipts) VALUES($1,$2::date,$3,$4)
       ON CONFLICT DO NOTHING`,
      [root.accountId, root.day, root.root, root.receipts],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async logRoot(accountId: string, day: string): Promise<GateLogRootRecord | undefined> {
    const r = await this.pool.query(
      "SELECT *, day::text AS day FROM gate_log_roots WHERE account_id=$1 AND day=$2::date",
      [accountId, day],
    );
    return r.rows[0] ? logRoot(r.rows[0]) : undefined;
  }

  /** An account's log roots, newest day first; `before` is the `next` cursor (a day). */
  async logRoots(
    accountId: string,
    options: { limit?: number; before?: string } = {},
  ): Promise<GatePage<GateLogRootRecord>> {
    const limit = limitOf(options.limit);
    const r = await this.pool.query(
      `SELECT *, day::text AS day FROM gate_log_roots
       WHERE account_id=$1 AND ($2::date IS NULL OR day<$2::date) ORDER BY gate_log_roots.day DESC LIMIT $3`,
      [accountId, options.before ?? null, limit],
    );
    return page(r.rows.map(logRoot), limit, (l) => l.day);
  }

  /** Mandate versions not posted on chain yet, oldest first. */
  async unpostedMandates(limit = 100): Promise<(GateMandateVersion & { accountId: string })[]> {
    const r = await this.pool.query(
      `SELECT * FROM gate_mandates WHERE anchored_at IS NULL ORDER BY created_at, account_id, version
       LIMIT $1`,
      [limit],
    );
    return r.rows.map((row) => ({ accountId: row.account_id as string, ...mandateVersion(row) }));
  }

  /** Log roots not posted on chain yet, oldest day first. */
  async unpostedRoots(limit = 100): Promise<GateLogRootRecord[]> {
    const r = await this.pool.query(
      `SELECT *, day::text AS day FROM gate_log_roots WHERE anchored_at IS NULL
       ORDER BY gate_log_roots.day, account_id LIMIT $1`,
      [limit],
    );
    return r.rows.map(logRoot);
  }

  /** Record a mandate version (`{ version }`) or a day's root (`{ day }`) as posted on chain. */
  async markPosted(
    accountId: string,
    which: { version: number } | { day: string },
    post: { chainId: number; contract: string; txHash: string | null },
  ): Promise<void> {
    const [table, key, value] =
      "version" in which
        ? ["gate_mandates", "version=$2::int", which.version]
        : ["gate_log_roots", "day=$2::date", which.day];
    await this.pool.query(
      `UPDATE ${table} SET anchor_chain_id=$3, anchor_contract=$4, anchor_tx=$5,
         anchored_at=now(), anchor_error=NULL WHERE account_id=$1 AND ${key}`,
      [accountId, value, post.chainId, post.contract.toLowerCase(), post.txHash],
    );
  }

  /** Why posting a mandate version or a day's root failed; it is tried again later. */
  async postFailed(
    accountId: string,
    which: { version: number } | { day: string },
    error: string,
  ): Promise<void> {
    const [table, key, value] =
      "version" in which
        ? ["gate_mandates", "version=$2::int", which.version]
        : ["gate_log_roots", "day=$2::date", which.day];
    await this.pool.query(
      `UPDATE ${table} SET anchor_error=$3 WHERE account_id=$1 AND ${key} AND anchored_at IS NULL`,
      [accountId, value, error.slice(0, 300)],
    );
  }
}

function refund(r: Record<string, unknown>): GateRefundRecord {
  return {
    id: String(r.id),
    reference: r.reference as string,
    name: r.name as string,
    account: r.account as string,
    amountCents: num(r.amount_cents),
    reason: r.reason as string,
    createdAt: r.created_at as Date,
  };
}

function ticket(r: Record<string, unknown>): GateTicketRecord {
  return {
    id: r.id as string,
    vendorId: r.vendor_id as string,
    account: r.account as string,
    verifiedBy: r.verified_by as string,
    usedBy: (r.used_by as string | null) ?? null,
    createdAt: r.created_at as Date,
  };
}
