import { describe, expect, it, vi } from "vitest";
import {
  BondedError,
  guardPayments,
  guardVendorChanges,
  PAYMENT_RULE_WORDS,
  PaymentBlockedError,
  type PaymentBreach,
  PaymentFrozenError,
  paymentGuard,
  type PaymentGuardOptions,
  type PaymentGuardState,
  type PaymentMandate,
  type PaymentRule,
} from "../src/index.js";

const ACME = "DE89 3704 0044 0532 0130 00";
const NIMBUS = "GB29NWBK60161331926819";
const NIMBUS_NEW = "GB33BUKB20201555555555";
const CUSTOMER = "FR7630006000011234567890189";
const FRAUD = "LT12 1000 0111 0100 1000";

const vendors = [
  { id: "acme", name: "Acme Supplies", account: ACME },
  { id: "nimbus", name: "Nimbus Cloud", account: NIMBUS },
];
const invoices = [
  { reference: "ACM-2291", vendorId: "acme", amountUsd: 1840.5 },
  { reference: "NIM-88412", vendorId: "nimbus", amountUsd: 9000 },
];
const refunds = [{ reference: "RF-4412", account: CUSTOMER, amountUsd: 640 }];
const changes = [{ vendorId: "nimbus", account: NIMBUS_NEW }];

const acmeInvoice = { account: ACME, amountUsd: 1840.5, invoiceReference: "ACM-2291" };
const nimbusInvoice = { account: NIMBUS, amountUsd: 9000, invoiceReference: "NIM-88412" };

const mandate = (overrides: Partial<PaymentMandate> = {}): PaymentMandate => ({
  mode: "enforce",
  maxPaymentUsd: 10_000,
  maxDailyUsd: 10_000,
  freezeOnBreach: false,
  ...overrides,
});

/** A guard over the test's vendor master, with a pay function that records what it was asked. */
function setup(options: Partial<PaymentGuardOptions> = {}) {
  const breaches: PaymentBreach[] = [];
  const guard = paymentGuard({
    mandate: mandate(),
    vendors,
    invoices,
    refunds,
    changes,
    onBreach: (b) => void breaches.push(b),
    now: () => new Date("2026-11-02T10:00:00Z"),
    ...options,
  });
  const bank = vi.fn(
    async (payment: { account: string; amountUsd: number; reference?: string }) => ({
      status: "paid",
      to: payment.account,
    }),
  );
  const pay = guardPayments(bank, { guard });
  return { guard, bank, pay, breaches };
}

/** One case per rule: the payments made first, then the one that breaks it. */
const RULE_CASES: {
  rule: PaymentRule;
  rules: PaymentRule[];
  before?: (typeof acmeInvoice)[];
  attempt: typeof acmeInvoice;
  mandate?: Partial<PaymentMandate>;
}[] = [
  {
    rule: "unknown_payee",
    rules: ["unknown_payee", "unmatched_invoice"],
    attempt: { ...acmeInvoice, account: FRAUD },
  },
  {
    rule: "duplicate_payment",
    rules: ["duplicate_payment"],
    before: [acmeInvoice],
    attempt: { ...acmeInvoice, invoiceReference: "acm-2291 " },
  },
  {
    rule: "unmatched_invoice",
    rules: ["unmatched_invoice"],
    attempt: { ...acmeInvoice, amountUsd: 1940.5 },
  },
  {
    rule: "over_payment_cap",
    rules: ["over_payment_cap"],
    attempt: nimbusInvoice,
    mandate: { maxPaymentUsd: 5_000, maxDailyUsd: 50_000 },
  },
  {
    rule: "over_daily_cap",
    rules: ["over_daily_cap"],
    before: [acmeInvoice],
    attempt: nimbusInvoice,
  },
];

describe("PaymentGuard in Enforce mode", () => {
  it.each(RULE_CASES)("blocks $rule without calling the pay function", async (c) => {
    const { pay, bank, breaches, guard } = setup({ mandate: mandate(c.mandate) });
    for (const p of c.before ?? []) await pay(p);
    bank.mockClear();

    const error = await pay(c.attempt).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentBlockedError);
    const blocked = error as PaymentBlockedError;
    expect(blocked.code).toBe("PAYMENT_BLOCKED");
    expect(blocked.breach.rules).toEqual(c.rules);
    expect(blocked.breach.blocked).toBe(true);
    for (const rule of c.rules) expect(blocked.message).toContain(PAYMENT_RULE_WORDS[rule]);
    expect(blocked.message).toMatch(/^payment blocked by the mandate: .*Nothing was paid$/);
    expect(bank).not.toHaveBeenCalled();
    expect(breaches).toEqual([blocked.breach]);
    // A blocked payment isn't recorded.
    expect(guard.state().payments).toHaveLength(c.before?.length ?? 0);
  });

  it("blocks an unverified bank change without calling the update function", async () => {
    const { guard, breaches } = setup();
    const update = vi.fn(async () => "updated");
    const change = guardVendorChanges(update, { guard });
    const error = await change({ vendorId: "acme", account: FRAUD }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentBlockedError);
    expect((error as PaymentBlockedError).breach).toMatchObject({
      kind: "vendor_change",
      rules: ["unverified_vendor_change"],
      reasons: [PAYMENT_RULE_WORDS.unverified_vendor_change],
      blocked: true,
      vendorId: "acme",
    });
    expect((error as Error).message).toMatch(/^bank change blocked by the mandate: .*changed$/);
    expect(update).not.toHaveBeenCalled();
    expect(breaches).toHaveLength(1);
    expect(guard.state().unverifiedChanges).toEqual([]);
  });

  it("lets correct payments, refunds and verified changes through, and reports nothing", async () => {
    const { guard, pay, bank, breaches } = setup();
    await expect(pay(acmeInvoice)).resolves.toEqual({ status: "paid", to: ACME });
    const refund = guardPayments(bank, { guard, kind: "refund" });
    await refund({ account: CUSTOMER, amountUsd: 640, reference: "RF-4412" });
    const update = vi.fn(async () => "updated");
    await expect(
      guardVendorChanges(update, { guard })({ vendorId: "nimbus", account: NIMBUS_NEW }),
    ).resolves.toBe("updated");
    expect(bank).toHaveBeenCalledTimes(2);
    expect(breaches).toEqual([]);
    expect(guard.state().payments).toEqual([
      {
        account: ACME,
        vendorId: "acme",
        amountUsd: 1840.5,
        invoiceReference: "ACM-2291",
        day: "2026-11-02",
      },
      {
        account: CUSTOMER,
        vendorId: null,
        amountUsd: 640,
        invoiceReference: "RF-4412",
        day: "2026-11-02",
        kind: "refund",
      },
    ]);
  });

  it("treats a verified ticket's account as the vendor's", async () => {
    const { pay, breaches } = setup({ mandate: mandate({ maxDailyUsd: 50_000 }) });
    await pay({ ...nimbusInvoice, account: NIMBUS_NEW });
    expect(breaches).toEqual([]);
  });

  it("blocks a refund to an account the refund queue doesn't name", async () => {
    const { guard, bank } = setup();
    const refund = guardPayments(bank, { guard, kind: "refund" });
    await expect(
      refund({ account: FRAUD, amountUsd: 640, reference: "RF-4412" }),
    ).rejects.toMatchObject({ breach: { rules: ["unknown_payee", "unmatched_invoice"] } });
    expect(bank).not.toHaveBeenCalled();
  });

  it("refuses a payment it can't check, in either mode", async () => {
    for (const mode of ["enforce", "monitor"] as const) {
      const { pay, bank, breaches } = setup({ mandate: mandate({ mode }) });
      await expect(pay({ ...acmeInvoice, amountUsd: -5 })).rejects.toMatchObject({
        code: "INVALID_PAYMENT",
      });
      await expect(pay({ account: ACME } as typeof acmeInvoice)).rejects.toBeInstanceOf(
        BondedError,
      );
      expect(bank).not.toHaveBeenCalled();
      expect(breaches).toEqual([]);
    }
  });

  it("checks payments one at a time, so the same invoice can't be paid twice at once", async () => {
    const { pay, bank } = setup();
    const results = await Promise.allSettled([pay(acmeInvoice), pay(acmeInvoice)]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(bank).toHaveBeenCalledTimes(1);
  });

  it("records nothing when the pay function fails, so a retry isn't a duplicate", async () => {
    const { guard, breaches } = setup();
    const failing = vi
      .fn()
      .mockRejectedValueOnce(new Error("bank timeout"))
      .mockResolvedValue("ok");
    const pay = guardPayments(failing, { guard });
    await expect(pay(acmeInvoice)).rejects.toThrow("bank timeout");
    await expect(pay(acmeInvoice)).resolves.toBe("ok");
    expect(breaches).toEqual([]);
    expect(guard.state().payments).toHaveLength(1);
  });

  it("check() gives the verdict without paying or recording", async () => {
    const { guard } = setup();
    const verdict = await guard.check({ ...acmeInvoice, account: FRAUD });
    expect(verdict).toMatchObject({
      rules: ["unknown_payee", "unmatched_invoice"],
      reasons: [PAYMENT_RULE_WORDS.unknown_payee, PAYMENT_RULE_WORDS.unmatched_invoice],
      lossUsd: 1840.5,
      frozen: false,
    });
    expect(guard.state().payments).toEqual([]);
  });

  it("reads the vendor master and invoices from functions on every check", async () => {
    let approved = [] as typeof invoices;
    const { pay, bank } = setup({ invoices: async () => approved });
    await expect(pay(acmeInvoice)).rejects.toBeInstanceOf(PaymentBlockedError);
    approved = invoices;
    await pay(acmeInvoice);
    expect(bank).toHaveBeenCalledTimes(1);
  });
});

describe("PaymentGuard in Monitor mode", () => {
  it.each(RULE_CASES)("lets $rule through and reports it", async (c) => {
    const { pay, bank, breaches, guard } = setup({
      mandate: mandate({ ...c.mandate, mode: "monitor" }),
    });
    for (const p of c.before ?? []) await pay(p);
    bank.mockClear();

    await expect(pay(c.attempt)).resolves.toEqual({ status: "paid", to: c.attempt.account });
    expect(bank).toHaveBeenCalledTimes(1);
    expect(breaches).toHaveLength(1);
    expect(breaches[0]).toMatchObject({
      kind: "invoice",
      rules: c.rules,
      reasons: c.rules.map((r) => PAYMENT_RULE_WORDS[r]),
      blocked: false,
      account: c.attempt.account,
      amountUsd: c.attempt.amountUsd,
      day: "2026-11-02",
    });
    expect(guard.state().payments).toHaveLength((c.before?.length ?? 0) + 1);
  });

  it("reports a payment to an unknown account as lost", async () => {
    const { pay, breaches } = setup({ mandate: mandate({ mode: "monitor" }) });
    await pay({ ...acmeInvoice, account: FRAUD });
    expect(breaches[0]).toMatchObject({ lossUsd: 1840.5, overpaidUsd: 0 });
  });

  it("lets an unverified bank change through, but never pays its account as the vendor's", async () => {
    // The builder's vendor master, which the change below writes to.
    const master = vendors.map((v) => ({ ...v }));
    const { guard, pay, breaches } = setup({
      mandate: mandate({ mode: "monitor" }),
      vendors: () => master,
    });
    const update = vi.fn(async (change: { vendorId: string; account: string }) => {
      master.find((v) => v.id === change.vendorId)!.account = change.account;
    });
    await guardVendorChanges(update, { guard })({ vendorId: "acme", account: FRAUD });
    expect(update).toHaveBeenCalledTimes(1);
    expect(breaches[0]).toMatchObject({ rules: ["unverified_vendor_change"], blocked: false });
    expect(guard.state().unverifiedChanges).toEqual([{ vendorId: "acme", account: FRAUD }]);

    await pay({ ...acmeInvoice, account: FRAUD });
    expect(breaches[1]).toMatchObject({ rules: ["unknown_payee", "unmatched_invoice"] });
  });

  it("treats a 'change' to the vendor's own account as no change, so it stays payable", async () => {
    const { guard, pay, bank, breaches } = setup({ mandate: mandate({ mode: "monitor" }) });
    const update = vi.fn(async () => undefined);
    await guardVendorChanges(update, { guard })({
      vendorId: "acme",
      account: "de89370400440532013000",
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(breaches).toEqual([]);
    expect(guard.state().unverifiedChanges).toEqual([]);

    await pay(acmeInvoice);
    expect(bank).toHaveBeenCalledTimes(1);
    expect(breaches).toEqual([]);
  });
});

describe("PaymentGuard with invoice matching off", () => {
  const general = (overrides: Partial<PaymentMandate> = {}) =>
    mandate({ invoiceMatching: false, ...overrides });

  it("pays a listed vendor with no invoice and no reference", async () => {
    const { guard, breaches } = setup({ mandate: general(), invoices: [] });
    const pay = vi.fn(async () => "paid");
    await expect(guard.pay({ account: ACME, amountUsd: 42 }, pay)).resolves.toBe("paid");
    expect(pay).toHaveBeenCalledOnce();
    expect(breaches).toEqual([]);
  });

  it("takes a payment with no reference through guardPayments", async () => {
    const { guard } = setup({ mandate: general(), invoices: [] });
    const bank = vi.fn(async (p: { account: string; amountUsd: number }) => p.amountUsd);
    await expect(guardPayments(bank, { guard })({ account: ACME, amountUsd: 42 })).resolves.toBe(
      42,
    );
  });

  it("blocks an account off the list", async () => {
    const { guard } = setup({ mandate: general() });
    const pay = vi.fn();
    await expect(guard.pay({ account: FRAUD, amountUsd: 42 }, pay)).rejects.toBeInstanceOf(
      PaymentBlockedError,
    );
    expect(pay).not.toHaveBeenCalled();
  });

  it("holds the hourly limit, and an hour later allows more", async () => {
    let now = new Date("2026-11-02T10:00:00Z");
    const { guard, breaches } = setup({
      mandate: general({ maxPaymentsPerHour: 2 }),
      now: () => now,
    });
    const pay = async () => "paid";
    await guard.pay({ account: ACME, amountUsd: 1 }, pay);
    await guard.pay({ account: ACME, amountUsd: 1 }, pay);
    await expect(guard.pay({ account: ACME, amountUsd: 1 }, pay)).rejects.toBeInstanceOf(
      PaymentBlockedError,
    );
    expect(breaches[0]).toMatchObject({
      rules: ["over_hourly_limit"],
      reasons: ["too many payments in the last hour"],
    });
    now = new Date("2026-11-02T11:00:01Z");
    await expect(guard.pay({ account: ACME, amountUsd: 1 }, pay)).resolves.toBe("paid");
  });

  it("still needs an approved refund for a refund", async () => {
    const { guard } = setup({ mandate: general() });
    await expect(
      guard.pay({ account: CUSTOMER, amountUsd: 1, invoiceReference: "RF-404" }, vi.fn(), "refund"),
    ).rejects.toBeInstanceOf(PaymentBlockedError);
  });

  it("keeps matching invoices unless the mandate says otherwise", async () => {
    const { guard } = setup();
    await expect(guard.pay({ account: ACME, amountUsd: 42 }, vi.fn())).rejects.toMatchObject({
      code: "INVALID_PAYMENT",
    });
  });
});

describe("freeze on breach", () => {
  it("Enforce: a blocked breach freezes the guard; every later payment is refused until unfrozen", async () => {
    const { guard, pay, bank } = setup({ mandate: mandate({ freezeOnBreach: true }) });
    await expect(pay({ ...acmeInvoice, account: FRAUD })).rejects.toBeInstanceOf(
      PaymentBlockedError,
    );
    expect(guard.frozen).toBe(true);
    const error = await pay(acmeInvoice).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaymentFrozenError);
    expect((error as PaymentFrozenError).code).toBe("PAYMENT_FROZEN");
    await expect(
      guardVendorChanges(vi.fn(), { guard })({ vendorId: "nimbus", account: NIMBUS_NEW }),
    ).rejects.toBeInstanceOf(PaymentFrozenError);
    expect(bank).not.toHaveBeenCalled();

    await guard.unfreeze();
    await pay(acmeInvoice);
    expect(bank).toHaveBeenCalledTimes(1);
  });

  it("Monitor: the breaching payment goes through, then the guard refuses", async () => {
    const { guard, pay, bank } = setup({
      mandate: mandate({ mode: "monitor", freezeOnBreach: true }),
    });
    await pay({ ...acmeInvoice, account: FRAUD });
    expect(bank).toHaveBeenCalledTimes(1);
    expect(guard.frozen).toBe(true);
    await expect(pay(acmeInvoice)).rejects.toBeInstanceOf(PaymentFrozenError);
    expect(bank).toHaveBeenCalledTimes(1);
  });
});

describe("persisting the guard's state", () => {
  it("round-trips through onStateChange and state", async () => {
    let saved: PaymentGuardState | undefined;
    const persist = vi.fn((state: PaymentGuardState) => {
      saved = JSON.parse(JSON.stringify(state)) as PaymentGuardState;
    });
    const first = setup({
      mandate: mandate({ mode: "monitor", freezeOnBreach: true }),
      onStateChange: persist,
    });
    await first.pay(acmeInvoice);
    expect(saved?.payments).toHaveLength(1);
    await guardVendorChanges(vi.fn(), { guard: first.guard })({ vendorId: "acme", account: FRAUD });
    expect(saved).toEqual(first.guard.state());
    expect(saved).toMatchObject({
      frozen: true,
      unverifiedChanges: [{ vendorId: "acme", account: FRAUD }],
    });

    // A restarted process picks up where it left off: still frozen.
    const second = setup({ mandate: mandate({ mode: "monitor" }), state: saved });
    expect(second.guard.frozen).toBe(true);
    await expect(second.pay(nimbusInvoice)).rejects.toBeInstanceOf(PaymentFrozenError);
    await second.guard.unfreeze();
    // ... and remembers the payment made before the restart.
    await second.pay(acmeInvoice);
    expect(second.breaches[0]).toMatchObject({ rules: ["duplicate_payment"] });
    expect(second.guard.state().payments).toHaveLength(2);
  });

  it("copies the state in and out, so callers can't change it behind the guard", async () => {
    const state: PaymentGuardState = { payments: [], frozen: false, unverifiedChanges: [] };
    const { guard, pay } = setup({ state });
    await pay(acmeInvoice);
    expect(state.payments).toEqual([]);
    guard.state().payments.length = 0;
    expect(guard.state().payments).toHaveLength(1);
  });
});
