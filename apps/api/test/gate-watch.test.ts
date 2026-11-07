import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress, isAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { ANVIL_KEYS } from "@bonded/arena";
import { connectChain } from "@bonded/keeper";
import { GateStore, GateWatchStore } from "@bonded/db";
import { gateMandateHash, parseEvmDeployment, selfServeMessage } from "@bondedhq/shared";
import { createApi } from "../src/index.js";
import {
  GateWatcher,
  WATCH_CHAINS,
  tokenCents,
  viemWalletReader,
  watchReadersFromEnv,
  type WalletReader,
  type WalletTransfer,
} from "../src/gate-watch.js";
import { Notifier } from "../src/notifications.js";
import { postgres } from "./postgres.js";

const TOKEN = "gate-test-token-at-least-24-characters";
// Throwaway keys, made for this run.
const RECEIPT_KEY = generatePrivateKey();
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
const FRAUD = "LT12 1000 0111 0100 1000";
const WALLET = getAddress(`0x${"a1".repeat(20)}`);
const OWN = getAddress(`0x${"a2".repeat(20)}`);
const VENDOR_WALLET = getAddress(`0x${"b1".repeat(20)}`);
const THIEF = getAddress(`0x${"c1".repeat(20)}`);
const BASE = 8453;

let pg: Awaited<ReturnType<typeof postgres>>;
let app: ReturnType<typeof createApi>;
const clock = Date.parse("2026-11-02T10:00:00Z");
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

/** A gate account with Nimbus on the list by bank account, and a vendor paid by wallet. */
async function gateAccount(settings: Record<string, unknown> = {}) {
  const session = await sessionFor(owner);
  const made = await call(
    "POST",
    "/gate/accounts",
    { name: "Acme", mode: "enforce", maxPaymentUsd: 5_000, maxDailyUsd: 8_000 },
    session,
  );
  expect(made.status).toBe(201);
  const id = made.body.account.id as string;
  const key = made.body.apiKey.key as string;
  const base = `/gate/accounts/${id}`;
  for (const vendor of [
    { id: "nimbus", name: "Nimbus", account: NIMBUS },
    { id: "shop", name: "Shop", account: VENDOR_WALLET },
  ])
    expect((await call("POST", `${base}/vendors`, vendor, session)).status).toBe(201);
  const r = await call("PUT", base, { invoiceMatching: false, ...settings }, session);
  expect(r.status).toBe(200);
  return { id, key, session, base };
}

const report = (key: string, ...payments: Record<string, unknown>[]) =>
  call("POST", "/payments/watched", { payments }, key);
const paid = (id: string, account: string, amountUsd: number, extra = {}) => ({
  id,
  account,
  amountUsd,
  paidAt: new Date(clock).toISOString(),
  ...extra,
});
const alerts = async (id: string) =>
  (
    await pg.db.pool.query(
      "SELECT type FROM owner_notifications WHERE payload->>'gateAccountId'=$1 ORDER BY type",
      [id],
    )
  ).rows.map((r) => r.type as string);
const quiet = () => new Notifier(pg.db, { log: () => {} });

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
      maxWalletsPerAccount: 2,
      notifier: new Notifier(pg.db, { log: () => {} }),
    },
  });
}, 120_000);
afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

describe("Watch mode: a payment log", () => {
  it("runs a payment with no check through the rules, counts it, and alerts", async () => {
    const { id, key, base, session } = await gateAccount();
    const r = await report(key, paid("p-1", FRAUD, 80));
    expect(r.status).toBe(200);
    expect(r.body.items[0]).toMatchObject({
      source: "log",
      checkedFirst: false,
      rules: ["unknown_payee"],
      lossUsd: 80,
      repeated: false,
    });
    await expect.poll(() => alerts(id)).toEqual(["payment_seen_breach"]);
    const payments = (await call("GET", `${base}/payments`, undefined, session)).body.items;
    expect(payments).toMatchObject([{ source: "watch", amountCents: 8000 }]);
    // It has no receipt and isn't in the decision log: nothing was decided before it left.
    expect(r.body.items[0]).not.toHaveProperty("receipt");
    expect((await call("GET", `${base}/decisions`, undefined, session)).body.items).toEqual([]);
  });

  it("records the same id once", async () => {
    const { id, key, base, session } = await gateAccount();
    await report(key, paid("p-1", FRAUD, 80));
    const again = await report(key, paid("p-1", FRAUD, 80));
    expect(again.body.items[0].repeated).toBe(true);
    await expect.poll(() => alerts(id)).toEqual(["payment_seen_breach"]);
    expect((await call("GET", `${base}/watched`, undefined, session)).body.items).toHaveLength(1);
    expect((await call("GET", `${base}/payments`, undefined, session)).body.items).toHaveLength(1);
  });

  it("notes a payment that matches an allowed check, without counting it twice", async () => {
    const { id, key, base, session } = await gateAccount();
    const check = await call("POST", "/payments/check", { account: NIMBUS, amountUsd: 50 }, key);
    expect(check.body.result).toBe("allowed");
    const r = await report(
      key,
      paid("p-1", NIMBUS, 50, { paidAt: new Date(clock + 60_000).toISOString() }),
    );
    expect(r.body.items[0]).toMatchObject({
      checkedFirst: true,
      matchedDecision: check.body.id,
      rules: [],
    });
    expect((await call("GET", `${base}/payments`, undefined, session)).body.items).toHaveLength(1);
    expect(await alerts(id)).toEqual([]);
  });

  it("lets one check match one payment, so a second payment has skipped the gate", async () => {
    const { key } = await gateAccount({ expectChecks: true });
    await call("POST", "/payments/check", { account: NIMBUS, amountUsd: 50 }, key);
    const paidAt = new Date(clock + 60_000).toISOString();
    const r = await report(
      key,
      paid("p-1", NIMBUS, 50, { paidAt }),
      paid("p-2", NIMBUS, 50, { paidAt }),
    );
    expect(r.body.items[0]).toMatchObject({ checkedFirst: true, rules: [] });
    expect(r.body.items[1]).toMatchObject({ checkedFirst: false, rules: ["skipped_gate"] });
  });

  it("doesn't call a payment checked when the check blocked it", async () => {
    const { key } = await gateAccount({ expectChecks: true });
    const check = await call("POST", "/payments/check", { account: FRAUD, amountUsd: 50 }, key);
    expect(check.body.result).toBe("blocked");
    const paidAt = new Date(clock + 60_000).toISOString();
    const r = await report(key, paid("p-1", FRAUD, 50, { paidAt }));
    expect(r.body.items[0]).toMatchObject({
      checkedFirst: false,
      rules: ["unknown_payee", "skipped_gate"],
    });
  });

  it("doesn't match a check made after the payment", async () => {
    const { key } = await gateAccount();
    await call("POST", "/payments/check", { account: NIMBUS, amountUsd: 50 }, key);
    const paidAt = new Date(clock - 3_600_000).toISOString();
    const r = await report(key, paid("p-1", NIMBUS, 50, { paidAt }));
    expect(r.body.items[0].checkedFirst).toBe(false);
  });

  it("alerts on a skipped check only when the account expects one", async () => {
    const expecting = await gateAccount({ expectChecks: true });
    await report(expecting.key, paid("p-1", NIMBUS, 50));
    await expect.poll(() => alerts(expecting.id)).toEqual(["gate_skipped"]);
    const watching = await gateAccount();
    const r = await report(watching.key, paid("p-1", NIMBUS, 50));
    expect(r.body.items[0].rules).toEqual([]);
    expect(await alerts(watching.id)).toEqual([]);
  });

  it("needs an approved invoice when invoice matching is on", async () => {
    const { key } = await gateAccount({ invoiceMatching: true });
    const r = await report(key, paid("p-1", NIMBUS, 50));
    expect(r.body.items[0]).toMatchObject({ rules: ["unmatched_invoice"], overpaidUsd: 50 });
  });

  it("counts watched payments toward the limits that follow", async () => {
    const { key } = await gateAccount({ maxDailyUsd: 100, maxPaymentUsd: 100 });
    await report(key, paid("p-1", NIMBUS, 90));
    const r = await call("POST", "/payments/check", { account: NIMBUS, amountUsd: 20 }, key);
    expect(r.body.rules).toEqual(["over_daily_cap"]);
  });

  it("freezes the account's checks after a breach when set, and can't undo the payment", async () => {
    const { id, key } = await gateAccount({ freezeOnBreach: true });
    await report(key, paid("p-1", FRAUD, 80));
    await expect.poll(() => alerts(id)).toEqual(["gate_frozen", "payment_seen_breach"]);
    const r = await call("POST", "/payments/check", { account: NIMBUS, amountUsd: 5 }, key);
    expect(r.body).toMatchObject({ decision: "frozen", result: "refused" });
  });

  it("refuses a payment dated in the future, no key, and a batch too big", async () => {
    const { key } = await gateAccount();
    const later = new Date(clock + 3_600_000).toISOString();
    expect((await report(key, paid("p-1", NIMBUS, 5, { paidAt: later }))).status).toBe(400);
    expect(
      (await call("POST", "/payments/watched", { payments: [paid("p", NIMBUS, 5)] })).status,
    ).toBe(401);
    const many = Array.from({ length: 101 }, (_, i) => paid(`p-${i}`, NIMBUS, 5));
    expect((await report(key, ...many)).status).toBe(400);
  });

  it("shows an account's payments only to its owner", async () => {
    const { base } = await gateAccount();
    const other = await sessionFor(stranger);
    expect((await call("GET", `${base}/watched`, undefined, other)).status).toBe(404);
    expect((await call("GET", `${base}/wallets`, undefined, other)).status).toBe(404);
    expect(
      (await call("POST", `${base}/wallets`, { chainId: BASE, address: WALLET }, other)).status,
    ).toBe(404);
  });
});

describe("Watch mode: wallets", () => {
  it("adds a public address on a chain it can read, once, up to the limit", async () => {
    const { base, session } = await gateAccount();
    expect((await call("GET", "/gate/watch-chains")).body.items).toEqual([
      { chainId: BASE, name: "Base", tokens: ["USDC"] },
    ]);
    const add = (body: unknown) => call("POST", `${base}/wallets`, body, session);
    const made = await add({ chainId: BASE, address: WALLET, label: "Ops" });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ address: WALLET.toLowerCase(), chain: "Base", label: "Ops" });
    expect((await add({ chainId: BASE, address: WALLET.toLowerCase() })).status).toBe(409);
    expect((await add({ chainId: 1, address: OWN })).status).toBe(409);
    expect((await add({ chainId: BASE, address: "0x123" })).status).toBe(400);
    expect((await add({ chainId: BASE, address: OWN })).status).toBe(201);
    expect((await add({ chainId: BASE, address: THIEF })).status).toBe(409);
    const gone = await call("DELETE", `${base}/wallets/${made.body.id}`, undefined, session);
    expect(gone.body.deleted).toBe(true);
    expect((await call("GET", `${base}/wallets`, undefined, session)).body.items).toHaveLength(1);
  });

  /** A chain that holds `transfers` per block; each read of a range returns those in it. */
  const fakeChain = (head: { block: bigint }, byBlock: Map<bigint, WalletTransfer[]>) => {
    const reads: [bigint, bigint][] = [];
    const reader: WalletReader = {
      safeHead: async () => head.block,
      transfers: async (_wallet, from, to) => {
        reads.push([from, to]);
        return [...byBlock].filter(([b]) => b >= from && b <= to).flatMap(([, t]) => t);
      },
    };
    return { reader, reads };
  };
  const transfer = (to: Address, amountCents: number, logIndex = 0): WalletTransfer => ({
    to,
    symbol: "USDC",
    amountCents,
    txHash: `0x${"11".repeat(32)}`,
    logIndex,
    paidAt: new Date(clock),
  });
  const watcher = (reader: WalletReader, maxBlocks?: bigint, log?: (l: string) => void) =>
    new GateWatcher({
      db: pg.db,
      store: new GateStore(pg.db, gateMandateHash),
      watch: new GateWatchStore(pg.db),
      notifier: quiet(),
      readers: new Map([[BASE, reader]]),
      ...(maxBlocks ? { maxBlocks } : {}),
      ...(log ? { log } : {}),
    });
  const wipeWallets = () => pg.db.pool.query("DELETE FROM gate_watch_wallets");

  it("starts a new wallet at the current block, then records what leaves it, once", async () => {
    await wipeWallets();
    const { base, session } = await gateAccount({ expectChecks: true });
    await call("POST", `${base}/wallets`, { chainId: BASE, address: WALLET }, session);
    const head = { block: 100n };
    const blocks = new Map([[50n, [transfer(THIEF, 999)]]]);
    const { reader, reads } = fakeChain(head, blocks);
    const w = watcher(reader);
    await w.tick();
    expect(reads).toEqual([]);
    blocks.set(101n, [transfer(THIEF, 8000), transfer(VENDOR_WALLET, 1500, 1)]);
    head.block = 101n;
    await w.tick();
    expect(reads).toEqual([[101n, 101n]]);
    await w.tick();
    const seen = (await call("GET", `${base}/watched`, undefined, session)).body.items;
    expect(seen.map((p: Body) => p.rules)).toEqual([
      ["skipped_gate"],
      ["unknown_payee", "skipped_gate"],
    ]);
    expect(seen[1]).toMatchObject({ source: "wallet", amountUsd: 80, details: { token: "USDC" } });
  });

  it("reads a wallet again without recording anything twice", async () => {
    await wipeWallets();
    const { id, base, session } = await gateAccount();
    await call("POST", `${base}/wallets`, { chainId: BASE, address: WALLET }, session);
    const head = { block: 10n };
    const blocks = new Map([[11n, [transfer(THIEF, 100)]]]);
    const w = watcher(fakeChain(head, blocks).reader);
    await w.tick();
    head.block = 11n;
    await w.tick();
    await pg.db.pool.query("UPDATE gate_watch_wallets SET next_block=11 WHERE account_id=$1", [id]);
    await w.tick();
    expect((await call("GET", `${base}/watched`, undefined, session)).body.items).toHaveLength(1);
  });

  it("skips moves between the account's own wallets", async () => {
    await wipeWallets();
    const { base, session } = await gateAccount();
    await call("POST", `${base}/wallets`, { chainId: BASE, address: WALLET }, session);
    await call("POST", `${base}/wallets`, { chainId: BASE, address: OWN }, session);
    const head = { block: 10n };
    const blocks = new Map([[11n, [transfer(OWN, 100)]]]);
    const w = watcher(fakeChain(head, blocks).reader);
    await w.tick();
    head.block = 11n;
    await w.tick();
    expect((await call("GET", `${base}/watched`, undefined, session)).body.items).toEqual([]);
  });

  it("reads a long gap in steps, and carries on after one wallet fails", async () => {
    await wipeWallets();
    const first = await gateAccount();
    const second = await gateAccount();
    await call("POST", `${first.base}/wallets`, { chainId: BASE, address: WALLET }, first.session);
    await call("POST", `${second.base}/wallets`, { chainId: BASE, address: OWN }, second.session);
    const head = { block: 10n };
    const { reader, reads } = fakeChain(head, new Map());
    const logs: string[] = [];
    const failing: WalletReader = {
      ...reader,
      transfers: async (wallet, from, to) => {
        if (wallet === WALLET) throw new Error("rpc down https://secret.example/key");
        return reader.transfers(wallet, from, to);
      },
    };
    const w = watcher(failing, 5n, (l) => logs.push(l));
    await w.tick();
    head.block = 30n;
    await w.tick();
    expect(reads).toEqual([[11n, 15n]]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain("secret.example");
  });
});

describe("Watch mode: reading a chain", () => {
  it("lists real checksummed token addresses", () => {
    for (const chain of Object.values(WATCH_CHAINS))
      for (const token of chain.tokens) expect(isAddress(token.address)).toBe(true);
  });

  it("values tokens in cents, keeps tiny payments, and ignores nothing moved", () => {
    expect(tokenCents(612_400_000n, 6)).toBe(61_240);
    expect(tokenCents(1_000n, 6)).toBe(1);
    expect(tokenCents(0n, 6)).toBe(0);
    expect(tokenCents(5_000n, 6)).toBe(1);
    expect(tokenCents(15_000n, 6)).toBe(2);
  });

  it("reads only the listed tokens, skips zero transfers and dates payments by block", async () => {
    const token = WATCH_CHAINS[BASE]!.tokens[0]!;
    const log = (address: Address, value: bigint, logIndex: number) => ({
      address,
      args: { to: THIEF, value },
      blockNumber: 7n,
      logIndex,
      transactionHash: `0x${"22".repeat(32)}`,
    });
    let asked: Record<string, unknown> = {};
    const client = {
      getBlockNumber: async () => 100n,
      getBlock: async () => ({ timestamp: 1_793_577_600n }),
      getLogs: async (q: Record<string, unknown>) => {
        asked = q;
        return [log(token.address, 80_000_000n, 0), log(token.address, 0n, 1), log(THIEF, 5n, 2)];
      },
    };
    const reader = viemWalletReader(client as never, WATCH_CHAINS[BASE]!);
    expect(await reader.safeHead()).toBe(70n);
    const got = await reader.transfers(WALLET, 1n, 2n);
    expect(asked).toMatchObject({ args: { from: WALLET }, fromBlock: 1n, toBlock: 2n });
    expect(got).toEqual([
      {
        to: THIEF,
        symbol: "USDC",
        amountCents: 8_000,
        txHash: `0x${"22".repeat(32)}`,
        logIndex: 0,
        paidAt: new Date(1_793_577_600_000),
      },
    ]);
  });

  it("reads nothing with no setting, and refuses a chain it can't read", () => {
    expect(watchReadersFromEnv({}).size).toBe(0);
    expect(
      watchReadersFromEnv({ GATE_WATCH_RPC_URLS: '{"8453":"https://rpc.example"}' }).has(8453),
    ).toBe(true);
    expect(() =>
      watchReadersFromEnv({ GATE_WATCH_RPC_URLS: '{"999":"https://rpc.example"}' }),
    ).toThrow(/chain 999/);
  });
});
