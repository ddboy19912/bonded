import { describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  budgetCloseCents,
  type GateBudgetCloseInput,
  type GateBudgetInput,
  gateInputHash,
  type GateReceipt,
  normalAccount,
  signGateReceipt,
} from "@bondedhq/shared";
import { paymentGate } from "../src/index.js";

// A throwaway receipt key, made for this run.
const KEY = generatePrivateKey();
const SIGNER = privateKeyToAccount(KEY).address;
const API = "0x1111111111111111111111111111111111111111";
const BUDGET_ID = "6f1c2b9e-1d2a-4c3b-9a8e-0f1e2d3c4b5a";
const CLOSE_ID = "7a2d3c0f-2e3b-4d4c-8b9f-1a2b3c4d5e6f";

const receiptFor = (r: Partial<GateReceipt>): GateReceipt => ({
  decisionId: BUDGET_ID,
  gateAccountId: "0b5e7c1a-2f3d-4e5f-8a9b-1c2d3e4f5a6b",
  kind: "budget",
  decision: "pass",
  result: "allowed",
  mode: "enforce",
  rules: [],
  amountCents: 100,
  payee: normalAccount(API),
  reference: "",
  inputHash: `0x${"00".repeat(32)}`,
  mandateHash: `0x${"22".repeat(32)}`,
  mandateVersion: 1,
  checkedAt: Math.floor(Date.now() / 1000),
  ...r,
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

/**
 * A fake gate: it opens a $1 budget as the API does, holds each report until `releaseSend`, and
 * closes with `closeAmount` cents (the true amount unless a test lies).
 */
function fakeGate(options: { closeAmount?: (cents: number) => number } = {}) {
  const now = Date.now();
  const input: GateBudgetInput = {
    kind: "budget",
    day: new Date(now).toISOString().slice(0, 10),
    limits: { maxPaymentCents: 1, maxDailyCents: 2_000, maxPaymentsPerHour: null },
    attempt: { account: normalAccount(API), amountCents: 100, reference: "" },
    payees: [{ vendorId: "weather", account: normalAccount(API) }],
    payments: [],
    paymentsLastHour: 0,
    reservedPayments: 0,
    terms: {
      account: normalAccount(API),
      budgetMicros: 1_000_000,
      maxPaymentMicros: 10_000,
      maxPayments: null,
      startsAtMs: now,
      expiresAtMs: now + 3_600_000,
    },
  };
  const reported: { id: string; amountMicros: number; reference: string; at: string }[] = [];
  let releaseSend: () => void = () => undefined;
  const gate = paymentGate({
    apiKey: "bonded_gk_test",
    apiUrl: "https://gate.test",
    receiptKey: SIGNER,
    fetch: (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/payments/budgets") {
        const signed = await signGateReceipt(receiptFor({ inputHash: gateInputHash(input) }), KEY);
        return json({
          id: BUDGET_ID,
          kind: "budget",
          decision: "pass",
          result: "allowed",
          allowed: true,
          mode: "enforce",
          rules: [],
          reasons: [],
          input,
          receipt: signed,
        });
      }
      if (path.endsWith("/spends")) {
        const body = JSON.parse(init!.body as string) as { spends: typeof reported };
        await new Promise<void>((resolve) => (releaseSend = resolve));
        reported.push(...body.spends);
        return json({ problems: [], frozen: false });
      }
      if (path.endsWith("/close")) {
        const close: GateBudgetCloseInput = {
          kind: "budget_close",
          budgetId: BUDGET_ID,
          terms: input.terms,
          spends: reported.map((s) => ({
            id: s.id,
            amountMicros: s.amountMicros,
            reference: s.reference,
            atMs: Date.parse(s.at),
          })),
        };
        const cents = budgetCloseCents(close);
        const signed = await signGateReceipt(
          receiptFor({
            decisionId: CLOSE_ID,
            kind: "budget_close",
            reference: BUDGET_ID,
            amountCents: options.closeAmount ? options.closeAmount(cents) : cents,
            inputHash: gateInputHash(close),
          }),
          KEY,
        );
        return json({ id: CLOSE_ID, kind: "budget_close", input: close, receipt: signed });
      }
      return json({});
    }) as typeof fetch,
  });
  return { gate, reported, release: () => releaseSend() };
}

describe("a hosted budget", () => {
  it("a payment already on its way to the gate can't be taken back", async () => {
    const { gate, reported, release } = fakeGate();
    const budget = await gate.budget({ account: API, amountUsd: 1 });
    const spend = await budget.spend(1_000);
    const sending = budget.flush();
    await new Promise((r) => setTimeout(r, 10));
    expect(budget.release(spend.id)).toBe(false);
    expect(budget.spentMicros).toBe(1_000);
    release();
    await sending;
    expect(reported.map((s) => s.amountMicros)).toEqual([1_000]);
  });

  it("a payment not yet sent can be taken back", async () => {
    const { gate } = fakeGate();
    const budget = await gate.budget({ account: API, amountUsd: 1 });
    const spend = await budget.spend(1_000);
    expect(budget.release(spend.id)).toBe(true);
    expect(budget.spentMicros).toBe(0);
  });

  it("accepts a close whose amount follows from its payments, and refuses one that doesn't", async () => {
    const honest = fakeGate();
    const good = await honest.gate.budget({ account: API, amountUsd: 1 });
    await good.spend(1_000);
    const closing = good.close();
    await new Promise((r) => setTimeout(r, 10));
    honest.release();
    await expect(closing).resolves.toBeUndefined();

    const lying = fakeGate({ closeAmount: (cents) => cents + 50 });
    const bad = await lying.gate.budget({ account: API, amountUsd: 1 });
    await bad.spend(1_000);
    const closingBad = bad.close();
    await new Promise((r) => setTimeout(r, 10));
    lying.release();
    await expect(closingBad).rejects.toThrow(/rules or amount don't follow from its input/);
  });
});
