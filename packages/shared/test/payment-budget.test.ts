import { describe, expect, it } from "vitest";
import {
  budgetCloseCents,
  type BudgetTerms,
  budgetSpendProblem,
  checkBudget,
  evaluateGateInput,
  type GateBudgetInput,
  gateInputHash,
  GATE_RULE_WORDS,
  GATE_RULES,
  microsToCentsUp,
  PAYMENT_RULES,
  replayBudget,
  usdToMicros,
} from "../src/index.js";

const API = "0x1111111111111111111111111111111111111111";
const DAY = "2026-11-08";
const limits = { maxPaymentUsd: 1, maxDailyUsd: 20, maxPaymentsPerHour: null };
const base = {
  limits,
  payees: [{ vendorId: "weather", account: API }],
  payments: [],
  paymentsLastHour: 0,
  reservedPayments: 0,
  day: DAY,
};

const terms: BudgetTerms = {
  account: API.toUpperCase(),
  budgetMicros: 50_000, // $0.05
  maxPaymentMicros: 10_000,
  maxPayments: 10,
  startsAtMs: 1_000_000,
  expiresAtMs: 1_000_000 + 3_600_000,
};

describe("micro-dollars", () => {
  it("converts exactly, refuses more than six decimals, and rounds spending up to the cent", () => {
    expect(usdToMicros(0.001)).toBe(1_000);
    expect(usdToMicros(1.234567)).toBe(1_234_567);
    expect(usdToMicros(0.0000001)).toBeUndefined();
    expect(usdToMicros(-1)).toBeUndefined();
    expect(microsToCentsUp(1)).toBe(1);
    expect(microsToCentsUp(10_000)).toBe(1);
    expect(microsToCentsUp(10_001)).toBe(2);
    expect(microsToCentsUp(0)).toBe(0);
  });
});

describe("checkBudget", () => {
  it("allows a budget to a listed payee within the day", () => {
    expect(checkBudget(base, { account: API, budgetUsd: 5 })).toEqual({
      ok: true,
      vendorId: "weather",
      rules: [],
      maxPayments: null,
    });
  });

  it("the budget may be more than the per-payment limit: that limit applies to each payment", () => {
    expect(checkBudget(base, { account: API, budgetUsd: 15 })).toMatchObject({ rules: [] });
  });

  it("breaks unknown_payee and over_daily_cap, counting other budgets' reservations", () => {
    const check = checkBudget(
      {
        ...base,
        payments: [
          { account: API, vendorId: "weather", amountUsd: 18, invoiceReference: "", day: DAY },
        ],
      },
      { account: "0x2222222222222222222222222222222222222222", budgetUsd: 5 },
    );
    expect(check).toMatchObject({ rules: ["unknown_payee", "over_daily_cap"] });
  });

  it("with an hourly limit, covers what's left of it, counting open budgets' payments", () => {
    const hourly = { ...base, limits: { ...limits, maxPaymentsPerHour: 100 } };
    expect(
      checkBudget(
        { ...hourly, paymentsLastHour: 30, reservedPayments: 50 },
        { account: API, budgetUsd: 1 },
      ),
    ).toMatchObject({ rules: [], maxPayments: 20 });
    expect(
      checkBudget(
        { ...hourly, paymentsLastHour: 60, reservedPayments: 40 },
        { account: API, budgetUsd: 1 },
      ),
    ).toMatchObject({ rules: ["over_hourly_limit"], maxPayments: 0 });
  });

  it("refuses a budget that isn't positive whole cents", () => {
    expect(checkBudget(base, { account: API, budgetUsd: 0 })).toMatchObject({ ok: false });
    expect(checkBudget(base, { account: API, budgetUsd: 1.005 })).toMatchObject({ ok: false });
  });
});

describe("budget spends", () => {
  it("fits exact sub-cent payments, and names what breaks the terms", () => {
    const at = terms.startsAtMs + 1_000;
    expect(
      budgetSpendProblem(terms, { spentMicros: 0, payments: 0 }, { amountMicros: 1_000, atMs: at }),
    ).toBeUndefined();
    expect(
      budgetSpendProblem(
        terms,
        { spentMicros: 0, payments: 0 },
        { amountMicros: 10_001, atMs: at },
      ),
    ).toMatch(/per-payment/);
    expect(
      budgetSpendProblem(
        terms,
        { spentMicros: 45_000, payments: 1 },
        { amountMicros: 6_000, atMs: at },
      ),
    ).toMatch(/past the budget/);
    expect(
      budgetSpendProblem(terms, { spentMicros: 0, payments: 10 }, { amountMicros: 1, atMs: at }),
    ).toMatch(/no more payments/);
    expect(
      budgetSpendProblem(
        terms,
        { spentMicros: 0, payments: 0 },
        { amountMicros: 1, atMs: terms.expiresAtMs + 6 * 60_000 },
      ),
    ).toMatch(/expired/);
    expect(
      budgetSpendProblem(terms, { spentMicros: 0, payments: 0 }, { amountMicros: 0.5, atMs: at }),
    ).toMatch(/whole number/);
  });

  it("replay counts every spend, including the ones that broke it", () => {
    const at = terms.startsAtMs;
    const replay = replayBudget(terms, [
      { id: "a", amountMicros: 1_000, reference: "", atMs: at },
      { id: "b", amountMicros: 20_000, reference: "", atMs: at },
      { id: "c", amountMicros: 3_000, reference: "", atMs: at },
    ]);
    expect(replay).toEqual({
      spentMicros: 24_000,
      payments: 3,
      problems: [{ id: "b", problem: "it is over the per-payment limit" }],
    });
  });
});

describe("budget receipts", () => {
  const input: GateBudgetInput = {
    kind: "budget",
    day: DAY,
    limits: { maxPaymentCents: 100, maxDailyCents: 2_000, maxPaymentsPerHour: 100 },
    attempt: { account: API.toUpperCase(), amountCents: 5, reference: "" },
    payees: [{ vendorId: "weather", account: API.toUpperCase() }],
    payments: [],
    paymentsLastHour: 90,
    reservedPayments: 0,
    terms: { ...terms, maxPayments: 10 },
  };

  it("a budget check evaluates to the same rules anyone can rerun", () => {
    expect(evaluateGateInput(input)).toEqual({
      ok: true,
      rules: [],
      vendorId: "weather",
      lossCents: 0,
      overpaidCents: 0,
    });
    expect(gateInputHash(input)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("terms that don't follow from the input don't evaluate", () => {
    for (const bad of [
      { maxPayments: 11 },
      { budgetMicros: 60_000 },
      { maxPaymentMicros: 1_000_001 },
      { expiresAtMs: terms.startsAtMs + 3_600_001 },
      { account: "0X2222222222222222222222222222222222222222" },
    ])
      expect(evaluateGateInput({ ...input, terms: { ...input.terms, ...bad } })).toMatchObject({
        ok: false,
      });
  });

  it("a close is over_budget when any spend broke the terms; its amount is the spend, rounded up", () => {
    const close = {
      kind: "budget_close" as const,
      budgetId: "b-1",
      terms,
      spends: [
        { id: "a", amountMicros: 1_000, reference: "0xabc", atMs: terms.startsAtMs },
        { id: "b", amountMicros: 2_500, reference: "", atMs: terms.startsAtMs },
      ],
    };
    expect(evaluateGateInput(close)).toMatchObject({ ok: true, rules: [] });
    expect(budgetCloseCents(close)).toBe(1);
    const over = {
      ...close,
      spends: [
        ...close.spends,
        { id: "c", amountMicros: 60_000, reference: "", atMs: terms.startsAtMs },
      ],
    };
    expect(evaluateGateInput(over)).toMatchObject({ rules: ["over_budget"] });
    expect(budgetCloseCents(over)).toBe(7);
  });

  it("over_budget is a gate-only rule with words, outside the rated rules", () => {
    expect(GATE_RULES).toContain("over_budget");
    expect(PAYMENT_RULES as readonly string[]).not.toContain("over_budget");
    expect(GATE_RULE_WORDS.over_budget).toBe("it spent beyond its budget");
  });
});
