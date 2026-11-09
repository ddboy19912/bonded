import { x402Client } from "@x402/core/client";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { wrapFetchWithPayment } from "@x402/fetch";
import { describe, expect, it, vi } from "vitest";
import { type PaymentBreach, paymentGuard, type PaymentMandate } from "../src/index.js";
import { x402Guard, x402Price, X402_USD_ASSETS } from "../src/x402.js";

const SERVICE = "0x1111111111111111111111111111111111111111";
const STRANGER = "0x2222222222222222222222222222222222222222";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const requirements = (over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: "eip155:8453",
  asset: BASE_USDC,
  amount: "1000", // $0.001
  payTo: SERVICE,
  maxTimeoutSeconds: 60,
  extra: {},
  ...over,
});

const paymentRequired = (accepts: PaymentRequirements): PaymentRequired => ({
  x402Version: 2,
  resource: { url: "https://api.example.com/forecast" },
  accepts: [accepts],
});

function guardFor(mode: PaymentMandate["mode"], extra: Partial<PaymentMandate> = {}) {
  const breaches: PaymentBreach[] = [];
  const now = Date.parse("2026-11-08T10:00:00Z");
  const guard = paymentGuard({
    mandate: {
      mode,
      maxPaymentUsd: 0.01,
      maxDailyUsd: 5,
      freezeOnBreach: false,
      invoiceMatching: false,
      ...extra,
    },
    vendors: [{ id: "forecast-api", account: SERVICE }],
    onBreach: (b) => void breaches.push(b),
    now: () => new Date(now),
  });
  return { guard, breaches };
}

/**
 * An x402 server: 402 with the requirements until a payment header comes. Then it settles, or,
 * with `turnDown`, answers 402 again (the payment didn't verify).
 */
function server(accepts: PaymentRequirements, options: { turnDown?: boolean } = {}) {
  const paid: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const signature = request.headers.get("PAYMENT-SIGNATURE");
    if (signature && !options.turnDown) {
      paid.push(signature);
      return new Response(JSON.stringify({ forecast: "sun" }), {
        status: 200,
        headers: {
          "PAYMENT-RESPONSE": encodePaymentResponseHeader({
            success: true,
            transaction: `0xtx${paid.length}`,
            network: "eip155:8453",
            payer: STRANGER,
          }),
        },
      });
    }
    return new Response("{}", {
      status: 402,
      headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired(accepts)) },
    });
  });
  return { fetch, paid };
}

/** An x402 client with a scheme that signs anything, and x402's own spend caps off. */
function client() {
  const sign = vi.fn(async (x402Version: number) => ({
    x402Version,
    payload: { sig: "0xsigned" },
  }));
  const c = x402Client.fromConfig({
    schemes: [{ network: "eip155:8453", client: { scheme: "exact", createPaymentPayload: sign } }],
    spendControls: false,
  });
  return { client: c, sign };
}

const URL_ = "https://api.example.com/forecast";
const ctx = (over: Partial<PaymentRequirements> = {}) => ({
  paymentRequired: { x402Version: 2 },
  selectedRequirements: requirements(over),
});

describe("x402Guard with the local guard", () => {
  it("one budget covers many sub-cent payments, each counted exactly", async () => {
    const { guard, breaches } = guardFor("enforce");
    const { client: c, sign } = client();
    const { fetch } = server(requirements());
    const x402 = x402Guard({ guard, budget: { amountUsd: 0.05 } });
    const paidFetch = wrapFetchWithPayment(fetch, x402.register(c));

    for (let i = 0; i < 3; i++) expect((await paidFetch(URL_)).status).toBe(200);

    expect(sign).toHaveBeenCalledTimes(3);
    expect(breaches).toEqual([]);
    expect(x402.budgets()).toHaveLength(1);
    expect(x402.budgets()[0]).toMatchObject({ spentMicros: 3_000, payments: 3 });
    // The whole budget counts toward the day until it closes; then what was spent, rounded up.
    expect(guard.state().payments.map((p) => p.amountUsd)).toEqual([0.05]);
    await x402.close();
    expect(guard.state().payments.map((p) => p.amountUsd)).toEqual([0.01]);
  });

  it("a payment the server turns down is taken back", async () => {
    const { guard } = guardFor("enforce");
    const { client: c, sign } = client();
    const { fetch } = server(requirements(), { turnDown: true });
    const x402 = x402Guard({ guard });
    const paidFetch = wrapFetchWithPayment(fetch, x402.register(c));

    expect((await paidFetch(URL_)).status).toBe(402);
    expect(sign).toHaveBeenCalledOnce();
    expect(x402.budgets()[0]).toMatchObject({ spentMicros: 0, payments: 0 });
  });

  it("Enforce: a payment to an unlisted address is never signed, and the request fails with why", async () => {
    const { guard, breaches } = guardFor("enforce");
    const { client: c, sign } = client();
    const { fetch, paid } = server(requirements({ payTo: STRANGER }));
    const paidFetch = wrapFetchWithPayment(fetch, x402Guard({ guard }).register(c));

    await expect(paidFetch(URL_)).rejects.toThrow(
      /payment blocked by the mandate: the account is not in the vendor master/,
    );
    expect(sign).not.toHaveBeenCalled();
    expect(paid).toEqual([]);
    expect(breaches.map((b) => [b.kind, b.rules])).toEqual([["budget", ["unknown_payee"]]]);
  });

  it("Enforce: a price over the per-payment limit is blocked by the budget, without a new one", async () => {
    const { guard, breaches } = guardFor("enforce");
    const { client: c, sign } = client();
    const x402 = x402Guard({ guard });
    const registered = x402.register(c);
    await wrapFetchWithPayment(server(requirements()).fetch, registered)(URL_);
    const big = server(requirements({ amount: "20000" })); // $0.02, over the $0.01 limit
    await expect(wrapFetchWithPayment(big.fetch, registered)(URL_)).rejects.toThrow(
      /it spent beyond its budget: it is over the per-payment limit/,
    );
    expect(sign).toHaveBeenCalledOnce();
    expect(x402.budgets()).toHaveLength(1);
    expect(breaches.map((b) => b.rules)).toEqual([["over_budget"]]);
  });

  it("a used-up budget closes and a new one opens; the day's limit counts both", async () => {
    const { guard } = guardFor("enforce", { maxDailyUsd: 0.02 });
    const x402 = x402Guard({ guard, budget: { amountUsd: 0.01 } });
    const price = ctx({ amount: "4000" }); // $0.004
    for (let i = 0; i < 2; i++) expect(await x402.check(price)).toBeUndefined();
    // $0.008 spent: the third won't fit, so the first budget closes ($0.01) and a second opens.
    expect(await x402.check(price)).toBeUndefined();
    await vi.waitFor(() =>
      expect(guard.state().payments.map((p) => p.amountUsd)).toEqual([0.01, 0.01]),
    );
    // The second budget holds one $0.004 payment; one more fits.
    expect(await x402.check(price)).toBeUndefined();
    // Both budgets are the whole day: a third is over the daily limit.
    expect(await x402.check(price)).toEqual({
      abort: true,
      reason: expect.stringMatching(/over the daily limit/),
    });
  });

  it("Monitor: a payment that breaks the budget is signed and reported", async () => {
    const { guard, breaches } = guardFor("monitor");
    const x402 = x402Guard({ guard });
    expect(await x402.check(ctx())).toBeUndefined();
    expect(await x402.check(ctx({ amount: "20000" }))).toBeUndefined();
    expect(breaches.map((b) => [b.rules, b.blocked])).toEqual([[["over_budget"], false]]);
    expect(x402.budgets()[0]!.spentMicros).toBe(21_000);
  });

  it("the hourly limit: a budget covers what's left of the hour", async () => {
    const { guard } = guardFor("enforce", { maxPaymentsPerHour: 2 });
    const x402 = x402Guard({ guard });
    expect(await x402.check(ctx())).toBeUndefined();
    expect(await x402.check(ctx())).toBeUndefined();
    expect(await x402.check(ctx())).toEqual({
      abort: true,
      reason: expect.stringMatching(/too many payments in the last hour/),
    });
  });

  it("a frozen guard refuses every payment", async () => {
    const { guard } = guardFor("enforce", { freezeOnBreach: true });
    const x402 = x402Guard({ guard });
    expect(await x402.check(ctx({ payTo: STRANGER }))).toMatchObject({ abort: true });
    expect(await x402.check(ctx())).toEqual({
      abort: true,
      reason: expect.stringMatching(/frozen/),
    });
  });

  it("an error that isn't a refusal is thrown, so nothing is signed", async () => {
    const x402 = x402Guard({
      guard: {
        budget: () => {
          throw new Error("disk full");
        },
      },
    });
    await expect(x402.check(ctx())).rejects.toThrow("disk full");
  });
});

describe("x402Price", () => {
  it("reads exact micro-dollars, version 1's fields, any-case EVM addresses, and added tokens", () => {
    expect(x402Price(requirements())).toEqual({ account: SERVICE, amountMicros: 1_000 });
    expect(
      x402Price({
        ...requirements(),
        network: "base",
        amount: undefined,
        maxAmountRequired: "120000",
      } as never),
    ).toEqual({ account: SERVICE, amountMicros: 120_000 });
    expect(x402Price(requirements({ asset: BASE_USDC.toLowerCase() })).amountMicros).toBe(1_000);
    const custom = [...X402_USD_ASSETS, { network: "eip155:8453", asset: STRANGER, decimals: 18 }];
    // 18 decimals: rounded up past six.
    expect(
      x402Price(requirements({ asset: STRANGER, amount: "300000000000001" }), custom).amountMicros,
    ).toBe(301);
  });

  it("refuses a token it doesn't know, a malformed price or a free one", () => {
    expect(() => x402Price(requirements({ asset: STRANGER }))).toThrow(
      /not a US dollar stablecoin/,
    );
    expect(() => x402Price(requirements({ amount: "0.5" }))).toThrow(/whole number/);
    expect(() => x402Price(requirements({ amount: "0" }))).toThrow(/zero/);
  });
});
