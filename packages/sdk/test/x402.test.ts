import { x402Client } from "@x402/core/client";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import {
  type PaymentBreach,
  paymentGate,
  paymentGuard,
  type PaymentMandate,
} from "../src/index.js";
import { guardX402Client, x402PaymentCheck, type X402PaymentContext } from "../src/x402.js";

const SERVICE = "0x1111111111111111111111111111111111111111";
const STRANGER = "0x2222222222222222222222222222222222222222";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const requirements = (over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: "eip155:8453",
  asset: BASE_USDC,
  amount: "250000", // $0.25
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

const context = (r: PaymentRequirements): X402PaymentContext => ({
  paymentRequired: paymentRequired(r),
  selectedRequirements: r,
});

function guardFor(mode: PaymentMandate["mode"], extra: Partial<PaymentMandate> = {}) {
  const breaches: PaymentBreach[] = [];
  const guard = paymentGuard({
    mandate: {
      mode,
      maxPaymentUsd: 1,
      maxDailyUsd: 5,
      freezeOnBreach: false,
      invoiceMatching: false,
      ...extra,
    },
    vendors: [{ id: "forecast-api", account: SERVICE }],
    onBreach: (b) => void breaches.push(b),
  });
  return { guard, breaches };
}

/** An x402 server: 402 with the requirements until a payment header comes, then 200. */
function server(accepts: PaymentRequirements) {
  const paid: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const signature = request.headers.get("PAYMENT-SIGNATURE");
    if (signature) {
      paid.push(signature);
      return new Response(JSON.stringify({ forecast: "sun" }), { status: 200 });
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

describe("guardX402Client", () => {
  it("pays a listed service within the limits, through x402's own fetch wrapper", async () => {
    const { guard, breaches } = guardFor("enforce");
    const { client: c, sign } = client();
    const { fetch, paid } = server(requirements());
    const paidFetch = wrapFetchWithPayment(fetch, guardX402Client(c, { guard }));

    const response = await paidFetch("https://api.example.com/forecast");

    expect(response.status).toBe(200);
    expect(sign).toHaveBeenCalledOnce();
    expect(paid).toHaveLength(1);
    expect(breaches).toEqual([]);
    expect(guard.state().payments).toMatchObject([{ account: SERVICE, amountUsd: 0.25 }]);
  });

  it("Enforce: a payment to an unlisted address is never signed, and the request fails with why", async () => {
    const { guard, breaches } = guardFor("enforce");
    const { client: c, sign } = client();
    const { fetch, paid } = server(requirements({ payTo: STRANGER }));
    const paidFetch = wrapFetchWithPayment(fetch, guardX402Client(c, { guard }));

    await expect(paidFetch("https://api.example.com/forecast")).rejects.toThrow(
      /payment blocked by the mandate: the account is not in the vendor master/,
    );
    expect(sign).not.toHaveBeenCalled();
    expect(paid).toEqual([]);
    expect(breaches.map((b) => [b.rules, b.blocked])).toEqual([[["unknown_payee"], true]]);
    expect(guard.state().payments).toEqual([]);
  });

  it("Enforce: a price over the per-payment limit is blocked", async () => {
    const { guard, breaches } = guardFor("enforce");
    const { client: c, sign } = client();
    const { fetch } = server(requirements({ amount: "5000000" })); // $5
    const paidFetch = wrapFetchWithPayment(fetch, guardX402Client(c, { guard }));

    await expect(paidFetch("https://api.example.com/forecast")).rejects.toThrow(/blocked/);
    expect(sign).not.toHaveBeenCalled();
    expect(breaches[0]?.rules).toContain("over_payment_cap");
  });

  it("Monitor: the breaking payment is signed and reported", async () => {
    const { guard, breaches } = guardFor("monitor");
    const { client: c, sign } = client();
    const { fetch, paid } = server(requirements({ payTo: STRANGER }));
    const paidFetch = wrapFetchWithPayment(fetch, guardX402Client(c, { guard }));

    expect((await paidFetch("https://api.example.com/forecast")).status).toBe(200);
    expect(sign).toHaveBeenCalledOnce();
    expect(paid).toHaveLength(1);
    expect(breaches.map((b) => [b.rules, b.blocked])).toEqual([[["unknown_payee"], false]]);
  });

  it("the daily limit counts every paid call", async () => {
    const { guard } = guardFor("enforce", { maxDailyUsd: 0.5 });
    const { client: c, sign } = client();
    const { fetch } = server(requirements());
    const paidFetch = wrapFetchWithPayment(fetch, guardX402Client(c, { guard }));

    await paidFetch("https://api.example.com/forecast");
    await paidFetch("https://api.example.com/forecast");
    await expect(paidFetch("https://api.example.com/forecast")).rejects.toThrow(/daily/);
    expect(sign).toHaveBeenCalledTimes(2);
  });
});

describe("x402PaymentCheck", () => {
  it("counts a price under a cent as one cent, never as free", async () => {
    const { guard } = guardFor("enforce");
    const check = x402PaymentCheck({ guard });
    expect(await check(context(requirements({ amount: "1000" })))).toBeUndefined(); // $0.001
    expect(guard.state().payments[0]?.amountUsd).toBe(0.01);
  });

  it("reads version 1's maxAmountRequired and network names", async () => {
    const { guard } = guardFor("enforce");
    const check = x402PaymentCheck({ guard });
    const v1 = {
      ...requirements(),
      network: "base",
      amount: undefined,
      maxAmountRequired: "120000",
    };
    expect(
      await check({ paymentRequired: { x402Version: 1 }, selectedRequirements: v1 }),
    ).toBeUndefined();
    expect(guard.state().payments[0]?.amountUsd).toBe(0.12);
  });

  it("matches the asset address in any case, and refuses a token it doesn't know as dollars", async () => {
    const { guard } = guardFor("enforce");
    const check = x402PaymentCheck({ guard });
    expect(await check(context(requirements({ asset: BASE_USDC.toLowerCase() })))).toBeUndefined();
    const other = await check(context(requirements({ asset: STRANGER })));
    expect(other).toEqual({
      abort: true,
      reason: expect.stringMatching(/not a US dollar stablecoin/),
    });
  });

  it("accepts a stablecoin you add, with its decimals", async () => {
    const { guard } = guardFor("enforce");
    const check = x402PaymentCheck({
      guard,
      assets: [{ network: "eip155:8453", asset: STRANGER, decimals: 18 }],
    });
    expect(
      await check(context(requirements({ asset: STRANGER, amount: "300000000000000000" }))),
    ).toBeUndefined();
    expect(guard.state().payments[0]?.amountUsd).toBe(0.3);
  });

  it("refuses a malformed price or a frozen guard", async () => {
    const { guard } = guardFor("enforce", { freezeOnBreach: true });
    const check = x402PaymentCheck({ guard });
    expect(await check(context(requirements({ amount: "0.5" })))).toMatchObject({ abort: true });
    expect(await check(context(requirements({ payTo: STRANGER })))).toMatchObject({ abort: true });
    expect(await check(context(requirements()))).toEqual({
      abort: true,
      reason: expect.stringMatching(/frozen/),
    });
  });

  it("an error that isn't a refusal is thrown, so nothing is signed", async () => {
    const check = x402PaymentCheck({
      guard: {
        pay: () => {
          throw new Error("disk full");
        },
      },
    });
    await expect(check(context(requirements()))).rejects.toThrow("disk full");
  });

  it("the hosted gate: an unreachable gate stops the payment (fails closed)", async () => {
    const gate = paymentGate({
      apiKey: "bonded_gk_test",
      receiptKey: privateKeyToAccount(`0x${"1".repeat(64)}`).address,
      fetch: async () => {
        throw new Error("connection refused");
      },
    });
    const result = await x402PaymentCheck({ guard: gate })(context(requirements()));
    expect(result).toEqual({ abort: true, reason: expect.stringMatching(/couldn't reach/) });
  });

  it("the hosted gate is asked with payTo and the price in dollars, and no reference", async () => {
    const asked: unknown[] = [];
    const gate = {
      pay: async <R>(attempt: unknown, pay: () => R | Promise<R>): Promise<R> => {
        asked.push(attempt);
        return pay();
      },
    };
    await x402PaymentCheck({ guard: gate })(context(requirements()));
    expect(asked).toEqual([{ account: SERVICE, amountUsd: 0.25 }]);
  });
});
