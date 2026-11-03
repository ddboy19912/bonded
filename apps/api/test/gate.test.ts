import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ANVIL_KEYS } from "@bonded/arena";
import { connectChain } from "@bonded/keeper";
import { GateStore } from "@bonded/db";
import {
  evaluateGateInput,
  gateInputHash,
  gateMandateHash,
  parseEvmDeployment,
  selfServeMessage,
  verifyGateReceipt,
  type GateInput,
  type SignedGateReceipt,
} from "@bondedhq/shared";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createApi } from "../src/index.js";
import type { GateOptions } from "../src/gate.js";
import { postgres } from "./postgres.js";

const TOKEN = "gate-test-token-at-least-24-characters";
// Throwaway keys, made for this run.
const RECEIPT_KEY = generatePrivateKey();
const RECEIPT_SIGNER = privateKeyToAccount(RECEIPT_KEY).address;
const owner = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

const chain = connectChain(
  parseEvmDeployment(
    readFileSync(new URL("../../../contracts/evm/deployments/46630.json", import.meta.url), "utf8"),
  ),
  "http://127.0.0.1:1",
  ANVIL_KEYS.deployer,
);
const chainId = chain.deployment.chainId;

const NIMBUS = "GB29 NWBK 6016 1331 9268 19";
const NIMBUS_NEW = "DE89 3704 0044 0532 0130 00";
const FRAUD = "LT12 1000 0111 0100 1000";

let pg: Awaited<ReturnType<typeof postgres>>;
let app: ReturnType<typeof createApi>;
let clock = Date.parse("2026-11-02T10:00:00Z");
const wide = { perClient: 100_000, total: 1_000_000, windowMs: 600_000 };

const makeApi = (gate: GateOptions = { receiptKey: RECEIPT_KEY, maxAccountsPerOwner: 100 }) =>
  createApi({
    db: pg.db,
    chain,
    attesterKey: ANVIL_KEYS.deployer,
    apiToken: TOKEN,
    selfServe: { now: () => clock },
    ownerRequests: { writes: wide, reads: wide },
    gate,
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
  return { status: res.status, body: (await res.json()) as Body };
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
 * A gate account with Nimbus in its vendor master and invoice NIM-1 approved for $612.40.
 * Returns its id, its API key and the owner's session.
 */
async function gateAccount(settings: Record<string, unknown> = {}) {
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
  expect(
    (
      await call(
        "POST",
        `${base}/vendors`,
        { id: "nimbus", name: "Nimbus Cloud", account: NIMBUS },
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
  return { id, key, session, base };
}

const check = (key: string, body: Record<string, unknown>, a = app) =>
  call("POST", "/payments/check", body, key, a);
const pay = (key: string, account: string, amountUsd: number, invoiceReference: string) =>
  check(key, { account, amountUsd, invoiceReference });

beforeAll(async () => {
  pg = await postgres();
  app = makeApi();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

describe("the payment gate: accounts and keys", () => {
  it("publishes the receipt key, and refuses checks without one", async () => {
    const r = await call("GET", "/gate/receipt-key");
    expect(r.status).toBe(200);
    expect(r.body.address).toBe(RECEIPT_SIGNER);
    expect(r.body.primaryType).toBe("GateReceipt");

    const bare = makeApi({});
    const { key } = await gateAccount();
    expect((await call("GET", "/gate/receipt-key", undefined, undefined, bare)).status).toBe(503);
    const refused = await check(
      key,
      { account: NIMBUS, amountUsd: 612.4, invoiceReference: "NIM-1" },
      bare,
    );
    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe("gate-receipt-key-missing");
    await bare.close();
  });

  it("makes accounts only for a signed-in owner, and hides them from other wallets", async () => {
    const anonymous = await call("POST", "/gate/accounts", { maxPaymentUsd: 1, maxDailyUsd: 1 });
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.code).toBe("not-signed-in");

    const { id, base, session } = await gateAccount();
    const view = await call("GET", base, undefined, session);
    expect(view.body).toMatchObject({
      id,
      mode: "enforce",
      maxPaymentUsd: 5000,
      maxDailyUsd: 8000,
      frozen: false,
      mandate: { version: 2 },
    });
    expect(view.body.rules).toContain("No single payment over $5,000.");

    const other = await sessionFor(stranger);
    for (const path of [base, `${base}/vendors`, `${base}/decisions`, `${base}/keys`]) {
      const r = await call("GET", path, undefined, other);
      expect(r.status).toBe(404);
      expect(r.body.code).toBe("gate-not-found");
    }
    expect((await call("PUT", base, { mode: "monitor" }, other)).status).toBe(404);
    expect((await call("GET", "/gate/accounts", undefined, other)).body.items).toEqual([]);
  });

  it("stores only a key's hash, and a revoked key stops working at once", async () => {
    const { id, key, base, session } = await gateAccount();
    const stored = await pg.db.pool.query(
      "SELECT key_hash, prefix FROM gate_api_keys WHERE account_id=$1",
      [id],
    );
    expect(JSON.stringify(stored.rows)).not.toContain(key);
    expect(stored.rows[0].prefix).toBe(key.slice(0, 14));

    const none = await call("POST", "/payments/check", {
      account: NIMBUS,
      amountUsd: 1,
      invoiceReference: "X",
    });
    expect(none.status).toBe(401);
    expect(none.body.code).toBe("gate-key-missing");
    const wrong = await check(`bonded_gk_${"A".repeat(43)}`, {
      account: NIMBUS,
      amountUsd: 1,
      invoiceReference: "X",
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe("gate-key-invalid");

    const second = await call("POST", `${base}/keys`, { label: "second agent" }, session);
    expect(second.status).toBe(201);
    expect(second.body.key).toMatch(/^bonded_gk_[A-Za-z0-9_-]{43}$/);
    const keys = await call("GET", `${base}/keys`, undefined, session);
    expect(keys.body.items).toHaveLength(2);
    expect(JSON.stringify(keys.body)).not.toContain(second.body.key);

    expect(
      (await call("DELETE", `${base}/keys/${second.body.id}`, undefined, session)).status,
    ).toBe(200);
    const revoked = await pay(second.body.key, NIMBUS, 612.4, "NIM-1");
    expect(revoked.status).toBe(401);
    expect((await pay(key, NIMBUS, 612.4, "NIM-1")).body.result).toBe("allowed");
  });
});

describe("the payment gate: checks", () => {
  it("passes an approved invoice with a receipt anyone can check offline", async () => {
    const { key, base, session } = await gateAccount();
    const r = await pay(key, "gb29nwbk60161331926819", 612.4, " nim-1 ");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      decision: "pass",
      result: "allowed",
      allowed: true,
      rules: [],
      amountUsd: 612.4,
      vendorId: "nimbus",
      reference: "nim-1",
      payee: "GB29NWBK60161331926819",
    });
    const signed = r.body.receipt as SignedGateReceipt;
    expect(signed.signer).toBe(RECEIPT_SIGNER);
    expect(await verifyGateReceipt(signed, RECEIPT_SIGNER)).toBe(true);
    expect(
      await verifyGateReceipt({ ...signed, receipt: { ...signed.receipt, amountCents: 1 } }),
    ).toBe(false);
    // The input it returns is the one it hashed and checked: rerun it and get the same answer.
    const input = r.body.input as GateInput;
    expect(gateInputHash(input)).toBe(signed.receipt.inputHash);
    expect(r.body.inputHash).toBe(signed.receipt.inputHash);
    expect(evaluateGateInput(input)).toMatchObject({ ok: true, rules: [] });
    // Checked against the mandate as it stood, by its hash and version.
    const account = (await call("GET", base, undefined, session)).body;
    expect(signed.receipt.mandateHash).toBe(account.mandate.hash);
    expect(signed.receipt.mandateVersion).toBe(account.mandate.version);
    const versions = (await call("GET", `${base}/mandates`, undefined, session)).body.items;
    expect(gateMandateHash(versions[0].mandate)).toBe(account.mandate.hash);
    // The payment is recorded.
    const payments = (await call("GET", `${base}/payments`, undefined, session)).body.items;
    expect(payments).toMatchObject([
      { source: "check", vendorId: "nimbus", amountCents: 61240, day: "2026-11-02" },
    ]);
  });

  it("blocks each rule in Enforce mode and records nothing as paid", async () => {
    const { key, base, session } = await gateAccount({ maxPaymentUsd: 1_000, maxDailyUsd: 1_500 });
    for (const [reference, amountUsd] of [
      ["NIM-2", 2_500],
      ["NIM-3", 700],
      ["NIM-4", 300],
    ] as const)
      await call("POST", `${base}/invoices`, { vendorId: "nimbus", reference, amountUsd }, session);
    const rulesOf = async (account: string, amountUsd: number, reference: string) => {
      const r = await pay(key, account, amountUsd, reference);
      expect(r.status).toBe(200);
      return { rules: r.body.rules, result: r.body.result };
    };
    // A stranger's account: unknown payee, and the vendor's invoice doesn't match it.
    expect(await rulesOf(FRAUD, 612.4, "NIM-1")).toEqual({
      rules: ["unknown_payee", "unmatched_invoice"],
      result: "blocked",
    });
    // An inflated amount, and a reference nobody approved.
    expect((await rulesOf(NIMBUS, 612.41, "NIM-1")).rules).toEqual(["unmatched_invoice"]);
    expect((await rulesOf(NIMBUS, 50, "NIM-404")).rules).toEqual(["unmatched_invoice"]);
    // Over the per-payment limit, even though the invoice is approved.
    expect((await rulesOf(NIMBUS, 2_500, "NIM-2")).rules).toEqual([
      "over_payment_cap",
      "over_daily_cap",
    ]);
    // Paid once, then a duplicate.
    expect(await rulesOf(NIMBUS, 612.4, "NIM-1")).toEqual({ rules: [], result: "allowed" });
    expect((await rulesOf(NIMBUS, 612.4, "NIM-1")).rules).toEqual(["duplicate_payment"]);
    // 612.40 + 700 = 1,312.40 is under the daily 1,500; 300 more is over.
    expect((await rulesOf(NIMBUS, 700, "NIM-3")).result).toBe("allowed");
    expect((await rulesOf(NIMBUS, 300, "NIM-4")).rules).toEqual(["over_daily_cap"]);
    // Only the two payments that passed were recorded.
    const payments = (await call("GET", `${base}/payments`, undefined, session)).body.items;
    expect(payments.map((p: Body) => p.reference).sort()).toEqual(["NIM-1", "NIM-3"]);
    // The next UTC day starts a new daily total.
    clock += 86_400_000;
    try {
      expect((await rulesOf(NIMBUS, 300, "NIM-4")).result).toBe("allowed");
    } finally {
      clock -= 86_400_000;
    }
  });

  it("allows a bank change only with a verified ticket, which makes a new mandate version", async () => {
    const { key, base, session } = await gateAccount();
    await call(
      "POST",
      `${base}/invoices`,
      { vendorId: "nimbus", reference: "NIM-9", amountUsd: 90 },
      session,
    );
    const unverified = await check(key, {
      kind: "bank_change",
      vendorId: "nimbus",
      account: NIMBUS_NEW,
      ticket: "FIN-1",
    });
    expect(unverified.body).toMatchObject({
      rules: ["unverified_vendor_change"],
      result: "blocked",
      amountUsd: 0,
    });
    expect(
      (await check(key, { kind: "bank_change", vendorId: "nobody", account: NIMBUS_NEW })).status,
    ).toBe(404);

    const before = (await call("GET", base, undefined, session)).body.mandate;
    const ticket = await call(
      "POST",
      `${base}/tickets`,
      {
        id: "FIN-1",
        vendorId: "nimbus",
        account: NIMBUS_NEW,
        verifiedBy: "called the number on file",
      },
      session,
    );
    expect(ticket.status).toBe(201);
    const verified = await check(key, {
      kind: "bank_change",
      vendorId: "nimbus",
      account: NIMBUS_NEW,
    });
    expect(verified.body).toMatchObject({ decision: "pass", result: "allowed" });
    expect(verified.body.mandate).toEqual(before);
    const after = (await call("GET", base, undefined, session)).body.mandate;
    expect(after.version).toBe(before.version + 1);
    expect(after.hash).not.toBe(before.hash);
    const history = (await call("GET", `${base}/mandates`, undefined, session)).body.items;
    expect(history[0]).toMatchObject({
      version: after.version,
      createdBy: `bank_change:${verified.body.id}`,
    });
    // The new account is now the vendor's; the old one is a stranger's.
    expect((await pay(key, NIMBUS_NEW, 90, "NIM-9")).body.result).toBe("allowed");
    expect((await pay(key, NIMBUS, 612.4, "NIM-1")).body.rules).toContain("unknown_payee");
  });

  it("checks refunds against the approved queue", async () => {
    const { key, base, session } = await gateAccount();
    const refund = await call(
      "POST",
      `${base}/refunds`,
      {
        reference: "R-77",
        name: "J. Doe",
        account: "FR14 2004 1010 0505 0001 3M02 606",
        amountUsd: 49.99,
      },
      session,
    );
    expect(refund.status).toBe(201);
    const ok = await check(key, {
      kind: "refund",
      account: "FR1420041010050500013M02606",
      amountUsd: 49.99,
      invoiceReference: "r-77",
    });
    expect(ok.body).toMatchObject({ kind: "refund", result: "allowed", vendorId: null });
    const again = await check(key, {
      kind: "refund",
      account: "FR1420041010050500013M02606",
      amountUsd: 49.99,
      invoiceReference: "R-77",
    });
    expect(again.body.rules).toEqual(["duplicate_payment"]);
    const elsewhere = await check(key, {
      kind: "refund",
      account: FRAUD,
      amountUsd: 49.99,
      invoiceReference: "R-77",
    });
    expect(elsewhere.body.rules).toEqual(["unknown_payee", "unmatched_invoice"]);
  });

  it("lets a breach through in Monitor mode, records it, and counts it toward the day", async () => {
    const { key, base, session } = await gateAccount({ mode: "monitor", maxDailyUsd: 1_000 });
    const fraud = await pay(key, FRAUD, 612.4, "NIM-1");
    expect(fraud.body).toMatchObject({
      decision: "breach",
      result: "allowed",
      allowed: true,
      mode: "monitor",
      rules: ["unknown_payee", "unmatched_invoice"],
      lossUsd: 612.4,
    });
    expect(fraud.body.message).toMatch(/^Allowed in Monitor mode, but it broke the mandate/);
    // The stranger's payment doesn't settle Nimbus's invoice, but it does count toward the day.
    expect((await pay(key, NIMBUS, 612.4, "NIM-1")).body.rules).toEqual(["over_daily_cap"]);
    const payments = (await call("GET", `${base}/payments`, undefined, session)).body.items;
    expect(payments).toHaveLength(2);
    await vi.waitFor(async () => {
      const n = await pg.db.pool.query(
        "SELECT type FROM owner_notifications WHERE payload->>'gateAccountId'=$1 ORDER BY id",
        [base.split("/").at(-1)],
      );
      expect(n.rows.map((r) => r.type)).toEqual(["payment_breach", "payment_breach"]);
    });
  });

  it("freezes on a breach when set, refuses every check until the owner lifts it, and alerts", async () => {
    const { id, key, base, session } = await gateAccount({ freezeOnBreach: true });
    const breach = await pay(key, FRAUD, 612.4, "NIM-1");
    expect(breach.body).toMatchObject({ result: "blocked", frozen: true });
    const refused = await pay(key, NIMBUS, 612.4, "NIM-1");
    expect(refused.body).toMatchObject({
      decision: "frozen",
      result: "refused",
      allowed: false,
      rules: [],
      frozen: true,
    });
    expect(await verifyGateReceipt(refused.body.receipt, RECEIPT_SIGNER)).toBe(true);
    expect((await call("GET", base, undefined, session)).body).toMatchObject({
      frozen: true,
      frozenBy: breach.body.id,
    });
    await vi.waitFor(async () => {
      const n = await pg.db.pool.query(
        "SELECT type, payload->>'code' AS code FROM owner_notifications WHERE owner=$1 AND payload->>'gateAccountId'=$2 ORDER BY type",
        [owner.address.toLowerCase(), id],
      );
      // Both are sent at once, so either may be recorded first.
      expect(n.rows).toEqual([
        { type: "gate_frozen", code: "gate-frozen" },
        { type: "payment_blocked", code: "gate-payment-blocked" },
      ]);
    });
    const inbox = await call("GET", "/self/notifications/inbox", undefined, session);
    expect(inbox.body.items.find((i: Body) => i.type === "gate_frozen")?.gateAccountId).toBe(id);

    const lifted = await call("POST", `${base}/unfreeze`, {}, session);
    expect(lifted.body.frozen).toBe(false);
    expect((await pay(key, NIMBUS, 612.4, "NIM-1")).body.result).toBe("allowed");
  });

  it("lets only one of many simultaneous checks of the same invoice pass", async () => {
    const { key, base, session } = await gateAccount();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => pay(key, NIMBUS, 612.4, "NIM-1")),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => r.body.result === "allowed")).toHaveLength(1);
    const blocked = results.filter((r) => r.body.result === "blocked");
    expect(blocked).toHaveLength(11);
    expect(blocked.every((r) => r.body.rules.join() === "duplicate_payment")).toBe(true);
    expect((await call("GET", `${base}/payments`, undefined, session)).body.items).toHaveLength(1);
  });

  it("keeps the day's total right under simultaneous checks", async () => {
    const { key, base, session } = await gateAccount({ maxDailyUsd: 1_000 });
    const refs = ["D-1", "D-2", "D-3", "D-4", "D-5"];
    for (const reference of refs)
      await call(
        "POST",
        `${base}/invoices`,
        { vendorId: "nimbus", reference, amountUsd: 300 },
        session,
      );
    const results = await Promise.all(refs.map((ref) => pay(key, NIMBUS, 300, ref)));
    expect(results.filter((r) => r.body.result === "allowed")).toHaveLength(3);
    expect(results.filter((r) => r.body.rules.join() === "over_daily_cap")).toHaveLength(2);
  });

  it("answers a repeated request id with the first decision, and refuses it for another check", async () => {
    const { key, base, session } = await gateAccount();
    const body = {
      account: NIMBUS,
      amountUsd: 612.4,
      invoiceReference: "NIM-1",
      requestId: "pay-001",
    };
    const first = await check(key, body);
    const again = await check(key, body);
    expect(first.body.result).toBe("allowed");
    expect(again.body).toMatchObject({ id: first.body.id, result: "allowed", replayed: true });
    expect(again.body.receipt).toEqual(first.body.receipt);
    const reused = await check(key, { ...body, amountUsd: 612.41 });
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe("gate-request-reused");
    // The meter counts the check once.
    const usage = await call("GET", `${base}/usage`, undefined, session);
    expect(usage.body).toEqual({ items: [{ day: "2026-11-02", checks: 1 }], total: 1 });
  });

  it("counts imported payments toward duplicates", async () => {
    const { key, base, session } = await gateAccount();
    const imported = await call(
      "POST",
      `${base}/payments`,
      { account: NIMBUS, amountUsd: 612.4, reference: "NIM-1", day: "2026-10-30" },
      session,
    );
    expect(imported.status).toBe(201);
    expect(imported.body).toMatchObject({ source: "import", vendorId: "nimbus" });
    expect((await pay(key, NIMBUS, 612.4, "NIM-1")).body.rules).toEqual(["duplicate_payment"]);
    const future = await call(
      "POST",
      `${base}/payments`,
      { account: NIMBUS, amountUsd: 1, reference: "X", day: "2026-11-03" },
      session,
    );
    expect(future.status).toBe(400);
    expect(future.body.code).toBe("gate-future-payment");
  });

  it("versions the mandate on every change, and not when nothing changed", async () => {
    const { key, base, session } = await gateAccount();
    const v2 = (await call("GET", base, undefined, session)).body.mandate;
    const same = await call("PUT", base, { maxPaymentUsd: 5_000, name: "Renamed" }, session);
    expect(same.body.mandate).toEqual(v2);
    const changed = await call("PUT", base, { maxPaymentUsd: 400 }, session);
    expect(changed.body.mandate.version).toBe(v2.version + 1);
    const history = (await call("GET", `${base}/mandates`, undefined, session)).body.items;
    expect(history.map((v: Body) => v.version)).toEqual([3, 2, 1]);
    expect(history[0].rules).toContain("No single payment over $400.");
    expect(new Set(history.map((v: Body) => v.hash)).size).toBe(3);
    const r = await pay(key, NIMBUS, 612.4, "NIM-1");
    expect(r.body.rules).toEqual(["over_payment_cap"]);
    expect(r.body.receipt.receipt.mandateVersion).toBe(3);
  });

  it("refuses malformed checks and limits checks per account", async () => {
    const { key } = await gateAccount();
    for (const body of [
      { account: NIMBUS, amountUsd: 0, invoiceReference: "NIM-1" },
      { account: NIMBUS, amountUsd: 1.001, invoiceReference: "NIM-1" },
      { account: NIMBUS, amountUsd: 1, invoiceReference: "  " },
      { account: NIMBUS, amountUsd: 1, invoiceReference: "NIM-1", extra: true },
      { kind: "bank_change", account: NIMBUS },
    ])
      expect((await check(key, body)).status).toBe(400);

    const tight = makeApi({
      receiptKey: RECEIPT_KEY,
      checksPerMinute: 2,
      maxAccountsPerOwner: 100,
    });
    const one = { account: NIMBUS, amountUsd: 1, invoiceReference: "NIM-404" };
    expect((await check(key, one, tight)).status).toBe(200);
    expect((await check(key, one, tight)).status).toBe(200);
    const limited = await check(key, one, tight);
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("gate-check-limit");
    await tight.close();
  });
});

describe("the payment gate: the decision log", () => {
  it("lists an account's decisions newest first, in pages, and only to that account", async () => {
    const { key, base, session } = await gateAccount();
    const made: string[] = [];
    for (const reference of ["L-1", "L-2", "L-3"])
      made.push((await pay(key, NIMBUS, 10, reference)).body.id);
    const first = await call("GET", "/payments/decisions?limit=2", undefined, key);
    expect(first.body.items.map((d: Body) => d.id)).toEqual([made[2], made[1]]);
    const second = await call(
      "GET",
      `/payments/decisions?limit=2&before=${first.body.next}`,
      undefined,
      key,
    );
    expect(second.body.items.map((d: Body) => d.id)).toEqual([made[0]]);
    expect(second.body.next).toBeNull();
    // Filter by result; the owner sees the same log.
    const blocked = await call("GET", "/payments/decisions?result=blocked", undefined, key);
    expect(blocked.body.items).toHaveLength(3);
    const owners = await call("GET", `${base}/decisions?limit=1`, undefined, session);
    expect(owners.body.items[0].id).toBe(made[2]);

    const one = await call("GET", `/payments/decisions/${made[0]}`, undefined, key);
    expect(one.body).toMatchObject({ id: made[0], rules: ["unmatched_invoice"], reference: "L-1" });
    expect(await verifyGateReceipt(one.body.receipt, RECEIPT_SIGNER)).toBe(true);
    // Another account's key can't read it.
    const other = await gateAccount();
    const hidden = await call("GET", `/payments/decisions/${made[0]}`, undefined, other.key);
    expect(hidden.status).toBe(404);
    expect((await call("GET", "/payments/decisions", undefined, other.key)).body.items).toEqual([]);
  });

  it("drops decisions past the retention window and keeps the payments", async () => {
    const { id, key } = await gateAccount();
    const old = await pay(key, NIMBUS, 612.4, "NIM-1");
    const recent = await pay(key, FRAUD, 5, "NIM-1");
    await pg.db.pool.query(
      "UPDATE gate_decisions SET created_at=now() - interval '400 days' WHERE id=$1",
      [old.body.id],
    );
    const store = new GateStore(pg.db, gateMandateHash);
    const cutoff = new Date(Date.now() - 365 * 86_400_000);
    expect(await store.pruneDecisions(cutoff, 1)).toBeGreaterThanOrEqual(1);
    expect(await store.decision(id, old.body.id)).toBeUndefined();
    expect(await store.decision(id, recent.body.id)).toBeDefined();
    const payments = await pg.db.pool.query(
      "SELECT decision_id FROM gate_payments WHERE account_id=$1",
      [id],
    );
    expect(payments.rows).toEqual([{ decision_id: null }]);
    // Each pruned decision clears its payment's decision_id: an index keeps that from scanning
    // every payment ever made.
    const indexed = await pg.db.pool.query(
      "SELECT 1 FROM pg_indexes WHERE tablename='gate_payments' AND indexdef LIKE '%(decision_id)'",
    );
    expect(indexed.rowCount).toBe(1);
    // The payment still counts: paying the invoice again is a duplicate.
    expect((await pay(key, NIMBUS, 612.4, "NIM-1")).body.rules).toEqual(["duplicate_payment"]);
    await expect(store.pruneDecisions(cutoff, 0)).rejects.toThrow(RangeError);
  });
});
