import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  GateBudgetStore,
  GateCardHookStore,
  type Database,
  type GateAccountRecord,
  type GateCardHookProvider,
  type GateCardHookRecord,
  type GateStore,
} from "@bonded/db";
import {
  CARD_HOOK_PROVIDERS,
  cardMerchantKey,
  evaluateGateInput,
  gateInputHash,
  signGateReceipt,
  utcDay,
  type GateCardChargeInput,
  type GateReceipt,
} from "@bondedhq/shared";
import type { Hex } from "viem";
import { Refused, handle } from "./refused.js";
import type { RateLimiter } from "./rate-limit.js";
import type { Notifier } from "./notifications.js";
import { cardHookContext, type SecretBox } from "./secrets.js";
import { STRIPE_API_VERSION, verifyStripeSignature } from "./stripe-signature.js";
import { alertOwner, type GateCheckOutcome } from "./gate-check.js";

/**
 * Card hooks (apps/api/GATE.md, "Card hooks"). The business issues cards in its own card program
 * and points the program's real-time approval question at `POST /payments/card-hook/:hookId`.
 * The gate checks each charge with the general rules, the merchant as the payee, and answers
 * approve or decline in the program's own format. Bonded holds no key for the program: only the
 * signing secret that proves a request came from it (Stripe, Lithic), or the hash of a password it
 * made for it (Marqeta). It can't issue a card, fund one or move money.
 *
 * Anything the gate can't decide declines: a bad request, a non-USD charge, an error, or an answer
 * not ready inside the time budget (1.5 s; Stripe waits 2 s, Marqeta 3 s, Lithic 6 s). A request
 * whose signature doesn't check is refused outright, since it didn't come from the program.
 */

export interface GateCardHookOptions {
  /** How long the gate may take to decide (default 1,500 ms). Past it the gate declines. */
  budgetMs?: number;
  /**
   * How long past the budget the gate waits for the database to commit or roll back (default
   * 300 ms), so the answer always matches what was recorded.
   */
  graceMs?: number;
  /** Card hooks per gate account (default 5). */
  maxHooksPerAccount?: number;
  /**
   * GATE_ALLOW_LIVE_CHARGES=true: answer Stripe live-mode charges. Off: they're declined.
   * Lithic and Marqeta requests don't say whether they're live.
   */
  allowLiveCharges?: boolean;
  /** STRIPE_API_VERSION: the version Stripe's answer is sent with. */
  stripeApiVersion?: string;
  log?: (line: string) => void;
}

/** A charge as every card program reports it. */
export interface CardCharge {
  /** The program's id for this request: the same charge asked twice gets the same answer. */
  requestId: string;
  /** False for anything that spends nothing (a refund to the card, a balance inquiry, a capture). */
  spend: boolean;
  amountCents: number;
  currency: string;
  merchant: { id: string; name: string; mcc: string };
  /** Stripe only: whether the charge is live. */
  livemode?: boolean;
}

/** Why a charge was declined, in the terms each program has for it. */
type Why = "merchant" | "limit" | "frozen" | "undecided";

const MAX_BODY = 64 * 1024;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const str = (v: unknown) => (typeof v === "string" ? v : "");
/** Whole cents from an integer amount in cents, or undefined. */
const intCents = (v: unknown) =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined;

/** Stripe Issuing's `issuing_authorization.request` event. */
export function stripeCharge(body: Json): CardCharge | undefined {
  if (body.type !== "issuing_authorization.request") return undefined;
  const auth = obj(obj(body.data).object);
  const pending = obj(auth.pending_request);
  const m = obj(auth.merchant_data);
  const id = str(auth.id);
  if (!id) return undefined;
  return {
    requestId: `stripe:${id}`,
    spend: true,
    amountCents: intCents(pending.amount) ?? 0,
    currency: str(pending.currency).toUpperCase(),
    merchant: { id: str(m.network_id), name: str(m.name), mcc: str(m.category_code) },
    livemode: body.livemode === true,
  };
}

/** Lithic's statuses that move no money to a merchant: a refund to the card, a balance inquiry. */
const LITHIC_NO_SPEND = [
  "CREDIT_AUTHORIZATION",
  "FINANCIAL_CREDIT_AUTHORIZATION",
  "BALANCE_INQUIRY",
];

/** Lithic's Auth Stream Access request. */
export function lithicCharge(body: Json): CardCharge | undefined {
  const token = str(body.token);
  if (!token) return undefined;
  const status = str(body.status);
  const holder = obj(obj(body.amounts).cardholder);
  const m = obj(body.merchant);
  return {
    requestId: `lithic:${token}`,
    // Anything not known to spend nothing is checked, so a new status can't slip through.
    spend: !LITHIC_NO_SPEND.includes(status),
    amountCents: intCents(holder.amount) ?? 0,
    currency: str(holder.currency).toUpperCase(),
    merchant: { id: str(m.acceptor_id), name: str(m.descriptor), mcc: str(m.mcc) },
  };
}

/** The Marqeta methods that spend: a new authorization or a raise of one. */
const MARQETA_SPEND = [
  "pgfs.authorization",
  "pgfs.authorization.incremental",
  "pgfs.auth_plus_capture",
];

/** Marqeta's Gateway JIT Funding request. Amounts are decimal dollars. */
export function marqetaCharge(body: Json): CardCharge | undefined {
  const order = obj(body.gpa_order);
  const jit = obj(order.jit_funding);
  const token = str(jit.token);
  if (!token || !str(jit.method)) return undefined;
  const dollars = jit.amount;
  const cents =
    typeof dollars === "number" && Number.isFinite(dollars) && dollars > 0
      ? Math.round(dollars * 100)
      : 0;
  const m = obj(body.card_acceptor);
  return {
    requestId: `marqeta:${token}`,
    spend: MARQETA_SPEND.includes(str(jit.method)),
    amountCents: cents,
    currency: str(order.currency_code || body.currency_code).toUpperCase(),
    merchant: { id: str(m.mid), name: str(m.name), mcc: str(m.mcc) },
  };
}

/**
 * Whether Lithic signed `payload`: HMAC-SHA256 over "{webhook-id}.{webhook-timestamp}.{body}"
 * with the secret after "whsec_", base64-decoded; any "v1," signature in the header may match.
 * Within 5 minutes of now. Never throws.
 */
export function verifyLithicSignature(
  payload: string,
  headers: {
    id?: string | undefined;
    timestamp?: string | undefined;
    signature?: string | undefined;
  },
  secret: string,
  nowSeconds: number,
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  if (!key.length) return false;
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${payload}`).digest();
  return signature.split(" ").some((part) => {
    const [version, value] = part.split(",");
    if (version !== "v1" || !value) return false;
    const given = Buffer.from(value, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Whether a Basic Authorization header names this user and password. Never throws. */
export function verifyBasicAuth(
  header: string | undefined,
  user: string,
  passwordHash: string,
): boolean {
  const m = /^Basic ([A-Za-z0-9+/=]{1,400})$/.exec(header ?? "");
  if (!m) return false;
  const plain = Buffer.from(m[1]!, "base64").toString("utf8");
  const at = plain.indexOf(":");
  if (at < 0 || !/^[0-9a-f]{64}$/.test(passwordHash)) return false;
  // Compare the user, and the password by its hash, each in constant time.
  const same = (a: string, b: string) =>
    timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  const userOk = same(sha256(plain.slice(0, at)), sha256(user));
  const passOk = same(sha256(plain.slice(at + 1)), passwordHash);
  return userOk && passOk;
}

/** A password Marqeta accepts: 32 letters and digits, with at least one of each kind. */
export function newHookPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  for (;;) {
    const bytes = randomBytes(32);
    const p = [...bytes].map((b) => chars[b % chars.length]).join("");
    if (/[0-9]/.test(p) && /[a-z]/.test(p) && /[A-Z]/.test(p)) return p;
  }
}

const LITHIC_RESULT: Record<Why, string> = {
  merchant: "UNAUTHORIZED_MERCHANT",
  limit: "VELOCITY_EXCEEDED",
  frozen: "CARD_PAUSED",
  undecided: "CARD_PAUSED",
};

/** The gate ran out of its time budget: the transaction rolls back and the answer is decline. */
class OutOfTime extends Error {}

const hookInput = z.strictObject({
  provider: z.enum(CARD_HOOK_PROVIDERS),
  label: z
    .string()
    .trim()
    .max(60)
    .regex(/^[^\p{Cc}]*$/u)
    .optional(),
  secret: z
    .string()
    .regex(/^whsec_[A-Za-z0-9+/=_-]{10,200}$/)
    .optional(),
});

export const hookPath = (id: string) => `/payments/card-hook/${id}`;

const hookView = (h: GateCardHookRecord) => ({
  id: h.id,
  provider: h.provider,
  label: h.label,
  path: hookPath(h.id),
  secretHint: h.secretHint || null,
  /** Whether it can answer: Marqeta always, Stripe and Lithic once their secret is set. */
  ready: h.provider === "marqeta" || h.secretCiphertext !== null,
  username: h.basicUser,
  createdAt: h.createdAt.toISOString(),
  lastRequestAt: h.lastRequestAt?.toISOString() ?? null,
});

export function gateCardHookRoutes(
  app: Hono,
  deps: {
    db: Database;
    store: GateStore;
    notifier: Notifier;
    receiptKey?: Hex | undefined;
    now: () => number;
    secrets?: SecretBox | undefined;
    checks: RateLimiter;
    owned: (c: Context, write: boolean) => Promise<{ owner: string; account: GateAccountRecord }>;
  },
  options: GateCardHookOptions = {},
) {
  const { db, store, notifier, now, secrets } = deps;
  const hooks = new GateCardHookStore(db);
  const budgetMs = options.budgetMs ?? 1_500;
  const graceMs = options.graceMs ?? 300;
  const maxHooks = options.maxHooksPerAccount ?? 5;
  const allowLive = options.allowLiveCharges === true;
  const stripeVersion = options.stripeApiVersion ?? STRIPE_API_VERSION;
  const log = options.log ?? ((line: string) => console.error(line));
  const context = cardHookContext;

  const marqetaSecret = () =>
    new Refused(
      400,
      "A Marqeta card hook takes no secret: Bonded makes its username and password.",
    );
  /** Encrypt a signing secret for this hook; only its start and end are kept in the clear. */
  const seal = (hookId: string, secret: string) => {
    if (!secrets)
      throw new Refused(
        503,
        "Card hooks for Stripe and Lithic are off on this service: its secret encryption key isn't set.",
      );
    return {
      sealed: secrets.encrypt(secret, context(hookId)) as string | null,
      hint: `whsec_…${secret.slice(-4)}`,
    };
  };

  // Setting a hook up (owner session).

  app.get(
    "/gate/accounts/:id/card-hooks",
    handle(async (c) => {
      const { account } = await deps.owned(c, false);
      return c.json({ items: (await hooks.hooks(account.id)).map(hookView) });
    }),
  );
  /**
   * Add a hook. Stripe and Lithic: the signing secret the program shows for the endpoint. Marqeta:
   * no secret; Bonded makes a username and password, and returns the password this once.
   */
  app.post(
    "/gate/accounts/:id/card-hooks",
    handle(async (c) => {
      const { owner, account } = await deps.owned(c, true);
      const input = hookInput.parse(await c.req.json());
      const id = randomUUID();
      let sealed: string | null = null;
      let hint = "";
      let user: string | null = null;
      let password: string | null = null;
      if (input.provider === "marqeta") {
        if (input.secret) throw marqetaSecret();
        user = `bonded_${id.slice(0, 8)}`;
        password = newHookPassword();
      } else if (input.secret) {
        ({ sealed, hint } = seal(id, input.secret));
      }
      const made = await hooks.add(
        {
          id,
          accountId: account.id,
          provider: input.provider,
          label: input.label ?? "",
          secretCiphertext: sealed,
          secretHint: hint,
          basicUser: user,
          basicPasswordHash: password ? sha256(password) : null,
          createdBy: owner,
        },
        maxHooks,
      );
      if ("refused" in made)
        throw new Refused(409, "This gate account has as many card hooks as it may.", {
          limit: maxHooks,
        });
      c.header("Cache-Control", "no-store");
      return c.json({ ...hookView(made), ...(password ? { password } : {}) }, 201);
    }),
  );
  app.delete(
    "/gate/accounts/:id/card-hooks/:hookId",
    handle(async (c) => {
      const { account } = await deps.owned(c, true);
      const id = z.uuid().safeParse(c.req.param("hookId"));
      if (!id.success || !(await hooks.remove(account.id, id.data)))
        throw new Refused(404, "No such card hook on this gate account.");
      return c.json({ deleted: true });
    }),
  );

  /**
   * Set a Stripe or Lithic hook's signing secret. Stripe shows it only after the hook's address is
   * set as an endpoint, so a hook can be made first and given its secret after. Until then every
   * request to it is refused.
   */
  app.put(
    "/gate/accounts/:id/card-hooks/:hookId/secret",
    handle(async (c) => {
      const { account } = await deps.owned(c, true);
      const id = z.uuid().safeParse(c.req.param("hookId"));
      const found = id.success ? await hooks.hook(id.data) : undefined;
      if (!found || found.accountId !== account.id)
        throw new Refused(404, "No such card hook on this gate account.");
      if (found.provider === "marqeta") throw marqetaSecret();
      const { secret } = z
        .strictObject({ secret: z.string().regex(/^whsec_[A-Za-z0-9+/=_-]{10,200}$/) })
        .parse(await c.req.json());
      const { sealed, hint } = seal(found.id, secret);
      const updated = await hooks.setSecret(account.id, found.id, { ciphertext: sealed!, hint });
      if (!updated) throw new Refused(404, "No such card hook on this gate account.");
      c.header("Cache-Control", "no-store");
      return c.json(hookView(updated));
    }),
  );

  // The card program asking (no session, no API key: the signature is the proof).

  /** The program's answer, in its own format. */
  const answer = (
    c: Context,
    provider: GateCardHookProvider,
    body: Json,
    approved: boolean,
    why: Why,
  ) => {
    c.header("Cache-Control", "no-store");
    if (provider === "stripe") {
      c.header("Stripe-Version", stripeVersion);
      return c.json({ approved }, 200);
    }
    if (provider === "lithic")
      return c.json(
        { token: str(body.token), result: approved ? "APPROVED" : LITHIC_RESULT[why] },
        200,
      );
    // Marqeta: echo the funding request; 200 approves, 402 declines. The amount needs two decimals.
    const jit = obj(obj(body.gpa_order).jit_funding);
    const amount = typeof jit.amount === "number" && jit.amount > 0 ? jit.amount : 0;
    const out: Json = {
      token: str(jit.token),
      method: str(jit.method),
      ...(str(jit.user_token) ? { user_token: str(jit.user_token) } : {}),
      ...(str(jit.business_token) ? { business_token: str(jit.business_token) } : {}),
      ...(str(jit.acting_user_token) ? { acting_user_token: str(jit.acting_user_token) } : {}),
      amount: "@AMOUNT@",
      ...(approved
        ? {}
        : {
            decline_reason: why === "merchant" ? "INVALID_MERCHANT" : "TRANSACTION_NOT_PERMITTED",
          }),
    };
    const text = JSON.stringify({ jit_funding: out }).replace(
      '"@AMOUNT@"',
      (Math.round(amount * 100) / 100).toFixed(2),
    );
    return c.body(text, approved ? 200 : 402, { "Content-Type": "application/json" });
  };

  app.post("/payments/card-hook/:hookId", async (c) => {
    const started = performance.now();
    const deadline = started + budgetMs;
    const id = z.uuid().safeParse(c.req.param("hookId"));
    const hook = id.success ? await hooks.hook(id.data) : undefined;
    if (!hook) return c.json({ error: "No such card hook." }, 404);
    const raw = await c.req.text();
    if (raw.length > MAX_BODY) return c.json({ error: "The request is over 64 KB." }, 413);
    const nowSeconds = Math.floor(now() / 1000);
    let signed = false;
    if (hook.provider === "marqeta")
      signed = verifyBasicAuth(
        c.req.header("Authorization"),
        hook.basicUser ?? "",
        hook.basicPasswordHash ?? "",
      );
    else if (secrets && hook.secretCiphertext) {
      let secret: string | undefined;
      try {
        secret = secrets.decrypt(hook.secretCiphertext, context(hook.id));
      } catch {
        log(`card hook ${hook.id}: its secret doesn't decrypt`);
      }
      if (secret)
        signed =
          hook.provider === "stripe"
            ? verifyStripeSignature(raw, c.req.header("Stripe-Signature"), [secret], {
                nowSeconds,
              })
            : verifyLithicSignature(
                raw,
                {
                  id: c.req.header("webhook-id"),
                  timestamp: c.req.header("webhook-timestamp"),
                  signature: c.req.header("webhook-signature"),
                },
                secret,
                nowSeconds,
              );
    }
    if (!signed)
      return c.json({ error: "The request isn't signed by this hook's card program." }, 401);

    let body: Json;
    try {
      body = obj(JSON.parse(raw));
    } catch {
      return answer(c, hook.provider, {}, false, "undecided");
    }
    const charge =
      hook.provider === "stripe"
        ? stripeCharge(body)
        : hook.provider === "lithic"
          ? lithicCharge(body)
          : marqetaCharge(body);
    if (!charge) {
      log(`card hook ${hook.id}: declined a request it can't read`);
      return answer(c, hook.provider, body, false, "undecided");
    }
    // Marqeta needs the card's balances in the answer to a balance inquiry, which Bonded doesn't
    // know: decline it rather than send an answer Marqeta can't read.
    if (
      hook.provider === "marqeta" &&
      str(obj(obj(body.gpa_order).jit_funding).method) === "pgfs.balanceinquiry"
    )
      return answer(c, hook.provider, body, false, "undecided");
    // Nothing spent (a refund to the card, a balance inquiry, a capture, or a $0 check that a
    // card works, as merchants make when a card is saved): nothing to decide.
    if (!charge.spend || (charge.amountCents === 0 && charge.currency !== "")) {
      await hooks.asked(hook.id, new Date(now()));
      return answer(c, hook.provider, body, true, "undecided");
    }
    const decline = (why: string) => {
      log(`card hook ${hook.id}: declined ${charge.requestId}: ${why}`);
      return answer(c, hook.provider, body, false, "undecided");
    };
    if (charge.livemode && !allowLive)
      return decline("live-mode charges are declined until live charges are allowed");
    if (charge.currency !== "USD") return decline("not a USD charge");
    if (charge.amountCents < 0) return decline("a negative amount");
    if (!deps.receiptKey) return decline("no receipt key");
    if (!deps.checks.allow(hook.accountId)) return decline("over the account's checks per minute");

    const work = decide(hook, charge, deadline);
    work.catch(() => undefined);
    // The transaction checks the budget as its last step, so its outcome is the answer: a late
    // one has rolled back and declines. Waiting for COMMIT keeps the answer and the record the
    // same. Only a database that hangs past the grace gets a decline without its outcome.
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(
        () => resolve("late"),
        Math.max(0, deadline + graceMs - performance.now()),
      );
    });
    try {
      const outcome = await Promise.race([work, late]);
      if (outcome === "late")
        return decline(`no answer from the database ${budgetMs + graceMs} ms in`);
      if (outcome.check) alertOwner(notifier, outcome.check);
      return answer(c, hook.provider, body, outcome.approved, outcome.why);
    } catch (error) {
      return decline(
        error instanceof OutOfTime
          ? `over the ${budgetMs} ms budget`
          : error instanceof Error
            ? error.name
            : "error",
      );
    } finally {
      clearTimeout(timer);
    }
  });

  /** Decide one charge and record it with its receipt, in one transaction. */
  function decide(
    hook: GateCardHookRecord,
    charge: CardCharge,
    deadline: number,
  ): Promise<{ approved: boolean; why: Why; check?: GateCheckOutcome }> {
    return db.transaction(async (c) => {
      const account = (await store.lockAccount(c, hook.accountId))!;
      const earlier = await store.decisionByRequest(c, account.id, charge.requestId);
      if (earlier)
        return {
          approved: earlier.result === "allowed",
          why: earlier.decision === "frozen" ? "frozen" : whyOf(earlier.rules),
        };
      const at = new Date(now());
      const day = utcDay(at);
      await store.countCheck(c, account.id, day);
      await hooks.asked(hook.id, at, c);
      const merchantKey = cardMerchantKey(charge.merchant.id);
      const state = await hooks.chargeState(c, account.id, { merchantKey, day });
      // Payments open budgets may still make count toward the hourly limit too.
      const reserved =
        account.maxPaymentsPerHour !== null
          ? await new GateBudgetStore(db).reservedPayments(c, account.id, at)
          : 0;
      const input: GateCardChargeInput = {
        kind: "card_charge",
        provider: hook.provider,
        day,
        limits: {
          maxPaymentCents: account.maxPaymentCents,
          maxDailyCents: account.maxDailyCents,
          maxPaymentsPerHour: account.maxPaymentsPerHour,
        },
        attempt: { account: merchantKey, amountCents: charge.amountCents, reference: "" },
        merchant: { key: merchantKey, name: charge.merchant.name, mcc: charge.merchant.mcc },
        payees: state.payees,
        payments: state.payments,
        paymentsLastHour: await store.paymentsSince(
          c,
          account.id,
          new Date(at.getTime() - 3_600_000),
        ),
        ...(reserved > 0 ? { reservedPayments: reserved } : {}),
      };
      const frozen = account.frozenAt !== null;
      const verdict = frozen ? undefined : evaluateGateInput(input);
      if (verdict && !verdict.ok) throw new Error(verdict.error);
      const rules = verdict?.ok ? verdict.rules : [];
      const decision = frozen ? "frozen" : rules.length ? "breach" : "pass";
      // Cash, money orders and gambling are declined in either mode.
      const result = frozen
        ? "refused"
        : rules.length && (account.mode === "enforce" || rules.includes("blocked_merchant"))
          ? "blocked"
          : "allowed";
      const wentOut = result === "allowed";
      const decisionId = randomUUID();
      const inputHash = gateInputHash(input);
      const receipt: GateReceipt = {
        decisionId,
        gateAccountId: account.id,
        kind: "card",
        decision,
        result,
        mode: account.mode,
        rules,
        amountCents: charge.amountCents,
        payee: merchantKey,
        reference: "",
        inputHash,
        mandateHash: account.mandateHash as Hex,
        mandateVersion: account.mandateVersion,
        checkedAt: Math.floor(at.getTime() / 1000),
      };
      const signedReceipt = await signGateReceipt(receipt, deps.receiptKey!);
      const vendorId = verdict?.ok ? verdict.vendorId : null;
      const record = await store.addDecision(c, {
        id: decisionId,
        accountId: account.id,
        keyId: null,
        requestId: charge.requestId,
        requestHash: null,
        kind: "card",
        decision,
        result,
        mode: account.mode,
        rules,
        amountCents: charge.amountCents,
        lossCents: wentOut && verdict?.ok ? verdict.lossCents : 0,
        overpaidCents: wentOut && verdict?.ok ? verdict.overpaidCents : 0,
        payee: merchantKey,
        vendorId,
        reference: "",
        inputHash,
        input,
        mandateHash: account.mandateHash,
        mandateVersion: account.mandateVersion,
        receipt: signedReceipt,
        createdAt: at,
      });
      if (wentOut)
        await store.addPayment(
          account.id,
          {
            decisionId,
            source: "hook",
            kind: "invoice",
            payee: merchantKey,
            payeeNorm: merchantKey,
            vendorId,
            amountCents: charge.amountCents,
            reference: "",
            referenceNorm: "",
            day,
          },
          c,
        );
      const froze = decision === "breach" && account.freezeOnBreach;
      if (froze) await store.freeze(c, account.id, decisionId);
      const after = (await store.account(account.id, c))!;
      // Past the budget the answer is decline: roll back so no "allowed" receipt is kept. This is
      // the last step before COMMIT, and the handler waits for COMMIT, so the answer matches it.
      if (performance.now() > deadline) throw new OutOfTime();
      return {
        approved: wentOut,
        why: frozen ? "frozen" : whyOf(rules),
        check: { decision: record, input, replayed: false, froze, account: after },
      };
    });
  }
}

/** Merchant rules decline as a bad merchant; everything else as over a limit. */
function whyOf(rules: readonly string[]): Why {
  return rules.includes("unknown_payee") || rules.includes("blocked_merchant")
    ? "merchant"
    : "limit";
}
