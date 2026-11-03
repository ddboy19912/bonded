import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ANVIL_KEYS,
  APPROVED_OS_IMAGES,
  DEV_OS_IMAGE_0_5_9,
  type QuoteVerifier,
} from "@bonded/arena";
import { connectChain } from "@bonded/keeper";
import {
  createPayoutServer,
  FakePayoutProvider,
  MockBackend,
  PayoutLedger,
  ProxyIdentity,
} from "@bonded/payout-proxy";
import {
  normalAccount,
  parseEvmDeployment,
  sealPayoutCredential,
  selfServeMessage,
  teeMeasurement,
  verifyGateReceipt,
} from "@bondedhq/shared";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createApi } from "../src/index.js";
import type { GateOptions } from "../src/gate.js";
import { PayoutTee, custodyStatement } from "../src/payout-tee.js";
import { SecretBox } from "../src/secrets.js";
import { postgres } from "./postgres.js";

/**
 * The payout route (gate-payout.ts) against a real payout proxy (services/payout-proxy) run
 * locally with no hardware, as the tee-agent tests run it, and a fake Stripe that moves no money.
 * The proxy's evidence carries a dstack-shaped event log, and a stand-in for Intel's check turns
 * its mock quote into quote facts, so the API's attestation checks (the Arena's verifier, the
 * compose-hash and measurement allowlists, the OS image) run for real. Keys and secrets are
 * throwaway values made for this run.
 */

const TOKEN = "gate-payout-test-token-at-least-24-chars";
const RECEIPT_KEY = generatePrivateKey();
const RECEIPT_SIGNER = privateKeyToAccount(RECEIPT_KEY).address;
const owner = privateKeyToAccount(generatePrivateKey());
const STRIPE_KEY = `rk_test_${randomBytes(24).toString("hex")}`;
const LIVE_KEY = `rk_live_${randomBytes(24).toString("hex")}`;
const EVENTS_SECRET = `whsec_${randomBytes(24).toString("hex")}`;
const FA = "fa_test_65NybHaQx7KJxDc22rZ16NybHIZ4";
// Shaped like Stripe's Global Payouts ids (docs examples), not real objects.
const NIMBUS = "stripe:acct_1Nv0FGQ9RKHgCVdK:usba_test_61Nyd9YFBVUzLyxXZ16Nyc6oZ4SQv89Z";
const FRAUD = "stripe:acct_1Fr4udQ9RKHgCVdK:usba_test_61FraudFBVUzLyxXZ16Nyc6oZ4SQv89Z";
const CODE = `0x${"07".repeat(32)}` as const;
const COMPOSE = "ab".repeat(32);
const OTHER_COMPOSE = "cd".repeat(32);
const PROD_OS = Object.values(APPROVED_OS_IMAGES)[0]!;

const chain = connectChain(
  parseEvmDeployment(
    readFileSync(new URL("../../../contracts/evm/deployments/46630.json", import.meta.url), "utf8"),
  ),
  "http://127.0.0.1:1",
  ANVIL_KEYS.deployer,
);
const chainId = chain.deployment.chainId;

// dstack's event log rules, written from the spec (as the Arena's tests do).
const sha384 = (...parts: (Buffer | string)[]) => {
  const h = createHash("sha384");
  parts.forEach((p) => h.update(p));
  return h.digest();
};
const extend = (digests: Buffer[]) =>
  digests.reduce(
    (mr, d) => sha384(mr, Buffer.concat([d, Buffer.alloc(48 - d.length)])),
    Buffer.alloc(48),
  );
function runtimeEvent(event: string, payloadHex: string) {
  const type = Buffer.alloc(4);
  type.writeUInt32LE(0x08000001);
  return {
    imr: 3,
    event_type: 0x08000001,
    digest: sha384(type, ":", event, ":", Buffer.from(payloadHex, "hex")).toString("hex"),
    event,
    event_payload: payloadHex,
  };
}
const MRTD = "01".repeat(48);

/**
 * A no-hardware backend whose evidence has a dstack-shaped event log: the compose hash and the OS
 * image it "booted" can be set, to show the API refusing a dev image or an unknown deployment.
 */
class LoggedBackend extends MockBackend {
  os = PROD_OS;
  compose = COMPOSE;
  log() {
    return [
      { imr: 0, event_type: 1, digest: "02".repeat(48), event: "", event_payload: "" },
      { imr: 1, event_type: 1, digest: "03".repeat(48), event: "", event_payload: "" },
      { imr: 2, event_type: 1, digest: "04".repeat(48), event: "", event_payload: "" },
      runtimeEvent("compose-hash", this.compose),
      runtimeEvent("os-image-hash", this.os),
    ];
  }
  rtmr(imr: number) {
    return extend(
      this.log()
        .filter((e) => e.imr === imr)
        .map((e) => Buffer.from(e.digest, "hex")),
    ).toString("hex");
  }
  override async quote(reportData: Uint8Array) {
    return { quote: Buffer.from(reportData).toString("hex"), eventLog: JSON.stringify(this.log()) };
  }
  override async composeHash() {
    return this.compose;
  }
}
const backend = new LoggedBackend();
/** Stands in for Intel's verification: the mock quote is the report data. */
const verifyQuote: QuoteVerifier = async (quote) => ({
  status: "UpToDate",
  mrTd: MRTD,
  rtMr0: backend.rtmr(0),
  rtMr1: backend.rtmr(1),
  rtMr2: backend.rtmr(2),
  rtMr3: backend.rtmr(3),
  reportData: `${Buffer.from(quote).toString("hex")}${"0".repeat(64)}`,
});
const MEASUREMENT = teeMeasurement({
  mrTd: MRTD,
  rtMr0: backend.rtmr(0),
  rtMr1: backend.rtmr(1),
  rtMr2: backend.rtmr(2),
  composeHash: COMPOSE,
});

let pg: Awaited<ReturnType<typeof postgres>>;
let app: ReturnType<typeof createApi>;
let provider: FakePayoutProvider;
let identity: ProxyIdentity;
let proxy: Server;
let proxyUrl: string;
const logs: string[] = [];
const proxyLogs: string[] = [];
const responses: string[] = [];
let clock = Date.parse("2026-11-03T10:00:00Z");
const wide = { perClient: 100_000, total: 1_000_000, windowMs: 600_000 };
const secrets = new SecretBox(randomBytes(32));

const tee = (o: Partial<ConstructorParameters<typeof PayoutTee>[0]> = {}) =>
  new PayoutTee({
    url: proxyUrl,
    codeHash: CODE,
    composeHashes: [COMPOSE],
    measurements: [MEASUREMENT],
    verifyQuote,
    ...o,
  });

const makeApi = (payout: GateOptions["payout"] = {}) =>
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
      payout: { tee: tee(), log: (line) => logs.push(line), ...payout },
    },
  });

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(
  method: string,
  path: string,
  body?: unknown,
  auth?: string,
  a: ReturnType<typeof createApi> = app,
): Promise<{ status: number; body: Body }> {
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
  return { status: res.status, body: JSON.parse(text) as Body };
}

let eventCount = 0;
/** A thin Stripe event about an OutboundPayment, signed as Stripe signs. */
async function payoutEvent(
  accountId: string,
  status: "created" | "posted" | "failed" | "returned" | "canceled",
  payoutId: string,
  o: { secret?: string; id?: string } = {},
) {
  eventCount++;
  const payload = JSON.stringify({
    id: o.id ?? `evt_test_${eventCount}`,
    object: "v2.core.event",
    type: `v2.money_management.outbound_payment.${status}`,
    livemode: false,
    created: new Date(clock).toISOString(),
    context: null,
    related_object: {
      id: payoutId,
      type: "v2.money_management.outbound_payment",
      url: `/v2/money_management/outbound_payments/${payoutId}`,
    },
  });
  const at = Math.floor(clock / 1000);
  const signature = `t=${at},v1=${createHmac("sha256", o.secret ?? EVENTS_SECRET)
    .update(`${at}.${payload}`)
    .digest("hex")}`;
  const res = await app.request(`/stripe/payouts/events/${accountId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": signature },
    body: payload,
  });
  const text = await res.text();
  responses.push(text);
  return { status: res.status, body: JSON.parse(text) as Body };
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
 * A gate account with Nimbus in its vendor master (its Stripe recipient and payout method) and
 * invoice NIM-1 approved for $612.40, its payout account linked unless `link` is false.
 */
async function payoutAccount(settings: Record<string, unknown> = {}, link = true) {
  const session = await sessionFor(owner);
  const made = await call(
    "POST",
    "/gate/accounts",
    { name: "Acme AP", mode: "enforce", maxPaymentUsd: 5_000, maxDailyUsd: 8_000, ...settings },
    session,
  );
  expect(made.status).toBe(201);
  const id = made.body.account.id as string;
  const base = `/gate/accounts/${id}`;
  expect(
    (
      await call(
        "POST",
        `${base}/vendors`,
        { id: "nimbus", name: "Nimbus", account: NIMBUS },
        session,
      )
    ).status,
  ).toBe(201);
  expect(
    (
      await call(
        "POST",
        `${base}/invoices`,
        { vendorId: "nimbus", reference: "NIM-1", amountUsd: 612.4 },
        session,
      )
    ).status,
  ).toBe(201);
  if (link) {
    const linked = await call(
      "PUT",
      `${base}/payout-link`,
      { secretKey: STRIPE_KEY, financialAccount: FA, eventsWebhookSecret: EVENTS_SECRET },
      session,
    );
    expect(linked.status).toBe(200);
  }
  return { id, key: made.body.apiKey.key as string, session, base };
}

const pay = (key: string, body: Record<string, unknown> = {}) =>
  call(
    "POST",
    "/payments/payouts",
    { account: NIMBUS, amountUsd: 612.4, invoiceReference: "NIM-1", ...body },
    key,
  );
const paymentsOf = async (accountId: string) =>
  (await pg.db.pool.query("SELECT * FROM gate_payments WHERE account_id=$1", [accountId])).rows;
const decisionsOf = async (accountId: string) =>
  (
    await pg.db.pool.query("SELECT * FROM gate_decisions WHERE account_id=$1 ORDER BY seq", [
      accountId,
    ])
  ).rows;
const notices = async (accountId: string) =>
  (
    await pg.db.pool.query(
      "SELECT type, payload FROM owner_notifications WHERE payload->>'gateAccountId'=$1 ORDER BY id",
      [accountId],
    )
  ).rows as { type: string; payload: Body }[];

async function startProxy() {
  identity = await ProxyIdentity.create(backend, CODE);
  proxy = createPayoutServer({
    identity,
    backendName: "mock",
    provider,
    gateSigner: RECEIPT_SIGNER,
    allowLiveCredentials: false,
    ledger: new PayoutLedger({ maxAgeSeconds: 600, now: () => clock }),
    now: () => clock,
    log: (line) => proxyLogs.push(line),
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  pg = await postgres();
  provider = new FakePayoutProvider();
  await startProxy();
  app = makeApi();
}, 120_000);
afterAll(async () => {
  proxy?.close();
  await app?.close();
  await pg?.stop();
});

describe("the payout proxy's attestation", () => {
  it("is checked, and what it proves is said plainly", async () => {
    const r = await call("GET", "/gate/payout-proxy");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      verified: true,
      production: true,
      measurement: MEASUREMENT,
      composeHash: `0x${COMPOSE}`,
      evmAddress: identity.evmAddress,
      sealPublicKey: identity.sealPublicKey,
      custody: custodyStatement({ production: true }),
    });
    expect(r.body.custody).toMatch(/Bonded staff can't read it/);
    // With no production measurement configured, nothing claims staff can't reach it.
    const plain = makeApi({ tee: tee({ measurements: [] }) });
    const p = await call("GET", "/gate/payout-proxy", undefined, undefined, plain);
    expect(p.body.production).toBe(false);
    expect(p.body.custody).toMatch(/makes no claim that Bonded staff can't reach it/);
    expect(p.body.custody).not.toMatch(/can't read it/);
    await plain.close();
  });

  it("refuses a dev OS image, an unknown deployment and an unknown measurement", async () => {
    const a = await payoutAccount({}, false);
    const link = () =>
      call(
        "PUT",
        `${a.base}/payout-link`,
        { secretKey: STRIPE_KEY, financialAccount: FA, eventsWebhookSecret: EVENTS_SECRET },
        a.session,
      );
    backend.os = DEV_OS_IMAGE_0_5_9;
    try {
      const dev = await link();
      expect(dev.status).toBe(503);
      expect(dev.body.error).toMatch(/not an approved production image/);
      expect((await pay(a.key)).status).toBe(409); // not linked: nothing to pay with
    } finally {
      backend.os = PROD_OS;
    }
    const unknownCompose = makeApi({ tee: tee({ composeHashes: [OTHER_COMPOSE] }) });
    const r1 = await call(
      "PUT",
      `${a.base}/payout-link`,
      { secretKey: STRIPE_KEY, financialAccount: FA, eventsWebhookSecret: EVENTS_SECRET },
      a.session,
      unknownCompose,
    );
    expect(r1.status).toBe(503);
    expect(r1.body.error).toMatch(/not on this service's allowlist/);
    await unknownCompose.close();
    const unknownMeasurement = makeApi({ tee: tee({ measurements: [`0x${"ee".repeat(32)}`] }) });
    const r2 = await call(
      "PUT",
      `${a.base}/payout-link`,
      { secretKey: STRIPE_KEY, financialAccount: FA, eventsWebhookSecret: EVENTS_SECRET },
      a.session,
      unknownMeasurement,
    );
    expect(r2.status).toBe(503);
    expect(r2.body.error).toMatch(/measurement is not on this service's allowlist/);
    await unknownMeasurement.close();
    // A quote that doesn't commit to the proxy's key and the API's challenge is refused too.
    const forged = makeApi({
      tee: tee({
        verifyQuote: async (q) => ({ ...(await verifyQuote(q)), reportData: "00".repeat(64) }),
      }),
    });
    const r3 = await call("GET", "/gate/payout-proxy", undefined, undefined, forged);
    expect(r3.status).toBe(503);
    expect(r3.body.error).toMatch(/does not commit/);
    await forged.close();
    expect(provider.calls).toHaveLength(0);
    expect((await link()).status).toBe(200);
  });

  it("refuses local mode for anything but a proxy on this machine", () => {
    expect(
      () =>
        new PayoutTee({
          url: "https://proxy.example",
          codeHash: CODE,
          composeHashes: [],
          local: true,
        }),
    ).toThrow(/only for a proxy on this machine/);
    expect(
      () =>
        new PayoutTee({ url: "http://proxy.example", codeHash: CODE, composeHashes: [COMPOSE] }),
    ).toThrow(/https/);
  });
});

describe("linking a payout account", () => {
  it("seals the key to the attested proxy and stores only the sealed copy", async () => {
    const a = await payoutAccount();
    const r = await call("GET", `${a.base}/payout-link`, undefined, a.session);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      provider: "stripe",
      keyHint: `${STRIPE_KEY.slice(0, 8)}…${STRIPE_KEY.slice(-4)}`,
      financialAccount: FA,
      livemode: false,
      tee: { sealedTo: identity.sealPublicKey, measurement: MEASUREMENT, production: true },
    });
    const row = (
      await pg.db.pool.query("SELECT * FROM gate_payout_links WHERE account_id=$1", [a.id])
    ).rows[0];
    expect(row.sealed_to).toBe(identity.sealPublicKey);
    expect(JSON.stringify(row)).not.toContain(STRIPE_KEY.slice(8));
    expect(JSON.stringify(row)).not.toContain(EVENTS_SECRET);
    // Only the proxy opens it.
    expect((await identity.open(row.sealed_credential, a.id)).secretKey).toBe(STRIPE_KEY);
  });

  it("takes a credential the owner sealed themselves, to the proxy's key only", async () => {
    const a = await payoutAccount({}, false);
    const proxyInfo = (await call("GET", "/gate/payout-proxy")).body;
    const credential = {
      provider: "stripe" as const,
      gateAccountId: a.id,
      secretKey: STRIPE_KEY,
      financialAccount: FA,
    };
    const sealed = await sealPayoutCredential(credential, proxyInfo.sealPublicKey);
    const r = await call(
      "PUT",
      `${a.base}/payout-link`,
      { sealedCredential: sealed, eventsWebhookSecret: EVENTS_SECRET },
      a.session,
    );
    expect(r.status).toBe(200);
    expect(r.body.keyHint).toBe(`${STRIPE_KEY.slice(0, 8)}…${STRIPE_KEY.slice(-4)}`);
    // Sealed for another account: the proxy can't open it for this one.
    const elsewhere = await sealPayoutCredential(
      { ...credential, gateAccountId: "00000000-0000-4000-8000-000000000000" },
      proxyInfo.sealPublicKey,
    );
    const bad = await call(
      "PUT",
      `${a.base}/payout-link`,
      { sealedCredential: elsewhere, eventsWebhookSecret: EVENTS_SECRET },
      a.session,
    );
    expect(bad.status).toBe(403);
  });

  it("refuses live keys, at the API and at the proxy", async () => {
    const a = await payoutAccount({}, false);
    const r = await call(
      "PUT",
      `${a.base}/payout-link`,
      { secretKey: LIVE_KEY, financialAccount: FA, eventsWebhookSecret: EVENTS_SECRET },
      a.session,
    );
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/test-mode keys only/);
    // An API that allows them still meets the proxy, which doesn't.
    const allowing = makeApi({ allowLiveCredentials: true });
    const p = await call(
      "PUT",
      `${a.base}/payout-link`,
      { secretKey: LIVE_KEY, financialAccount: FA, eventsWebhookSecret: EVENTS_SECRET },
      a.session,
      allowing,
    );
    expect(p.status).toBe(403);
    expect(p.body.error).toMatch(/live credentials are refused/);
    await allowing.close();
    expect((await call("GET", `${a.base}/payout-link`, undefined, a.session)).status).toBe(404);
  });
});

describe("paying out", () => {
  it("pays an allowed invoice through the proxy, once, with a receipt that verifies", async () => {
    const a = await payoutAccount();
    const before = provider.calls.length;
    const r = await pay(a.key, { requestId: "pay-1" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ decision: "pass", result: "allowed", paid: true });
    expect(r.body.payout).toMatchObject({
      status: "processing",
      gateApproved: true,
      amountUsd: 612.4,
      destination: NIMBUS,
      invoiceReference: "NIM-1",
    });
    expect(await verifyGateReceipt(r.body.receipt, RECEIPT_SIGNER)).toBe(true);
    const call0 = provider.calls[before]!;
    expect(call0.secretKey).toBe(STRIPE_KEY);
    expect(call0.request).toMatchObject({
      decisionId: r.body.id,
      amountCents: 61_240,
      destination: {
        recipient: "acct_1Nv0FGQ9RKHgCVdK",
        payoutMethod: "usba_test_61Nyd9YFBVUzLyxXZ16Nyc6oZ4SQv89Z",
      },
    });
    expect(r.body.payout.providerPayoutId).toBe([...provider.payouts.keys()].at(-1));
    // The same request again: the first payout, and nothing more is paid.
    const again = await pay(a.key, { requestId: "pay-1" });
    expect(again.status).toBe(200);
    expect(again.body.payout.id).toBe(r.body.payout.id);
    expect(provider.calls.length).toBe(before + 1);
    // A second ask for the same invoice is a duplicate: blocked, nothing sent.
    const dup = await pay(a.key);
    expect(dup.body).toMatchObject({ result: "blocked", paid: false, payout: null });
    expect(dup.body.rules).toContain("duplicate_payment");
    expect(provider.calls.length).toBe(before + 1);
    const listed = await call("GET", `${a.base}/payouts`, undefined, a.session);
    expect(listed.body.items).toHaveLength(1);
    expect(
      (await call("GET", `/payments/payouts/${r.body.payout.id}`, undefined, a.key)).body,
    ).toMatchObject({ status: "processing" });
  });

  it("blocks a payout to an account outside the vendor master in Enforce mode", async () => {
    const a = await payoutAccount();
    const before = provider.calls.length;
    const r = await pay(a.key, { account: FRAUD });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ result: "blocked", paid: false, payout: null });
    expect(r.body.rules).toContain("unknown_payee");
    expect(provider.calls.length).toBe(before);
    expect(await paymentsOf(a.id)).toHaveLength(0);
  });

  it("fails closed when the proxy is down: nothing checked, recorded or paid", async () => {
    const a = await payoutAccount();
    const down = makeApi({ tee: tee({ url: "http://127.0.0.1:1" }) });
    const before = provider.calls.length;
    const r = await call(
      "POST",
      "/payments/payouts",
      { account: NIMBUS, amountUsd: 612.4, invoiceReference: "NIM-1" },
      a.key,
      down,
    );
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/can't be reached\. Nothing was paid: the gate fails closed/);
    expect(await decisionsOf(a.id)).toHaveLength(0);
    expect(await paymentsOf(a.id)).toHaveLength(0);
    expect(provider.calls.length).toBe(before);
    await down.close();
    // The same in Monitor mode: only the proxy can pay.
    await call("PUT", a.base, { mode: "monitor" }, a.session);
    const down2 = makeApi({ tee: tee({ url: "http://127.0.0.1:1" }) });
    expect(
      (
        await call(
          "POST",
          "/payments/payouts",
          { account: NIMBUS, amountUsd: 612.4, invoiceReference: "NIM-1" },
          a.key,
          down2,
        )
      ).status,
    ).toBe(503);
    await down2.close();
  });

  it("refuses to pay when the proxy was redeployed with another seal key", async () => {
    const a = await payoutAccount();
    await pg.db.pool.query("UPDATE gate_payout_links SET sealed_to=$2 WHERE account_id=$1", [
      a.id,
      `0x04${"11".repeat(64)}`,
    ]);
    const r = await pay(a.key);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/seal key changed/);
    expect(await decisionsOf(a.id)).toHaveLength(0);
  });

  it("releases the invoice when the provider refuses, so it can be paid again", async () => {
    const a = await payoutAccount();
    provider.next = "refuse";
    const r = await pay(a.key);
    expect(r.status).toBe(502);
    expect(r.body.payout).toMatchObject({ status: "not_sent" });
    expect(r.body.payoutMessage).toMatch(/Nothing was paid/);
    expect(await paymentsOf(a.id)).toHaveLength(0);
    const again = await pay(a.key);
    expect(again.status).toBe(201);
    expect(again.body.decision).toBe("pass");
  });

  it("keeps the invoice held when the answer is lost, and a retry finds the same payout", async () => {
    const a = await payoutAccount();
    provider.next = "unknown";
    const r = await pay(a.key, { requestId: "lost-1" });
    expect(r.status).toBe(202);
    expect(r.body.payout.status).toBe("unknown");
    expect(await paymentsOf(a.id)).toHaveLength(1);
    const made = [...provider.payouts.values()].at(-1)!;
    const retry = await pay(a.key, { requestId: "lost-1" });
    expect(retry.status).toBe(200);
    expect(retry.body.payout).toMatchObject({ status: "processing", providerPayoutId: made.id });
    expect([...provider.payouts.values()].filter((p) => p.gateDecision === r.body.id)).toHaveLength(
      1,
    );
  });

  it("forwards a breaking payout in Monitor mode, and records the breach", async () => {
    const a = await payoutAccount({ mode: "monitor" });
    const r = await pay(a.key, { account: FRAUD });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ decision: "breach", result: "allowed", paid: true });
    expect(r.body.payout.destination).toBe(FRAUD);
    await vi.waitFor(async () =>
      expect((await notices(a.id)).map((n) => n.type)).toEqual(["payment_breach"]),
    );
  });
});

describe("the provider's events", () => {
  it("records posted, and releases the invoice when the payout is returned", async () => {
    const a = await payoutAccount();
    const r = await pay(a.key);
    const obp = r.body.payout.providerPayoutId as string;
    const posted = await payoutEvent(a.id, "posted", obp);
    expect(posted.body).toMatchObject({ handled: true, replayed: false });
    expect(
      (await call("GET", `/payments/payouts/${r.body.payout.id}`, undefined, a.key)).body.status,
    ).toBe("posted");
    expect(await paymentsOf(a.id)).toHaveLength(1);
    const returned = await payoutEvent(a.id, "returned", obp, { id: "evt_test_returned" });
    expect(returned.status).toBe(200);
    expect(
      (await call("GET", `/payments/payouts/${r.body.payout.id}`, undefined, a.key)).body.status,
    ).toBe("returned");
    expect(await paymentsOf(a.id)).toHaveLength(0);
    // The same event again changes nothing; a late "posted" doesn't undo the return.
    expect(
      (await payoutEvent(a.id, "returned", obp, { id: "evt_test_returned" })).body.replayed,
    ).toBe(true);
    await payoutEvent(a.id, "posted", obp);
    expect(
      (await call("GET", `/payments/payouts/${r.body.payout.id}`, undefined, a.key)).body.status,
    ).toBe("returned");
    // The invoice can be paid again.
    expect((await pay(a.key)).status).toBe(201);
  });

  it("releases the invoice when a payout fails", async () => {
    const a = await payoutAccount();
    const r = await pay(a.key);
    await payoutEvent(a.id, "failed", r.body.payout.providerPayoutId);
    expect(await paymentsOf(a.id)).toHaveLength(0);
  });

  it("refuses events that aren't signed with the account's secret", async () => {
    const a = await payoutAccount();
    const r = await pay(a.key);
    const bad = await payoutEvent(a.id, "failed", r.body.payout.providerPayoutId, {
      secret: `whsec_${randomBytes(24).toString("hex")}`,
    });
    expect(bad.status).toBe(400);
    expect(await paymentsOf(a.id)).toHaveLength(1);
    // An account with no payout link has no endpoint secret: nothing is accepted for it.
    const unlinked = await payoutAccount({}, false);
    expect((await payoutEvent(unlinked.id, "posted", "obp_test_x")).status).toBe(400);
    expect((await payoutEvent("not-a-uuid", "posted", "obp_test_x")).status).toBe(400);
  });

  it("records a payout the gate never approved as a breach, alerts, and freezes if set", async () => {
    const a = await payoutAccount({ freezeOnBreach: true });
    const outside = provider.outside({
      status: "processing",
      amountCents: 250_000,
      currency: "usd",
      destination: FRAUD,
      gateDecision: null,
      livemode: false,
    });
    const r = await payoutEvent(a.id, "created", outside.id);
    expect(r.body).toMatchObject({ handled: true, replayed: false });
    const [d] = await decisionsOf(a.id);
    expect(d).toMatchObject({ decision: "breach", result: "allowed", payee: normalAccount(FRAUD) });
    expect(d.rules).toEqual(expect.arrayContaining(["unknown_payee"]));
    expect(await verifyGateReceipt(d.receipt, RECEIPT_SIGNER)).toBe(true);
    const payouts = (await call("GET", `${a.base}/payouts`, undefined, a.session)).body.items;
    expect(payouts).toMatchObject([
      { gateApproved: false, providerPayoutId: outside.id, status: "processing" },
    ]);
    expect((await paymentsOf(a.id)).map((p) => p.source)).toEqual(["payout"]);
    expect((await call("GET", a.base, undefined, a.session)).body.frozen).toBe(true);
    await vi.waitFor(async () =>
      expect((await notices(a.id)).map((n) => n.payload.code)).toEqual([
        "gate-payout-bypass",
        "gate-frozen",
      ]),
    );
    // Its later events move that record.
    await payoutEvent(a.id, "posted", outside.id);
    expect(
      (await call("GET", `${a.base}/payouts`, undefined, a.session)).body.items[0].status,
    ).toBe("posted");
  });

  it("alerts and asks Stripe to retry when an unknown payout can't be checked", async () => {
    const a = await payoutAccount();
    const outside = provider.outside({
      status: "processing",
      amountCents: 1_000,
      currency: "usd",
      destination: FRAUD,
      gateDecision: null,
      livemode: false,
    });
    proxy.close();
    proxy.closeAllConnections();
    const before = app;
    try {
      const r = await payoutEvent(a.id, "created", outside.id, { id: "evt_test_unchecked" });
      expect(r.status).toBe(503);
      await vi.waitFor(async () =>
        expect((await notices(a.id)).map((n) => n.payload.code)).toEqual(["gate-payout-unchecked"]),
      );
      expect(await decisionsOf(a.id)).toHaveLength(0);
    } finally {
      // The same deployment back (same keys, so the sealed credential still opens).
      await startProxy();
      app = makeApi();
      await before.close();
    }
    // Stripe's retry is checked.
    const retried = await payoutEvent(a.id, "created", outside.id, { id: "evt_test_unchecked" });
    expect(retried.body.handled).toBe(true);
    expect(await decisionsOf(a.id)).toHaveLength(1);
  });

  it("matches a payout made just before its answer was recorded to its decision", async () => {
    const a = await payoutAccount();
    provider.next = "unknown";
    const r = await pay(a.key);
    expect(r.body.payout.status).toBe("unknown");
    const made = [...provider.payouts.values()].find((p) => p.gateDecision === r.body.id)!;
    await payoutEvent(a.id, "posted", made.id);
    const after = (await call("GET", `/payments/payouts/${r.body.payout.id}`, undefined, a.key))
      .body;
    expect(after).toMatchObject({
      status: "posted",
      providerPayoutId: made.id,
      gateApproved: true,
    });
    expect(await decisionsOf(a.id)).toHaveLength(1);
  });
});

describe("secrets", () => {
  it("never puts the payout key or the events secret in logs, answers, alerts or the database", async () => {
    clock += 1_000;
    const all = [
      ...logs,
      ...proxyLogs,
      ...responses,
      JSON.stringify((await pg.db.pool.query("SELECT * FROM gate_payout_links")).rows),
      JSON.stringify((await pg.db.pool.query("SELECT * FROM gate_payouts")).rows),
      JSON.stringify((await pg.db.pool.query("SELECT * FROM gate_decisions")).rows),
      JSON.stringify((await pg.db.pool.query("SELECT * FROM owner_notifications")).rows),
    ].join("\n");
    expect(logs.length).toBeGreaterThan(0);
    expect(proxyLogs.length).toBeGreaterThan(0);
    for (const secret of [STRIPE_KEY.slice(8), LIVE_KEY.slice(8), EVENTS_SECRET])
      expect(all).not.toContain(secret);
  });
});
