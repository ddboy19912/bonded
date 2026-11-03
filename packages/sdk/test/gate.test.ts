import { describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  normalAccount,
  PAYMENT_RULE_WORDS,
  signGateReceipt,
  type GateReceipt,
  type PaymentRule,
} from "@bondedhq/shared";
import {
  BondedError,
  guardPayments,
  guardVendorChanges,
  isPaymentRefusal,
  PaymentBlockedError,
  type PaymentBreach,
  PaymentFrozenError,
  paymentGate,
  PaymentGateError,
} from "../src/index.js";

// A throwaway receipt key, made for this run.
const KEY = generatePrivateKey();
const SIGNER = privateKeyToAccount(KEY).address;
const NIMBUS = "GB29 NWBK 6016 1331 9268 19";
const FRAUD = "LT12 1000 0111 0100 1000";
const PAYMENT = { account: NIMBUS, amountUsd: 612.4, invoiceReference: "NIM-88412" };
const API = "https://gate.test";

interface Decided {
  decision?: GateReceipt["decision"];
  result?: GateReceipt["result"];
  mode?: GateReceipt["mode"];
  rules?: PaymentRule[];
}

/** The API's answer to a check, signed as it signs one. */
async function answer(asked: Record<string, unknown>, d: Decided = {}, key = KEY) {
  const rules = d.rules ?? [];
  const bank = asked.kind === "bank_change";
  const receipt: GateReceipt = {
    decisionId: "6f1c2b9e-1d2a-4c3b-9a8e-0f1e2d3c4b5a",
    gateAccountId: "0b5e7c1a-2f3d-4e5f-8a9b-1c2d3e4f5a6b",
    kind: (asked.kind ?? "invoice") as GateReceipt["kind"],
    decision: d.decision ?? (rules.length ? "breach" : "pass"),
    result: d.result ?? (rules.length ? "blocked" : "allowed"),
    mode: d.mode ?? "enforce",
    rules,
    amountCents: bank ? 0 : Math.round((asked.amountUsd as number) * 100),
    payee: normalAccount(asked.account as string),
    reference: bank ? "" : (asked.invoiceReference as string),
    inputHash: `0x${"11".repeat(32)}`,
    mandateHash: `0x${"22".repeat(32)}`,
    mandateVersion: 2,
    checkedAt: Date.parse("2026-11-03T10:00:00Z") / 1000,
  };
  return {
    id: receipt.decisionId,
    kind: receipt.kind,
    decision: receipt.decision,
    result: receipt.result,
    allowed: receipt.result === "allowed",
    message: "",
    mode: receipt.mode,
    rules,
    reasons: rules.map((r) => PAYMENT_RULE_WORDS[r]),
    amountUsd: receipt.amountCents / 100,
    lossUsd: 0,
    overpaidUsd: 0,
    payee: receipt.payee,
    vendorId: null,
    reference: receipt.reference,
    requestId: asked.requestId,
    inputHash: receipt.inputHash,
    mandate: { version: 2, hash: receipt.mandateHash },
    createdAt: "2026-11-03T10:00:00.000Z",
    receipt: await signGateReceipt(receipt, key),
    frozen: receipt.decision === "frozen",
    replayed: false,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A fake API: `respond` answers each check; the receipt key is always published. */
function api(respond: (asked: Record<string, unknown>) => Response | Promise<Response>) {
  const asked: Record<string, unknown>[] = [];
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  const fake = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/gate/receipt-key")) return json({ address: SIGNER });
    if (String(url).endsWith("/payments/check")) {
      const body = JSON.parse(init!.body as string) as Record<string, unknown>;
      asked.push(body);
      return respond(body);
    }
    return json({ items: [], next: null });
  });
  return { fetch: fake as unknown as typeof fetch, fake, asked, calls };
}

const gateOn = (server: ReturnType<typeof api>, onBreach?: (b: PaymentBreach) => void) =>
  paymentGate({
    apiKey: "bonded_gk_test",
    apiUrl: `${API}/`,
    fetch: server.fetch,
    ...(onBreach ? { onBreach } : {}),
  });

describe("the hosted payment gate", () => {
  it("pays what the gate allows, sending the key and a request id", async () => {
    const server = api((asked) => answer(asked).then(json));
    const pay = vi.fn(() => "paid");
    await expect(gateOn(server).pay(PAYMENT, pay)).resolves.toBe("paid");
    expect(pay).toHaveBeenCalledOnce();
    expect(server.asked[0]).toMatchObject({ ...PAYMENT, kind: "invoice" });
    expect(server.asked[0]!.requestId).toEqual(expect.any(String));
    const check = server.calls.find((c) => c.url === `${API}/payments/check`)!;
    expect((check.init!.headers as Record<string, string>).Authorization).toBe(
      "Bearer bonded_gk_test",
    );
  });

  it("doesn't call pay when Enforce blocks it, and names the rules and the receipt", async () => {
    const server = api((asked) =>
      answer(asked, { rules: ["unknown_payee", "unmatched_invoice"] }).then(json),
    );
    const onBreach = vi.fn();
    const pay = vi.fn();
    const error = await gateOn(server, onBreach)
      .pay({ ...PAYMENT, account: FRAUD }, pay)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentBlockedError);
    const { breach } = error as PaymentBlockedError;
    expect(breach.rules).toEqual(["unknown_payee", "unmatched_invoice"]);
    expect(breach.reasons[0]).toBe("the account is not in the vendor master");
    expect(breach.blocked).toBe(true);
    expect(breach.receipt?.signer).toBe(SIGNER);
    expect(onBreach).toHaveBeenCalledWith(breach);
    expect(pay).not.toHaveBeenCalled();
    expect(isPaymentRefusal(error)).toBe(true);
  });

  it("pays a breach Monitor lets through and reports it, unless onBreach throws", async () => {
    const monitor = (asked: Record<string, unknown>) =>
      answer(asked, { rules: ["over_daily_cap"], result: "allowed", mode: "monitor" }).then(json);
    const onBreach = vi.fn();
    const pay = vi.fn(() => "paid");
    await expect(gateOn(api(monitor), onBreach).pay(PAYMENT, pay)).resolves.toBe("paid");
    expect(onBreach.mock.calls[0]![0]).toMatchObject({ blocked: false, day: "2026-11-03" });

    pay.mockClear();
    const refuse = () => {
      throw new Error("alert failed");
    };
    await expect(gateOn(api(monitor), refuse).pay(PAYMENT, pay)).rejects.toThrow("alert failed");
    expect(pay).not.toHaveBeenCalled();
  });

  it("refuses when the account is frozen", async () => {
    const server = api((asked) =>
      answer(asked, { decision: "frozen", result: "refused" }).then(json),
    );
    const pay = vi.fn();
    await expect(gateOn(server).pay(PAYMENT, pay)).rejects.toBeInstanceOf(PaymentFrozenError);
    expect(pay).not.toHaveBeenCalled();
  });

  it("fails closed when the gate can't be reached, after asking again with the same id", async () => {
    const server = api(() => {
      throw new Error("connection reset");
    });
    const pay = vi.fn();
    const error = await gateOn(server)
      .pay(PAYMENT, pay)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentGateError);
    expect(isPaymentRefusal(error)).toBe(true);
    expect(pay).not.toHaveBeenCalled();
    expect(server.asked).toHaveLength(2);
    expect(server.asked[1]!.requestId).toBe(server.asked[0]!.requestId);
  });

  it("recovers from a lost answer, and doesn't ask again after a refusal", async () => {
    let tries = 0;
    const flaky = api(async (asked) =>
      ++tries === 1 ? json({ error: "busy" }, 503) : json(await answer(asked)),
    );
    await expect(gateOn(flaky).pay(PAYMENT, () => "paid")).resolves.toBe("paid");
    expect(flaky.asked).toHaveLength(2);

    const denied = api(() => json({ error: "Invalid API key." }, 401));
    const error = await gateOn(denied)
      .pay(PAYMENT, () => "paid")
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "PAYMENT_GATE_ERROR", status: 401 });
    expect((error as Error).message).toBe("Invalid API key.");
    expect(denied.asked).toHaveLength(1);
  });

  it("calls a request the API can't read an invalid payment", async () => {
    const server = api(() => json({ error: "amountUsd is invalid" }, 400));
    const error = await gateOn(server)
      .pay({ ...PAYMENT, amountUsd: -1 }, () => "paid")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BondedError);
    expect(error).toMatchObject({ code: "INVALID_PAYMENT" });
  });

  it("won't pay on an answer signed by another key", async () => {
    const server = api((asked) => answer(asked, {}, generatePrivateKey()).then(json));
    const pay = vi.fn();
    await expect(gateOn(server).pay(PAYMENT, pay)).rejects.toThrow(
      /isn't signed by Bonded's receipt key/,
    );
    expect(pay).not.toHaveBeenCalled();
    expect(server.asked).toHaveLength(1);
  });

  it("won't pay on a blocked receipt with its answer changed to allowed", async () => {
    const server = api(async (asked) =>
      json({
        ...(await answer(asked, { rules: ["unknown_payee"] })),
        result: "allowed",
        allowed: true,
        decision: "pass",
      }),
    );
    const pay = vi.fn();
    await expect(gateOn(server).pay(PAYMENT, pay)).rejects.toBeInstanceOf(PaymentGateError);
    expect(pay).not.toHaveBeenCalled();
  });

  it("won't pay on a genuine receipt for a different payment", async () => {
    const server = api((asked) => answer({ ...asked, account: FRAUD }).then(json));
    const pay = vi.fn();
    await expect(gateOn(server).pay(PAYMENT, pay)).rejects.toThrow(/different decision or payment/);
    expect(pay).not.toHaveBeenCalled();
  });

  it("checks receipts against a pinned key without reading the published one", async () => {
    const server = api((asked) => answer(asked).then(json));
    const gate = paymentGate({
      apiKey: "bonded_gk_test",
      apiUrl: API,
      fetch: server.fetch,
      receiptKey: SIGNER,
    });
    await gate.pay(PAYMENT, () => "paid");
    expect(server.calls.some((c) => c.url.endsWith("/gate/receipt-key"))).toBe(false);
  });

  it("reads the published key once", async () => {
    const server = api((asked) => answer(asked).then(json));
    const gate = gateOn(server);
    await gate.pay(PAYMENT, () => "paid");
    await gate.pay(PAYMENT, () => "paid");
    expect(server.calls.filter((c) => c.url.endsWith("/gate/receipt-key"))).toHaveLength(1);
  });

  it("works as the guard for guardPayments and guardVendorChanges", async () => {
    const server = api((asked) => answer(asked).then(json));
    const gate = gateOn(server);
    const bank = vi.fn((p: typeof PAYMENT) => `paid ${p.invoiceReference}`);
    const refund = guardPayments(bank, { guard: gate, kind: "refund" });
    await expect(refund(PAYMENT)).resolves.toBe("paid NIM-88412");
    expect(server.asked[0]).toMatchObject({ kind: "refund" });

    const update = vi.fn(() => "changed");
    const change = guardVendorChanges(update, { guard: gate });
    await change({ vendorId: "nimbus", account: NIMBUS, ticket: "FIN-1" });
    expect(server.asked[1]).toMatchObject({
      kind: "bank_change",
      vendorId: "nimbus",
      account: NIMBUS,
      ticket: "FIN-1",
    });
    expect(update).toHaveBeenCalledOnce();
  });

  it("sends only what the API takes, whatever toPayment returns", async () => {
    const server = api((asked) => answer(asked).then(json));
    const pay = guardPayments(() => "paid", {
      guard: gateOn(server),
      toPayment: () => ({ ...PAYMENT, memo: "for the API to refuse" }),
    });
    await pay(undefined);
    expect(Object.keys(server.asked[0]!).sort()).toEqual([
      "account",
      "amountUsd",
      "invoiceReference",
      "kind",
      "requestId",
    ]);
  });

  it("won't report rules its receipt doesn't name", async () => {
    const server = api(async (asked) =>
      json({ ...(await answer(asked, { rules: ["unknown_payee"] })), rules: ["over_daily_cap"] }),
    );
    await expect(gateOn(server).pay(PAYMENT, vi.fn())).rejects.toBeInstanceOf(PaymentGateError);
  });

  it("keeps a caller's request id, so a retry gets the first decision back", async () => {
    const server = api((asked) => answer(asked).then(json));
    const pay = guardPayments(() => "paid", { guard: gateOn(server) });
    await pay({ ...PAYMENT, requestId: "pay-001" });
    expect(server.asked[0]!.requestId).toBe("pay-001");
  });

  it("reads the decision log and a receipt's proof", async () => {
    const server = api((asked) => answer(asked).then(json));
    const gate = gateOn(server);
    await gate.decisions({ limit: 5, result: "blocked" });
    await gate.decision("abc");
    await gate.proof("abc");
    expect(server.calls.map((c) => c.url)).toEqual([
      `${API}/payments/decisions?limit=5&result=blocked`,
      `${API}/payments/decisions/abc`,
      `${API}/payments/decisions/abc/proof`,
    ]);
  });

  it("needs an API key", () => {
    expect(() => paymentGate({ apiKey: "" })).toThrow("apiKey is required");
  });
});
