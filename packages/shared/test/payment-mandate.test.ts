import { describe, expect, it } from "vitest";
import {
  checkInvoicePayment,
  checkRefundPayment,
  describePaymentMandate,
  isVerifiedChange,
  PAYMENT_RULE_WORDS,
  PAYMENT_RULES,
  type PaidPayment,
  paymentLoss,
} from "../src/index.js";

const DAY = "2026-11-02";
const limits = { maxPaymentUsd: 5_000, maxDailyUsd: 8_000 };
const payees = [{ vendorId: "nimbus", account: "GB29 NWBK 6016 1331 9268 19" }];
const invoices = [{ reference: "NIM-88412", vendorId: "nimbus", amountUsd: 612.4 }];
const invoice = (
  attempt: { account: string; amountUsd: number; invoiceReference: string },
  payments: PaidPayment[] = [],
) => checkInvoicePayment({ limits, payees, invoices, payments, day: DAY }, attempt);
const REAL = "GB29NWBK60161331926819";
const FRAUD = "LT12 1000 0111 0100 1000";

describe("payment mandate: invoices", () => {
  it("allows the approved invoice to the vendor's account, matching loosely", () => {
    const check = invoice({
      account: "gb29 nwbk 6016 1331 9268 19",
      amountUsd: 612.4,
      invoiceReference: " nim-88412 ",
    });
    expect(check).toMatchObject({
      ok: true,
      rules: [],
      vendorId: "nimbus",
      lossUsd: 0,
      overpaidUsd: 0,
    });
  });

  it("calls a stranger's account an unknown payee, and all of it lost", () => {
    const check = invoice({ account: FRAUD, amountUsd: 612.4, invoiceReference: "NIM-88412" });
    expect(check).toMatchObject({ ok: true, vendorId: null, lossUsd: 612.4, overpaidUsd: 0 });
    // The fraudster's account has no invoice either.
    expect(check.ok && check.rules).toEqual(["unknown_payee", "unmatched_invoice"]);
  });

  it("calls a second payment a duplicate, and all of it overpaid", () => {
    const paid: PaidPayment[] = [
      {
        account: REAL,
        vendorId: "nimbus",
        amountUsd: 612.4,
        invoiceReference: "NIM-88412",
        day: "2026-10-26",
      },
    ];
    const check = invoice({ account: REAL, amountUsd: 612.4, invoiceReference: "NIM-88412" }, paid);
    expect(check).toMatchObject({ ok: true, rules: ["duplicate_payment"], overpaidUsd: 612.4 });
  });

  it("doesn't count a fraudster's payment of the same reference as settling the invoice", () => {
    const paid: PaidPayment[] = [
      { account: FRAUD, vendorId: null, amountUsd: 612.4, invoiceReference: "NIM-88412", day: DAY },
    ];
    expect(
      invoice({ account: REAL, amountUsd: 612.4, invoiceReference: "NIM-88412" }, paid),
    ).toMatchObject({ rules: [] });
  });

  it("overpays only the difference on an inflated amount", () => {
    const check = invoice({ account: REAL, amountUsd: 700, invoiceReference: "NIM-88412" });
    expect(check).toMatchObject({ rules: ["unmatched_invoice"], lossUsd: 0, overpaidUsd: 87.6 });
  });

  it("applies both caps, and they cost nothing on a correct payment", () => {
    const big = checkInvoicePayment(
      {
        limits,
        payees,
        invoices: [{ reference: "NIM-1", vendorId: "nimbus", amountUsd: 6_000 }],
        payments: [
          {
            account: REAL,
            vendorId: "nimbus",
            amountUsd: 3_000,
            invoiceReference: "NIM-0",
            day: DAY,
          },
        ],
        day: DAY,
      },
      { account: REAL, amountUsd: 6_000, invoiceReference: "NIM-1" },
    );
    expect(big).toMatchObject({
      rules: ["over_payment_cap", "over_daily_cap"],
      lossUsd: 0,
      overpaidUsd: 0,
    });
  });

  it("counts only today's payments toward the daily cap", () => {
    const yesterday: PaidPayment[] = [
      {
        account: REAL,
        vendorId: "nimbus",
        amountUsd: 7_900,
        invoiceReference: "NIM-0",
        day: "2026-11-01",
      },
    ];
    expect(
      invoice({ account: REAL, amountUsd: 612.4, invoiceReference: "NIM-88412" }, yesterday),
    ).toMatchObject({ rules: [] });
  });

  it("rejects malformed amounts and references before any rule", () => {
    expect(invoice({ account: REAL, amountUsd: 0, invoiceReference: "NIM-88412" })).toEqual({
      ok: false,
      error: "amountUsd must be a positive number",
    });
    expect(invoice({ account: REAL, amountUsd: 1.234, invoiceReference: "NIM-88412" })).toEqual({
      ok: false,
      error: "amountUsd has more than two decimals",
    });
    expect(invoice({ account: REAL, amountUsd: 1, invoiceReference: "  " })).toEqual({
      ok: false,
      error: "invoiceReference is required",
    });
  });
});

describe("payment mandate: refunds and bank changes", () => {
  const refunds = [{ reference: "RF-7", account: "DE89 3704 0044 0532 0130 00", amountUsd: 120 }];
  const refund = (account: string, amountUsd: number) =>
    checkRefundPayment(
      { limits, payees, refunds, payments: [], day: DAY },
      { account, amountUsd, invoiceReference: "RF-7" },
    );

  it("allows the approved refund and calls any other account unknown", () => {
    expect(refund("DE89370400440532013000", 120)).toMatchObject({ rules: [] });
    expect(refund(FRAUD, 120)).toMatchObject({
      rules: ["unknown_payee", "unmatched_invoice"],
      lossUsd: 120,
    });
  });

  it("calls a refund to a vendor that isn't on the queue overpaid, not lost", () => {
    expect(refund(REAL, 120)).toMatchObject({ lossUsd: 0, overpaidUsd: 120 });
  });

  it("verifies a bank change only when a ticket covers this vendor and this account", () => {
    const tickets = [{ vendorId: "nimbus", account: "GB11 NWBK 0000 0000 0000 01" }];
    expect(
      isVerifiedChange(tickets, { vendorId: "nimbus", account: "gb11nwbk00000000000001" }),
    ).toBe(true);
    expect(isVerifiedChange(tickets, { vendorId: "nimbus", account: FRAUD })).toBe(false);
    expect(
      isVerifiedChange(tickets, { vendorId: "other", account: "GB11NWBK00000000000001" }),
    ).toBe(false);
  });
});

describe("payment mandate: words", () => {
  it("has plain words for every rule", () => {
    for (const rule of PAYMENT_RULES) expect(PAYMENT_RULE_WORDS[rule]).toBeTruthy();
  });

  it("describes the mandate in plain lines, with its limits and mode", () => {
    const lines = describePaymentMandate({
      mode: "enforce",
      maxPaymentUsd: 5_000,
      maxDailyUsd: 8_000,
      freezeOnBreach: true,
    });
    expect(lines).toContain("No single payment over $5,000.");
    expect(lines).toContain("A payment that breaks a rule is blocked before money moves.");
    expect(lines.at(-1)).toMatch(/first breach/);
    expect(
      describePaymentMandate({
        mode: "monitor",
        maxPaymentUsd: 1,
        maxDailyUsd: 2,
        freezeOnBreach: false,
      }),
    ).toHaveLength(6);
  });

  it("splits a breach's cost by whether the money can come back", () => {
    expect(paymentLoss(10_000, false, undefined, 0)).toEqual({ lossUsd: 100, overpaidUsd: 0 });
    expect(paymentLoss(10_000, true, undefined, 0)).toEqual({ lossUsd: 0, overpaidUsd: 100 });
    // The second half of a split payment: still owed, so nothing overpaid.
    expect(paymentLoss(5_000, true, 10_000, 5_000)).toEqual({ lossUsd: 0, overpaidUsd: 0 });
  });
});
