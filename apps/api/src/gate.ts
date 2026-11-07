import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  GateStore,
  GateWatchStore,
  type Database,
  type GateAccountRecord,
  type GateAnchorPost,
} from "@bonded/db";
import {
  cardMerchantKey,
  describePaymentMandate,
  GATE_MODES,
  GATE_RECEIPT_DOMAIN,
  GATE_RECEIPT_TYPES,
  gateAccountKey,
  gateDayNumber,
  gateLogProof,
  gateLogRoot,
  gateMandateHash,
  gateReceiptHash,
  normalAccount,
  normalReference,
  utcDay,
  type SignedGateReceipt,
} from "@bondedhq/shared";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { Refused, handle } from "./refused.js";
import { RateLimiter, clientAddress } from "./rate-limit.js";
import type { SessionWallet } from "./sessions.js";
import { Notifier, type EmailSender } from "./notifications.js";
import type { SecretBox } from "./secrets.js";
import { alertOwner, decisionView, runGateCheck, type GateCheckRequest } from "./gate-check.js";
import { gateCardRoutes, type GateCardOptions } from "./gate-card.js";
import { gatePayoutRoutes, type GatePayoutOptions } from "./gate-payout.js";
import { gateWatchRoutes } from "./gate-watch.js";

/**
 * The payment gate's hosted check (apps/api/GATE.md). A business makes a gate account with its
 * wallet session (sessions.ts), fills in its mandate (limits, mode, vendors) and the state the
 * rules read (approved invoices and refunds, verified bank-change tickets), and gives its agents
 * an API key. Each payment the agent is about to make goes to `POST /payments/check`, which runs
 * the shared rule engine (`@bondedhq/shared`, payment-mandate.ts) and answers with the decision
 * and a receipt signed with GATE_RECEIPT_PRIVATE_KEY. Every route under /gate and /payments
 * authenticates itself (owner session, gate API key, or none for the receipt key), so the
 * operator-token check in index.ts lets them through (`gateOpen`).
 */

export const GATE_KEY_PREFIX = "bonded_gk_";

export interface GateOptions {
  /** Signs receipts (GATE_RECEIPT_PRIVATE_KEY). Without it, checks are refused. */
  receiptKey?: Hex;
  /** Checks per gate account per minute (default 600). */
  checksPerMinute?: number;
  /** Requests per client address per minute to the API-key routes (default 1,200). */
  keyRequestsPerMinute?: number;
  /** Gate accounts per wallet (default 20). */
  maxAccountsPerOwner?: number;
  /** Live API keys per gate account (default 10). */
  maxKeysPerAccount?: number;
  /** Vendors per gate account (default 500). */
  maxVendorsPerAccount?: number;
  /** Sends the owner's alerts (default: one made from the API's secrets and email sender). */
  notifier?: Notifier;
  /** The card route with Stripe Issuing (gate-card.ts). */
  card?: GateCardOptions;
  /** The payout route through the payout proxy in a TEE (gate-payout.ts). */
  payout?: GatePayoutOptions;
  /** Chains wallets can be watched on (GATE_WATCH_RPC_URLS, gate-watch.ts). */
  watchChains?: readonly number[];
  /** Watched wallets per gate account (default 20). */
  maxWalletsPerAccount?: number;
}

/**
 * Routes under /gate and /payments do their own authentication (see the module comment), and
 * Stripe's webhooks under /stripe/issuing and /stripe/payouts are checked by their signature.
 */
export const gateOpen = (path: string) =>
  /^\/(gate|payments|stripe\/issuing|stripe\/payouts)(\/|$)/.test(path);

/** Stripe's webhooks, whose events can be larger than the API's usual 16 KB body cap. */
export const stripeWebhookPath = (path: string) => /^\/stripe\/issuing\//.test(path);

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** A dollar amount with at most two decimals, as whole cents. */
const cents = z
  .number()
  .positive()
  .max(100_000_000_000)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6)
  .transform((v) => Math.round(v * 100));
/** Printable text without control characters. */
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}]*$/u);
/** A bank account or payee as the business writes it: compared without spaces, any case. */
const payee = z
  .string()
  .max(100)
  .regex(/^[\x20-\x7E]+$/)
  .refine((v) => normalAccount(v).length > 0);
const id = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);
const reference = text(100);
const requestId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const uuid = z.uuid();
const rowId = z.string().regex(/^\d{1,18}$/);
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && utcDay(new Date(v)) === v);
const listQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: rowId.optional(),
});

const accountInput = z.strictObject({
  name: text(80).optional(),
  /** Monitor (record and let through) unless set: a new account starts by watching. */
  mode: z.enum(GATE_MODES).default("monitor"),
  maxPaymentUsd: cents,
  maxDailyUsd: cents,
  freezeOnBreach: z.boolean().default(false),
  /** A name for the first API key. */
  keyLabel: text(80).optional(),
});
const accountPatch = z
  .strictObject({
    name: text(80).optional(),
    mode: z.enum(GATE_MODES).optional(),
    maxPaymentUsd: cents.optional(),
    maxDailyUsd: cents.optional(),
    freezeOnBreach: z.boolean().optional(),
    /** Off for payments with no invoices: the check reads the payee list and the limits. */
    invoiceMatching: z.boolean().optional(),
    /** A watched payment with no check before it raises an alert. */
    expectChecks: z.boolean().optional(),
    /** Payments allowed in any hour, with invoice matching off. null removes the limit. */
    maxPaymentsPerHour: z.number().int().positive().max(1_000_000).nullable().optional(),
  })
  .refine((p) => Object.keys(p).length > 0);
/** A vendor's card merchant: its name and Stripe network id (`merchant_data.network_id`). */
const cardMerchant = z.strictObject({
  name: text(120),
  networkId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
});
const vendorInput = z.strictObject({
  id,
  name: text(120),
  account: payee,
  cardMerchant: cardMerchant.optional(),
});
const vendorPatch = z
  .strictObject({
    name: text(120).optional(),
    account: payee.optional(),
    /** null removes it. Changing one on file needs `ticket`. */
    cardMerchant: cardMerchant.nullable().optional(),
    ticket: id.optional(),
  })
  .refine((p) => Object.keys(p).some((k) => k !== "ticket"));
const merchantOf = (m: { name: string; networkId: string }) => ({
  ...m,
  key: cardMerchantKey(m.networkId),
});
const invoiceInput = z.strictObject({ vendorId: id, reference, amountUsd: cents });
const refundInput = z.strictObject({
  reference,
  account: payee,
  amountUsd: cents,
  name: text(120).optional(),
  reason: text(300).optional(),
});
const ticketInput = z.strictObject({ id, vendorId: id, account: payee, verifiedBy: text(120) });
const paymentInput = z.strictObject({
  kind: z.enum(["invoice", "refund"]).default("invoice"),
  account: payee,
  amountUsd: cents,
  reference,
  day,
});
/** A check. `kind` defaults to an invoice payment; fields are named as in `PaymentAttempt`. */
const checkInput = z.preprocess(
  (v) => (v && typeof v === "object" && !("kind" in v) ? { ...(v as object), kind: "invoice" } : v),
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("invoice"),
      account: payee,
      amountUsd: cents,
      /** Required unless the account has invoice matching off (the rules say so). */
      invoiceReference: reference.optional(),
      requestId: requestId.optional(),
    }),
    z.strictObject({
      kind: z.literal("refund"),
      account: payee,
      amountUsd: cents,
      invoiceReference: reference,
      requestId: requestId.optional(),
    }),
    z.strictObject({
      kind: z.literal("bank_change"),
      vendorId: id,
      account: payee,
      ticket: id.optional(),
      requestId: requestId.optional(),
    }),
  ]),
);
const decisionsQuery = listQuery.extend({
  result: z.enum(["allowed", "blocked", "refused"]).optional(),
});

/** An account as its owner sees it, with its mandate in plain words. */
const accountView = (a: GateAccountRecord) => ({
  id: a.id,
  name: a.name,
  owner: a.owner,
  mode: a.mode,
  maxPaymentUsd: a.maxPaymentCents / 100,
  maxDailyUsd: a.maxDailyCents / 100,
  freezeOnBreach: a.freezeOnBreach,
  invoiceMatching: a.invoiceMatching,
  maxPaymentsPerHour: a.maxPaymentsPerHour,
  expectChecks: a.expectChecks,
  frozen: a.frozenAt !== null,
  frozenAt: a.frozenAt?.toISOString() ?? null,
  frozenBy: a.frozenBy,
  mandate: { version: a.mandateVersion, hash: a.mandateHash },
  rules: describePaymentMandate({
    mode: a.mode,
    maxPaymentUsd: a.maxPaymentCents / 100,
    maxDailyUsd: a.maxDailyCents / 100,
    freezeOnBreach: a.freezeOnBreach,
    invoiceMatching: a.invoiceMatching,
    maxPaymentsPerHour: a.maxPaymentsPerHour,
  }),
  createdAt: a.createdAt.toISOString(),
  updatedAt: a.updatedAt.toISOString(),
});

/** Where a hash was posted on chain (GateAnchor), or null while it isn't. */
const postedView = (p: GateAnchorPost | null) =>
  p && {
    chainId: p.chainId,
    contract: p.contract,
    txHash: p.txHash,
    postedAt: p.postedAt.toISOString(),
  };

/** A new API key: the key itself (shown once) and what is stored (its hash and a prefix). */
const newKey = (label: string) => {
  const key = `${GATE_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return {
    key,
    stored: { id: randomUUID(), hash: sha256(key), prefix: key.slice(0, 14), label },
  };
};

export function gateRoutes(
  app: Hono,
  options: GateOptions & {
    db: Database;
    wallet: SessionWallet;
    writes: RateLimiter;
    reads: RateLimiter;
    now: () => number;
    secrets?: SecretBox | undefined;
    email?: EmailSender | undefined;
    allowLoopbackUrls?: boolean | undefined;
  },
) {
  const { db, wallet, now } = options;
  const store = new GateStore(db, gateMandateHash);
  const notifier =
    options.notifier ??
    new Notifier(db, {
      ...(options.secrets ? { secrets: options.secrets } : {}),
      ...(options.email ? { email: options.email } : {}),
      ...(options.allowLoopbackUrls ? { allowLoopback: true } : {}),
      log: (line) => console.error(line),
    });
  const receiptSigner = options.receiptKey
    ? privateKeyToAccount(options.receiptKey).address
    : undefined;
  const maxAccounts = options.maxAccountsPerOwner ?? 20;
  const maxKeys = options.maxKeysPerAccount ?? 10;
  const maxVendors = options.maxVendorsPerAccount ?? 500;
  const keyClients = new RateLimiter({
    perClient: options.keyRequestsPerMinute ?? 1200,
    total: 100_000,
    windowMs: 60_000,
    now,
  });
  const checks = new RateLimiter({
    perClient: options.checksPerMinute ?? 600,
    total: 50_000,
    windowMs: 60_000,
    now,
  });
  const limited = (c: Context, limiter: RateLimiter) => {
    if (!limiter.allow(clientAddress(c.req.raw.headers)))
      throw new Refused(429, "Too many requests. Try again in a few minutes.");
  };

  /** The signed-in owner's account named in the path, or "not found" for anyone else. */
  const owned = async (c: Context, limiter: RateLimiter) => {
    limited(c, limiter);
    const owner = (await wallet(c)).toLowerCase();
    const parsed = uuid.safeParse(c.req.param("id"));
    const account = parsed.success ? await store.account(parsed.data) : undefined;
    if (!account || account.owner !== owner) throw new Refused(404, "No such gate account.");
    return { owner, account };
  };
  /** The account behind the request's API key. */
  const keyed = async (c: Context) => {
    limited(c, keyClients);
    const header = c.req.header("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token.startsWith(GATE_KEY_PREFIX)) throw new Refused(401, "Send your gate API key.");
    const found = /^bonded_gk_[A-Za-z0-9_-]{43}$/.test(token)
      ? await store.keyAccount(sha256(token))
      : undefined;
    if (!found) throw new Refused(401, "That gate API key isn't valid or was revoked.");
    return found;
  };
  const notFound = (what: string): never => {
    throw new Refused(404, `No such ${what} on this gate account.`);
  };
  const already = (what: string): never => {
    throw new Refused(409, `That ${what} is already on this gate account.`);
  };

  /** The address receipts are signed with, and the typed data to check them against. */
  app.get(
    "/gate/receipt-key",
    handle(async (c) => {
      if (!receiptSigner)
        throw new Refused(503, "The payment gate's receipt key isn't set up on this service.");
      return c.json({
        address: receiptSigner,
        domain: GATE_RECEIPT_DOMAIN,
        types: GATE_RECEIPT_TYPES,
        primaryType: "GateReceipt",
      });
    }),
  );

  // Gate accounts and their mandates (owner session).

  app.post(
    "/gate/accounts",
    handle(async (c) => {
      limited(c, options.writes);
      const owner = (await wallet(c)).toLowerCase();
      const input = accountInput.parse(await c.req.json());
      const { key, stored } = newKey(input.keyLabel ?? "");
      const made = await store.createAccount(
        {
          id: randomUUID(),
          owner,
          name: input.name ?? "",
          mode: input.mode,
          maxPaymentCents: input.maxPaymentUsd,
          maxDailyCents: input.maxDailyUsd,
          freezeOnBreach: input.freezeOnBreach,
          key: stored,
        },
        maxAccounts,
      );
      if ("refused" in made)
        throw new Refused(409, "This wallet has as many gate accounts as it may.", {
          limit: maxAccounts,
        });
      c.header("Cache-Control", "no-store");
      return c.json(
        { account: accountView(made), apiKey: { id: stored.id, key, prefix: stored.prefix } },
        201,
      );
    }),
  );
  app.get(
    "/gate/accounts",
    handle(async (c) => {
      limited(c, options.reads);
      const owner = await wallet(c);
      return c.json({ items: (await store.accountsOf(owner)).map(accountView) });
    }),
  );
  app.get(
    "/gate/accounts/:id",
    handle(async (c) => {
      const { account } = await owned(c, options.reads);
      return c.json(accountView(account));
    }),
  );
  /** Change the name, mode, limits or freeze setting. A changed mandate gets a new version. */
  app.put(
    "/gate/accounts/:id",
    handle(async (c) => {
      const { owner, account } = await owned(c, options.writes);
      const p = accountPatch.parse(await c.req.json());
      const updated = await store.updateAccount(
        account.id,
        {
          ...(p.name !== undefined ? { name: p.name } : {}),
          ...(p.mode ? { mode: p.mode } : {}),
          ...(p.maxPaymentUsd !== undefined ? { maxPaymentCents: p.maxPaymentUsd } : {}),
          ...(p.maxDailyUsd !== undefined ? { maxDailyCents: p.maxDailyUsd } : {}),
          ...(p.freezeOnBreach !== undefined ? { freezeOnBreach: p.freezeOnBreach } : {}),
          ...(p.invoiceMatching !== undefined ? { invoiceMatching: p.invoiceMatching } : {}),
          ...(p.expectChecks !== undefined ? { expectChecks: p.expectChecks } : {}),
          ...(p.maxPaymentsPerHour !== undefined
            ? { maxPaymentsPerHour: p.maxPaymentsPerHour }
            : {}),
        },
        owner,
      );
      return c.json(accountView(updated!));
    }),
  );
  /** Lift a freeze: checks run again. */
  app.post(
    "/gate/accounts/:id/unfreeze",
    handle(async (c) => {
      const { account } = await owned(c, options.writes);
      return c.json(accountView((await store.unfreeze(account.id))!));
    }),
  );
  /** Every version of the mandate, newest first, each with its hash and its rules in words. */
  app.get(
    "/gate/accounts/:id/mandates",
    handle(async (c) => {
      const { account } = await owned(c, options.reads);
      const q = listQuery.parse(c.req.query());
      const versions = await store.mandates(account.id, {
        ...(q.limit ? { limit: q.limit } : {}),
        ...(q.before ? { before: Number(q.before) } : {}),
      });
      return c.json({
        items: versions.items.map((v) => ({
          ...v,
          createdAt: v.createdAt.toISOString(),
          posted: postedView(v.posted),
          rules: describePaymentMandate({
            mode: v.mandate.mode,
            maxPaymentUsd: v.mandate.maxPaymentCents / 100,
            maxDailyUsd: v.mandate.maxDailyCents / 100,
            freezeOnBreach: v.mandate.freezeOnBreach,
            invoiceMatching: v.mandate.invoiceMatching ?? true,
            maxPaymentsPerHour: v.mandate.maxPaymentsPerHour ?? null,
          }),
        })),
        next: versions.next,
      });
    }),
  );
  /** Checks per UTC day (the meter), `?days=` back from today (default 30). */
  app.get(
    "/gate/accounts/:id/usage",
    handle(async (c) => {
      const { account } = await owned(c, options.reads);
      const { days } = z
        .strictObject({ days: z.coerce.number().int().min(1).max(400).default(30) })
        .parse(c.req.query());
      const since = utcDay(new Date(now() - (days - 1) * 86_400_000));
      const items = await store.usage(account.id, since);
      return c.json({ items, total: items.reduce((sum, d) => sum + d.checks, 0) });
    }),
  );

  // API keys (owner session). A key is shown once, when it is made.

  app.get(
    "/gate/accounts/:id/keys",
    handle(async (c) => {
      const { account } = await owned(c, options.reads);
      return c.json({ items: await store.keys(account.id) });
    }),
  );
  app.post(
    "/gate/accounts/:id/keys",
    handle(async (c) => {
      const { account } = await owned(c, options.writes);
      const { label } = z.strictObject({ label: text(80).optional() }).parse(await c.req.json());
      const { key, stored } = newKey(label ?? "");
      const made = await store.createKey(account.id, stored, maxKeys);
      if ("refused" in made)
        throw new Refused(409, "This gate account has as many live API keys as it may.", {
          limit: maxKeys,
        });
      c.header("Cache-Control", "no-store");
      return c.json({ ...made, key }, 201);
    }),
  );
  app.delete(
    "/gate/accounts/:id/keys/:keyId",
    handle(async (c) => {
      const { account } = await owned(c, options.writes);
      const keyId = uuid.safeParse(c.req.param("keyId"));
      if (!keyId.success || !(await store.revokeKey(account.id, keyId.data))) notFound("API key");
      return c.json({ revoked: true });
    }),
  );

  // The vendor master (part of the mandate: each change makes a new version).

  app.get(
    "/gate/accounts/:id/vendors",
    handle(async (c) => {
      const { account } = await owned(c, options.reads);
      return c.json({ items: await store.vendors(account.id) });
    }),
  );
  app.post(
    "/gate/accounts/:id/vendors",
    handle(async (c) => {
      const { owner, account } = await owned(c, options.writes);
      const v = vendorInput.parse(await c.req.json());
      if ((await store.vendors(account.id)).length >= maxVendors)
        throw new Refused(409, "This gate account has as many vendors as it may.", {
          limit: maxVendors,
        });
      const made = await store.addVendor(
        account.id,
        {
          id: v.id,
          name: v.name,
          account: v.account,
          accountNorm: normalAccount(v.account),
          cardMerchant: v.cardMerchant ? merchantOf(v.cardMerchant) : undefined,
        },
        owner,
      );
      if (made === "exists") already("vendor");
      return c.json(made, 201);
    }),
  );
  app.put(
    "/gate/accounts/:id/vendors/:vendorId",
    handle(async (c) => {
      const { owner, account } = await owned(c, options.writes);
      const vendorId = id.parse(c.req.param("vendorId"));
      const p = vendorPatch.parse(await c.req.json());
      const updated = await store.updateVendor(
        account.id,
        vendorId,
        {
          ...(p.name ? { name: p.name } : {}),
          ...(p.account ? { account: p.account, accountNorm: normalAccount(p.account) } : {}),
          ...(p.cardMerchant !== undefined
            ? { cardMerchant: p.cardMerchant && merchantOf(p.cardMerchant) }
            : {}),
          ...(p.ticket ? { ticket: p.ticket } : {}),
        },
        owner,
      );
      if (updated === "needs-ticket")
        throw new Refused(
          409,
          "A vendor's card merchant changes only with a verified ticket that covers it: a ticket for this vendor whose account is card:<network id>.",
        );
      return updated ? c.json(updated) : notFound("vendor");
    }),
  );
  app.delete(
    "/gate/accounts/:id/vendors/:vendorId",
    handle(async (c) => {
      const { owner, account } = await owned(c, options.writes);
      const vendorId = id.parse(c.req.param("vendorId"));
      if (!(await store.deleteVendor(account.id, vendorId, owner))) notFound("vendor");
      return c.json({ deleted: true });
    }),
  );

  // Approved invoices and refunds, verified bank-change tickets, and payments made.

  app.get(
    "/gate/accounts/:id/invoices",
    handle(async (c) => {
      const { account } = await owned(c, options.reads);
      return c.json(await store.invoices(account.id, listQuery.parse(c.req.query())));
    }),
  );
  app.post(
    "/gate/accounts/:id/invoices",
    handle(async (c) => {
      const { account } = await owned(c, options.writes);
      const i = invoiceInput.parse(await c.req.json());
      const made = await store.addInvoice(account.id, {
        vendorId: i.vendorId,
        reference: i.reference,
        referenceNorm: normalReference(i.reference),
        amountCents: i.amountUsd,
      });
      if (made === "no-vendor") notFound("vendor");
      if (made === "exists") already("invoice");
      return c.json(made, 201);
    }),
  );
  app.get(
    "/gate/accounts/:id/refunds",
    handle(async (c) => {
      const { account } = await owned(c, options.reads);
      return c.json(await store.refunds(account.id, listQuery.parse(c.req.query())));
    }),
  );
  app.post(
    "/gate/accounts/:id/refunds",
    handle(async (c) => {
      const { account } = await owned(c, options.writes);
      const f = refundInput.parse(await c.req.json());
      const made = await store.addRefund(account.id, {
        reference: f.reference,
        referenceNorm: normalReference(f.reference),
        name: f.name ?? "",
        account: f.account,
        accountNorm: normalAccount(f.account),
        amountCents: f.amountUsd,
        reason: f.reason ?? "",
      });
      if (made === "exists") already("refund");
      return c.json(made, 201);
    }),
  );
  app.get(
    "/gate/accounts/:id/tickets",
    handle(async (c) => {
      const { account } = await owned(c, options.reads);
      return c.json({ items: await store.tickets(account.id) });
    }),
  );
  app.post(
    "/gate/accounts/:id/tickets",
    handle(async (c) => {
      const { account } = await owned(c, options.writes);
      const t = ticketInput.parse(await c.req.json());
      const made = await store.addTicket(account.id, {
        ...t,
        accountNorm: normalAccount(t.account),
      });
      if (made === "no-vendor") notFound("vendor");
      if (made === "exists") already("ticket");
      return c.json(made, 201);
    }),
  );
  for (const [what, path, remove, param] of [
    ["invoice", "invoices", (a: string, i: string) => store.deleteInvoice(a, i), rowId],
    ["refund", "refunds", (a: string, i: string) => store.deleteRefund(a, i), rowId],
    ["ticket", "tickets", (a: string, i: string) => store.deleteTicket(a, i), id],
  ] as const)
    app.delete(
      `/gate/accounts/:id/${path}/:itemId`,
      handle(async (c) => {
        const { account } = await owned(c, options.writes);
        const itemId = param.safeParse(c.req.param("itemId"));
        if (!itemId.success || !(await remove(account.id, itemId.data))) notFound(what);
        return c.json({ deleted: true });
      }),
    );
  app.get(
    "/gate/accounts/:id/payments",
    handle(async (c) => {
      const { account } = await owned(c, options.reads);
      return c.json(await store.payments(account.id, listQuery.parse(c.req.query())));
    }),
  );
  /** Import a payment made before the gate, so the duplicate and daily rules count it. */
  app.post(
    "/gate/accounts/:id/payments",
    handle(async (c) => {
      const { account } = await owned(c, options.writes);
      const p = paymentInput.parse(await c.req.json());
      if (p.day > utcDay(new Date(now())))
        throw new Refused(400, "A payment's day can't be in the future.");
      const made = await store.addPayment(account.id, {
        source: "import",
        kind: p.kind,
        payee: p.account,
        payeeNorm: normalAccount(p.account),
        amountCents: p.amountUsd,
        reference: p.reference.trim(),
        referenceNorm: normalReference(p.reference),
        day: p.day,
      });
      return c.json(made, 201);
    }),
  );

  // The check and the decision log.

  /** Check a payment, refund or bank change before it is made. Always answers with a receipt. */
  app.post(
    "/payments/check",
    handle(async (c) => {
      const auth = await keyed(c);
      if (!checks.allow(auth.accountId))
        throw new Refused(429, "Too many checks for this gate account. Try again in a minute.");
      // Fail closed: a decision without a signed receipt is never given.
      if (!options.receiptKey)
        throw new Refused(503, "The payment gate's receipt key isn't set up on this service.");
      const input = checkInput.parse(await c.req.json());
      const request: GateCheckRequest =
        input.kind === "bank_change"
          ? input
          : {
              kind: input.kind,
              account: input.account,
              amountCents: input.amountUsd,
              reference: input.invoiceReference ?? "",
              requestId: input.requestId,
            };
      const outcome = await runGateCheck(
        { db, store, receiptKey: options.receiptKey, now, followInvoiceSetting: true },
        auth,
        request,
      );
      alertOwner(notifier, outcome);
      c.header("Cache-Control", "no-store");
      return c.json({
        ...decisionView(outcome.decision),
        frozen: outcome.account.frozenAt !== null,
        replayed: outcome.replayed,
        ...(outcome.input ? { input: outcome.input } : {}),
      });
    }),
  );
  const decisions = async (c: Context, accountId: string) => {
    const q = decisionsQuery.parse(c.req.query());
    const result = await store.decisions(accountId, q);
    return c.json({ items: result.items.map(decisionView), next: result.next });
  };
  const decision = async (c: Context, accountId: string) => {
    const parsed = uuid.safeParse(c.req.param("decisionId"));
    const found = parsed.success ? await store.decision(accountId, parsed.data) : undefined;
    return found ? c.json(decisionView(found)) : notFound("decision");
  };
  /** The decision log, newest first: `?limit=`, `?before=<next>`, `?result=blocked`. */
  app.get(
    "/payments/decisions",
    handle(async (c) => decisions(c, (await keyed(c)).accountId)),
  );
  app.get(
    "/payments/decisions/:decisionId",
    handle(async (c) => decision(c, (await keyed(c)).accountId)),
  );
  app.get(
    "/gate/accounts/:id/decisions",
    handle(async (c) => decisions(c, (await owned(c, options.reads)).account.id)),
  );
  app.get(
    "/gate/accounts/:id/decisions/:decisionId",
    handle(async (c) => decision(c, (await owned(c, options.reads)).account.id)),
  );

  // Hashes on chain: each day's log root and each mandate version's hash (GateAnchor).

  /**
   * The proof that a decision's receipt is in its day's log root. It reveals the receipt, so only
   * the owner and the account's agents get it.
   */
  const proof = async (c: Context, accountId: string) => {
    const parsed = uuid.safeParse(c.req.param("decisionId"));
    const found = parsed.success ? await store.decision(accountId, parsed.data) : undefined;
    if (!found) return notFound("decision");
    const day = utcDay(found.createdAt);
    const root = await store.logRoot(accountId, day);
    if (!root)
      throw new Refused(
        409,
        "This decision's day has no log root yet. It is made once the day ends (UTC).",
        { day },
      );
    const decisions = await store.dayDecisions(accountId, day);
    const hashes = decisions.map((d) => gateReceiptHash((d.receipt as SignedGateReceipt).receipt));
    // The day must still be exactly what the root covers.
    if (hashes.length !== root.receipts || gateLogRoot(hashes) !== root.root)
      throw new Refused(
        409,
        "This day's log no longer matches its root, so it can't be proved: some of its decisions were deleted after the retention period.",
        { day },
      );
    const index = decisions.findIndex((d) => d.id === found.id);
    c.header("Cache-Control", "no-store");
    return c.json({
      decisionId: found.id,
      accountKey: gateAccountKey(accountId),
      day,
      dayNumber: gateDayNumber(day),
      receiptHash: hashes[index],
      root: root.root,
      proof: gateLogProof(hashes, index),
      posted: postedView(root.posted),
    });
  };
  app.get(
    "/gate/accounts/:id/decisions/:decisionId/proof",
    handle(async (c) => proof(c, (await owned(c, options.reads)).account.id)),
  );
  app.get(
    "/payments/decisions/:decisionId/proof",
    handle(async (c) => proof(c, (await keyed(c)).accountId)),
  );

  /** Any account named in the path, for the public routes. Hashes only: nothing they cover. */
  const anyAccount = async (c: Context) => {
    limited(c, options.reads);
    const parsed = uuid.safeParse(c.req.param("id"));
    const account = parsed.success ? await store.account(parsed.data) : undefined;
    if (!account) throw new Refused(404, "No such gate account.");
    return account;
  };
  /** Public: each mandate version's hash, newest first, and where it was posted. */
  app.get(
    "/gate/anchors/:id/mandates",
    handle(async (c) => {
      const account = await anyAccount(c);
      const q = listQuery.parse(c.req.query());
      const versions = await store.mandates(account.id, {
        ...(q.limit ? { limit: q.limit } : {}),
        ...(q.before ? { before: Number(q.before) } : {}),
      });
      return c.json({
        accountId: account.id,
        accountKey: gateAccountKey(account.id),
        items: versions.items.map((v) => ({
          version: v.version,
          hash: v.hash,
          createdAt: v.createdAt.toISOString(),
          posted: postedView(v.posted),
        })),
        next: versions.next,
      });
    }),
  );
  /** Public: each day's log root, newest first, and where it was posted. */
  app.get(
    "/gate/anchors/:id/roots",
    handle(async (c) => {
      const account = await anyAccount(c);
      const q = z
        .strictObject({
          limit: z.coerce.number().int().min(1).max(100).optional(),
          before: day.optional(),
        })
        .parse(c.req.query());
      const roots = await store.logRoots(account.id, q);
      return c.json({
        accountId: account.id,
        accountKey: gateAccountKey(account.id),
        items: roots.items.map((r) => ({
          day: r.day,
          dayNumber: gateDayNumber(r.day),
          root: r.root,
          posted: postedView(r.posted),
        })),
        next: roots.next,
      });
    }),
  );

  gateWatchRoutes(app, {
    db,
    store,
    watch: new GateWatchStore(db),
    notifier,
    now,
    chains: options.watchChains ?? [],
    maxWallets: options.maxWalletsPerAccount ?? 20,
    owned: (c, write) => owned(c, write ? options.writes : options.reads),
    keyed,
    allowCheck: (accountId) => checks.allow(accountId),
  });
  gateCardRoutes(
    app,
    {
      db,
      store,
      notifier,
      receiptKey: options.receiptKey,
      now,
      secrets: options.secrets,
      checks,
      owned,
      keyed,
      writes: options.writes,
      reads: options.reads,
      log: options.card?.log ?? ((line) => console.error(line)),
    },
    options.card,
  );
  gatePayoutRoutes(
    app,
    {
      db,
      store,
      notifier,
      receiptKey: options.receiptKey,
      now,
      secrets: options.secrets,
      checks,
      owned,
      keyed,
      limited,
      writes: options.writes,
      reads: options.reads,
      log: options.payout?.log ?? ((line) => console.error(line)),
    },
    options.payout,
  );

  return { store, notifier };
}
