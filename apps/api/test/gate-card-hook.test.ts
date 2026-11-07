import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
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
  lithicCharge,
  marqetaCharge,
  newHookPassword,
  stripeCharge,
  verifyBasicAuth,
  verifyLithicSignature,
} from "../src/gate-card-hook.js";
import { postgres } from "./postgres.js";

/**
 * Card hooks (gate-card-hook.ts): a card program the business runs asks the gate before each
 * charge. Requests are signed the way Stripe, Lithic and Marqeta sign them, with throwaway
 * secrets made for this run.
 */

const TOKEN = "gate-card-hook-test-token-at-least-24-chars";
const RECEIPT_KEY = generatePrivateKey();
const RECEIPT_SIGNER = privateKeyToAccount(RECEIPT_KEY).address;
const owner = privateKeyToAccount(generatePrivateKey());
// Throwaway secrets in each program's shape: none is real.
const STRIPE_SECRET = `whsec_${randomBytes(24).toString("hex")}`;
const LITHIC_SECRET = `whsec_${randomBytes(24).toString("base64")}`;

const CLOUD = { name: "Cloud Hosting Co", networkId: "445566778" };
const STRANGER = { name: "Quick Pay Ltd", networkId: "999999999" };

const chain = connectChain(
  parseEvmDeployment(
    readFileSync(new URL("../../../contracts/evm/deployments/46630.json", import.meta.url), "utf8"),
  ),
  "http://127.0.0.1:1",
  ANVIL_KEYS.deployer,
);
const chainId = chain.deployment.chainId;

let pg: Awaited<ReturnType<typeof postgres>>;
let app: ReturnType<typeof createApi>;
const logs: string[] = [];
const clock = Date.parse("2026-11-07T10:00:00Z");
const wide = { perClient: 100_000, total: 1_000_000, windowMs: 600_000 };
const secrets = new SecretBox(randomBytes(32));

const makeApi = (cardHook: GateOptions["cardHook"] = {}) =>
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
      card: { log: (line) => logs.push(line) },
      cardHook,
    },
  });

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(
  method: string,
  path: string,
  body?: unknown,
  auth?: string,
): Promise<{ status: number; body: Body }> {
  const res = await app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: JSON.parse(await res.text()) as Body };
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

/** A gate account with Cloud Hosting Co as a vendor whose card merchant is on file. */
async function account(settings: Record<string, unknown> = {}) {
  const session = await sessionFor(owner);
  const made = await call(
    "POST",
    "/gate/accounts",
    { name: "Acme ops", mode: "enforce", maxPaymentUsd: 500, maxDailyUsd: 800, ...settings },
    session,
  );
  expect(made.status).toBe(201);
  const id = made.body.account.id as string;
  const base = `/gate/accounts/${id}`;
  const vendor = await call(
    "POST",
    `${base}/vendors`,
    { id: "cloud", name: CLOUD.name, account: "GB29NWBK60161331926819", cardMerchant: CLOUD },
    session,
  );
  expect(vendor.status).toBe(201);
  return { id, session, base };
}

async function addHook(
  a: { base: string; session: string },
  provider: "stripe" | "lithic" | "marqeta",
) {
  const secret =
    provider === "stripe" ? STRIPE_SECRET : provider === "lithic" ? LITHIC_SECRET : undefined;
  const r = await call(
    "POST",
    `${a.base}/card-hooks`,
    { provider, label: `${provider} cards`, ...(secret ? { secret } : {}) },
    a.session,
  );
  expect(r.status).toBe(201);
  return r.body;
}

let n = 0;
const seconds = Math.floor(clock / 1000);

/** Stripe's `issuing_authorization.request`, signed. */
function stripeRequest(
  amount: number,
  o: { merchant?: typeof CLOUD; mcc?: string; authId?: string; livemode?: boolean } = {},
) {
  n++;
  const body = JSON.stringify({
    id: `evt_${n}`,
    type: "issuing_authorization.request",
    livemode: o.livemode ?? false,
    data: {
      object: {
        id: o.authId ?? `iauth_${n}`,
        card: { id: "ic_theirs" },
        pending_request: { amount, currency: "usd" },
        merchant_data: {
          network_id: (o.merchant ?? CLOUD).networkId,
          name: (o.merchant ?? CLOUD).name,
          category_code: o.mcc ?? "7372",
        },
      },
    },
  });
  const sig = createHmac("sha256", STRIPE_SECRET).update(`${seconds}.${body}`).digest("hex");
  return { body, headers: { "Stripe-Signature": `t=${seconds},v1=${sig}` } };
}

/** Lithic's Auth Stream Access request, signed. */
function lithicRequest(
  amount: number,
  o: { merchant?: typeof CLOUD; mcc?: string; status?: string; token?: string } = {},
) {
  n++;
  const token = o.token ?? `7d7f6a4e-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const body = JSON.stringify({
    token,
    status: o.status ?? "AUTHORIZATION",
    amounts: { cardholder: { amount, currency: "USD" }, merchant: { amount, currency: "USD" } },
    card: { token: "c0ffee00-0000-4000-8000-000000000001" },
    merchant: {
      acceptor_id: (o.merchant ?? CLOUD).networkId,
      descriptor: (o.merchant ?? CLOUD).name,
      mcc: o.mcc ?? "7372",
    },
  });
  const id = `msg_${n}`;
  const key = Buffer.from(LITHIC_SECRET.slice("whsec_".length), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${seconds}.${body}`).digest("base64");
  return {
    body,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": String(seconds),
      "webhook-signature": `v1,${"A".repeat(44)} v1,${sig}`,
    },
  };
}

/** Marqeta's Gateway JIT Funding request, with Basic auth. */
function marqetaRequest(
  dollars: number,
  auth: { username: string; password: string },
  o: { merchant?: typeof CLOUD; method?: string } = {},
) {
  n++;
  const jit = {
    token: `jit_${n}`,
    method: o.method ?? "pgfs.authorization",
    user_token: "user_1",
    acting_user_token: "user_1",
    amount: dollars,
  };
  const body = JSON.stringify({
    type: "authorization",
    state: "PENDING",
    token: `txn_${n}`,
    card_token: "card_1",
    amount: dollars,
    currency_code: "USD",
    card_acceptor: {
      mid: (o.merchant ?? CLOUD).networkId,
      mcc: "7372",
      name: (o.merchant ?? CLOUD).name,
    },
    gpa_order: { amount: dollars, currency_code: "USD", jit_funding: jit },
  });
  const basic = Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
  return { body, headers: { Authorization: `Basic ${basic}` } };
}

async function ask(path: string, r: { body: string; headers: Record<string, string> }) {
  const res = await app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...r.headers },
    body: r.body,
  });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Body, headers: res.headers };
}

const decisions = async (accountId: string) =>
  (
    await pg.db.pool.query("SELECT * FROM gate_decisions WHERE account_id=$1 ORDER BY seq", [
      accountId,
    ])
  ).rows;
const payments = async (accountId: string) =>
  (
    await pg.db.pool.query("SELECT * FROM gate_payments WHERE account_id=$1 ORDER BY id", [
      accountId,
    ])
  ).rows;
const notices = async (accountId: string) =>
  (
    await pg.db.pool.query(
      "SELECT type FROM owner_notifications WHERE payload->>'gateAccountId'=$1 ORDER BY id",
      [accountId],
    )
  ).rows.map((r) => r.type as string);

beforeAll(async () => {
  pg = await postgres();
  app = makeApi();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

describe("how each card program proves a request", () => {
  it("checks Lithic's signature: any v1 signature may match, within 5 minutes", () => {
    const r = lithicRequest(100);
    const h = {
      id: r.headers["webhook-id"],
      timestamp: r.headers["webhook-timestamp"],
      signature: r.headers["webhook-signature"],
    };
    expect(verifyLithicSignature(r.body, h, LITHIC_SECRET, seconds)).toBe(true);
    expect(verifyLithicSignature(`${r.body} `, h, LITHIC_SECRET, seconds)).toBe(false);
    expect(verifyLithicSignature(r.body, h, LITHIC_SECRET, seconds + 301)).toBe(false);
    expect(verifyLithicSignature(r.body, { ...h, id: "msg_other" }, LITHIC_SECRET, seconds)).toBe(
      false,
    );
    expect(
      verifyLithicSignature(r.body, { ...h, signature: undefined }, LITHIC_SECRET, seconds),
    ).toBe(false);
  });

  it("checks Marqeta's Basic auth against the password's hash, and makes passwords Marqeta takes", () => {
    const password = newHookPassword();
    expect(password).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(password).toMatch(/[0-9]/);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[A-Z]/);
    const hash = createHash("sha256").update(password).digest("hex");
    const header = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
    expect(verifyBasicAuth(header("bonded_1", password), "bonded_1", hash)).toBe(true);
    expect(verifyBasicAuth(header("bonded_2", password), "bonded_1", hash)).toBe(false);
    expect(verifyBasicAuth(header("bonded_1", `${password}x`), "bonded_1", hash)).toBe(false);
    expect(verifyBasicAuth(undefined, "bonded_1", hash)).toBe(false);
    expect(verifyBasicAuth("Bearer abc", "bonded_1", hash)).toBe(false);
  });

  it("reads each program's charge: amount in cents, currency, merchant id, name and category", () => {
    const s = stripeCharge(JSON.parse(stripeRequest(4_200).body));
    expect(s).toMatchObject({
      spend: true,
      amountCents: 4_200,
      currency: "USD",
      merchant: { id: CLOUD.networkId, name: CLOUD.name, mcc: "7372" },
    });
    expect(lithicCharge(JSON.parse(lithicRequest(4_200).body))).toMatchObject({
      spend: true,
      amountCents: 4_200,
      currency: "USD",
      merchant: { id: CLOUD.networkId },
    });
    expect(
      lithicCharge(JSON.parse(lithicRequest(4_200, { status: "CREDIT_AUTHORIZATION" }).body)),
    ).toMatchObject({ spend: false });
    const auth = { username: "u", password: "p" };
    expect(marqetaCharge(JSON.parse(marqetaRequest(29.7, auth).body))).toMatchObject({
      spend: true,
      amountCents: 2_970,
      currency: "USD",
    });
    expect(
      marqetaCharge(JSON.parse(marqetaRequest(29.7, auth, { method: "pgfs.refund" }).body)),
    ).toMatchObject({ spend: false });
    expect(stripeCharge({ type: "issuing_authorization.created" })).toBeUndefined();
  });
});

describe("setting up a card hook", () => {
  it("keeps the signing secret out of every answer, and gives Marqeta's password once", async () => {
    const a = await account();
    const stripe = await addHook(a, "stripe");
    expect(stripe.path).toBe(`/payments/card-hook/${stripe.id}`);
    expect(stripe.secretHint).toBe(`whsec_…${STRIPE_SECRET.slice(-4)}`);
    expect(JSON.stringify(stripe)).not.toContain(STRIPE_SECRET);
    const marqeta = await addHook(a, "marqeta");
    expect(marqeta.username).toMatch(/^bonded_/);
    expect(marqeta.password).toMatch(/^[A-Za-z0-9]{32}$/);
    const list = await call("GET", `${a.base}/card-hooks`, undefined, a.session);
    expect(list.body.items.map((h: Body) => h.provider)).toEqual(["stripe", "marqeta"]);
    expect(JSON.stringify(list.body)).not.toContain(marqeta.password);
    expect(JSON.stringify(list.body)).not.toContain(STRIPE_SECRET);
    const stored = (
      await pg.db.pool.query("SELECT * FROM gate_card_hooks WHERE account_id=$1", [a.id])
    ).rows;
    expect(JSON.stringify(stored)).not.toContain(STRIPE_SECRET);
    expect(JSON.stringify(stored)).not.toContain(marqeta.password);
    const conn = await call("GET", `${a.base}/connections`, undefined, a.session);
    expect(conn.body.cardHooks).toHaveLength(2);
    expect(conn.body.cardHooks[0]).toMatchObject({ provider: "stripe", lastRequestAt: null });
  });

  it("takes Stripe's and Lithic's secret after the address is set, and refuses one for Marqeta", async () => {
    const a = await account();
    const made = await call("POST", `${a.base}/card-hooks`, { provider: "lithic" }, a.session);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ ready: false, secretHint: null });
    // No secret yet: nothing it answers can be trusted, so every request is refused.
    expect((await ask(made.body.path, lithicRequest(4_200))).status).toBe(401);
    const set = await call(
      "PUT",
      `${a.base}/card-hooks/${made.body.id}/secret`,
      { secret: LITHIC_SECRET },
      a.session,
    );
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ ready: true });
    expect(JSON.stringify(set.body)).not.toContain(LITHIC_SECRET);
    expect((await ask(made.body.path, lithicRequest(4_200))).body.result).toBe("APPROVED");

    const marqeta = await addHook(a, "marqeta");
    expect(marqeta.ready).toBe(true);
    const extra = await call(
      "POST",
      `${a.base}/card-hooks`,
      { provider: "marqeta", secret: STRIPE_SECRET },
      a.session,
    );
    expect(extra.status).toBe(400);
    expect(extra.body.error).toMatch(/takes no secret/);
    const later = await call(
      "PUT",
      `${a.base}/card-hooks/${marqeta.id}/secret`,
      { secret: STRIPE_SECRET },
      a.session,
    );
    expect(later.status).toBe(400);
    const odd = await call(
      "POST",
      `${a.base}/card-hooks`,
      { provider: "visa", secret: STRIPE_SECRET },
      a.session,
    );
    expect(odd.status).toBe(400);
  });

  it("caps hooks per account, lets only the owner see them, and removes one", async () => {
    const a = await account();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await addHook(a, "marqeta")).id);
    const sixth = await call("POST", `${a.base}/card-hooks`, { provider: "marqeta" }, a.session);
    expect(sixth.status).toBe(409);
    const stranger = await sessionFor(privateKeyToAccount(generatePrivateKey()));
    expect((await call("GET", `${a.base}/card-hooks`, undefined, stranger)).status).toBe(404);
    expect(
      (await call("DELETE", `${a.base}/card-hooks/${ids[0]}`, undefined, a.session)).status,
    ).toBe(200);
    expect(
      (await call("DELETE", `${a.base}/card-hooks/${ids[0]}`, undefined, a.session)).status,
    ).toBe(404);
    expect((await ask(`/payments/card-hook/${ids[0]}`, { body: "{}", headers: {} })).status).toBe(
      404,
    );
  });
});

describe("Stripe Issuing asking before a charge", () => {
  it("approves a vendor's merchant within the limits, with a receipt, and counts it as paid", async () => {
    const a = await account();
    const hook = await addHook(a, "stripe");
    const r = await ask(hook.path, stripeRequest(4_200));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ approved: true });
    expect(r.headers.get("Stripe-Version")).toBeTruthy();
    const [d] = await decisions(a.id);
    expect(d).toMatchObject({ kind: "card", decision: "pass", result: "allowed" });
    expect(d.payee).toBe(`CARD:${CLOUD.networkId}`);
    expect(d.input.kind).toBe("card_charge");
    expect(d.input_hash).toBe(gateInputHash(d.input as GateInput));
    expect(evaluateGateInput(d.input as GateInput)).toMatchObject({ ok: true, rules: [] });
    expect(await verifyGateReceipt(d.receipt, RECEIPT_SIGNER)).toBe(true);
    const [p] = await payments(a.id);
    expect(p).toMatchObject({ source: "hook", amount_cents: "4200", vendor_id: "cloud" });
    const activity = await call("GET", `${a.base}/activity`, undefined, a.session);
    expect(activity.body.items[0]).toMatchObject({ source: "card", rail: "Stripe card" });
    const conn = await call("GET", `${a.base}/connections`, undefined, a.session);
    expect(conn.body.cardHooks[0].lastRequestAt).toBe(new Date(clock).toISOString());
  });

  it("declines a merchant no vendor has on file in Enforce mode, and alerts the owner", async () => {
    const a = await account();
    const hook = await addHook(a, "stripe");
    const r = await ask(hook.path, stripeRequest(4_200, { merchant: STRANGER }));
    expect(r.body).toEqual({ approved: false });
    const [d] = await decisions(a.id);
    expect(d).toMatchObject({ decision: "breach", result: "blocked", rules: ["unknown_payee"] });
    expect(await payments(a.id)).toHaveLength(0);
    // The alert is sent after the answer, so it may land a moment later.
    await vi.waitFor(async () => expect(await notices(a.id)).toContain("payment_blocked"));
  });

  it("reads a Stripe event over the API's usual 16 KB cap", async () => {
    const a = await account();
    const hook = await addHook(a, "stripe");
    n++;
    const body = JSON.stringify({
      id: `evt_${n}`,
      type: "issuing_authorization.request",
      livemode: false,
      data: {
        object: {
          id: `iauth_big_${n}`,
          // Stripe sends the card with its spending controls: long category lists.
          card: {
            id: "ic_theirs",
            spending_controls: {
              allowed_categories: Array(1_500).fill("computer_software_stores"),
            },
          },
          pending_request: { amount: 4_200, currency: "usd" },
          merchant_data: { network_id: CLOUD.networkId, name: CLOUD.name, category_code: "7372" },
        },
      },
    });
    expect(body.length).toBeGreaterThan(16 * 1024);
    const sig = createHmac("sha256", STRIPE_SECRET).update(`${seconds}.${body}`).digest("hex");
    const r = await ask(hook.path, {
      body,
      headers: { "Stripe-Signature": `t=${seconds},v1=${sig}` },
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ approved: true });
  });

  it("answers the same charge asked twice the same way, with one decision", async () => {
    const a = await account();
    const hook = await addHook(a, "stripe");
    const first = await ask(hook.path, stripeRequest(4_200, { authId: "iauth_twice" }));
    const again = await ask(hook.path, stripeRequest(4_200, { authId: "iauth_twice" }));
    expect(first.body).toEqual({ approved: true });
    expect(again.body).toEqual({ approved: true });
    expect(await decisions(a.id)).toHaveLength(1);
    expect(await payments(a.id)).toHaveLength(1);
  });

  it("refuses a request it can't prove came from the program, and declines live charges", async () => {
    const a = await account();
    const hook = await addHook(a, "stripe");
    const forged = stripeRequest(4_200);
    forged.headers["Stripe-Signature"] = `t=${seconds},v1=${"0".repeat(64)}`;
    expect((await ask(hook.path, forged)).status).toBe(401);
    const live = await ask(hook.path, stripeRequest(4_200, { livemode: true }));
    expect(live.body).toEqual({ approved: false });
    expect(await decisions(a.id)).toHaveLength(0);
  });

  it("declines when the answer isn't ready in time, and keeps no decision", async () => {
    const a = await account();
    const hook = await addHook(a, "stripe");
    app = makeApi({ budgetMs: 0 });
    try {
      const r = await ask(hook.path, stripeRequest(4_200));
      expect(r.body).toEqual({ approved: false });
      // Give the abandoned transaction a moment to roll back.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await decisions(a.id)).toHaveLength(0);
    } finally {
      await app.close();
      app = makeApi();
    }
  });
});

describe("Lithic asking before a charge", () => {
  it("approves in Lithic's format, and lets a refund to the card through without a decision", async () => {
    const a = await account();
    const hook = await addHook(a, "lithic");
    const req = lithicRequest(4_200);
    const r = await ask(hook.path, req);
    expect(r.body).toEqual({ token: JSON.parse(req.body).token, result: "APPROVED" });
    const credit = await ask(hook.path, lithicRequest(1_000, { status: "CREDIT_AUTHORIZATION" }));
    expect(credit.body.result).toBe("APPROVED");
    expect(await decisions(a.id)).toHaveLength(1);
    const activity = await call("GET", `${a.base}/activity`, undefined, a.session);
    expect(activity.body.items[0].rail).toBe("Lithic card");
    // A status it doesn't know is checked like a charge, never waved through.
    const odd = await ask(
      hook.path,
      lithicRequest(4_200, { status: "SOMETHING_NEW", merchant: STRANGER }),
    );
    expect(odd.body.result).toBe("UNAUTHORIZED_MERCHANT");
    // A $0 check that the card works moves nothing: approved, with nothing to record.
    const zero = await ask(hook.path, lithicRequest(0, { merchant: STRANGER }));
    expect(zero.body.result).toBe("APPROVED");
    expect(await decisions(a.id)).toHaveLength(2);
  });

  it("lets a stranger through in Monitor mode, but never cash or gambling", async () => {
    const a = await account({ mode: "monitor" });
    const hook = await addHook(a, "lithic");
    const stranger = await ask(hook.path, lithicRequest(4_200, { merchant: STRANGER }));
    expect(stranger.body.result).toBe("APPROVED");
    const atm = await ask(hook.path, lithicRequest(2_000, { mcc: "6011" }));
    expect(atm.body.result).toBe("UNAUTHORIZED_MERCHANT");
    const rows = await decisions(a.id);
    expect(rows.map((d) => [d.result, d.rules])).toEqual([
      ["allowed", ["unknown_payee"]],
      ["blocked", ["blocked_merchant"]],
    ]);
  });

  it("declines over the daily limit as a limit, counting earlier approved charges", async () => {
    const a = await account({ maxDailyUsd: 100 });
    const hook = await addHook(a, "lithic");
    expect((await ask(hook.path, lithicRequest(6_000))).body.result).toBe("APPROVED");
    expect((await ask(hook.path, lithicRequest(6_000))).body.result).toBe("VELOCITY_EXCEEDED");
  });
});

describe("Marqeta asking before a charge", () => {
  it("approves with 200 and declines with 402, echoing the funding request with two decimals", async () => {
    const a = await account();
    const hook = await addHook(a, "marqeta");
    const auth = { username: hook.username as string, password: hook.password as string };
    const ok = await ask(hook.path, marqetaRequest(29.7, auth));
    expect(ok.status).toBe(200);
    expect(ok.text).toContain('"amount":29.70');
    expect(ok.body.jit_funding).toMatchObject({
      method: "pgfs.authorization",
      user_token: "user_1",
      acting_user_token: "user_1",
    });
    expect(ok.body.jit_funding.decline_reason).toBeUndefined();
    const no = await ask(hook.path, marqetaRequest(10, auth, { merchant: STRANGER }));
    expect(no.status).toBe(402);
    expect(no.text).toContain('"amount":10.00');
    expect(no.body.jit_funding.decline_reason).toBe("INVALID_MERCHANT");
  });

  it("declines a balance inquiry, since it can't give the card's balances", async () => {
    const a = await account();
    const hook = await addHook(a, "marqeta");
    const auth = { username: hook.username as string, password: hook.password as string };
    const r = await ask(hook.path, marqetaRequest(0.01, auth, { method: "pgfs.balanceinquiry" }));
    expect(r.status).toBe(402);
    expect(await decisions(a.id)).toHaveLength(0);
  });

  it("refuses the wrong password, and declines everything once a breach freezes the account", async () => {
    const a = await account({ freezeOnBreach: true });
    const hook = await addHook(a, "marqeta");
    const auth = { username: hook.username as string, password: hook.password as string };
    expect(
      (await ask(hook.path, marqetaRequest(5, { ...auth, password: `${auth.password}x` }))).status,
    ).toBe(401);
    expect((await ask(hook.path, marqetaRequest(5, auth, { merchant: STRANGER }))).status).toBe(
      402,
    );
    const after = await ask(hook.path, marqetaRequest(5, auth));
    expect(after.status).toBe(402);
    expect(after.body.jit_funding.decline_reason).toBe("TRANSACTION_NOT_PERMITTED");
    expect((await decisions(a.id)).map((d) => d.decision)).toEqual(["breach", "frozen"]);
  });
});
