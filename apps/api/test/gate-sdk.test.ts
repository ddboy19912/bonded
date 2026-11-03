import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ANVIL_KEYS } from "@bonded/arena";
import { connectChain } from "@bonded/keeper";
import { paymentGate, PaymentBlockedError, PaymentFrozenError } from "@bondedhq/sdk";
import { parseEvmDeployment, selfServeMessage, verifyGateReceipt } from "@bondedhq/shared";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApi } from "../src/index.js";
import { postgres } from "./postgres.js";

// The SDK's hosted gate client against the real API and database: the client an agent runs.

const TOKEN = "gate-sdk-test-token-at-least-24-characters";
// Throwaway keys, made for this run.
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

const NIMBUS = "GB29 NWBK 6016 1331 9268 19";
const NIMBUS_NEW = "DE89 3704 0044 0532 0130 00";
const FRAUD = "LT12 1000 0111 0100 1000";
const INVOICE = { account: NIMBUS, amountUsd: 612.4, invoiceReference: "NIM-1" };

let pg: Awaited<ReturnType<typeof postgres>>;
let app: ReturnType<typeof createApi>;
const wide = { perClient: 100_000, total: 1_000_000, windowMs: 600_000 };

/** What the SDK sends, handed to the API in this process. */
const toApi = ((url: string, init?: RequestInit) => {
  const { pathname, search } = new URL(url);
  return app.request(`${pathname}${search}`, init);
}) as unknown as typeof fetch;

async function post(path: string, body: unknown, session?: string) {
  const res = await app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session}` } : {}),
    },
    body: JSON.stringify(body),
  });
  expect(res.status).toBeLessThan(300);
  return (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

let session: string | undefined;
async function signIn() {
  if (session) return session;
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await owner.signMessage({
    message: selfServeMessage({
      action: "sign-in",
      chainId: chain.deployment.chainId,
      wallet: owner.address,
      timestamp,
    }),
  });
  session = (await post("/self/session", { wallet: owner.address, timestamp, signature }))
    .session as string;
  return session;
}

/** A gate account with Nimbus on file and invoice NIM-1 approved, and a client for its key. */
async function account(settings: Record<string, unknown> = {}) {
  const owned = await signIn();
  const made = await post(
    "/gate/accounts",
    { name: "Acme AP", mode: "enforce", maxPaymentUsd: 5_000, maxDailyUsd: 8_000, ...settings },
    owned,
  );
  const base = `/gate/accounts/${made.account.id as string}`;
  await post(`${base}/vendors`, { id: "nimbus", name: "Nimbus", account: NIMBUS }, owned);
  await post(
    `${base}/invoices`,
    { vendorId: "nimbus", reference: "NIM-1", amountUsd: 612.4 },
    owned,
  );
  const key = made.apiKey.key as string;
  return { base, gate: paymentGate({ apiKey: key, apiUrl: "http://api.test", fetch: toApi }) };
}

beforeAll(async () => {
  pg = await postgres();
  app = createApi({
    db: pg.db,
    chain,
    attesterKey: ANVIL_KEYS.deployer,
    apiToken: TOKEN,
    ownerRequests: { writes: wide, reads: wide },
    gate: { receiptKey: RECEIPT_KEY },
  });
}, 120_000);
afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

describe("the SDK's payment gate client against the API", () => {
  it("blocks the hijacked account, pays the real one, and logs both with good receipts", async () => {
    const { gate } = await account();
    const bank = vi.fn(() => "sent");

    const error = await gate.pay({ ...INVOICE, account: FRAUD }, bank).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentBlockedError);
    const { breach } = error as PaymentBlockedError;
    expect(breach.rules).toEqual(["unknown_payee", "unmatched_invoice"]);
    expect(await verifyGateReceipt(breach.receipt!, RECEIPT_SIGNER)).toBe(true);
    expect(bank).not.toHaveBeenCalled();

    await expect(gate.pay(INVOICE, bank)).resolves.toBe("sent");
    expect(bank).toHaveBeenCalledOnce();

    const { items } = await gate.decisions();
    expect(items.map((d) => d.result)).toEqual(["allowed", "blocked"]);
    expect((await gate.decision(breach.decisionId!)).result).toBe("blocked");
  });

  it("blocks a second payment of the invoice, but a retry with the same id gets the first decision", async () => {
    const { gate } = await account();
    const failing = vi.fn(() => {
      throw new Error("bank timeout");
    });
    const retry = { ...INVOICE, requestId: "pay-001" };
    await expect(gate.pay(retry, failing)).rejects.toThrow("bank timeout");
    // The gate counted it as paid: the same id gets the allowed decision back.
    await expect(gate.pay(retry, () => "sent")).resolves.toBe("sent");
    expect((await gate.check(retry)).replayed).toBe(true);

    const error = await gate.pay(INVOICE, () => "sent").catch((e: unknown) => e);
    expect((error as PaymentBlockedError).breach.rules).toEqual(["duplicate_payment"]);
  });

  it("lets Monitor pay a breach and report it", async () => {
    const onBreach = vi.fn();
    const { base: path } = await account({ mode: "monitor" });
    const keyed = await post(`${path}/keys`, { label: "second" }, await signIn());
    const gate = paymentGate({
      apiKey: keyed.key as string,
      apiUrl: "http://api.test",
      fetch: toApi,
      onBreach,
    });
    await expect(gate.pay({ ...INVOICE, account: FRAUD }, () => "sent")).resolves.toBe("sent");
    expect(onBreach.mock.calls[0]![0]).toMatchObject({
      rules: ["unknown_payee", "unmatched_invoice"],
      blocked: false,
    });
  });

  it("checks a bank change against its ticket", async () => {
    const { gate, base } = await account();
    const change = { vendorId: "nimbus", account: NIMBUS_NEW };
    const update = vi.fn(() => "changed");
    const error = await gate.changeVendorAccount(change, update).catch((e: unknown) => e);
    expect((error as PaymentBlockedError).breach.rules).toEqual(["unverified_vendor_change"]);
    expect(update).not.toHaveBeenCalled();

    await post(
      `${base}/tickets`,
      { id: "FIN-1", ...change, verifiedBy: "called the number on file" },
      await signIn(),
    );
    await expect(gate.changeVendorAccount({ ...change, ticket: "FIN-1" }, update)).resolves.toBe(
      "changed",
    );
  });

  it("refuses everything once a breach freezes the account", async () => {
    const { gate } = await account({ freezeOnBreach: true });
    await gate.pay({ ...INVOICE, account: FRAUD }, () => "sent").catch(() => undefined);
    const bank = vi.fn();
    await expect(gate.pay(INVOICE, bank)).rejects.toBeInstanceOf(PaymentFrozenError);
    expect(bank).not.toHaveBeenCalled();
  });

  it("refuses a wrong API key without paying", async () => {
    const gate = paymentGate({
      apiKey: "bonded_gk_wrong",
      apiUrl: "http://api.test",
      fetch: toApi,
    });
    const bank = vi.fn();
    await expect(gate.pay(INVOICE, bank)).rejects.toMatchObject({
      code: "PAYMENT_GATE_ERROR",
      status: 401,
    });
    expect(bank).not.toHaveBeenCalled();
  });
});
