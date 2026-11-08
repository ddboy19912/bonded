import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ANVIL_KEYS } from "@bonded/arena";
import { connectChain } from "@bonded/keeper";
import { GateBudgetStore, GateStore, GateWatchStore } from "@bonded/db";
import {
  evaluateGateInput,
  gateInputHash,
  gateMandateHash,
  parseEvmDeployment,
  selfServeMessage,
  verifyGateReceipt,
  type GateInput,
} from "@bondedhq/shared";
import { createApi } from "../src/index.js";
import { BUDGET_REPORT_GRACE_MS, sweepBudgets } from "../src/gate-budget.js";
import { GateWatcher, type WalletReader } from "../src/gate-watch.js";
import { Notifier } from "../src/notifications.js";
import { postgres } from "./postgres.js";

const TOKEN = "gate-test-token-at-least-24-characters";
const RECEIPT_KEY = generatePrivateKey();
const RECEIPT_SIGNER = privateKeyToAccount(RECEIPT_KEY).address;
const owner = privateKeyToAccount(generatePrivateKey());
const chain = connectChain(
  parseEvmDeployment(
    readFileSync(new URL("../../../contracts/evm/deployments/46630.json", import.meta.url), "utf8"),
  ),
  "http://127.0.0.1:1",
  ANVIL_KEYS.deployer,
);
const chainId = chain.deployment.chainId;

const API = getAddress(`0x${"d1".repeat(20)}`);
const STRANGER = getAddress(`0x${"e1".repeat(20)}`);
const WALLET = getAddress(`0x${"a1".repeat(20)}`);
const BASE = 8453;

let pg: Awaited<ReturnType<typeof postgres>>;
let app: ReturnType<typeof createApi>;
const start = Date.parse("2026-11-08T10:00:00Z");
let clock = start;
const wide = { perClient: 100_000, total: 1_000_000, windowMs: 600_000 };
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: string, path: string, body?: unknown, auth?: string) {
  const res = await app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Body };
}

let session: string;
/** A gate account with invoice matching off and the API's address on the vendor list. */
async function gateAccount(settings: Record<string, unknown> = {}) {
  const made = await call(
    "POST",
    "/gate/accounts",
    { name: "Agent", mode: "enforce", maxPaymentUsd: 1, maxDailyUsd: 20 },
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
        { id: "weather", name: "Weather API", account: API },
        session,
      )
    ).status,
  ).toBe(201);
  const r = await call("PUT", base, { invoiceMatching: false, ...settings }, session);
  expect(r.status).toBe(200);
  return { id, key, base };
}

const spend = (id: string, amountMicros: number, at = clock, reference = "") => ({
  id,
  amountMicros,
  reference,
  at: new Date(at).toISOString(),
});
const reserved = async (accountId: string) =>
  (
    await pg.db.pool.query(
      "SELECT amount_cents FROM gate_payments WHERE account_id=$1 AND source='budget'",
      [accountId],
    )
  ).rows.map((r) => Number(r.amount_cents));
const alerts = async (id: string) =>
  (
    await pg.db.pool.query(
      "SELECT type FROM owner_notifications WHERE payload->>'gateAccountId'=$1 ORDER BY type",
      [id],
    )
  ).rows.map((r) => r.type as string);
const deps = () => ({
  db: pg.db,
  store: new GateStore(pg.db, gateMandateHash),
  budgets: new GateBudgetStore(pg.db),
  receiptKey: RECEIPT_KEY,
  now: () => clock,
});

beforeAll(async () => {
  pg = await postgres();
  app = createApi({
    db: pg.db,
    chain,
    attesterKey: ANVIL_KEYS.deployer,
    apiToken: TOKEN,
    selfServe: { now: () => clock },
    ownerRequests: { writes: wide, reads: wide },
    gate: {
      receiptKey: RECEIPT_KEY,
      maxAccountsPerOwner: 100,
      watchChains: [BASE],
      notifier: new Notifier(pg.db, { log: () => {} }),
    },
  });
  const timestamp = Math.floor(clock / 1000);
  const signature = await owner.signMessage({
    message: selfServeMessage({ action: "sign-in", chainId, wallet: owner.address, timestamp }),
  });
  const r = await call("POST", "/self/session", { wallet: owner.address, timestamp, signature });
  expect(r.status).toBe(201);
  session = r.body.session as string;
}, 120_000);
afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

describe("budgets", () => {
  it("opens with a signed receipt whose input commits to the terms, and reserves the budget", async () => {
    clock = start;
    const { id, key } = await gateAccount({ maxPaymentsPerHour: 100 });
    const r = await call(
      "POST",
      "/payments/budgets",
      { account: API, amountUsd: 2, maxPaymentUsd: 0.01 },
      key,
    );
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      kind: "budget",
      decision: "pass",
      result: "allowed",
      amountUsd: 2,
    });
    expect(r.body.budget).toMatchObject({
      budgetUsd: 2,
      maxPaymentUsd: 0.01,
      maxPayments: 100,
      spentUsd: 0,
      open: true,
      expiresAt: new Date(start + 3_600_000).toISOString(),
    });
    expect(await verifyGateReceipt(r.body.receipt, RECEIPT_SIGNER)).toBe(true);
    const input = r.body.input as GateInput;
    expect(gateInputHash(input)).toBe(r.body.receipt.receipt.inputHash);
    expect(evaluateGateInput(input)).toMatchObject({ ok: true, rules: [] });
    expect(input).toMatchObject({ terms: { budgetMicros: 2_000_000, maxPaymentMicros: 10_000 } });
    expect(await reserved(id)).toEqual([200]);
  });

  it("Enforce blocks a budget for an unlisted payee or past the daily limit; nothing is reserved", async () => {
    clock = start;
    const { id, key } = await gateAccount();
    const stranger = await call(
      "POST",
      "/payments/budgets",
      { account: STRANGER, amountUsd: 1 },
      key,
    );
    expect(stranger.body).toMatchObject({
      result: "blocked",
      rules: ["unknown_payee"],
      budget: null,
    });
    const big = await call("POST", "/payments/budgets", { account: API, amountUsd: 25 }, key);
    expect(big.body).toMatchObject({ result: "blocked", rules: ["over_daily_cap"] });
    expect(await reserved(id)).toEqual([]);
    await expect.poll(() => alerts(id)).toEqual(["payment_blocked", "payment_blocked"]);
  });

  it("needs invoice matching off", async () => {
    const { key, base } = await gateAccount();
    await call("PUT", base, { invoiceMatching: true }, session);
    const r = await call("POST", "/payments/budgets", { account: API, amountUsd: 1 }, key);
    expect(r.status).toBe(409);
  });

  it("the same request id gives back the first budget", async () => {
    clock = start;
    const { key } = await gateAccount();
    const ask = { account: API, amountUsd: 1, requestId: "b-1" };
    const first = await call("POST", "/payments/budgets", ask, key);
    const again = await call("POST", "/payments/budgets", ask, key);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      id: first.body.id,
      replayed: true,
      budget: { id: first.body.id },
    });
    const other = await call("POST", "/payments/budgets", { ...ask, amountUsd: 2 }, key);
    expect(other.status).toBe(409);
  });

  it("records sub-cent payments exactly, once each, and closes with a receipt over every one", async () => {
    clock = start;
    const { id, key } = await gateAccount();
    const opened = (await call("POST", "/payments/budgets", { account: API, amountUsd: 1 }, key))
      .body;
    const path = `/payments/budgets/${opened.id}`;
    const report = await call(
      "POST",
      `${path}/spends`,
      { spends: [spend("s1", 1_000, clock, "0xaaa"), spend("s2", 2_500), spend("s3", 1_000)] },
      key,
    );
    expect(report.body).toMatchObject({
      recorded: 3,
      repeated: 0,
      problems: [],
      budget: { spentUsd: 0.0045, payments: 3 },
    });
    const again = await call("POST", `${path}/spends`, { spends: [spend("s1", 1_000)] }, key);
    expect(again.body).toMatchObject({ recorded: 0, repeated: 1, budget: { payments: 3 } });

    const detail = await call("GET", path, undefined, key);
    expect(detail.body.spends.map((s: Body) => [s.id, s.amountUsd])).toEqual([
      ["s1", 0.001],
      ["s2", 0.0025],
      ["s3", 0.001],
    ]);

    const closed = await call("POST", `${path}/close`, undefined, key);
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({
      kind: "budget_close",
      decision: "pass",
      amountUsd: 0.01,
      reference: opened.id,
      budget: { open: false, closeDecision: closed.body.id },
    });
    expect(await verifyGateReceipt(closed.body.receipt, RECEIPT_SIGNER)).toBe(true);
    const input = closed.body.input as GateInput;
    expect(gateInputHash(input)).toBe(closed.body.receipt.receipt.inputHash);
    expect(input).toMatchObject({
      spends: [{ id: "s1", amountMicros: 1_000, reference: "0xaaa" }, { id: "s2" }, { id: "s3" }],
    });
    // The reservation is now what was spent, rounded up to the cent.
    expect(await reserved(id)).toEqual([1]);
    // Closing again gives back the same close; a closed budget takes no more payments.
    expect((await call("POST", `${path}/close`, undefined, key)).body.id).toBe(closed.body.id);
    expect((await call("POST", `${path}/spends`, { spends: [spend("s4", 1)] }, key)).status).toBe(
      409,
    );
  });

  it("a payment that breaks the terms is recorded, alerts, freezes, and makes the close a breach", async () => {
    clock = start;
    const { id, key } = await gateAccount({ freezeOnBreach: true });
    const opened = (
      await call(
        "POST",
        "/payments/budgets",
        { account: API, amountUsd: 0.05, maxPaymentUsd: 0.01 },
        key,
      )
    ).body;
    const path = `/payments/budgets/${opened.id}`;
    const r = await call(
      "POST",
      `${path}/spends`,
      { spends: [spend("ok", 5_000), spend("big", 20_000)] },
      key,
    );
    expect(r.body).toMatchObject({
      recorded: 2,
      problems: [{ id: "big", problem: "it is over the per-payment limit" }],
      frozen: true,
    });
    await expect.poll(() => alerts(id)).toEqual(["gate_frozen", "payment_breach"]);
    const closed = await call("POST", `${path}/close`, undefined, key);
    expect(closed.body).toMatchObject({
      decision: "breach",
      rules: ["over_budget"],
      amountUsd: 0.03,
    });
    // A frozen account gets no new budget.
    const next = await call("POST", "/payments/budgets", { account: API, amountUsd: 0.05 }, key);
    expect(next.body).toMatchObject({ decision: "frozen", result: "refused", budget: null });
  });

  it("refuses payments dated in the future", async () => {
    clock = start;
    const { key } = await gateAccount();
    const opened = (await call("POST", "/payments/budgets", { account: API, amountUsd: 1 }, key))
      .body;
    const r = await call(
      "POST",
      `/payments/budgets/${opened.id}/spends`,
      { spends: [spend("later", 1_000, clock + 3_600_000)] },
      key,
    );
    expect(r.status).toBe(400);
  });

  it("the hourly limit counts open budgets' payments, and each reported payment", async () => {
    clock = start;
    const { key } = await gateAccount({ maxPaymentsPerHour: 3 });
    const first = (await call("POST", "/payments/budgets", { account: API, amountUsd: 1 }, key))
      .body;
    expect(first.budget.maxPayments).toBe(3);
    // The first budget may still make 3 payments: no room for another.
    const second = await call("POST", "/payments/budgets", { account: API, amountUsd: 1 }, key);
    expect(second.body).toMatchObject({ result: "blocked", rules: ["over_hourly_limit"] });
    await call(
      "POST",
      `/payments/budgets/${first.id}/spends`,
      { spends: [spend("a", 1_000)] },
      key,
    );
    await call("POST", `/payments/budgets/${first.id}/close`, undefined, key);
    // Closed after one payment: two left in the hour.
    const third = (await call("POST", "/payments/budgets", { account: API, amountUsd: 1 }, key))
      .body;
    expect(third.budget.maxPayments).toBe(2);
  });

  it("an expired budget closes itself after the grace period, releasing what wasn't spent", async () => {
    clock = start;
    const { id, key } = await gateAccount();
    const opened = (
      await call("POST", "/payments/budgets", { account: API, amountUsd: 5, ttlSeconds: 60 }, key)
    ).body;
    await call(
      "POST",
      `/payments/budgets/${opened.id}/spends`,
      { spends: [spend("a", 123_456)] },
      key,
    );
    expect(await reserved(id)).toEqual([500]);
    clock = start + 60_000 + BUDGET_REPORT_GRACE_MS - 1;
    expect(await sweepBudgets(deps())).toBe(0);
    clock = start + 60_000 + BUDGET_REPORT_GRACE_MS + 1;
    expect(await sweepBudgets(deps())).toBeGreaterThanOrEqual(1);
    const b = (await call("GET", `/payments/budgets/${opened.id}`, undefined, key)).body;
    expect(b).toMatchObject({ open: false, spentUsd: 0.123456 });
    expect(await reserved(id)).toEqual([13]);
  });

  it("lists budgets for the key and for the owner", async () => {
    clock = start;
    const { key, base } = await gateAccount();
    const opened = (await call("POST", "/payments/budgets", { account: API, amountUsd: 1 }, key))
      .body;
    const mine = await call("GET", "/payments/budgets?open=true", undefined, key);
    expect(mine.body.items.map((b: Body) => b.id)).toEqual([opened.id]);
    const owners = await call("GET", `${base}/budgets`, undefined, session);
    expect(owners.body.items.map((b: Body) => b.id)).toEqual([opened.id]);
    const one = await call("GET", `${base}/budgets/${opened.id}`, undefined, session);
    expect(one.body).toMatchObject({ id: opened.id, spends: [] });
  });
});

describe("Watch and budgets", () => {
  it("a wallet's sub-cent x402 payments fall under the open budget; a payment beyond it doesn't", async () => {
    clock = start;
    const { id, key, base } = await gateAccount({ expectChecks: true });
    expect(
      (await call("POST", `${base}/wallets`, { chainId: BASE, address: WALLET }, session)).status,
    ).toBe(201);
    const opened = (
      await call(
        "POST",
        "/payments/budgets",
        { account: API, amountUsd: 0.01, maxPaymentUsd: 0.005 },
        key,
      )
    ).body;
    const transfers = [
      { amountMicros: 1_000, logIndex: 0 },
      { amountMicros: 4_000, logIndex: 1 },
      // Past the budget's $0.01: no longer under it.
      { amountMicros: 6_000, logIndex: 2 },
    ].map((t) => ({
      to: API,
      symbol: "USDC",
      amountCents: Math.max(1, Math.round(t.amountMicros / 10_000)),
      amountMicros: t.amountMicros,
      txHash: `0x${"22".repeat(32)}`,
      logIndex: t.logIndex,
      paidAt: new Date(clock + 1_000),
    }));
    let head = 100n;
    const reader: WalletReader = {
      safeHead: async () => head,
      transfers: async (_wallet, from, to) => (from <= 101n && to >= 101n ? transfers : []),
    };
    const watcher = new GateWatcher({
      db: pg.db,
      store: new GateStore(pg.db, gateMandateHash),
      watch: new GateWatchStore(pg.db),
      budgets: new GateBudgetStore(pg.db),
      notifier: new Notifier(pg.db, { log: () => {} }),
      readers: new Map([[BASE, reader]]),
      now: () => clock,
    });
    await watcher.tick(); // first sight of the wallet: it reads from block 101
    head = 101n;
    await watcher.tick();
    const rows = (
      await pg.db.pool.query(
        "SELECT amount_micros, matched_budget, rules FROM gate_watched_payments WHERE account_id=$1 ORDER BY id",
        [id],
      )
    ).rows.map((r) => [Number(r.amount_micros), r.matched_budget, r.rules]);
    expect(rows).toEqual([
      [1_000, opened.id, []],
      [4_000, opened.id, []],
      [6_000, null, ["skipped_gate"]],
    ]);
  });

  it("a payment log can report exact amounts", async () => {
    clock = start;
    const { id, key } = await gateAccount({ expectChecks: true });
    const opened = (await call("POST", "/payments/budgets", { account: API, amountUsd: 0.01 }, key))
      .body;
    const r = await call(
      "POST",
      "/payments/watched",
      {
        payments: [
          { id: "x1", account: API, amountUsd: 0.001, paidAt: new Date(clock).toISOString() },
        ],
      },
      key,
    );
    expect(r.status).toBe(200);
    const row = (
      await pg.db.pool.query(
        "SELECT amount_cents, amount_micros, matched_budget FROM gate_watched_payments WHERE account_id=$1",
        [id],
      )
    ).rows[0];
    expect([Number(row.amount_cents), Number(row.amount_micros), row.matched_budget]).toEqual([
      1,
      1_000,
      opened.id,
    ]);
  });
});
