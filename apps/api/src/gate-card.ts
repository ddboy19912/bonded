import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  GateCardStore,
  type Connection,
  type Database,
  type GateAccountRecord,
  type GateCardIntentRecord,
  type GateStore,
} from "@bonded/db";
import {
  CARD_BLOCKED_CATEGORIES,
  cardMerchantKey,
  evaluateGateInput,
  gateInputHash,
  normalReference,
  signGateReceipt,
  utcDay,
  type GateCardInput,
  type GateReceipt,
} from "@bondedhq/shared";
import type { Hex } from "viem";
import { Refused, handle } from "./refused.js";
import type { RateLimiter } from "./rate-limit.js";
import { gateNotification, type GateNotification, type Notifier } from "./notifications.js";
import { gateStripeContext, type SecretBox } from "./secrets.js";
import {
  STRIPE_API_VERSION,
  stripeIssuingClient,
  verifyStripeSignature,
  type StripeIssuingClient,
} from "./stripe-issuing.js";
import { alertOwner, ruleWords, type GateCheckOutcome } from "./gate-check.js";

/**
 * The payment gate's card route (apps/api/GATE.md, "The card route"). A gate account links its
 * Stripe Issuing account; the agent asks `POST /payments/intents` for a single-use virtual card
 * per approved invoice, limited to its amount; Stripe asks `POST /stripe/issuing/authorization`
 * before each charge on it, and the gate answers in the webhook response after running the shared
 * rules through the card mapping (`GateCardInput` in @bondedhq/shared), the account's mode and
 * freeze, and recording a decision with a signed receipt, all in one transaction. Enforce mode
 * never approves a charge that breaks a rule, and any failure or a blown time budget declines.
 * `POST /stripe/issuing/events` reconciles what reached Stripe without the gate: authorizations
 * Stripe approved itself, transactions with no gate-approved authorization (a breach: recorded,
 * card cancelled, owner alerted), captures above the approved amount (overpayment), and reversals
 * or expiries (the invoice is released). Nothing is marked paid until a transaction settles.
 *
 * Card numbers and CVCs pass through to the agent once, as Stripe returns them, and are never
 * stored or logged; the Stripe key and endpoint secrets are stored encrypted and never returned.
 */

export interface GateCardOptions {
  /** Stripe's API (default: the fetch client). Tests pass a fake. */
  stripe?: StripeIssuingClient;
  /** STRIPE_WEBHOOK_SECRET: signs the real-time authorization endpoint's requests. */
  authorizationSecret?: string;
  /** STRIPE_EVENTS_WEBHOOK_SECRET: signs the events endpoint's requests. */
  eventsSecret?: string;
  /** GATE_ALLOW_LIVE_CREDENTIALS=true: accept live Stripe keys and live charges. Off by default. */
  allowLiveCredentials?: boolean;
  /** STRIPE_API_VERSION: sent to Stripe and answered with (default STRIPE_API_VERSION). */
  apiVersion?: string;
  /**
   * How long the gate may take to answer an authorization request (default 1,500 ms, inside
   * Stripe's 2 seconds). Past it the gate declines, and nothing it was deciding is kept.
   */
  budgetMs?: number;
  /** Where operational lines go (default stderr). Never given a card number, CVC or secret. */
  log?: (line: string) => void;
}

/** Stripe's `request_history.reason` values that mean the gate's answer didn't count. */
const MISSED = ["webhook_timeout", "webhook_error", "network_fallback"];

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}]*$/u);
const vendorIdInput = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);
const linkInput = z.strictObject({
  /** A restricted key (rk_) or secret key (sk_); test mode unless live credentials are allowed. */
  secretKey: z.string().regex(/^(rk|sk)_(test|live)_[A-Za-z0-9]{10,247}$/),
  cardholderId: z.string().regex(/^ich_[A-Za-z0-9]{1,64}$/),
  authorizationWebhookSecret: z
    .string()
    .regex(/^whsec_[A-Za-z0-9+/=_-]{10,200}$/)
    .optional(),
  eventsWebhookSecret: z
    .string()
    .regex(/^whsec_[A-Za-z0-9+/=_-]{10,200}$/)
    .optional(),
});
const intentInput = z.strictObject({
  invoiceReference: text(100),
  vendorId: vendorIdInput.optional(),
});

/** Stripe objects carry the card as an id or an expanded object. */
const idOf = (v: unknown): string | undefined =>
  typeof v === "string"
    ? v
    : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string"
      ? (v as { id: string }).id
      : undefined;

const dollars = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type StripeObject = Record<string, unknown>;

/** The merchant's Stripe network id, as given (`merchant_data.network_id`). */
const networkIdOf = (o: StripeObject) => {
  const m = (o.merchant_data ?? {}) as Record<string, unknown>;
  return typeof m.network_id === "string" ? m.network_id : "";
};

/** The merchant as the card mapping sees it. */
const merchantOf = (o: StripeObject) => {
  const m = (o.merchant_data ?? {}) as Record<string, unknown>;
  return {
    key: cardMerchantKey(networkIdOf(o)),
    name: typeof m.name === "string" ? m.name : "",
    category: typeof m.category === "string" ? m.category : "",
  };
};

const intentView = (i: GateCardIntentRecord) => ({
  id: i.id,
  status: i.status,
  vendorId: i.vendorId,
  invoiceReference: i.reference,
  amountUsd: i.amountCents / 100,
  card: i.cardId ? { id: i.cardId, last4: i.cardLast4 } : null,
  createdAt: i.createdAt.toISOString(),
  updatedAt: i.updatedAt.toISOString(),
});

/** The gate ran out of its time budget: the transaction rolls back and the answer is decline. */
class OutOfTime extends Error {}

export function gateCardRoutes(
  app: Hono,
  deps: {
    db: Database;
    store: GateStore;
    notifier: Notifier;
    receiptKey?: Hex | undefined;
    now: () => number;
    secrets?: SecretBox | undefined;
    checks: RateLimiter;
    owned: (
      c: Context,
      limiter: RateLimiter,
    ) => Promise<{ owner: string; account: GateAccountRecord }>;
    keyed: (c: Context) => Promise<{ keyId: string; accountId: string }>;
    writes: RateLimiter;
    reads: RateLimiter;
    log: (line: string) => void;
  },
  options: GateCardOptions = {},
) {
  const { db, store, notifier, now, secrets, log } = deps;
  const cards = new GateCardStore(db);
  const stripe = options.stripe ?? stripeIssuingClient({ apiVersion: options.apiVersion });
  const apiVersion = options.apiVersion ?? STRIPE_API_VERSION;
  const budgetMs = options.budgetMs ?? 1_500;
  const allowLive = options.allowLiveCredentials === true;

  const unavailable = () =>
    new Refused(503, "Stripe linking is off on this service: its secret encryption key isn't set.");
  const notLinked = () => new Refused(409, "This gate account isn't linked to Stripe.");
  const liveRefused = () =>
    new Refused(
      403,
      "Live Stripe keys are refused: the payment gate takes test-mode keys only for now.",
    );

  /** The linked account's Stripe key, decrypted for one call. */
  const stripeKey = async (accountId: string) => {
    if (!secrets) throw unavailable();
    const l = await cards.link(accountId);
    if (!l) throw notLinked();
    if (l.livemode && !allowLive) throw liveRefused();
    return { key: secrets.decrypt(l.keyCiphertext, gateStripeContext(accountId, "key")), link: l };
  };

  /** The secrets a webhook may be signed with: the account's own endpoint's, then the service's. */
  const endpointSecrets = async (
    accountId: string | undefined,
    which: "authorization" | "events",
  ) => {
    const list: string[] = [];
    if (accountId && secrets) {
      const l = await cards.link(accountId);
      const sealed =
        which === "authorization" ? l?.authorizationSecretCiphertext : l?.eventsSecretCiphertext;
      if (sealed)
        try {
          list.push(secrets.decrypt(sealed, gateStripeContext(accountId, which)));
        } catch {
          log(`stripe: the ${which} secret of gate account ${accountId} doesn't decrypt`);
        }
    }
    const shared = which === "authorization" ? options.authorizationSecret : options.eventsSecret;
    if (shared) list.push(shared);
    return list;
  };

  /** Cancel a card after a breach. Never fails the caller; a failure is logged and alerted. */
  const cancelCard = async (account: GateAccountRecord, cardId: string) => {
    try {
      const { key } = await stripeKey(account.id);
      await stripe.cancelCard(key, cardId);
    } catch (error) {
      log(
        `stripe: could not cancel card ${cardId}: ${error instanceof Error ? error.message : "error"}`,
      );
    }
  };

  const alert = (
    account: GateAccountRecord,
    n: Omit<GateNotification, "code" | "fix" | "gateAccountId">,
  ) => notifier.notify(account.owner, gateNotification({ ...n, gateAccountId: account.id }));

  /**
   * Run the card mapping on `input` and record the decision with its signed receipt, inside the
   * caller's transaction. At the authorization stage the mode applies (Monitor lets a breaking
   * charge through, Enforce blocks it) and cash or quasi-cash is always declined; at the
   * transaction stage the money already moved, so the result is "allowed".
   */
  const recordCard = async (
    c: Connection,
    account: GateAccountRecord,
    intent: GateCardIntentRecord,
    input: GateCardInput,
    at: Date,
    override: { overpaidCents?: number } = {},
  ) => {
    if (!deps.receiptKey) throw new Error("no receipt key");
    const frozen = input.stage === "authorization" && account.frozenAt !== null;
    const verdict = frozen ? undefined : evaluateGateInput(input);
    if (verdict && !verdict.ok) throw new Error(verdict.error);
    const ok = verdict?.ok ? verdict : undefined;
    const rules = ok?.rules ?? [];
    const breach = rules.length > 0 || ok?.bypassed === true;
    const decision = frozen ? "frozen" : breach ? "breach" : "pass";
    // Cash and quasi-cash aren't invoice payments: declined in either mode.
    const cash = (CARD_BLOCKED_CATEGORIES as readonly string[]).includes(input.merchant.category);
    const result =
      input.stage === "transaction"
        ? "allowed"
        : frozen
          ? "refused"
          : breach && (account.mode === "enforce" || cash)
            ? "blocked"
            : "allowed";
    const wentOut = result === "allowed";
    const id = randomUUID();
    const inputHash = gateInputHash(input);
    const receipt: GateReceipt = {
      decisionId: id,
      gateAccountId: account.id,
      kind: "card",
      decision,
      result,
      mode: account.mode,
      rules,
      amountCents: input.attempt.amountCents,
      payee: input.merchant.key,
      reference: intent.reference,
      inputHash,
      mandateHash: account.mandateHash as Hex,
      mandateVersion: account.mandateVersion,
      checkedAt: Math.floor(at.getTime() / 1000),
    };
    const signed = await signGateReceipt(receipt, deps.receiptKey);
    const record = await store.addDecision(c, {
      id,
      accountId: account.id,
      keyId: intent.keyId,
      requestId: null,
      requestHash: null,
      kind: "card",
      decision,
      result,
      mode: account.mode,
      rules,
      amountCents: input.attempt.amountCents,
      lossCents: wentOut && ok ? ok.lossCents : 0,
      overpaidCents: wentOut && ok ? (override.overpaidCents ?? ok.overpaidCents) : 0,
      payee: input.merchant.key,
      vendorId: ok?.vendorId ?? null,
      reference: intent.reference,
      inputHash,
      mandateHash: account.mandateHash,
      mandateVersion: account.mandateVersion,
      receipt: signed,
      createdAt: at,
    });
    const froze = decision === "breach" && account.freezeOnBreach && account.frozenAt === null;
    if (froze) await store.freeze(c, account.id, id);
    return { record, froze, approved: wentOut, vendorId: ok?.vendorId ?? null, input };
  };

  /** What one card check reads, for this intent and this merchant (see `GateCardInput`). */
  const cardInput = async (
    c: Connection,
    account: GateAccountRecord,
    intent: GateCardIntentRecord,
    q: {
      stage: GateCardInput["stage"];
      gateApproved: boolean;
      merchant: GateCardInput["merchant"];
      amountCents: number;
      day: string;
      exceptAuthorization?: string | undefined;
    },
  ): Promise<{ input: GateCardInput; tickets: { id: string }[] }> => {
    const vendor = await store.vendor(c, account.id, intent.vendorId);
    const state = await cards.cardState(c, account.id, {
      merchantKey: q.merchant.key,
      vendorId: intent.vendorId,
      referenceNorm: intent.referenceNorm,
      day: q.day,
      exceptAuthorization: q.exceptAuthorization,
    });
    return {
      input: {
        kind: "card",
        stage: q.stage,
        gateApproved: q.gateApproved,
        day: q.day,
        limits: { maxPaymentCents: account.maxPaymentCents, maxDailyCents: account.maxDailyCents },
        attempt: {
          account: q.merchant.key,
          amountCents: q.amountCents,
          reference: intent.reference,
        },
        vendorId: intent.vendorId,
        vendorMerchant: vendor?.cardMerchant
          ? { key: vendor.cardMerchant.key, name: vendor.cardMerchant.name }
          : null,
        merchant: q.merchant,
        payees: state.payees,
        invoices: state.invoices,
        payments: state.payments,
        tickets: state.tickets.map((t) => ({ vendorId: t.vendorId, account: t.account })),
      },
      tickets: state.tickets,
    };
  };

  // Linking a gate account to its Stripe account (owner session).

  const linkView = (l: Awaited<ReturnType<GateCardStore["link"]>>) =>
    l && {
      linked: true,
      keyHint: l.keyHint,
      livemode: l.livemode,
      cardholderId: l.cardholderId,
      webhookSecrets: {
        authorization: l.authorizationSecretCiphertext !== null,
        events: l.eventsSecretCiphertext !== null,
      },
      createdAt: l.createdAt.toISOString(),
      updatedAt: l.updatedAt.toISOString(),
    };

  app.get(
    "/gate/accounts/:id/stripe",
    handle(async (c) => {
      const { account } = await deps.owned(c, deps.reads);
      const l = await cards.link(account.id);
      if (!l) throw new Refused(404, "This gate account isn't linked to Stripe.");
      return c.json(linkView(l));
    }),
  );
  /** Link (or relink) the account's Stripe account. Test-mode keys only, unless allowed. */
  app.put(
    "/gate/accounts/:id/stripe",
    handle(async (c) => {
      const { owner, account } = await deps.owned(c, deps.writes);
      const input = linkInput.parse(await c.req.json());
      const livemode = input.secretKey.includes("_live_");
      if (livemode && !allowLive) throw liveRefused();
      if (!secrets) throw unavailable();
      const seal = (value: string | undefined, what: "key" | "authorization" | "events") =>
        value ? secrets.encrypt(value, gateStripeContext(account.id, what)) : null;
      const l = await cards.setLink({
        accountId: account.id,
        keyCiphertext: seal(input.secretKey, "key")!,
        keyHint: `${input.secretKey.slice(0, 8)}…${input.secretKey.slice(-4)}`,
        livemode,
        cardholderId: input.cardholderId,
        authorizationSecretCiphertext: seal(input.authorizationWebhookSecret, "authorization"),
        eventsSecretCiphertext: seal(input.eventsWebhookSecret, "events"),
        linkedBy: owner,
      });
      c.header("Cache-Control", "no-store");
      return c.json(linkView(l));
    }),
  );
  /** Unlink: no new card is issued. Cards already issued are still checked on every charge. */
  app.delete(
    "/gate/accounts/:id/stripe",
    handle(async (c) => {
      const { account } = await deps.owned(c, deps.writes);
      if (!(await cards.unlink(account.id)))
        throw new Refused(404, "This gate account isn't linked to Stripe.");
      return c.json({ unlinked: true });
    }),
  );
  app.get(
    "/gate/accounts/:id/card-intents",
    handle(async (c) => {
      const { account } = await deps.owned(c, deps.reads);
      const q = z
        .strictObject({
          limit: z.coerce.number().int().min(1).max(100).optional(),
          before: z.uuid().optional(),
        })
        .parse(c.req.query());
      const page = await cards.intents(account.id, q);
      return c.json({ items: page.items.map(intentView), next: page.next });
    }),
  );

  // Payment intents (gate API key): one single-use card per approved invoice.

  /**
   * Issue a single-use virtual card for an approved, unpaid invoice within the limits, on an
   * account that isn't frozen. The same invoice again, while its card is unused, returns that card.
   */
  app.post(
    "/payments/intents",
    handle(async (c) => {
      const auth = await deps.keyed(c);
      if (!deps.checks.allow(auth.accountId))
        throw new Refused(429, "Too many checks for this gate account. Try again in a minute.");
      // Fail closed: a card is only worth issuing if its charges can be decided with receipts.
      if (!deps.receiptKey)
        throw new Refused(503, "The payment gate's receipt key isn't set up on this service.");
      const body = intentInput.parse(await c.req.json());
      const { key, link } = await stripeKey(auth.accountId);
      const referenceNorm = normalReference(body.invoiceReference);
      const at = new Date(now());
      const planned = await db.transaction(async (tx) => {
        const account = (await store.lockAccount(tx, auth.accountId))!;
        if (account.frozenAt)
          throw new Refused(
            409,
            "The payment gate froze this account after a breach: no card is issued until its owner lifts the freeze.",
          );
        const invoices = (
          await tx.query(
            `SELECT vendor_id, reference, amount_cents FROM gate_invoices
             WHERE account_id=$1 AND reference_norm=$2 ORDER BY vendor_id`,
            [account.id, referenceNorm],
          )
        ).rows.filter((i) => !body.vendorId || i.vendor_id === body.vendorId);
        if (!invoices.length)
          throw new Refused(404, "No such approved invoice on this gate account.");
        if (invoices.length > 1)
          throw new Refused(
            409,
            "Several vendors have an approved invoice with that reference: send the vendorId.",
          );
        const invoice = invoices[0]!;
        const vendor = await store.vendor(tx, account.id, invoice.vendor_id);
        if (!vendor?.cardMerchant)
          throw new Refused(409, "That vendor has no card merchant on file.");
        const open = await cards.openIntent(tx, account.id, vendor.id, referenceNorm);
        if (open?.status === "authorized")
          throw new Refused(409, "A card for that invoice is already in use.");
        if (open) return { intent: open, account };
        // The charge the card is for, checked now as it will be at authorization.
        const draft: GateCardIntentRecord = {
          id: randomUUID(),
          accountId: account.id,
          keyId: auth.keyId,
          vendorId: vendor.id,
          reference: invoice.reference,
          referenceNorm,
          amountCents: Number(invoice.amount_cents),
          cardId: null,
          cardLast4: null,
          status: "creating",
          createdAt: at,
          updatedAt: at,
        };
        const { input } = await cardInput(tx, account, draft, {
          stage: "authorization",
          gateApproved: true,
          merchant: { key: vendor.cardMerchant.key, name: vendor.cardMerchant.name, category: "" },
          amountCents: draft.amountCents,
          day: utcDay(at),
        });
        const verdict = evaluateGateInput(input);
        if (verdict.ok && verdict.rules.length)
          throw new Refused(
            409,
            `The payment gate won't issue a card for that invoice: ${ruleWords(verdict.rules)
              .map((r) => r.words)
              .join("; ")}.`,
            { rules: verdict.rules },
          );
        return { intent: await cards.addIntent(tx, draft), account };
      });
      let intent = planned.intent;
      if (intent.status === "creating") {
        try {
          const made = await stripe.createCard(
            key,
            {
              cardholder: link.cardholderId,
              amountCents: intent.amountCents,
              metadata: {
                bonded_gate_account: intent.accountId,
                bonded_intent: intent.id,
                invoice_reference: intent.reference,
              },
            },
            // The same intent asks Stripe for the same card, so a retry never makes two.
            `bonded-gate-intent-${intent.id}`,
          );
          intent = await cards.issued(intent.id, { id: made.id, last4: made.last4 });
        } catch (error) {
          await cards.setIntentStatus(db.pool, intent.id, "failed");
          log(
            `stripe: card for intent ${intent.id} not issued: ${error instanceof Error ? error.message : "error"}`,
          );
          throw new Refused(503, "Stripe didn't issue the card. Try again in a minute.");
        }
      }
      let details;
      try {
        details = await stripe.revealCard(key, intent.cardId!);
      } catch (error) {
        log(
          `stripe: card details for intent ${intent.id} not returned: ${error instanceof Error ? error.message : "error"}`,
        );
        throw new Refused(
          503,
          "Stripe didn't return the card's details. Ask again: the same card comes back.",
        );
      }
      c.header("Cache-Control", "no-store");
      return c.json(
        {
          intent: intentView(intent),
          card: {
            id: details.id,
            brand: details.brand,
            last4: details.last4,
            expMonth: details.expMonth,
            expYear: details.expYear,
            number: details.number,
            cvc: details.cvc,
          },
          replayed: planned.intent.status !== "creating",
        },
        planned.intent.status === "creating" ? 201 : 200,
      );
    }),
  );
  app.get(
    "/payments/intents/:intentId",
    handle(async (c) => {
      const auth = await deps.keyed(c);
      const id = z.uuid().safeParse(c.req.param("intentId"));
      const found = id.success ? await cards.intent(auth.accountId, id.data) : undefined;
      if (!found) throw new Refused(404, "No such card intent on this gate account.");
      return c.json(intentView(found));
    }),
  );

  // Stripe's webhooks. Each verifies Stripe's signature over the raw body first.

  const parse = (raw: string) => {
    try {
      const e = JSON.parse(raw) as { id?: unknown; type?: unknown; data?: { object?: unknown } };
      const object = e?.data?.object;
      if (
        typeof e.id !== "string" ||
        typeof e.type !== "string" ||
        !object ||
        typeof object !== "object"
      )
        return undefined;
      return { id: e.id, type: e.type, object: object as StripeObject };
    } catch {
      return undefined;
    }
  };

  /**
   * The real-time authorization: answer `{ approved }` with a Stripe-Version header, well inside
   * Stripe's 2 seconds. Anything but a clean approval of a charge that passes (or, in Monitor
   * mode, one that breaks a rule but isn't cash) is a decline.
   */
  app.post("/stripe/issuing/authorization", async (c) => {
    const started = performance.now();
    const deadline = started + budgetMs;
    const raw = await c.req.text();
    const answer = (approved: boolean) => {
      c.header("Stripe-Version", apiVersion);
      c.header("Cache-Control", "no-store");
      return c.json({ approved }, 200);
    };
    const event = parse(raw);
    if (!event || event.type !== "issuing_authorization.request")
      return c.json({ error: "That isn't an issuing_authorization.request event." }, 400);
    const object = event.object;
    const cardId = idOf(object.card);
    const intent = cardId ? await cards.intentByCard(db.pool, cardId) : undefined;
    const signed = verifyStripeSignature(
      raw,
      c.req.header("Stripe-Signature"),
      await endpointSecrets(intent?.accountId, "authorization"),
      { nowSeconds: Math.floor(now() / 1000) },
    );
    if (!signed) return c.json({ error: "The Stripe signature doesn't match." }, 400);
    const authId = typeof object.id === "string" ? object.id : "";
    if (!intent) {
      log(`stripe: declined authorization ${authId}: not a card the gate issued`);
      return answer(false);
    }
    if (!deps.receiptKey) {
      log(`stripe: declined authorization ${authId}: no receipt key`);
      return answer(false);
    }
    const work = decideAuthorization(event.id, object, authId, intent, deadline);
    // A late answer is never used: decline, and the transaction rolls back on its own.
    work.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), Math.max(0, deadline - performance.now()));
    });
    try {
      const outcome = await Promise.race([work, late]);
      if (outcome === "late") {
        log(`stripe: declined authorization ${authId}: over the ${budgetMs} ms budget`);
        return answer(false);
      }
      if (outcome.check) alertOwner(notifier, outcome.check);
      return answer(outcome.approved);
    } catch (error) {
      log(
        `stripe: declined authorization ${authId}: ${error instanceof OutOfTime ? `over the ${budgetMs} ms budget` : error instanceof Error ? error.name : "error"}`,
      );
      return answer(false);
    } finally {
      clearTimeout(timer);
    }
  });

  async function decideAuthorization(
    eventId: string,
    object: StripeObject,
    authId: string,
    found: GateCardIntentRecord,
    deadline: number,
  ): Promise<{ approved: boolean; check?: GateCheckOutcome }> {
    return db.transaction(async (c) => {
      const account = (await store.lockAccount(c, found.accountId))!;
      const earlier = await cards.handledEvent(c, eventId);
      if (earlier) return { approved: earlier.answer === true };
      // Read again under the account's lock: another event may have moved it on.
      const intent = (await cards.intentByCard(c, found.cardId!))!;
      const at = new Date(now());
      const day = utcDay(at);
      await store.countCheck(c, account.id, day);
      const decline = async (why: string) => {
        log(`stripe: declined authorization ${authId}: ${why}`);
        await cards.claimEvent(c, {
          id: eventId,
          type: "issuing_authorization.request",
          accountId: account.id,
          answer: false,
        });
        return { approved: false };
      };
      if (object.livemode === true && !allowLive)
        return decline("live-mode card charges are declined until live credentials are allowed");
      const pending = (object.pending_request ?? {}) as Record<string, unknown>;
      const amount = pending.amount;
      if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0)
        return decline("no positive amount requested");
      if (pending.currency !== "usd") return decline("not a USD charge");
      // A card whose invoice was paid, released or cancelled is spent: Stripe cancels a
      // single-use card after its first approved charge, and the gate declines anything later.
      if (intent.status !== "issued" && intent.status !== "authorized")
        return decline(`the card's intent is ${intent.status}`);
      const existing = authId ? await cards.authorization(c, authId) : undefined;
      // An incremental authorization asks for more on an approved one: check the new total.
      const total = existing?.gateApproved ? existing.approvedCents + amount : amount;
      const merchant = merchantOf(object);
      const { input, tickets } = await cardInput(c, account, intent, {
        stage: "authorization",
        gateApproved: true,
        merchant,
        amountCents: total,
        day,
        exceptAuthorization: authId,
      });
      const r = await recordCard(c, account, intent, input, at);
      await cards.decided(c, {
        id: authId,
        accountId: account.id,
        intentId: intent.id,
        decisionId: r.record.id,
        gateApproved: r.approved,
        amountCents: r.approved ? total : existing?.gateApproved ? existing.approvedCents : 0,
        merchantKey: merchant.key,
        vendorId: r.vendorId,
        day: existing?.day ?? day,
      });
      if (r.approved && intent.status === "issued")
        await cards.setIntentStatus(c, intent.id, "authorized");
      // A verified merchant change becomes the vendor's merchant on file: a new mandate version.
      const vendorMerchant = input.vendorMerchant?.key;
      if (r.record.decision === "pass" && vendorMerchant !== merchant.key && tickets[0])
        await store.updateVendor(
          account.id,
          intent.vendorId,
          {
            cardMerchant: {
              name: merchant.name,
              networkId: networkIdOf(object),
              key: merchant.key,
            },
            ticket: tickets[0].id,
          },
          `card_change:${r.record.id}`,
          c,
        );
      if (performance.now() > deadline) throw new OutOfTime();
      await cards.claimEvent(c, {
        id: eventId,
        type: "issuing_authorization.request",
        accountId: account.id,
        answer: r.approved,
      });
      return {
        approved: r.approved,
        check: {
          decision: r.record,
          input,
          replayed: false,
          froze: r.froze,
          account: (await store.account(account.id, c))!,
        },
      };
    });
  }

  /**
   * Everything else Stripe reports on a gate card: authorizations created or updated (webhook
   * failures, approvals the gate didn't give, reversals and expiries) and transactions (what
   * settled). Each event is handled once.
   */
  app.post("/stripe/issuing/events", async (c) => {
    const raw = await c.req.text();
    const event = parse(raw);
    if (!event) return c.json({ error: "That isn't a Stripe event." }, 400);
    const object = event.object;
    const intent = await (async () => {
      const cardId = idOf(object.card);
      return cardId ? cards.intentByCard(db.pool, cardId) : undefined;
    })();
    const signed = verifyStripeSignature(
      raw,
      c.req.header("Stripe-Signature"),
      await endpointSecrets(intent?.accountId, "events"),
      { nowSeconds: Math.floor(now() / 1000) },
    );
    if (!signed) return c.json({ error: "The Stripe signature doesn't match." }, 400);
    const handled = [
      "issuing_authorization.created",
      "issuing_authorization.updated",
      "issuing_transaction.created",
    ];
    if (!intent || !handled.includes(event.type)) return c.json({ received: true, handled: false });
    const followUp: {
      account?: GateAccountRecord;
      cancel?: string;
      alerts: Omit<GateNotification, "code" | "fix" | "gateAccountId">[];
    } = { alerts: [] };
    const replayed = await db.transaction(async (tx) => {
      const account = (await store.lockAccount(tx, intent.accountId))!;
      followUp.account = account;
      if (!(await cards.claimEvent(tx, { id: event.id, type: event.type, accountId: account.id })))
        return true;
      const current = (await cards.intentByCard(tx, intent.cardId!))!;
      if (event.type === "issuing_transaction.created")
        await settle(tx, account, current, object, followUp);
      else await reported(tx, account, current, object, followUp);
      return false;
    });
    const account = followUp.account!;
    if (followUp.cancel) await cancelCard(account, followUp.cancel);
    for (const n of followUp.alerts) alert(account, n);
    return c.json({ received: true, handled: true, replayed });
  });

  /** An authorization created or updated on a gate card. */
  async function reported(
    c: Connection,
    account: GateAccountRecord,
    intent: GateCardIntentRecord,
    object: StripeObject,
    followUp: {
      cancel?: string;
      alerts: Omit<GateNotification, "code" | "fix" | "gateAccountId">[];
    },
  ) {
    const authId = String(object.id);
    const merchant = merchantOf(object);
    const at = new Date(now()).toISOString();
    const created =
      typeof object.created === "number" ? new Date(object.created * 1000) : new Date(now());
    const rec = await cards.reported(c, {
      id: authId,
      accountId: account.id,
      intentId: intent.id,
      stripeApproved: object.approved === true,
      status: String(object.status ?? "pending"),
      amountCents: typeof object.amount === "number" ? object.amount : 0,
      merchantKey: merchant.key,
      day: utcDay(created),
    });
    // Stripe couldn't use the gate's answer: it applied the timeout setting (or Autopilot).
    const history = Array.isArray(object.request_history)
      ? (object.request_history as Record<string, unknown>[])
      : [];
    for (const reason of new Set(
      history.map((h) => String(h.reason)).filter((r) => MISSED.includes(r)),
    ))
      followUp.alerts.push({
        type: "stripe_webhook_failed",
        dedupeKey: `gate:stripe:${authId}:${reason}`,
        message: `Stripe couldn't get the payment gate's answer on a card charge (${reason}) and ${object.approved === true ? "approved" : "declined"} it by its own settings: authorization ${authId} on card ending ${intent.cardLast4 ?? "?"}.`,
        details: {
          authorizationId: authId,
          reason,
          approved: object.approved === true,
          intentId: intent.id,
        },
        at,
      });
    // Approved by Stripe without the gate's approval (timeout setting, Autopilot, stand-in): the
    // card is cancelled now, and whatever settles is recorded as a breach.
    if (object.approved === true && rec.gateApproved !== true && intent.cardId) {
      if (["creating", "issued", "authorized"].includes(intent.status))
        await cards.setIntentStatus(c, intent.id, "canceled");
      followUp.cancel = intent.cardId;
      followUp.alerts.push({
        type: "payment_breach",
        dedupeKey: `gate:stripe:${authId}:unapproved`,
        message: `A card charge of ${dollars(rec.amountCents)} at ${merchant.name || merchant.key} went through without the payment gate's approval; the card was cancelled.`,
        details: { authorizationId: authId, intentId: intent.id, merchant: merchant.key },
        at,
      });
    }
    // Reversed or expired with nothing captured: the invoice is free to pay again.
    if ((rec.status === "reversed" || rec.status === "expired") && intent.status === "authorized") {
      const captured = await cards.captured(c, authId);
      const others = (await cards.authorizationsOf(c, intent.id)).filter(
        (a) => a.id !== authId && a.status === "pending" && (a.stripeApproved ?? a.gateApproved),
      );
      if (captured === 0 && !others.length) await cards.setIntentStatus(c, intent.id, "released");
    }
  }

  /** A transaction settled on a gate card. */
  async function settle(
    c: Connection,
    account: GateAccountRecord,
    intent: GateCardIntentRecord,
    object: StripeObject,
    followUp: {
      cancel?: string;
      alerts: Omit<GateNotification, "code" | "fix" | "gateAccountId">[];
    },
  ) {
    const id = String(object.id);
    if (await cards.hasTransaction(c, id)) return;
    const type = object.type === "refund" ? "refund" : object.type === "capture" ? "capture" : null;
    const stripeAmount = typeof object.amount === "number" ? object.amount : 0;
    // Stripe's capture amounts are negative (money out of the balance), refunds positive.
    const out = -stripeAmount;
    const authId = idOf(object.authorization) ?? null;
    const base = { id, accountId: account.id, intentId: intent.id, authorizationId: authId };
    if (type !== "capture" || out <= 0) {
      if (type)
        await cards.addTransaction(c, {
          ...base,
          type,
          amountCents: out,
          decisionId: null,
          paymentId: null,
        });
      return;
    }
    const at = new Date(now());
    const created = typeof object.created === "number" ? new Date(object.created * 1000) : at;
    const day = utcDay(created);
    const merchant = merchantOf(object);
    const auth = authId ? await cards.authorization(c, authId) : undefined;
    const gateApproved = auth?.gateApproved === true;
    const capturedBefore = auth ? await cards.captured(c, auth.id) : 0;
    const total = capturedBefore + out;
    // What this capture adds beyond what the gate approved.
    const excess = gateApproved
      ? Math.max(0, total - auth!.approvedCents) - Math.max(0, capturedBefore - auth!.approvedCents)
      : 0;
    let decision: Awaited<ReturnType<typeof recordCard>> | undefined;
    const when = at.toISOString();
    if (!gateApproved || excess > 0) {
      const { input } = await cardInput(c, account, intent, {
        stage: "transaction",
        gateApproved,
        merchant,
        amountCents: gateApproved ? total : out,
        day,
        exceptAuthorization: auth?.id,
      });
      decision = await recordCard(
        c,
        account,
        intent,
        input,
        at,
        gateApproved ? { overpaidCents: excess } : {},
      );
      const where = merchant.name || merchant.key;
      if (!gateApproved) {
        if (intent.cardId) followUp.cancel = intent.cardId;
        followUp.alerts.push({
          type: "payment_breach",
          dedupeKey: `gate:${decision.record.id}:payment_breach`,
          message: `A card charge of ${dollars(out)} at ${where} settled without the payment gate's approval${authId ? "" : " (no authorization: a force capture)"}; the card was cancelled.`,
          details: {
            decisionId: decision.record.id,
            transactionId: id,
            intentId: intent.id,
            rules: decision.record.rules.join(","),
          },
          at: when,
        });
      } else
        followUp.alerts.push({
          type: "payment_breach",
          dedupeKey: `gate:${decision.record.id}:payment_breach`,
          message: `A card charge at ${where} settled for more than the payment gate approved: ${dollars(excess)} over, recorded as an overpayment.`,
          details: {
            decisionId: decision.record.id,
            transactionId: id,
            intentId: intent.id,
            overpaidUsd: excess / 100,
          },
          at: when,
        });
      if (decision.froze)
        followUp.alerts.push({
          type: "gate_frozen",
          dedupeKey: `gate:${decision.record.id}:gate_frozen`,
          message: `The payment gate froze ${account.name ? `"${account.name}"` : "a gate account"} after a breach; every check is refused until you lift the freeze.`,
          details: { decisionId: decision.record.id },
          at: when,
        });
    }
    const payment = await store.addPayment(
      account.id,
      {
        decisionId: decision?.record.id ?? auth?.decisionId ?? null,
        source: "card",
        kind: "invoice",
        payee: merchant.key,
        payeeNorm: merchant.key,
        vendorId: decision ? decision.vendorId : (auth?.vendorId ?? null),
        amountCents: out,
        reference: intent.reference,
        referenceNorm: intent.referenceNorm,
        day,
      },
      c,
    );
    await cards.addTransaction(c, {
      ...base,
      type: "capture",
      amountCents: out,
      decisionId: decision?.record.id ?? null,
      paymentId: payment.id,
    });
    if (!gateApproved) {
      if (intent.status !== "canceled") await cards.setIntentStatus(c, intent.id, "canceled");
    } else if (
      intent.status === "issued" ||
      intent.status === "authorized" ||
      intent.status === "released"
    )
      await cards.setIntentStatus(c, intent.id, "paid");
  }
}
