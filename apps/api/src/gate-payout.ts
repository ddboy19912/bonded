import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { TeeUnavailableError, TeeVerificationError } from "@bonded/arena";
import {
  GateCardStore,
  GatePayoutStore,
  RELEASED_PAYOUT_STATUSES,
  type Connection,
  type Database,
  type GateAccountRecord,
  type GateDecisionRecord,
  type GatePayoutLinkRecord,
  type GatePayoutRecord,
  type GatePayoutStatus,
  type GateStore,
} from "@bonded/db";
import {
  evaluateGateInput,
  gateInputHash,
  isLivePayoutKey,
  isSealedPayoutCredential,
  normalAccount,
  normalReference,
  payoutKeyHint,
  sealPayoutCredential,
  signGateReceipt,
  signPayoutLookup,
  utcDay,
  type GateInput,
  type GateReceipt,
  type PayoutResult,
  type SealedPayoutCredential,
  type SignedGateReceipt,
} from "@bondedhq/shared";
import type { Hex } from "viem";
import { Refused, handle } from "./refused.js";
import type { RateLimiter } from "./rate-limit.js";
import { gateNotification, type GateNotification, type Notifier } from "./notifications.js";
import { gatePayoutContext, type SecretBox } from "./secrets.js";
import { verifyStripeSignature } from "./stripe-issuing.js";
import { alertOwner, decisionView, runGateCheck, type GateCheckOutcome } from "./gate-check.js";
import {
  PayoutRefused,
  custodyStatement,
  type AttestedPayoutTee,
  type PayoutTee,
} from "./payout-tee.js";

/**
 * The payment gate's payout route (apps/api/GATE.md, "The payout route"). For bank payouts the
 * agent never holds the credential. The owner links the account's payout provider account: its
 * key is sealed to the payout proxy (services/payout-proxy), a small service in a TEE, after the
 * API has checked the proxy's attestation; the API stores only the sealed copy. The agent asks
 * `POST /payments/payouts`; the gate runs the shared rules through the hosted check
 * (`runGateCheck`, one transaction holding the account's lock) and only an allowed payout is
 * forwarded, with its signed receipt, to the proxy, after attesting it again. The proxy pays
 * exactly what the receipt allows, once.
 *
 * The provider's events (`POST /stripe/payouts/events/:accountId`) reconcile what happened next:
 * a payout that failed, was returned or was canceled releases its invoice, and a payout the gate
 * never approved is a breach, recorded with a signed receipt and alerted.
 *
 * Enforce mode fails closed, and so does Monitor: with the proxy down or failing its attestation
 * nothing is paid, since nothing but the proxy can pay.
 */

export interface GatePayoutOptions {
  /** The payout proxy (payout-tee.ts). Without it the payout routes answer 503. */
  tee?: PayoutTee;
  /** GATE_ALLOW_LIVE_CREDENTIALS=true: accept live provider keys. Off by default. */
  allowLiveCredentials?: boolean;
  /** Where operational lines go (default stderr). Never given a key or secret. */
  log?: (line: string) => void;
}

/** How long after its check a decision may still be sent to the proxy (it accepts 600 s). */
const FORWARD_WINDOW_MS = 540_000;

/** Stripe's OutboundPayment events this route reconciles (thin events, by type). */
const EVENT_STATUS: Record<string, GatePayoutStatus> = {
  "v2.money_management.outbound_payment.created": "processing",
  "v2.money_management.outbound_payment.posted": "posted",
  "v2.money_management.outbound_payment.failed": "failed",
  "v2.money_management.outbound_payment.returned": "returned",
  "v2.money_management.outbound_payment.canceled": "canceled",
};
const FINAL: readonly GatePayoutStatus[] = ["failed", "returned", "canceled"];

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}]*$/u);
const cents = z
  .number()
  .positive()
  .max(100_000_000_000)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6)
  .transform((v) => Math.round(v * 100));
const payee = z
  .string()
  .max(100)
  .regex(/^[\x20-\x7E]+$/)
  .refine((v) => normalAccount(v).length > 0);
const payoutInput = z.strictObject({
  kind: z.enum(["invoice", "refund"]).default("invoice"),
  account: payee,
  amountUsd: cents,
  invoiceReference: text(100),
  requestId: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{1,128}$/)
    .optional(),
});
const linkInput = z
  .strictObject({
    provider: z.literal("stripe").default("stripe"),
    /** A restricted key (rk_) or secret key (sk_); test mode unless live credentials are allowed. */
    secretKey: z
      .string()
      .regex(/^(rk|sk)_(test|live)_[A-Za-z0-9]{10,247}$/)
      .optional(),
    /** The Stripe financial account payouts are paid from (fa_...). */
    financialAccount: z
      .string()
      .regex(/^fa_[A-Za-z0-9_]{1,200}$/)
      .optional(),
    /** Or the credential sealed by the owner to the proxy's attested seal key. */
    sealedCredential: z.custom<SealedPayoutCredential>(isSealedPayoutCredential).optional(),
    /** The signing secret of the account's Stripe event destination for payout events. */
    eventsWebhookSecret: z.string().regex(/^whsec_[A-Za-z0-9+/=_-]{10,200}$/),
  })
  .refine(
    (l) =>
      l.sealedCredential
        ? !l.secretKey && !l.financialAccount
        : Boolean(l.secretKey && l.financialAccount),
    "Send secretKey and financialAccount, or sealedCredential.",
  );

const payoutView = (p: GatePayoutRecord) => ({
  id: p.id,
  status: p.status,
  gateApproved: p.gateApproved,
  decisionId: p.decisionId,
  provider: p.provider,
  providerPayoutId: p.providerPayoutId,
  amountUsd: p.amountCents / 100,
  payee: p.payee,
  destination: p.destination,
  vendorId: p.vendorId,
  invoiceReference: p.reference,
  error: p.error,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
});

const dollars = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The provider's status as the gate stores it. */
const statusOf = (s: string): GatePayoutStatus =>
  (["processing", "posted", "failed", "returned", "canceled"] as const).find((x) => x === s) ??
  "processing";

export function gatePayoutRoutes(
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
    limited: (c: Context, limiter: RateLimiter) => void;
    writes: RateLimiter;
    reads: RateLimiter;
    log: (line: string) => void;
  },
  options: GatePayoutOptions = {},
) {
  const { db, store, notifier, now, secrets, log } = deps;
  const payouts = new GatePayoutStore(db);
  // Stripe event ids already handled, shared with the card route (gate_stripe_events).
  const events = new GateCardStore(db);
  const tee = options.tee;
  const allowLive = options.allowLiveCredentials === true;

  const notSetUp = () =>
    new Refused(
      503,
      "The payout route isn't set up on this service: no payout proxy is configured.",
    );
  const liveRefused = () =>
    new Refused(
      403,
      "Live payout keys are refused: the payment gate takes test-mode keys only for now.",
    );

  const alert = (
    account: GateAccountRecord,
    n: Omit<GateNotification, "code" | "fix" | "gateAccountId">,
  ) => notifier.notify(account.owner, gateNotification({ ...n, gateAccountId: account.id }));

  /** Attest the proxy, turning its failures into answers. Nothing is paid when this fails. */
  const attest = async (): Promise<AttestedPayoutTee> => {
    if (!tee) throw notSetUp();
    try {
      return await tee.attest();
    } catch (error) {
      if (error instanceof TeeVerificationError) {
        log(`payout: the payout proxy failed its attestation: ${error.message}`);
        throw new Refused(
          503,
          `The payout proxy failed its attestation (${error.message}). Nothing was paid: the gate fails closed.`,
        );
      }
      log(
        `payout: the payout proxy can't be reached: ${error instanceof Error ? error.message : "error"}`,
      );
      throw new Refused(
        503,
        "The payout proxy can't be reached. Nothing was paid: the gate fails closed. Try again later.",
      );
    }
  };

  const linkView = (l: GatePayoutLinkRecord) => {
    const production =
      tee !== undefined &&
      l.teeMeasurement !== null &&
      tee.isProductionMeasurement(l.teeMeasurement);
    return {
      linked: true,
      provider: l.provider,
      keyHint: l.keyHint,
      financialAccount: l.financialAccount,
      livemode: l.livemode,
      tee: {
        sealedTo: l.sealedTo,
        measurement: l.teeMeasurement,
        composeHash: l.teeComposeHash,
        production,
      },
      custody: custodyStatement({ production }),
      createdAt: l.createdAt.toISOString(),
      updatedAt: l.updatedAt.toISOString(),
    };
  };

  // The payout proxy, publicly: what an owner seals to when sealing in their own browser.

  app.get(
    "/gate/payout-proxy",
    handle(async (c) => {
      deps.limited(c, deps.reads);
      const t = await attest();
      c.header("Cache-Control", "no-store");
      return c.json({
        // The quote verified against Intel's collateral (false only in local mode).
        verified: t.measurement !== null,
        production: t.production,
        measurement: t.measurement,
        composeHash: t.composeHash,
        evmAddress: t.evmAddress,
        sealPublicKey: t.sealPublicKey,
        custody: custodyStatement(t),
      });
    }),
  );

  // Linking a gate account's payout provider account (owner session).

  app.get(
    "/gate/accounts/:id/payout-link",
    handle(async (c) => {
      const { account } = await deps.owned(c, deps.reads);
      const l = await payouts.link(account.id);
      if (!l) throw new Refused(404, "This gate account has no payout account linked.");
      return c.json(linkView(l));
    }),
  );
  /**
   * Link (or relink) the payout account. The key is sealed to the attested proxy at once and only
   * the sealed copy is stored: the API holds the plain key only for this request. An owner who
   * wants the API never to see it seals it themselves (`GET /gate/payout-proxy`, then
   * `sealPayoutCredential` from @bondedhq/shared) and sends `sealedCredential`.
   */
  app.put(
    "/gate/accounts/:id/payout-link",
    handle(async (c) => {
      const { owner, account } = await deps.owned(c, deps.writes);
      const input = linkInput.parse(await c.req.json());
      if (!secrets)
        throw new Refused(
          503,
          "Payout linking is off on this service: its secret encryption key isn't set.",
        );
      if (input.secretKey && isLivePayoutKey(input.secretKey) && !allowLive) throw liveRefused();
      const t = await attest();
      let sealed: SealedPayoutCredential;
      if (input.sealedCredential) {
        sealed = input.sealedCredential;
        if (sealed.to.toLowerCase() !== t.sealPublicKey)
          throw new Refused(
            409,
            "That credential is sealed to another key than the payout proxy's: seal it to the key GET /gate/payout-proxy shows.",
          );
      } else
        sealed = await sealPayoutCredential(
          {
            provider: input.provider,
            gateAccountId: account.id,
            secretKey: input.secretKey!,
            financialAccount: input.financialAccount!,
          },
          t.sealPublicKey,
        );
      let checked;
      try {
        checked = await tee!.checkCredential(account.id, sealed);
      } catch (error) {
        if (error instanceof PayoutRefused)
          throw new Refused(
            error.status === 403 ? 403 : 400,
            `The payout proxy refused the credential: ${error.message}.`,
          );
        throw new Refused(503, "The payout proxy can't be reached. Try again later.");
      }
      if (checked.livemode && !allowLive) throw liveRefused();
      const l = await payouts.setLink({
        accountId: account.id,
        provider: "stripe",
        sealedCredential: sealed,
        sealedTo: t.sealPublicKey,
        teeMeasurement: t.measurement,
        teeComposeHash: t.composeHash,
        keyHint: checked.keyHint || (input.secretKey ? payoutKeyHint(input.secretKey) : ""),
        financialAccount: checked.financialAccount,
        livemode: checked.livemode,
        eventsSecretCiphertext: secrets.encrypt(
          input.eventsWebhookSecret,
          gatePayoutContext(account.id),
        ),
        linkedBy: owner,
      });
      c.header("Cache-Control", "no-store");
      return c.json(linkView(l));
    }),
  );
  /** Unlink: the sealed credential is deleted, and no payout can go through the gate. */
  app.delete(
    "/gate/accounts/:id/payout-link",
    handle(async (c) => {
      const { account } = await deps.owned(c, deps.writes);
      if (!(await payouts.unlink(account.id)))
        throw new Refused(404, "This gate account has no payout account linked.");
      return c.json({ unlinked: true });
    }),
  );
  app.get(
    "/gate/accounts/:id/payouts",
    handle(async (c) => {
      const { account } = await deps.owned(c, deps.reads);
      const q = z
        .strictObject({
          limit: z.coerce.number().int().min(1).max(100).optional(),
          before: z.uuid().optional(),
        })
        .parse(c.req.query());
      const page = await payouts.payouts(account.id, q);
      return c.json({ items: page.items.map(payoutView), next: page.next });
    }),
  );

  // Payouts (gate API key).

  /**
   * Move a payout on, under the account's lock, from what it is now (a provider event may have
   * moved it first): the provider's statuses through `apply`; "unknown" only from pending;
   * "not_sent" only from pending or unknown, releasing the invoice.
   */
  const move = (
    p: GatePayoutRecord,
    status: GatePayoutStatus,
    u: { providerPayoutId?: string; error?: string } = {},
  ) =>
    db.transaction(async (c) => {
      const account = (await store.lockAccount(c, p.accountId))!;
      const current = (await payouts.payout(p.accountId, p.id, c))!;
      if (status === "unknown") {
        if (current.status === "pending") return payouts.update(c, p.id, { status, ...u });
      } else if (status === "not_sent") {
        if (current.status === "pending" || current.status === "unknown") {
          await payouts.release(c, current);
          return payouts.update(c, p.id, { status, ...u });
        }
      } else await apply(c, account, current, status, u.providerPayoutId, u.error ?? null);
      return (await payouts.payout(p.accountId, p.id, c))!;
    });

  /**
   * Send one allowed decision's payout to the proxy and record what happened. Never throws: the
   * payout record says how it ended.
   */
  async function forward(
    link: GatePayoutLinkRecord,
    t: AttestedPayoutTee,
    p: GatePayoutRecord,
    decision: GateDecisionRecord,
  ): Promise<{ payout: GatePayoutRecord; message: string }> {
    try {
      const r = await tee!.execute(t, {
        receipt: decision.receipt as SignedGateReceipt,
        destination: p.destination,
        currency: "usd",
        credential: link.sealedCredential as SealedPayoutCredential,
      });
      if (
        r.decisionId !== decision.id ||
        r.amountCents !== p.amountCents ||
        normalAccount(r.destination) !== p.payee
      ) {
        log(`payout: the proxy's answer for decision ${decision.id} doesn't match it`);
        return {
          payout: await move(p, "unknown", {
            providerPayoutId: r.payoutId,
            error: "The payout proxy's answer doesn't match the decision.",
          }),
          message: "The payout's outcome is unknown: the invoice stays held until Stripe reports.",
        };
      }
      const payout = await move(p, statusOf(r.status), { providerPayoutId: r.payoutId });
      return {
        payout,
        message: (RELEASED_PAYOUT_STATUSES as readonly string[]).includes(payout.status)
          ? `The payout ${r.payoutId} ${payout.status}: the invoice is released.`
          : `Paid out: ${dollars(p.amountCents)} sent to ${p.destination} (${r.payoutId}).`,
      };
    } catch (error) {
      if (error instanceof PayoutRefused && error.details.replayed && error.details.payoutId)
        return {
          payout: await move(p, "processing", { providerPayoutId: error.details.payoutId }),
          message: `Already paid out (${error.details.payoutId}).`,
        };
      if (error instanceof PayoutRefused && error.sent === "unknown") {
        log(`payout: decision ${decision.id}: outcome unknown: ${error.message}`);
        return {
          payout: await move(p, "unknown", { error: error.message }),
          message:
            "The payout's outcome is unknown (the provider's answer was lost). The invoice stays held until Stripe reports; asking again with the same requestId retries safely.",
        };
      }
      const why =
        error instanceof PayoutRefused
          ? error.message
          : error instanceof TeeUnavailableError
            ? "the payout proxy can't be reached"
            : "the payout proxy failed";
      log(`payout: decision ${decision.id} not sent: ${why}`);
      return {
        payout: await move(p, "not_sent", { error: why }),
        message: `Nothing was paid: ${why}. The invoice is released; ask again.`,
      };
    }
  }

  /** Ask the gate to pay an invoice (or an approved refund) by bank payout. */
  app.post(
    "/payments/payouts",
    handle(async (c) => {
      const auth = await deps.keyed(c);
      if (!deps.checks.allow(auth.accountId))
        throw new Refused(429, "Too many checks for this gate account. Try again in a minute.");
      // Fail closed: a payout is only made from a decision with a signed receipt.
      if (!deps.receiptKey)
        throw new Refused(503, "The payment gate's receipt key isn't set up on this service.");
      if (!tee) throw notSetUp();
      const body = payoutInput.parse(await c.req.json());
      const link = await payouts.link(auth.accountId);
      if (!link) throw new Refused(409, "This gate account has no payout account linked.");
      if (link.livemode && !allowLive) throw liveRefused();
      // Attested before every use: a proxy that fails, or can't be reached, pays nothing.
      const t = await attest();
      if (t.sealPublicKey !== link.sealedTo.toLowerCase())
        throw new Refused(
          409,
          "The payout proxy's seal key changed (it was redeployed): the owner must link the payout account again. Nothing was paid.",
        );
      let created: GatePayoutRecord | undefined;
      const outcome = await runGateCheck(
        { db, store, receiptKey: deps.receiptKey, now },
        auth,
        {
          kind: body.kind,
          account: body.account,
          amountCents: body.amountUsd,
          reference: body.invoiceReference,
          requestId: body.requestId,
        },
        async (tx: Connection, o: GateCheckOutcome) => {
          if (o.decision.result !== "allowed") return;
          const vendor = o.decision.vendorId
            ? await store.vendor(tx, auth.accountId, o.decision.vendorId)
            : undefined;
          created = await payouts.addPayout(tx, {
            id: randomUUID(),
            accountId: auth.accountId,
            decisionId: o.decision.id,
            keyId: auth.keyId,
            paymentId: await payouts.paymentOf(tx, o.decision.id),
            provider: link.provider,
            providerPayoutId: null,
            status: "pending",
            gateApproved: true,
            amountCents: o.decision.amountCents,
            payee: o.decision.payee,
            // Where to pay, as the vendor master writes it (provider ids are case-sensitive).
            destination:
              vendor && normalAccount(vendor.account) === o.decision.payee
                ? vendor.account
                : body.account.trim(),
            vendorId: o.decision.vendorId,
            reference: o.decision.reference,
            createdAt: o.decision.createdAt,
          });
        },
      );
      alertOwner(notifier, outcome);
      c.header("Cache-Control", "no-store");
      const answer = (
        payout: GatePayoutRecord | undefined,
        message: string,
        status: 200 | 201 | 202 | 502,
      ) =>
        c.json(
          {
            ...decisionView(outcome.decision),
            frozen: outcome.account.frozenAt !== null,
            replayed: outcome.replayed,
            ...(outcome.input ? { input: outcome.input } : {}),
            // The provider took the payout (it may still fail or come back: see its status).
            paid: payout !== undefined && ["processing", "posted"].includes(payout.status),
            payout: payout ? payoutView(payout) : null,
            payoutMessage: message,
          },
          status,
        );
      if (outcome.replayed) {
        const earlier = await payouts.payoutByDecision(db.pool, outcome.decision.id);
        if (!earlier) return answer(undefined, "No payout: the gate didn't allow it.", 200);
        // A lost answer, asked again while the receipt is fresh: the proxy and Stripe dedupe it.
        if (
          (earlier.status === "unknown" || earlier.status === "pending") &&
          now() - outcome.decision.createdAt.getTime() < FORWARD_WINDOW_MS
        ) {
          const done = await forward(link, t, earlier, outcome.decision);
          return answer(done.payout, done.message, done.payout.status === "unknown" ? 202 : 200);
        }
        return answer(earlier, "The same request again: the first payout, unchanged.", 200);
      }
      if (!created)
        return answer(
          undefined,
          outcome.decision.result === "blocked"
            ? "Nothing was paid: the gate blocked it."
            : "Nothing was paid: the gate refused it.",
          200,
        );
      const done = await forward(link, t, created, outcome.decision);
      return answer(
        done.payout,
        done.message,
        done.payout.status === "not_sent" ? 502 : done.payout.status === "unknown" ? 202 : 201,
      );
    }),
  );
  app.get(
    "/payments/payouts/:payoutId",
    handle(async (c) => {
      const auth = await deps.keyed(c);
      const id = z.uuid().safeParse(c.req.param("payoutId"));
      const found = id.success ? await payouts.payout(auth.accountId, id.data) : undefined;
      if (!found) throw new Refused(404, "No such payout on this gate account.");
      return c.json(payoutView(found));
    }),
  );

  // Stripe's payout events (thin events), one endpoint per gate account.

  /**
   * Record a payout the provider made that the gate never approved: a breach decision with a
   * signed receipt (the rules run on what was paid), the payment, the payout, and a freeze if set.
   */
  async function bypassed(
    c: Connection,
    account: GateAccountRecord,
    r: PayoutResult,
    status: GatePayoutStatus,
  ) {
    const at = new Date(now());
    const day = utcDay(at);
    const payeeNorm = normalAccount(r.destination);
    const reference = `stripe:${r.payoutId}`;
    const state = await store.checkState(c, account.id, {
      kind: "invoice",
      accountNorm: payeeNorm,
      referenceNorm: normalReference(reference),
      day,
    });
    const input: GateInput = {
      kind: "invoice",
      day,
      limits: { maxPaymentCents: account.maxPaymentCents, maxDailyCents: account.maxDailyCents },
      attempt: { account: payeeNorm, amountCents: r.amountCents, reference },
      payees: state.payees,
      payments: state.payments,
      invoices: state.invoices,
    };
    const verdict = evaluateGateInput(input);
    const ok = verdict.ok ? verdict : undefined;
    const id = randomUUID();
    const receipt: GateReceipt = {
      decisionId: id,
      gateAccountId: account.id,
      kind: "invoice",
      decision: "breach",
      result: "allowed",
      mode: account.mode,
      rules: ok?.rules ?? [],
      amountCents: r.amountCents,
      payee: payeeNorm,
      reference,
      inputHash: gateInputHash(input),
      mandateHash: account.mandateHash as Hex,
      mandateVersion: account.mandateVersion,
      checkedAt: Math.floor(at.getTime() / 1000),
    };
    const record = await store.addDecision(c, {
      id,
      accountId: account.id,
      keyId: null,
      requestId: null,
      requestHash: null,
      kind: "invoice",
      decision: "breach",
      result: "allowed",
      mode: account.mode,
      rules: receipt.rules,
      amountCents: r.amountCents,
      lossCents: ok?.lossCents ?? r.amountCents,
      overpaidCents: ok?.overpaidCents ?? 0,
      payee: payeeNorm,
      vendorId: ok?.vendorId ?? null,
      reference,
      inputHash: receipt.inputHash,
      mandateHash: account.mandateHash,
      mandateVersion: account.mandateVersion,
      receipt: await signGateReceipt(receipt, deps.receiptKey!),
      createdAt: at,
    });
    const released = (RELEASED_PAYOUT_STATUSES as readonly string[]).includes(status);
    const payment = released
      ? undefined
      : await store.addPayment(
          account.id,
          {
            decisionId: id,
            source: "payout",
            kind: "invoice",
            payee: r.destination,
            payeeNorm,
            vendorId: ok?.vendorId ?? null,
            amountCents: r.amountCents,
            reference,
            referenceNorm: normalReference(reference),
            day,
          },
          c,
        );
    await payouts.addPayout(c, {
      id: randomUUID(),
      accountId: account.id,
      decisionId: id,
      keyId: null,
      paymentId: payment?.id ?? null,
      provider: r.provider,
      providerPayoutId: r.payoutId,
      status,
      gateApproved: false,
      amountCents: r.amountCents,
      payee: payeeNorm,
      destination: r.destination,
      vendorId: ok?.vendorId ?? null,
      reference,
      createdAt: at,
    });
    const froze = account.freezeOnBreach && account.frozenAt === null;
    if (froze) await store.freeze(c, account.id, id);
    return { record, froze };
  }

  /** Move a known payout to what the provider reported. Final statuses don't move again. */
  async function apply(
    c: Connection,
    account: GateAccountRecord,
    p: GatePayoutRecord,
    status: GatePayoutStatus,
    providerPayoutId?: string,
    error: string | null = null,
  ) {
    if (FINAL.includes(p.status)) return;
    // "processing" only moves a payout that hadn't been reported on yet.
    if (status === "processing" && !["pending", "unknown", "not_sent"].includes(p.status)) return;
    if ((RELEASED_PAYOUT_STATUSES as readonly string[]).includes(status))
      await payouts.release(c, p);
    else if (!p.paymentId && p.decisionId) {
      // Money the gate thought unsent went out after all: hold the invoice again.
      log(`payout: ${providerPayoutId ?? p.id} was made after all; its invoice is held again`);
      const decided = await store.decision(account.id, p.decisionId);
      const payment = await store.addPayment(
        account.id,
        {
          decisionId: p.decisionId,
          source: "payout",
          kind: decided?.kind === "refund" ? "refund" : "invoice",
          payee: p.destination,
          payeeNorm: p.payee,
          vendorId: p.vendorId,
          amountCents: p.amountCents,
          reference: p.reference,
          referenceNorm: normalReference(p.reference),
          day: utcDay(new Date(now())),
        },
        c,
      );
      await payouts.hold(c, p.id, payment.id);
    }
    await payouts.update(c, p.id, {
      status,
      ...(providerPayoutId ? { providerPayoutId } : {}),
      error,
    });
  }

  app.post("/stripe/payouts/events/:accountId", async (c) => {
    const raw = await c.req.text();
    const accountId = z.uuid().safeParse(c.req.param("accountId"));
    const link = accountId.success ? await payouts.link(accountId.data) : undefined;
    let secret: string | undefined;
    if (link && secrets)
      try {
        secret = secrets.decrypt(link.eventsSecretCiphertext, gatePayoutContext(link.accountId));
      } catch {
        log(`payout: the events secret of gate account ${link.accountId} doesn't decrypt`);
      }
    if (
      !link ||
      !secret ||
      !verifyStripeSignature(raw, c.req.header("Stripe-Signature"), [secret], {
        nowSeconds: Math.floor(now() / 1000),
      })
    )
      return c.json({ error: "The Stripe signature doesn't match." }, 400);
    let event: { id: string; type: string; payoutId: string };
    try {
      const e = JSON.parse(raw) as {
        id?: unknown;
        type?: unknown;
        related_object?: { id?: unknown; type?: unknown };
      };
      if (
        typeof e.id !== "string" ||
        typeof e.type !== "string" ||
        typeof e.related_object?.id !== "string"
      )
        throw new Error("shape");
      event = { id: e.id, type: e.type, payoutId: e.related_object.id };
    } catch {
      return c.json({ error: "That isn't a Stripe event." }, 400);
    }
    const status = EVENT_STATUS[event.type];
    if (!status || !/^obp_[A-Za-z0-9_]{1,200}$/.test(event.payoutId))
      return c.json({ received: true, handled: false });
    if (await events.handledEvent(db.pool, event.id))
      return c.json({ received: true, handled: true, replayed: true });
    let known = await payouts.payoutByProvider(db.pool, link.accountId, event.payoutId);
    // A payout the gate has no id for: ask the provider, through the proxy, what it is.
    let looked: PayoutResult | undefined;
    if (!known) {
      if (!tee || !deps.receiptKey) return c.json({ error: "The payout proxy isn't set up." }, 503);
      try {
        const t = await tee.attest();
        looked = await tee.lookup(
          t,
          await signPayoutLookup(
            {
              gateAccountId: link.accountId,
              payoutId: event.payoutId,
              issuedAt: Math.floor(now() / 1000),
            },
            deps.receiptKey,
          ),
          link.sealedCredential as SealedPayoutCredential,
        );
      } catch (error) {
        log(
          `payout: couldn't look up ${event.payoutId}: ${error instanceof Error ? error.message : "error"}`,
        );
        const account = await store.account(link.accountId);
        if (account)
          alert(account, {
            type: "payment_breach",
            dedupeKey: `gate:payout:${event.payoutId}:unchecked`,
            message: `Stripe reported a payout (${event.payoutId}) the payment gate has no record of, and it couldn't be checked yet; the gate will check it when Stripe retries.`,
            details: { payoutId: event.payoutId, event: event.type },
            at: new Date(now()).toISOString(),
          });
        // Stripe retries the event, and it is checked then.
        return c.json({ error: "The payout couldn't be checked yet." }, 503);
      }
      if (looked.gateDecision) {
        const ours = await payouts.payoutByDecision(db.pool, looked.gateDecision);
        if (ours?.accountId === link.accountId) known = ours;
      }
    }
    const alerts: Omit<GateNotification, "code" | "fix" | "gateAccountId">[] = [];
    let account: GateAccountRecord | undefined;
    const replayed = await db.transaction(async (tx) => {
      account = (await store.lockAccount(tx, link.accountId))!;
      if (
        !(await events.claimEvent(tx, {
          id: event.id,
          type: event.type,
          accountId: link.accountId,
        }))
      )
        return true;
      if (known) {
        const current = (await payouts.payout(link.accountId, known.id, tx))!;
        await apply(tx, account, current, status, event.payoutId);
        return false;
      }
      const again = await payouts.payoutByProvider(tx, link.accountId, event.payoutId);
      if (again) {
        await apply(tx, account, again, status, event.payoutId);
        return false;
      }
      const r = looked!;
      const b = await bypassed(tx, account, r, status);
      const when = b.record.createdAt.toISOString();
      alerts.push({
        type: "payment_breach",
        dedupeKey: `gate:${b.record.id}:payment_breach`,
        message: `A payout of ${dollars(r.amountCents)} to ${r.destination} went out without the payment gate's approval (${r.payoutId}).`,
        details: {
          decisionId: b.record.id,
          payoutId: r.payoutId,
          rules: b.record.rules.join(","),
        },
        at: when,
      });
      if (b.froze)
        alerts.push({
          type: "gate_frozen",
          dedupeKey: `gate:${b.record.id}:gate_frozen`,
          message: `The payment gate froze ${account.name ? `"${account.name}"` : "a gate account"} after a breach; every check is refused until you lift the freeze.`,
          details: { decisionId: b.record.id },
          at: when,
        });
      return false;
    });
    for (const n of alerts) alert(account!, n);
    return c.json({ received: true, handled: true, replayed });
  });
}
