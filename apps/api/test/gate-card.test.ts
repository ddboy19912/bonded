import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ANVIL_KEYS } from "@bonded/arena";
import { connectChain } from "@bonded/keeper";
import {
  evaluateGateInput,
  gateInputHash,
  parseEvmDeployment,
  selfServeMessage,
  verifyGateReceipt,
  type GateInput,
} from "@bondedhq/shared";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createApi } from "../src/index.js";
import type { GateOptions } from "../src/gate.js";
import { SecretBox } from "../src/secrets.js";
import {
  stripeForm,
  verifyStripeSignature,
  type NewGateCard,
  type StripeIssuingClient,
} from "../src/stripe-issuing.js";
import { postgres } from "./postgres.js";

/**
 * The card route with Stripe Issuing (gate-card.ts), against a fake Stripe client and webhook
 * payloads signed the way Stripe signs them, with throwaway secrets made for this run.
 */

const TOKEN = "gate-card-test-token-at-least-24-chars";
const RECEIPT_KEY = generatePrivateKey();
const RECEIPT_SIGNER = privateKeyToAccount(RECEIPT_KEY).address;
const owner = privateKeyToAccount(generatePrivateKey());
// Throwaway Stripe-shaped values: none of them is a real key or secret.
const STRIPE_KEY = `rk_test_${randomBytes(24).toString("hex")}`;
const AUTH_SECRET = `whsec_${randomBytes(24).toString("hex")}`;
const EVENTS_SECRET = `whsec_${randomBytes(24).toString("hex")}`;
const OTHER_SECRET = `whsec_${randomBytes(24).toString("hex")}`;
// Stripe's published test card number and a test CVC, as a fake card's details.
const CARD_NUMBER = "4000056655665556";
const CARD_CVC = "737";

const NIMBUS = "GB29 NWBK 6016 1331 9268 19";
const NIMBUS_MERCHANT = { name: "Nimbus Cloud", networkId: "1234567890" };
const FRAUD_MERCHANT = { name: "Quick Pay Ltd", networkId: "9999999999" };

const chain = connectChain(
  parseEvmDeployment(
    readFileSync(new URL("../../../contracts/evm/deployments/46630.json", import.meta.url), "utf8"),
  ),
  "http://127.0.0.1:1",
  ANVIL_KEYS.deployer,
);
const chainId = chain.deployment.chainId;

/** A fake Stripe: cards in memory, every call recorded. */
class FakeStripe implements StripeIssuingClient {
  cards = new Map<string, NewGateCard & { status: string }>();
  calls: { method: string; key: string; idempotencyKey?: string; card?: NewGateCard }[] = [];
  fail = false;
  async createCard(key: string, card: NewGateCard, idempotencyKey: string) {
    this.calls.push({ method: "createCard", key, idempotencyKey, card });
    if (this.fail) throw new Error("Stripe is down");
    const id = `ic_${idempotencyKey.slice(-12)}`;
    if (!this.cards.has(id)) this.cards.set(id, { ...card, status: "active" });
    return { id, last4: "5556", brand: "Visa", expMonth: 12, expYear: 2029, status: "active" };
  }
  async revealCard(key: string, cardId: string) {
    this.calls.push({ method: "revealCard", key });
    return {
      id: cardId,
      last4: "5556",
      brand: "Visa",
      expMonth: 12,
      expYear: 2029,
      status: this.cards.get(cardId)!.status,
      number: CARD_NUMBER,
      cvc: CARD_CVC,
    };
  }
  async cancelCard(key: string, cardId: string) {
    this.calls.push({ method: "cancelCard", key });
    this.cards.get(cardId)!.status = "canceled";
  }
}

let pg: Awaited<ReturnType<typeof postgres>>;
let app: ReturnType<typeof createApi>;
let stripe: FakeStripe;
const logs: string[] = [];
const responses: string[] = [];
const clock = Date.parse("2026-11-03T10:00:00Z");
const wide = { perClient: 100_000, total: 1_000_000, windowMs: 600_000 };
const secrets = new SecretBox(randomBytes(32));

const makeApi = (card: GateOptions["card"] = {}) =>
  createApi({
    db: pg.db,
    chain,
    attesterKey: ANVIL_KEYS.deployer,
    apiToken: TOKEN,
    selfServe: { now: () => clock },
    ownerRequests: { writes: wide, reads: wide },
    secrets,
    gate: {
      receiptKey: RECEIPT_KEY,
      maxAccountsPerOwner: 100,
      card: {
        stripe,
        authorizationSecret: AUTH_SECRET,
        eventsSecret: EVENTS_SECRET,
        log: (line) => logs.push(line),
        ...card,
      },
    },
  });

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(
  method: string,
  path: string,
  body?: unknown,
  auth?: string,
  a: ReturnType<typeof createApi> = app,
): Promise<{ status: number; body: Body; headers: Headers }> {
  const res = await a.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  responses.push(text);
  return { status: res.status, body: JSON.parse(text) as Body, headers: res.headers };
}

/** Signs a payload as Stripe does: `t=<seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`. */
const stripeSignature = (payload: string, secret: string, at = Math.floor(clock / 1000)) =>
  `t=${at},v1=${createHmac("sha256", secret).update(`${at}.${payload}`).digest("hex")},v0=${"0".repeat(64)}`;

let events = 0;
/** Posts a Stripe event to a webhook route, signed with `secret` unless `signature` is given. */
async function webhook(
  path: "/stripe/issuing/authorization" | "/stripe/issuing/events",
  event: Body,
  options: { secret?: string; signature?: string; a?: ReturnType<typeof createApi> } = {},
) {
  const payload = JSON.stringify(event);
  const secret =
    options.secret ?? (path === "/stripe/issuing/authorization" ? AUTH_SECRET : EVENTS_SECRET);
  const res = await (options.a ?? app).request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": options.signature ?? stripeSignature(payload, secret),
    },
    body: payload,
  });
  const text = await res.text();
  responses.push(text);
  return { status: res.status, body: JSON.parse(text) as Body, headers: res.headers };
}

const merchantData = (
  m: { name: string; networkId: string },
  category = "computer_software_stores",
) => ({
  name: m.name,
  network_id: m.networkId,
  category,
  city: "London",
  country: "GB",
});

/** An `issuing_authorization.request` event on a card. */
function authRequest(
  cardId: string,
  amount: number,
  o: {
    merchant?: { name: string; networkId: string };
    category?: string;
    authId?: string;
    eventId?: string;
    livemode?: boolean;
    approved?: boolean;
    approvedAmount?: number;
  } = {},
) {
  events++;
  return {
    id: o.eventId ?? `evt_req_${events}`,
    object: "event",
    type: "issuing_authorization.request",
    livemode: o.livemode ?? false,
    data: {
      object: {
        id: o.authId ?? `iauth_${events}`,
        object: "issuing_authorization",
        approved: o.approved ?? false,
        amount: o.approvedAmount ?? 0,
        currency: "usd",
        status: "pending",
        livemode: o.livemode ?? false,
        card: { id: cardId, object: "issuing.card", last4: "5556", status: "active" },
        merchant_data: merchantData(o.merchant ?? NIMBUS_MERCHANT, o.category),
        pending_request: {
          amount,
          currency: "usd",
          is_amount_controllable: false,
          merchant_amount: amount,
          merchant_currency: "usd",
        },
        request_history: [],
        created: Math.floor(clock / 1000),
      },
    },
  };
}

/** An `issuing_authorization.created` or `.updated` event. */
function authEvent(
  type: "issuing_authorization.created" | "issuing_authorization.updated",
  cardId: string,
  authId: string,
  o: {
    approved: boolean;
    amount: number;
    status?: string;
    reasons?: string[];
    merchant?: { name: string; networkId: string };
  },
) {
  events++;
  return {
    id: `evt_auth_${events}`,
    object: "event",
    type,
    data: {
      object: {
        id: authId,
        object: "issuing_authorization",
        approved: o.approved,
        amount: o.amount,
        currency: "usd",
        status: o.status ?? "pending",
        livemode: false,
        card: { id: cardId, object: "issuing.card" },
        merchant_data: merchantData(o.merchant ?? NIMBUS_MERCHANT),
        pending_request: null,
        request_history: (o.reasons ?? []).map((reason) => ({
          amount: o.amount,
          approved: o.approved,
          reason,
          reason_message: null,
          created: Math.floor(clock / 1000),
        })),
        created: Math.floor(clock / 1000),
      },
    },
  };
}

/** An `issuing_transaction.created` event; `amount` is money out, sent as Stripe does (negative). */
function transaction(
  cardId: string,
  amount: number,
  o: {
    authId?: string | null;
    type?: "capture" | "refund";
    merchant?: { name: string; networkId: string };
  } = {},
) {
  events++;
  const type = o.type ?? "capture";
  return {
    id: `evt_tx_${events}`,
    object: "event",
    type: "issuing_transaction.created",
    data: {
      object: {
        id: `ipi_${events}`,
        object: "issuing.transaction",
        amount: type === "capture" ? -amount : amount,
        authorization: o.authId === undefined ? null : o.authId,
        card: cardId,
        currency: "usd",
        type,
        merchant_data: merchantData(o.merchant ?? NIMBUS_MERCHANT),
        created: Math.floor(clock / 1000),
      },
    },
  };
}

const sessions = new Map<string, string>();
async function sessionFor(who: PrivateKeyAccount) {
  const known = sessions.get(who.address);
  if (known) return known;
  const timestamp = Math.floor(clock / 1000);
  const signature = await who.signMessage({
    message: selfServeMessage({ action: "sign-in", chainId, wallet: who.address, timestamp }),
  });
  const r = await call("POST", "/self/session", { wallet: who.address, timestamp, signature });
  expect(r.status).toBe(201);
  sessions.set(who.address, r.body.session);
  return r.body.session as string;
}

/**
 * A gate account linked to Stripe, with Nimbus (bank account and card merchant) in its vendor
 * master and invoice NIM-1 approved for $612.40.
 */
async function cardAccount(settings: Record<string, unknown> = {}, link = true) {
  const session = await sessionFor(owner);
  const made = await call(
    "POST",
    "/gate/accounts",
    { name: "Acme AP", mode: "enforce", maxPaymentUsd: 5_000, maxDailyUsd: 8_000, ...settings },
    session,
  );
  expect(made.status).toBe(201);
  const id = made.body.account.id as string;
  const key = made.body.apiKey.key as string;
  const base = `/gate/accounts/${id}`;
  const vendor = await call(
    "POST",
    `${base}/vendors`,
    { id: "nimbus", name: "Nimbus Cloud", account: NIMBUS, cardMerchant: NIMBUS_MERCHANT },
    session,
  );
  expect(vendor.status).toBe(201);
  const invoice = await call(
    "POST",
    `${base}/invoices`,
    { vendorId: "nimbus", reference: "NIM-1", amountUsd: 612.4 },
    session,
  );
  expect(invoice.status).toBe(201);
  if (link)
    expect(
      (
        await call(
          "PUT",
          `${base}/stripe`,
          { secretKey: STRIPE_KEY, cardholderId: "ich_test1" },
          session,
        )
      ).status,
    ).toBe(200);
  return { id, key, session, base };
}

/** An account and a card issued for NIM-1. */
async function withCard(settings: Record<string, unknown> = {}) {
  const a = await cardAccount(settings);
  const intent = await call("POST", "/payments/intents", { invoiceReference: "NIM-1" }, a.key);
  expect(intent.status).toBe(201);
  return { ...a, intent: intent.body.intent as Body, cardId: intent.body.card.id as string };
}

const decisions = async (accountId: string) =>
  (
    await pg.db.pool.query("SELECT * FROM gate_decisions WHERE account_id=$1 ORDER BY seq", [
      accountId,
    ])
  ).rows;
const intentStatus = async (intentId: string) =>
  (await pg.db.pool.query("SELECT status FROM gate_card_intents WHERE id=$1", [intentId])).rows[0]
    .status as string;
const notices = async (accountId: string) =>
  (
    await pg.db.pool.query(
      "SELECT type, payload FROM owner_notifications WHERE payload->>'gateAccountId'=$1 ORDER BY id",
      [accountId],
    )
  ).rows as { type: string; payload: Body }[];

beforeAll(async () => {
  pg = await postgres();
  stripe = new FakeStripe();
  app = makeApi();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

describe("Stripe's webhook signature", () => {
  const payload = JSON.stringify({ id: "evt_1" });
  const now = 1_800_000_000;
  it("accepts Stripe's scheme and refuses everything else", () => {
    const header = stripeSignature(payload, AUTH_SECRET, now);
    expect(verifyStripeSignature(payload, header, [AUTH_SECRET], { nowSeconds: now })).toBe(true);
    // Any of the secrets, as while a rolled secret is still live.
    expect(
      verifyStripeSignature(payload, header, [OTHER_SECRET, AUTH_SECRET], { nowSeconds: now }),
    ).toBe(true);
    expect(verifyStripeSignature(payload, header, [OTHER_SECRET], { nowSeconds: now })).toBe(false);
    expect(verifyStripeSignature(`${payload} `, header, [AUTH_SECRET], { nowSeconds: now })).toBe(
      false,
    );
    // Older than five minutes, or from the future.
    expect(verifyStripeSignature(payload, header, [AUTH_SECRET], { nowSeconds: now + 301 })).toBe(
      false,
    );
    expect(verifyStripeSignature(payload, header, [AUTH_SECRET], { nowSeconds: now - 301 })).toBe(
      false,
    );
    // Only v1 counts: a v0 signature alone (Stripe's fake test scheme) is refused.
    const v0 = `t=${now},v0=${createHmac("sha256", AUTH_SECRET).update(`${now}.${payload}`).digest("hex")}`;
    expect(verifyStripeSignature(payload, v0, [AUTH_SECRET], { nowSeconds: now })).toBe(false);
    expect(verifyStripeSignature(payload, undefined, [AUTH_SECRET])).toBe(false);
    expect(verifyStripeSignature(payload, header, [], { nowSeconds: now })).toBe(false);
  });

  it("form-encodes nested params as Stripe expects", () => {
    expect(
      stripeForm({
        spending_controls: { spending_limits: [{ amount: 100, interval: "all_time" }] },
        expand: ["number", "cvc"],
      }).toString(),
    ).toBe(
      "spending_controls%5Bspending_limits%5D%5B0%5D%5Bamount%5D=100&spending_controls%5Bspending_limits%5D%5B0%5D%5Binterval%5D=all_time&expand%5B0%5D=number&expand%5B1%5D=cvc",
    );
  });
});

describe("linking a gate account to Stripe", () => {
  it("takes test-mode keys only, stores them encrypted and never shows them again", async () => {
    const { id, base, session } = await cardAccount({}, false);
    const live = await call(
      "PUT",
      `${base}/stripe`,
      { secretKey: `rk_live_${randomBytes(24).toString("hex")}`, cardholderId: "ich_1" },
      session,
    );
    expect(live.status).toBe(403);
    expect(live.body.code).toBe("gate-stripe-live-refused");
    expect((await call("GET", `${base}/stripe`, undefined, session)).body.code).toBe(
      "gate-stripe-not-linked",
    );

    const linked = await call(
      "PUT",
      `${base}/stripe`,
      {
        secretKey: STRIPE_KEY,
        cardholderId: "ich_test1",
        authorizationWebhookSecret: OTHER_SECRET,
      },
      session,
    );
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({
      linked: true,
      livemode: false,
      cardholderId: "ich_test1",
      keyHint: `rk_test_…${STRIPE_KEY.slice(-4)}`,
      webhookSecrets: { authorization: true, events: false },
    });
    const row = (
      await pg.db.pool.query("SELECT * FROM gate_stripe_links WHERE account_id=$1", [id])
    ).rows[0];
    expect(JSON.stringify(row)).not.toContain(STRIPE_KEY.slice(8));
    expect(JSON.stringify(row)).not.toContain(OTHER_SECRET);
    expect(JSON.stringify(linked.body)).not.toContain(STRIPE_KEY.slice(8));

    // Another wallet can't see or change it.
    const other = await sessionFor(privateKeyToAccount(generatePrivateKey()));
    expect((await call("GET", `${base}/stripe`, undefined, other)).status).toBe(404);
    expect((await call("DELETE", `${base}/stripe`, undefined, session)).body).toEqual({
      unlinked: true,
    });
  });

  it("allows live keys only when GATE_ALLOW_LIVE_CREDENTIALS is on, and needs the secret box", async () => {
    const allowed = makeApi({ allowLiveCredentials: true });
    const { base, session } = await cardAccount({}, false);
    const live = await call(
      "PUT",
      `${base}/stripe`,
      { secretKey: `sk_live_${randomBytes(24).toString("hex")}`, cardholderId: "ich_1" },
      session,
      allowed,
    );
    expect(live.body.livemode).toBe(true);
    await allowed.close();

    const boxless = createApi({
      db: pg.db,
      chain,
      attesterKey: ANVIL_KEYS.deployer,
      apiToken: TOKEN,
      selfServe: { now: () => clock },
      ownerRequests: { writes: wide, reads: wide },
      gate: { receiptKey: RECEIPT_KEY, card: { stripe } },
    });
    const off = await call(
      "PUT",
      `${base}/stripe`,
      { secretKey: STRIPE_KEY, cardholderId: "ich_1" },
      session,
      boxless,
    );
    expect(off.status).toBe(503);
    expect(off.body.code).toBe("gate-stripe-unavailable");
    await boxless.close();
  });
});

describe("the vendor master's card merchants", () => {
  it("changes a merchant on file only with a verified ticket that covers it", async () => {
    const { base, session } = await cardAccount({}, false);
    const before = (await call("GET", base, undefined, session)).body.mandate.version;
    const changed = await call(
      "PUT",
      `${base}/vendors/nimbus`,
      { cardMerchant: FRAUD_MERCHANT },
      session,
    );
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe("gate-merchant-change-unverified");
    // A ticket for another account doesn't cover it.
    await call(
      "POST",
      `${base}/tickets`,
      { id: "FIN-1", vendorId: "nimbus", account: "card:1111", verifiedBy: "ap@acme.test" },
      session,
    );
    expect(
      (
        await call(
          "PUT",
          `${base}/vendors/nimbus`,
          { cardMerchant: FRAUD_MERCHANT, ticket: "FIN-1" },
          session,
        )
      ).status,
    ).toBe(409);
    await call(
      "POST",
      `${base}/tickets`,
      { id: "FIN-2", vendorId: "nimbus", account: "card:9999999999", verifiedBy: "ap@acme.test" },
      session,
    );
    const ok = await call(
      "PUT",
      `${base}/vendors/nimbus`,
      { cardMerchant: FRAUD_MERCHANT, ticket: "FIN-2" },
      session,
    );
    expect(ok.status).toBe(200);
    expect(ok.body.cardMerchant).toEqual({ ...FRAUD_MERCHANT, key: "CARD:9999999999" });
    const after = (await call("GET", base, undefined, session)).body.mandate.version;
    expect(after).toBe(before + 1);
    const mandate = (await call("GET", `${base}/mandates?limit=1`, undefined, session)).body
      .items[0].mandate;
    expect(mandate.vendors[0].cardMerchant).toEqual(FRAUD_MERCHANT);

    // FIN-2 is used up: after a verified move back, it can't switch the merchant again.
    await call(
      "POST",
      `${base}/tickets`,
      { id: "FIN-3", vendorId: "nimbus", account: "card:1234567890", verifiedBy: "ap@acme.test" },
      session,
    );
    const back = await call(
      "PUT",
      `${base}/vendors/nimbus`,
      { cardMerchant: NIMBUS_MERCHANT, ticket: "FIN-3" },
      session,
    );
    expect(back.status).toBe(200);
    const reuse = await call(
      "PUT",
      `${base}/vendors/nimbus`,
      { cardMerchant: FRAUD_MERCHANT, ticket: "FIN-2" },
      session,
    );
    expect(reuse.status).toBe(409);
    expect(reuse.body.code).toBe("gate-merchant-change-unverified");
  });
});

describe("payment intents: a single-use card per approved invoice", () => {
  it("issues a single-use card limited to the invoice, cash blocked, and returns the same card on a retry", async () => {
    const { id, key } = await cardAccount();
    const calls = stripe.calls.length;
    const made = await call("POST", "/payments/intents", { invoiceReference: "nim-1" }, key);
    expect(made.status).toBe(201);
    expect(made.headers.get("Cache-Control")).toBe("no-store");
    expect(made.body.intent).toMatchObject({
      status: "issued",
      vendorId: "nimbus",
      invoiceReference: "NIM-1",
      amountUsd: 612.4,
    });
    expect(made.body.card).toMatchObject({ last4: "5556", number: CARD_NUMBER, cvc: CARD_CVC });
    const create = stripe.calls[calls]!;
    expect(create).toMatchObject({ method: "createCard", key: STRIPE_KEY });
    expect(create.idempotencyKey).toBe(`bonded-gate-intent-${made.body.intent.id}`);
    expect(create.card).toMatchObject({ cardholder: "ich_test1", amountCents: 61_240 });

    const again = await call("POST", "/payments/intents", { invoiceReference: "NIM-1" }, key);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, card: { id: made.body.card.id } });
    expect(stripe.calls.filter((c) => c.method === "createCard")).toHaveLength(
      stripe.calls.slice(0, calls).filter((c) => c.method === "createCard").length + 1,
    );
    // Only the card's id and last four digits are kept.
    const rows = (
      await pg.db.pool.query("SELECT * FROM gate_card_intents WHERE account_id=$1", [id])
    ).rows;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(CARD_NUMBER);
    expect(Object.keys(rows[0])).not.toContain("cvc");
  });

  it("asks Stripe for the card with the right controls (the real client's request)", async () => {
    const { stripeIssuingClient } = await import("../src/stripe-issuing.js");
    const seen: { url: string; init: RequestInit }[] = [];
    const client = stripeIssuingClient({
      apiVersion: "2026-09-30.endive",
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return new Response(
          JSON.stringify({
            id: "ic_1",
            last4: "5556",
            brand: "Visa",
            exp_month: 1,
            exp_year: 2030,
            status: "active",
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    await client.createCard(
      STRIPE_KEY,
      { cardholder: "ich_1", amountCents: 61_240, metadata: { bonded_intent: "x" } },
      "idem-1",
    );
    const sent = new URLSearchParams(seen[0]!.init.body as string);
    expect(seen[0]!.url).toBe("https://api.stripe.com/v1/issuing/cards");
    expect(seen[0]!.init.headers).toMatchObject({
      "Stripe-Version": "2026-09-30.endive",
      "Idempotency-Key": "idem-1",
    });
    expect(Object.fromEntries(sent)).toMatchObject({
      cardholder: "ich_1",
      currency: "usd",
      type: "virtual",
      status: "active",
      "lifecycle_controls[cancel_after][payment_count]": "1",
      "spending_controls[spending_limits][0][amount]": "61240",
      "spending_controls[spending_limits][0][interval]": "all_time",
    });
    expect(sent.getAll("spending_controls[blocked_categories][0]")).toEqual([
      "automated_cash_disburse",
    ]);
    expect(
      [...sent.keys()].filter((k) => k.startsWith("spending_controls[blocked_categories]")),
    ).toHaveLength(7);
    // Revealing asks for the number and CVC with expand; cancelling sets the status.
    await client.revealCard(STRIPE_KEY, "ic_1");
    expect(seen[1]!.url).toBe(
      "https://api.stripe.com/v1/issuing/cards/ic_1?expand%5B0%5D=number&expand%5B1%5D=cvc",
    );
    await client.cancelCard(STRIPE_KEY, "ic_1");
    expect(seen[2]!.init.body).toBe("status=canceled");
  });

  it("refuses a card for an unknown, paid or over-limit invoice, a frozen or unlinked account, or a vendor without a merchant", async () => {
    const { key, base, session } = await cardAccount({ maxPaymentUsd: 500 });
    const over = await call("POST", "/payments/intents", { invoiceReference: "NIM-1" }, key);
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({ code: "gate-card-refused", rules: ["over_payment_cap"] });
    expect(
      (await call("POST", "/payments/intents", { invoiceReference: "NOPE" }, key)).body.code,
    ).toBe("gate-not-found");

    await call("PUT", base, { maxPaymentUsd: 5_000 }, session);
    await call(
      "POST",
      `${base}/payments`,
      { account: NIMBUS, amountUsd: 612.4, reference: "NIM-1", day: "2026-11-02" },
      session,
    );
    const paid = await call("POST", "/payments/intents", { invoiceReference: "NIM-1" }, key);
    expect(paid.body.rules).toEqual(["duplicate_payment"]);

    await call(
      "POST",
      `${base}/vendors`,
      { id: "bank-only", name: "Bank Only", account: "DE89 3704 0044 0532 0130 00" },
      session,
    );
    await call(
      "POST",
      `${base}/invoices`,
      { vendorId: "bank-only", reference: "B-1", amountUsd: 10 },
      session,
    );
    expect(
      (await call("POST", "/payments/intents", { invoiceReference: "B-1" }, key)).body.code,
    ).toBe("gate-no-card-merchant");

    await call("DELETE", `${base}/stripe`, undefined, session);
    expect(
      (await call("POST", "/payments/intents", { invoiceReference: "NIM-1" }, key)).body.code,
    ).toBe("gate-stripe-not-linked");

    const frozen = await cardAccount({ freezeOnBreach: true });
    await call(
      "POST",
      "/payments/check",
      { account: "LT12 1000 0111 0100 1000", amountUsd: 1, invoiceReference: "X" },
      frozen.key,
    );
    const refused = await call(
      "POST",
      "/payments/intents",
      { invoiceReference: "NIM-1" },
      frozen.key,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("gate-frozen");
  });

  it("marks the intent failed when Stripe refuses, so a retry makes a new one", async () => {
    const { key } = await cardAccount();
    stripe.fail = true;
    const failed = await call("POST", "/payments/intents", { invoiceReference: "NIM-1" }, key);
    stripe.fail = false;
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe("gate-stripe-failed");
    expect(
      (await call("POST", "/payments/intents", { invoiceReference: "NIM-1" }, key)).status,
    ).toBe(201);
  });
});

describe("the real-time authorization webhook", () => {
  it("refuses a request without Stripe's signature, with another secret, or replayed late", async () => {
    const { id, cardId } = await withCard();
    const event = authRequest(cardId, 61_240);
    expect((await webhook("/stripe/issuing/authorization", event, { signature: "" })).status).toBe(
      400,
    );
    expect(
      (await webhook("/stripe/issuing/authorization", event, { secret: OTHER_SECRET })).status,
    ).toBe(400);
    const payload = JSON.stringify(event);
    const stale = stripeSignature(payload, AUTH_SECRET, Math.floor(clock / 1000) - 600);
    expect(
      (await webhook("/stripe/issuing/authorization", event, { signature: stale })).status,
    ).toBe(400);
    // The events endpoint's secret doesn't sign authorizations.
    expect(
      (await webhook("/stripe/issuing/authorization", event, { secret: EVENTS_SECRET })).status,
    ).toBe(400);
    expect(await decisions(id)).toHaveLength(0);
  });

  it("approves the invoice's charge in Stripe's direct-response format, with a verifiable receipt, well inside 2 seconds", async () => {
    const { id, cardId, intent, base, session } = await withCard();
    const started = performance.now();
    const r = await webhook("/stripe/issuing/authorization", authRequest(cardId, 61_240));
    const ms = performance.now() - started;
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ approved: true });
    expect(r.headers.get("Stripe-Version")).toBe("2026-09-30.endive");
    expect(r.headers.get("Content-Type")).toMatch(/application\/json/);
    expect(ms).toBeLessThan(2_000);
    console.log(`authorization answered in ${ms.toFixed(1)} ms`);

    const [d] = await decisions(id);
    expect(d).toMatchObject({ kind: "card", decision: "pass", result: "allowed", rules: [] });
    expect(await verifyGateReceipt(d.receipt, RECEIPT_SIGNER)).toBe(true);
    expect(d.receipt.receipt).toMatchObject({
      kind: "card",
      payee: "CARD:1234567890",
      reference: "NIM-1",
      amountCents: 61_240,
    });
    // The decision log shows it to the owner; nothing is paid until a transaction settles.
    const log = await call("GET", `${base}/decisions`, undefined, session);
    expect(log.body.items[0]).toMatchObject({ kind: "card", allowed: true });
    expect((await call("GET", `${base}/payments`, undefined, session)).body.items).toEqual([]);
    expect(await intentStatus(intent.id)).toBe("authorized");
  });

  it("measures the 2-second budget over a run of charges", async () => {
    const times: number[] = [];
    for (let i = 0; i < 8; i++) {
      const { cardId } = await withCard();
      const started = performance.now();
      const r = await webhook("/stripe/issuing/authorization", authRequest(cardId, 61_240));
      times.push(performance.now() - started);
      expect(r.body.approved).toBe(true);
    }
    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length / 2)]!;
    const max = times.at(-1)!;
    console.log(
      `authorization p50 ${p50.toFixed(1)} ms, max ${max.toFixed(1)} ms (embedded Postgres)`,
    );
    expect(max).toBeLessThan(1_500);
  });

  it("maps each rule onto the card and declines every breaking charge in Enforce mode", async () => {
    // unknown_payee: a merchant no vendor has on file.
    const a = await withCard();
    const unknown = await webhook(
      "/stripe/issuing/authorization",
      authRequest(a.cardId, 61_240, { merchant: FRAUD_MERCHANT }),
    );
    expect(unknown.body.approved).toBe(false);
    expect((await decisions(a.id))[0]).toMatchObject({
      decision: "breach",
      result: "blocked",
      rules: ["unknown_payee", "unmatched_invoice"],
    });

    // unverified_vendor_change: the vendor's name on another merchant id, no ticket.
    const b = await withCard();
    const lookalike = await webhook(
      "/stripe/issuing/authorization",
      authRequest(b.cardId, 61_240, { merchant: { name: "NIMBUS CLOUD", networkId: "5555" } }),
    );
    expect(lookalike.body.approved).toBe(false);
    expect((await decisions(b.id))[0].rules).toEqual([
      "unknown_payee",
      "unverified_vendor_change",
      "unmatched_invoice",
    ]);

    // unmatched_invoice: more than the invoice.
    const c = await withCard();
    const more = await webhook("/stripe/issuing/authorization", authRequest(c.cardId, 70_000));
    expect(more.body.approved).toBe(false);
    expect((await decisions(c.id))[0].rules).toEqual(["unmatched_invoice"]);

    // duplicate_payment: the invoice was paid after the card was issued.
    const d = await withCard();
    await call(
      "POST",
      `${d.base}/payments`,
      { account: NIMBUS, amountUsd: 612.4, reference: "NIM-1", day: "2026-11-03" },
      d.session,
    );
    const dup = await webhook("/stripe/issuing/authorization", authRequest(d.cardId, 61_240));
    expect(dup.body.approved).toBe(false);
    expect((await decisions(d.id))[0].rules).toEqual(["duplicate_payment"]);

    // over_payment_cap and over_daily_cap: limits lowered after the card was issued.
    const e = await withCard();
    await call("PUT", e.base, { maxPaymentUsd: 100, maxDailyUsd: 200 }, e.session);
    const caps = await webhook("/stripe/issuing/authorization", authRequest(e.cardId, 61_240));
    expect(caps.body.approved).toBe(false);
    expect((await decisions(e.id))[0].rules).toEqual(["over_payment_cap", "over_daily_cap"]);

    // Each receipt's input reruns to the same rules and hash.
    for (const acc of [a, b, c, d, e]) {
      const [row] = await decisions(acc.id);
      expect(row.input_hash).toBe(row.receipt.receipt.inputHash);
      expect(await verifyGateReceipt(row.receipt, RECEIPT_SIGNER)).toBe(true);
    }
  });

  it("declines another vendor's merchant on the card, even for that vendor's invoice with the same reference", async () => {
    const a = await withCard();
    const orbit = { name: "Orbit Hosting", networkId: "7777777777" };
    await call(
      "POST",
      `${a.base}/vendors`,
      {
        id: "orbit",
        name: "Orbit Hosting",
        account: "DE89 3704 0044 0532 0130 00",
        cardMerchant: orbit,
      },
      a.session,
    );
    await call(
      "POST",
      `${a.base}/invoices`,
      { vendorId: "orbit", reference: "NIM-1", amountUsd: 612.4 },
      a.session,
    );
    const r = await webhook(
      "/stripe/issuing/authorization",
      authRequest(a.cardId, 61_240, { merchant: orbit }),
    );
    expect(r.body.approved).toBe(false);
    expect((await decisions(a.id))[0]).toMatchObject({
      result: "blocked",
      rules: ["unmatched_invoice"],
    });
    expect(await intentStatus(a.intent.id)).toBe("issued");
  });

  it("lets a verified merchant change through and makes it the vendor's merchant", async () => {
    const a = await withCard();
    await call(
      "POST",
      `${a.base}/tickets`,
      { id: "FIN-9", vendorId: "nimbus", account: "card:5555", verifiedBy: "ap@acme.test" },
      a.session,
    );
    const r = await webhook(
      "/stripe/issuing/authorization",
      authRequest(a.cardId, 61_240, { merchant: { name: "Nimbus Cloud", networkId: "5555" } }),
    );
    expect(r.body.approved).toBe(true);
    const vendor = (await call("GET", `${a.base}/vendors`, undefined, a.session)).body.items[0];
    expect(vendor.cardMerchant).toEqual({
      name: "Nimbus Cloud",
      networkId: "5555",
      key: "CARD:5555",
    });
  });

  it("declines cash and quasi-cash in either mode", async () => {
    for (const mode of ["enforce", "monitor"]) {
      const a = await withCard({ mode });
      const r = await webhook(
        "/stripe/issuing/authorization",
        authRequest(a.cardId, 61_240, { category: "automated_cash_disburse" }),
      );
      expect(r.body.approved).toBe(false);
      expect((await decisions(a.id))[0]).toMatchObject({
        result: "blocked",
        rules: ["unmatched_invoice"],
      });
    }
  });

  it("lets a breaking charge through in Monitor mode, records it and alerts", async () => {
    const a = await withCard({ mode: "monitor" });
    const r = await webhook(
      "/stripe/issuing/authorization",
      authRequest(a.cardId, 61_240, { merchant: FRAUD_MERCHANT }),
    );
    expect(r.body.approved).toBe(true);
    expect((await decisions(a.id))[0]).toMatchObject({
      decision: "breach",
      result: "allowed",
      mode: "monitor",
      loss_cents: "61240",
    });
    await vi.waitFor(async () =>
      expect((await notices(a.id)).map((n) => n.type)).toEqual(["payment_breach"]),
    );
  });

  it("freezes on a breach when set, and then declines every charge in either mode", async () => {
    for (const mode of ["enforce", "monitor"]) {
      const a = await withCard({ mode, freezeOnBreach: true });
      await webhook(
        "/stripe/issuing/authorization",
        authRequest(a.cardId, 61_240, { merchant: FRAUD_MERCHANT, authId: `iauth_f1_${mode}` }),
      );
      const after = await webhook(
        "/stripe/issuing/authorization",
        authRequest(a.cardId, 61_240, { authId: `iauth_f2_${mode}` }),
      );
      expect(after.body.approved).toBe(false);
      const rows = await decisions(a.id);
      expect(rows.map((r) => [r.decision, r.result])).toEqual([
        ["breach", mode === "enforce" ? "blocked" : "allowed"],
        ["frozen", "refused"],
      ]);
    }
  });

  it("declines when the gate runs out of time, and keeps nothing it was deciding", async () => {
    const slow = makeApi({ budgetMs: 0 });
    const a = await withCard();
    const r = await webhook("/stripe/issuing/authorization", authRequest(a.cardId, 61_240), {
      a: slow,
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ approved: false });
    expect(r.headers.get("Stripe-Version")).toBeTruthy();
    expect(await decisions(a.id)).toHaveLength(0);
    expect(await intentStatus(a.intent.id)).toBe("issued");
    expect(logs.some((l) => /over the 0 ms budget/.test(l))).toBe(true);
    await slow.close();
  });

  it("declines without a receipt key, on a card the gate didn't issue, and on a live charge", async () => {
    const a = await withCard();
    const keyless = createApi({
      db: pg.db,
      chain,
      attesterKey: ANVIL_KEYS.deployer,
      apiToken: TOKEN,
      selfServe: { now: () => clock },
      secrets,
      gate: { card: { stripe, authorizationSecret: AUTH_SECRET, log: (l) => logs.push(l) } },
    });
    expect(
      (
        await webhook("/stripe/issuing/authorization", authRequest(a.cardId, 61_240), {
          a: keyless,
        })
      ).body,
    ).toEqual({ approved: false });
    await keyless.close();
    expect(
      (await webhook("/stripe/issuing/authorization", authRequest("ic_not_ours", 61_240))).body,
    ).toEqual({ approved: false });
    expect(
      (
        await webhook(
          "/stripe/issuing/authorization",
          authRequest(a.cardId, 61_240, { livemode: true }),
        )
      ).body,
    ).toEqual({ approved: false });
    expect(await decisions(a.id)).toHaveLength(0);
  });

  it("answers a replayed request the same, once, and checks an increment against the invoice", async () => {
    const a = await withCard();
    const first = authRequest(a.cardId, 61_240, { authId: "iauth_inc" });
    expect((await webhook("/stripe/issuing/authorization", first)).body.approved).toBe(true);
    expect((await webhook("/stripe/issuing/authorization", first)).body.approved).toBe(true);
    expect(await decisions(a.id)).toHaveLength(1);
    // An increment of $50 on the approved $612.40: the total no longer matches the invoice.
    const increment = authRequest(a.cardId, 5_000, {
      authId: "iauth_inc",
      approved: true,
      approvedAmount: 61_240,
    });
    expect((await webhook("/stripe/issuing/authorization", increment)).body.approved).toBe(false);
    const rows = await decisions(a.id);
    expect(rows[1]).toMatchObject({ amount_cents: "66240", rules: ["unmatched_invoice"] });
    const held = (
      await pg.db.pool.query("SELECT * FROM gate_card_authorizations WHERE id='iauth_inc'")
    ).rows[0];
    expect(held).toMatchObject({ gate_approved: true, approved_cents: "61240" });
  });

  it("lets only one of several simultaneous charges on the invoice through", async () => {
    const a = await withCard();
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        webhook(
          "/stripe/issuing/authorization",
          authRequest(a.cardId, 61_240, { authId: `iauth_race_${i}` }),
        ),
      ),
    );
    expect(results.filter((r) => r.body.approved)).toHaveLength(1);
    expect(
      (await decisions(a.id)).filter((d) => d.rules.includes("duplicate_payment")),
    ).toHaveLength(5);
  });
});

describe("reconciling what reached Stripe without the gate", () => {
  it("records a payment only when a transaction settles, once per event", async () => {
    const a = await withCard();
    await webhook(
      "/stripe/issuing/authorization",
      authRequest(a.cardId, 61_240, { authId: "iauth_ok" }),
    );
    const created = await webhook(
      "/stripe/issuing/events",
      authEvent("issuing_authorization.created", a.cardId, "iauth_ok", {
        approved: true,
        amount: 61_240,
        reasons: ["webhook_approved"],
      }),
    );
    expect(created.body).toMatchObject({ received: true, handled: true, replayed: false });
    expect((await call("GET", `${a.base}/payments`, undefined, a.session)).body.items).toEqual([]);

    const settled = transaction(a.cardId, 61_240, { authId: "iauth_ok" });
    expect((await webhook("/stripe/issuing/events", settled)).body.replayed).toBe(false);
    expect((await webhook("/stripe/issuing/events", settled)).body.replayed).toBe(true);
    const payments = (await call("GET", `${a.base}/payments`, undefined, a.session)).body.items;
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      source: "card",
      amountCents: 61_240,
      vendorId: "nimbus",
      reference: "NIM-1",
    });
    expect(await intentStatus(a.intent.id)).toBe("paid");
    // A clean settlement adds no decision; the invoice can't get a second card.
    expect(await decisions(a.id)).toHaveLength(1);
    const second = await call("POST", "/payments/intents", { invoiceReference: "NIM-1" }, a.key);
    expect(second.body.rules).toEqual(["duplicate_payment"]);
  });

  it("records a force capture (no authorization) as a breach, cancels the card and alerts", async () => {
    const a = await withCard();
    const cancels = stripe.calls.filter((c) => c.method === "cancelCard").length;
    const r = await webhook(
      "/stripe/issuing/events",
      transaction(a.cardId, 61_240, { authId: null }),
    );
    expect(r.body.handled).toBe(true);
    const [d] = await decisions(a.id);
    expect(d).toMatchObject({ kind: "card", decision: "breach", result: "allowed", rules: [] });
    const input = (d.receipt as { receipt: { inputHash: string } }).receipt;
    expect(input.inputHash).toBe(d.input_hash);
    expect(stripe.calls.filter((c) => c.method === "cancelCard")).toHaveLength(cancels + 1);
    expect(stripe.cards.get(a.cardId)!.status).toBe("canceled");
    expect(await intentStatus(a.intent.id)).toBe("canceled");
    expect((await call("GET", `${a.base}/payments`, undefined, a.session)).body.items).toHaveLength(
      1,
    );
    await vi.waitFor(async () => {
      const n = await notices(a.id);
      expect(n.map((x) => [x.type, x.payload.code])).toEqual([
        ["payment_breach", "gate-card-bypass"],
      ]);
    });
  });

  it("records a capture on an authorization the gate declined (a stand-in approval) as a breach", async () => {
    const a = await withCard({ freezeOnBreach: true });
    await webhook(
      "/stripe/issuing/authorization",
      authRequest(a.cardId, 61_240, { authId: "iauth_stand_in", merchant: FRAUD_MERCHANT }),
    );
    await call("POST", `${a.base}/unfreeze`, {}, a.session);
    // Stripe approved it anyway (a stand-in or timeout fallback): the card is cancelled at once.
    await webhook(
      "/stripe/issuing/events",
      authEvent("issuing_authorization.created", a.cardId, "iauth_stand_in", {
        approved: true,
        amount: 61_240,
        merchant: FRAUD_MERCHANT,
        reasons: ["network_fallback"],
      }),
    );
    expect(stripe.cards.get(a.cardId)!.status).toBe("canceled");
    await webhook(
      "/stripe/issuing/events",
      transaction(a.cardId, 61_240, { authId: "iauth_stand_in", merchant: FRAUD_MERCHANT }),
    );
    const rows = await decisions(a.id);
    expect(rows.at(-1)).toMatchObject({
      decision: "breach",
      result: "allowed",
      rules: ["unknown_payee", "unmatched_invoice"],
      loss_cents: "61240",
    });
    // The breach froze the account again.
    expect((await call("GET", a.base, undefined, a.session)).body.frozen).toBe(true);
    await vi.waitFor(async () => {
      const types = (await notices(a.id)).map((n) => n.payload.code);
      expect(types).toEqual(
        expect.arrayContaining(["gate-stripe-webhook-failed", "gate-card-bypass", "gate-frozen"]),
      );
    });
  });

  it("records a capture above the approved amount as an overpayment", async () => {
    const a = await withCard();
    await webhook(
      "/stripe/issuing/authorization",
      authRequest(a.cardId, 61_240, { authId: "iauth_over" }),
    );
    await webhook(
      "/stripe/issuing/events",
      transaction(a.cardId, 65_000, { authId: "iauth_over" }),
    );
    const rows = await decisions(a.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      decision: "breach",
      result: "allowed",
      rules: ["unmatched_invoice"],
      amount_cents: "65000",
      overpaid_cents: "3760",
    });
    const payments = (await call("GET", `${a.base}/payments`, undefined, a.session)).body.items;
    expect(payments[0].amountCents).toBe(65_000);
    await vi.waitFor(async () => {
      expect((await notices(a.id)).map((n) => n.payload.code)).toEqual(["gate-card-overpaid"]);
    });
  });

  it("releases the invoice when the approved charge is reversed or expires", async () => {
    for (const status of ["reversed", "expired"]) {
      const a = await withCard();
      const authId = `iauth_${status}`;
      await webhook("/stripe/issuing/authorization", authRequest(a.cardId, 61_240, { authId }));
      expect(await intentStatus(a.intent.id)).toBe("authorized");
      const busy = await call("POST", "/payments/intents", { invoiceReference: "NIM-1" }, a.key);
      expect(busy.body.code).toBe("gate-card-in-use");
      await webhook(
        "/stripe/issuing/events",
        authEvent("issuing_authorization.updated", a.cardId, authId, {
          approved: true,
          amount: status === "reversed" ? 0 : 61_240,
          status,
        }),
      );
      expect(await intentStatus(a.intent.id)).toBe("released");
      expect((await call("GET", `${a.base}/payments`, undefined, a.session)).body.items).toEqual(
        [],
      );
      const next = await call("POST", "/payments/intents", { invoiceReference: "NIM-1" }, a.key);
      expect(next.status).toBe(201);
      expect(next.body.intent.id).not.toBe(a.intent.id);
      // The old card is spent: a later charge on it is declined.
      const late = await webhook("/stripe/issuing/authorization", authRequest(a.cardId, 61_240));
      expect(late.body.approved).toBe(false);
    }
  });

  it("releases the invoice when Stripe declines a charge the gate approved (its answer came too late)", async () => {
    const a = await withCard();
    await webhook(
      "/stripe/issuing/authorization",
      authRequest(a.cardId, 61_240, { authId: "iauth_slow" }),
    );
    expect(await intentStatus(a.intent.id)).toBe("authorized");
    await webhook(
      "/stripe/issuing/events",
      authEvent("issuing_authorization.created", a.cardId, "iauth_slow", {
        approved: false,
        amount: 61_240,
        status: "closed",
        reasons: ["webhook_timeout"],
      }),
    );
    expect(await intentStatus(a.intent.id)).toBe("released");
    const next = await call("POST", "/payments/intents", { invoiceReference: "NIM-1" }, a.key);
    expect(next.status).toBe(201);
  });

  it("still counts a captured charge toward the day when its transaction arrives after the authorization closes", async () => {
    // Daily cap $1,000; two invoices of $612.40.
    const a = await withCard({ maxDailyUsd: 1_000 });
    await call(
      "POST",
      `${a.base}/invoices`,
      { vendorId: "nimbus", reference: "NIM-2", amountUsd: 612.4 },
      a.session,
    );
    await webhook(
      "/stripe/issuing/authorization",
      authRequest(a.cardId, 61_240, { authId: "iauth_first" }),
    );
    // Captured: Stripe closes the authorization; its issuing_transaction.created comes later.
    await webhook(
      "/stripe/issuing/events",
      authEvent("issuing_authorization.updated", a.cardId, "iauth_first", {
        approved: true,
        amount: 0,
        status: "closed",
      }),
    );
    const second = await call("POST", "/payments/intents", { invoiceReference: "NIM-2" }, a.key);
    expect(second.status).toBe(409);
    expect(second.body.rules).toEqual(["over_daily_cap"]);
  });

  it("alerts on webhook_timeout and webhook_error, once each", async () => {
    const a = await withCard();
    const timeout = authEvent("issuing_authorization.created", a.cardId, "iauth_to", {
      approved: false,
      amount: 61_240,
      reasons: ["webhook_timeout"],
    });
    await webhook("/stripe/issuing/events", timeout);
    await webhook("/stripe/issuing/events", { ...timeout, id: `${timeout.id}_dup` });
    await webhook(
      "/stripe/issuing/events",
      authEvent("issuing_authorization.updated", a.cardId, "iauth_err", {
        approved: false,
        amount: 61_240,
        reasons: ["webhook_error"],
      }),
    );
    await vi.waitFor(async () => {
      const n = await notices(a.id);
      expect(n.map((x) => [x.type, x.payload.details.reason])).toEqual([
        ["stripe_webhook_failed", "webhook_timeout"],
        ["stripe_webhook_failed", "webhook_error"],
      ]);
      expect(n[0]!.payload.code).toBe("gate-stripe-webhook-failed");
    });
    // A declined fallback cancels nothing.
    expect(stripe.cards.get(a.cardId)!.status).toBe("active");
  });

  it("refuses unsigned events and ignores cards the gate didn't issue", async () => {
    const a = await withCard();
    const event = transaction(a.cardId, 61_240, { authId: null });
    expect((await webhook("/stripe/issuing/events", event, { secret: AUTH_SECRET })).status).toBe(
      400,
    );
    expect(await decisions(a.id)).toHaveLength(0);
    const other = await webhook(
      "/stripe/issuing/events",
      transaction("ic_not_ours", 100, { authId: null }),
    );
    expect(other.body).toEqual({ received: true, handled: false });
  });

  it("verifies with a linked account's own endpoint secret too", async () => {
    const a = await withCard();
    await call(
      "PUT",
      `${a.base}/stripe`,
      {
        secretKey: STRIPE_KEY,
        cardholderId: "ich_test1",
        authorizationWebhookSecret: OTHER_SECRET,
      },
      a.session,
    );
    const r = await webhook("/stripe/issuing/authorization", authRequest(a.cardId, 61_240), {
      secret: OTHER_SECRET,
    });
    expect(r.body.approved).toBe(true);
  });
});

describe("secrets and card details", () => {
  it("never puts a card number, CVC, Stripe key or webhook secret in logs, receipts, alerts or answers", async () => {
    const all = [
      ...logs,
      ...responses.filter((r) => !r.includes(`"number":"${CARD_NUMBER}"`)),
      JSON.stringify((await pg.db.pool.query("SELECT * FROM gate_decisions")).rows),
      JSON.stringify((await pg.db.pool.query("SELECT * FROM owner_notifications")).rows),
      JSON.stringify((await pg.db.pool.query("SELECT * FROM gate_card_intents")).rows),
      JSON.stringify((await pg.db.pool.query("SELECT * FROM gate_card_authorizations")).rows),
      JSON.stringify((await pg.db.pool.query("SELECT * FROM gate_stripe_links")).rows),
    ].join("\n");
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of [
      CARD_NUMBER,
      STRIPE_KEY.slice(8),
      AUTH_SECRET,
      EVENTS_SECRET,
      OTHER_SECRET,
    ])
      expect(all).not.toContain(secret);
    expect(all).not.toMatch(/"cvc"/);
    // The card details went only to the agent, in the intent answers.
    expect(
      responses.filter((r) => r.includes(CARD_NUMBER)).every((r) => r.includes('"intent"')),
    ).toBe(true);
  });

  it("reruns a card receipt's input to the same rules and hash offline", async () => {
    const a = await withCard();
    await webhook(
      "/stripe/issuing/authorization",
      authRequest(a.cardId, 61_240, { merchant: { name: "Nimbus Cloud", networkId: "777" } }),
    );
    const [row] = await decisions(a.id);
    // Rebuild the input from the state the gate read (the shared engine is pure).
    const input: GateInput = {
      kind: "card",
      stage: "authorization",
      gateApproved: true,
      day: "2026-11-03",
      limits: { maxPaymentCents: 500_000, maxDailyCents: 800_000 },
      attempt: { account: "CARD:777", amountCents: 61_240, reference: "NIM-1" },
      vendorId: "nimbus",
      vendorMerchant: { key: "CARD:1234567890", name: "Nimbus Cloud" },
      merchant: { key: "CARD:777", name: "Nimbus Cloud", category: "computer_software_stores" },
      payees: [],
      invoices: [{ reference: "NIM-1", vendorId: "nimbus", amountCents: 61_240 }],
      payments: [],
      tickets: [],
    };
    expect(gateInputHash(input)).toBe(row.input_hash);
    const verdict = evaluateGateInput(input);
    expect(verdict.ok && verdict.rules).toEqual(row.rules);
  });
});
