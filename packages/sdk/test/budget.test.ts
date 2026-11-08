import { describe, expect, it } from "vitest";
import {
  PaymentBlockedError,
  type PaymentBreach,
  PaymentFrozenError,
  paymentGuard,
  type PaymentGuardState,
  type PaymentMandate,
} from "../src/index.js";

const API = "0x1111111111111111111111111111111111111111";

function guardFor(extra: Partial<PaymentMandate> = {}, state?: PaymentGuardState) {
  const breaches: PaymentBreach[] = [];
  const saved: PaymentGuardState[] = [];
  let now = Date.parse("2026-11-08T10:00:00Z");
  const guard = paymentGuard({
    mandate: {
      mode: "enforce",
      maxPaymentUsd: 0.01,
      maxDailyUsd: 5,
      freezeOnBreach: false,
      invoiceMatching: false,
      ...extra,
    },
    vendors: [{ id: "api", account: API }],
    onBreach: (b) => void breaches.push(b),
    onStateChange: (s) => void saved.push(s),
    now: () => new Date(now),
    ...(state ? { state } : {}),
  });
  return { guard, breaches, saved, tick: (ms: number) => (now += ms) };
}

describe("local budgets", () => {
  it("checks the budget once, then counts exact payments with no rule check each", async () => {
    const { guard } = guardFor();
    const budget = await guard.budget({ account: API, amountUsd: 0.05 });
    expect(budget.terms).toMatchObject({
      budgetMicros: 50_000,
      maxPaymentMicros: 10_000,
      maxPayments: null,
    });
    await budget.spend(1_000);
    await budget.spend(2_500);
    expect([budget.spentMicros, budget.payments]).toEqual([3_500, 2]);
    expect(guard.state().budgets).toMatchObject([
      { id: budget.id, spentMicros: 3_500, payments: 2 },
    ]);
    await budget.close();
    expect(guard.state().payments.map((p) => p.amountUsd)).toEqual([0.01]);
    expect(guard.state().budgets).toEqual([]);
    await expect(budget.spend(1)).rejects.toThrow(/the budget is closed/);
  });

  it("Enforce blocks a payment past the terms without counting it", async () => {
    const { guard, breaches } = guardFor();
    const budget = await guard.budget({ account: API, amountUsd: 0.01 });
    await budget.spend(9_000);
    const error = await budget.spend(2_000).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentBlockedError);
    expect((error as Error).message).toMatch(/it spent beyond its budget: it goes past the budget/);
    expect(budget.spentMicros).toBe(9_000);
    expect(breaches.map((b) => [b.kind, b.rules, b.decisionId])).toEqual([
      ["budget", ["over_budget"], budget.id],
    ]);
  });

  it("a breach freezes the guard when the mandate says so, and a frozen guard spends nothing", async () => {
    const { guard } = guardFor({ freezeOnBreach: true });
    const budget = await guard.budget({ account: API, amountUsd: 0.01 });
    await expect(budget.spend(20_000)).rejects.toBeInstanceOf(PaymentBlockedError);
    expect(guard.frozen).toBe(true);
    await expect(budget.spend(1_000)).rejects.toBeInstanceOf(PaymentFrozenError);
    await expect(guard.budget({ account: API, amountUsd: 0.01 })).rejects.toBeInstanceOf(
      PaymentFrozenError,
    );
  });

  it("a released payment stops counting", async () => {
    const { guard } = guardFor();
    const budget = await guard.budget({ account: API, amountUsd: 0.01 });
    const spend = await budget.spend(5_000);
    expect(budget.release(spend.id)).toBe(true);
    expect(budget.release(spend.id)).toBe(false);
    expect(budget.spentMicros).toBe(0);
  });

  it("refuses an unlisted payee or a budget past the day, and needs invoice matching off", async () => {
    const { guard, breaches } = guardFor();
    await expect(
      guard.budget({ account: "0x2222222222222222222222222222222222222222", amountUsd: 1 }),
    ).rejects.toThrow(/not in the vendor master/);
    await expect(guard.budget({ account: API, amountUsd: 6 })).rejects.toThrow(
      /over the daily limit/,
    );
    expect(breaches.map((b) => b.rules)).toEqual([["unknown_payee"], ["over_daily_cap"]]);
    const matching = guardFor({ invoiceMatching: true });
    await expect(matching.guard.budget({ account: API, amountUsd: 1 })).rejects.toThrow(
      /invoiceMatching: false/,
    );
  });

  it("the hourly limit counts budget payments and open budgets' room", async () => {
    const { guard, tick } = guardFor({ maxPaymentsPerHour: 3 });
    const first = await guard.budget({ account: API, amountUsd: 0.05 });
    expect(first.terms.maxPayments).toBe(3);
    await expect(guard.budget({ account: API, amountUsd: 0.05 })).rejects.toThrow(
      /too many payments in the last hour/,
    );
    await first.spend(1_000);
    await first.close();
    const second = await guard.budget({ account: API, amountUsd: 0.05 });
    expect(second.terms.maxPayments).toBe(2);
    await second.close();
    tick(3_600_001);
    expect((await guard.budget({ account: API, amountUsd: 0.05 })).terms.maxPayments).toBe(3);
  });

  it("an expired budget refuses payments and is closed when the next one opens", async () => {
    const { guard, tick } = guardFor();
    const budget = await guard.budget({ account: API, amountUsd: 0.05, ttlSeconds: 60 });
    await budget.spend(1_000);
    tick(60_000);
    await expect(budget.spend(1_000)).rejects.toThrow(/after the budget expired/);
    await guard.budget({ account: API, amountUsd: 0.05 });
    expect(guard.state().payments.map((p) => p.amountUsd)).toEqual([0.01, 0.05]);
  });

  it("budgets saved in state survive a restart and close when they expire", async () => {
    const first = guardFor();
    await (await first.guard.budget({ account: API, amountUsd: 1, ttlSeconds: 60 })).spend(4_000);
    const restored = guardFor({}, first.saved.at(-1));
    restored.tick(61_000);
    await restored.guard.budget({ account: API, amountUsd: 0.05 });
    expect(restored.guard.state().payments.map((p) => p.amountUsd)).toEqual([0.01, 0.05]);
  });
});
