import { sha256, stringToBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  CARD_BLOCKED_CATEGORIES,
  cardMerchantKey,
  evaluateGateInput,
  gateInputHash,
  gateMandateHash,
  gateReceiptHash,
  sameMerchantName,
  type GateCardInput,
  type GateInput,
  type GateReceipt,
  signGateReceipt,
  verifyGateReceipt,
} from "../src/index.js";

// Throwaway keys, made for this test run.
const KEY = generatePrivateKey();
const OTHER = generatePrivateKey();

const receipt: GateReceipt = {
  decisionId: "6f1c2b9e-1d2a-4c3b-9a8e-0f1e2d3c4b5a",
  gateAccountId: "0b5e7c1a-2f3d-4e5f-8a9b-1c2d3e4f5a6b",
  kind: "invoice",
  decision: "breach",
  result: "blocked",
  mode: "enforce",
  rules: ["unknown_payee", "unmatched_invoice"],
  amountCents: 61_240,
  payee: "LT121000011101001000",
  reference: "NIM-88412",
  inputHash: `0x${"11".repeat(32)}`,
  mandateHash: `0x${"22".repeat(32)}`,
  mandateVersion: 3,
  checkedAt: 1_793_577_600,
};

const invoiceInput: GateInput = {
  kind: "invoice",
  day: "2026-11-02",
  limits: { maxPaymentCents: 500_000, maxDailyCents: 800_000 },
  attempt: { account: "GB29 NWBK 6016 1331 9268 19", amountCents: 61_240, reference: "NIM-88412" },
  payees: [{ vendorId: "nimbus", account: "GB29NWBK60161331926819" }],
  invoices: [{ reference: "NIM-88412", vendorId: "nimbus", amountCents: 61_240 }],
  payments: [],
};

describe("gate receipts", () => {
  it("verify when signed by the stated key, and against the published one", async () => {
    const signed = await signGateReceipt(receipt, KEY);
    expect(signed.signer).toBe(privateKeyToAccount(KEY).address);
    expect(await verifyGateReceipt(signed)).toBe(true);
    expect(await verifyGateReceipt(signed, privateKeyToAccount(KEY).address)).toBe(true);
    expect(await verifyGateReceipt(signed, privateKeyToAccount(OTHER).address)).toBe(false);
  });

  it("fail when any field is edited", async () => {
    const signed = await signGateReceipt(receipt, KEY);
    const edits: Partial<GateReceipt>[] = [
      { result: "allowed" },
      { decision: "pass" },
      { rules: ["unmatched_invoice"] },
      { amountCents: 61_241 },
      { payee: "GB29NWBK60161331926819" },
      { reference: "NIM-88413" },
      { mandateHash: `0x${"33".repeat(32)}` },
      { mandateVersion: 2 },
      { checkedAt: receipt.checkedAt + 1 },
      { gateAccountId: "another" },
    ];
    for (const edit of edits)
      expect(await verifyGateReceipt({ ...signed, receipt: { ...receipt, ...edit } })).toBe(false);
  });

  it("fail when the signer is swapped or the signature is malformed, without throwing", async () => {
    const signed = await signGateReceipt(receipt, KEY);
    const other = await signGateReceipt(receipt, OTHER);
    expect(await verifyGateReceipt({ ...signed, signer: other.signer })).toBe(false);
    expect(await verifyGateReceipt({ ...signed, signature: other.signature })).toBe(false);
    expect(await verifyGateReceipt({ ...signed, signature: "0x1234" })).toBe(false);
  });

  it("hash the same receipt the same way every time", () => {
    expect(gateReceiptHash(receipt)).toBe(gateReceiptHash({ ...receipt }));
    expect(gateReceiptHash(receipt)).not.toBe(gateReceiptHash({ ...receipt, rules: [] }));
  });
});

describe("gate inputs", () => {
  it("hash the same input the same way, whatever its key order", () => {
    const reordered = {
      payments: [],
      invoices: invoiceInput.kind === "invoice" ? invoiceInput.invoices : [],
      payees: invoiceInput.kind === "invoice" ? invoiceInput.payees : [],
      attempt: {
        reference: "NIM-88412",
        amountCents: 61_240,
        account: "GB29 NWBK 6016 1331 9268 19",
      },
      limits: { maxDailyCents: 800_000, maxPaymentCents: 500_000 },
      day: "2026-11-02",
      kind: "invoice",
    } as GateInput;
    expect(gateInputHash(reordered)).toBe(gateInputHash(invoiceInput));
    expect(gateInputHash(invoiceInput)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("run the shared rules: the approved invoice passes, a stranger's account breaks them", () => {
    expect(evaluateGateInput(invoiceInput)).toEqual({
      ok: true,
      rules: [],
      vendorId: "nimbus",
      lossCents: 0,
      overpaidCents: 0,
    });
    if (invoiceInput.kind !== "invoice") throw new Error("unreachable");
    const fraud = evaluateGateInput({
      ...invoiceInput,
      attempt: { ...invoiceInput.attempt, account: "LT12 1000 0111 0100 1000" },
    });
    expect(fraud).toMatchObject({
      ok: true,
      rules: ["unknown_payee", "unmatched_invoice"],
      lossCents: 61_240,
    });
  });

  it("count the day's refunds and payments toward the daily limit, in cents", () => {
    const verdict = evaluateGateInput({
      kind: "refund",
      day: "2026-11-02",
      limits: { maxPaymentCents: 500_000, maxDailyCents: 100_000 },
      attempt: { account: "DE89 3704 0044 0532 0130 00", amountCents: 4_999, reference: "R-1" },
      payees: [],
      refunds: [{ reference: "R-1", account: "DE89370400440532013000", amountCents: 4_999 }],
      payments: [
        {
          account: "GB29NWBK60161331926819",
          vendorId: "nimbus",
          amountCents: 95_002,
          reference: "NIM-1",
          day: "2026-11-02",
          kind: "invoice",
        },
      ],
    });
    expect(verdict).toMatchObject({ ok: true, rules: ["over_daily_cap"] });
  });

  it("pass a bank change only when a ticket covers that vendor and account", () => {
    const change = (account: string) =>
      evaluateGateInput({
        kind: "bank_change",
        vendorId: "nimbus",
        account,
        tickets: [{ vendorId: "nimbus", account: "DE89 3704 0044 0532 0130 00" }],
      });
    expect(change("de89370400440532013000")).toMatchObject({ ok: true, rules: [] });
    expect(change("LT121000011101001000")).toMatchObject({
      ok: true,
      rules: ["unverified_vendor_change"],
    });
  });
});

describe("gate mandates", () => {
  const mandate = {
    mode: "enforce" as const,
    maxPaymentCents: 500_000,
    maxDailyCents: 800_000,
    freezeOnBreach: true,
    vendors: [
      { id: "nimbus", name: "Nimbus", account: "GB29 NWBK 6016 1331 9268 19" },
      { id: "acme", name: "Acme", account: "DE89370400440532013000" },
    ],
  };
  it("hash the same whatever the vendor order or account spacing", () => {
    expect(
      gateMandateHash({
        ...mandate,
        vendors: [
          { id: "acme", name: "Acme", account: "DE89 3704 0044 0532 0130 00" },
          { id: "nimbus", name: "Nimbus", account: "gb29nwbk60161331926819" },
        ],
      }),
    ).toBe(gateMandateHash(mandate));
  });
  it("hash differently when a rule, a limit or a vendor's account changes", () => {
    const hash = gateMandateHash(mandate);
    expect(gateMandateHash({ ...mandate, mode: "monitor" })).not.toBe(hash);
    expect(gateMandateHash({ ...mandate, maxDailyCents: 800_001 })).not.toBe(hash);
    expect(gateMandateHash({ ...mandate, freezeOnBreach: false })).not.toBe(hash);
    expect(
      gateMandateHash({
        ...mandate,
        vendors: [mandate.vendors[0]!, { ...mandate.vendors[1]!, account: "LT121000011101001000" }],
      }),
    ).not.toBe(hash);
  });
  it("hash a vendor without a card merchant as before card merchants, and with one differently", () => {
    // The hash as it was first defined: vendors without a cardMerchant field at all.
    const before = sha256(
      stringToBytes(
        canonicalJson({
          ...mandate,
          vendors: [
            { id: "acme", name: "Acme", account: "DE89370400440532013000" },
            { id: "nimbus", name: "Nimbus", account: "GB29NWBK60161331926819" },
          ],
        }),
      ),
    );
    expect(gateMandateHash(mandate)).toBe(before);
    const withMerchant = {
      ...mandate,
      vendors: [
        { ...mandate.vendors[0]!, cardMerchant: { name: "Nimbus", networkId: "1234" } },
        mandate.vendors[1]!,
      ],
    };
    expect(gateMandateHash(withMerchant)).not.toBe(before);
    expect(
      gateMandateHash({
        ...withMerchant,
        vendors: [
          { ...mandate.vendors[0]!, cardMerchant: { name: "Nimbus", networkId: "9999" } },
          mandate.vendors[1]!,
        ],
      }),
    ).not.toBe(gateMandateHash(withMerchant));
  });
});

describe("card inputs (Stripe Issuing)", () => {
  const nimbus = { key: cardMerchantKey("1234567890"), name: "Nimbus Cloud" };
  const card: GateCardInput = {
    kind: "card",
    stage: "authorization",
    gateApproved: true,
    day: "2026-11-03",
    limits: { maxPaymentCents: 500_000, maxDailyCents: 800_000 },
    attempt: { account: nimbus.key, amountCents: 61_240, reference: "NIM-1" },
    vendorId: "nimbus",
    vendorMerchant: nimbus,
    merchant: { ...nimbus, category: "computer_software_stores" },
    payees: [{ vendorId: "nimbus", account: nimbus.key }],
    invoices: [{ reference: "NIM-1", vendorId: "nimbus", amountCents: 61_240 }],
    payments: [],
    tickets: [],
  };
  const rules = (input: GateInput) => {
    const v = evaluateGateInput(input);
    return v.ok ? v.rules : v.error;
  };
  /** The charge comes from another merchant than the vendor's on file. */
  const from = (networkId: string, name: string) => ({
    ...card,
    attempt: { ...card.attempt, account: cardMerchantKey(networkId) },
    merchant: { key: cardMerchantKey(networkId), name, category: "computer_software_stores" },
    payees: [],
  });

  it("key merchants by network id and compare names by letters and digits", () => {
    expect(cardMerchantKey(" 12 34 ")).toBe("CARD:1234");
    expect(sameMerchantName("Nimbus Cloud", "NIMBUS-CLOUD")).toBe(true);
    expect(sameMerchantName("Nimbus Cloud", "Nimbus Cloud Ltd")).toBe(false);
    expect(sameMerchantName("", "")).toBe(false);
  });

  it("pass the invoice's exact amount at the vendor's merchant, and break the card mapping otherwise", () => {
    expect(rules(card)).toEqual([]);
    // unknown_payee: no vendor's merchant.
    expect(rules(from("9999", "Quick Pay"))).toEqual(["unknown_payee", "unmatched_invoice"]);
    // unverified_vendor_change: the vendor's name on another merchant, no ticket.
    expect(rules(from("5555", "NIMBUS CLOUD"))).toEqual([
      "unknown_payee",
      "unverified_vendor_change",
      "unmatched_invoice",
    ]);
    // unmatched_invoice: more, or less, than the invoice (the mandate pays exact amounts).
    expect(rules({ ...card, attempt: { ...card.attempt, amountCents: 70_000 } })).toEqual([
      "unmatched_invoice",
    ]);
    expect(rules({ ...card, attempt: { ...card.attempt, amountCents: 100 } })).toEqual([
      "unmatched_invoice",
    ]);
    // duplicate_payment: paid, or held by an approved charge.
    const paid = {
      account: nimbus.key,
      vendorId: "nimbus",
      amountCents: 61_240,
      reference: "NIM-1",
      day: "2026-11-03",
      kind: "invoice" as const,
    };
    expect(rules({ ...card, payments: [paid] })).toEqual(["duplicate_payment"]);
    // The caps.
    expect(rules({ ...card, limits: { maxPaymentCents: 100, maxDailyCents: 100 } })).toEqual([
      "over_payment_cap",
      "over_daily_cap",
    ]);
    // Cash and quasi-cash are no invoice payment, whatever the merchant.
    for (const category of CARD_BLOCKED_CATEGORIES)
      expect(rules({ ...card, merchant: { ...card.merchant, category } })).toEqual([
        "unmatched_invoice",
      ]);
  });

  it("accept a merchant change a verified ticket covers, as a bank change", () => {
    const changed = from("5555", "Nimbus Cloud");
    const covered = { ...changed, tickets: [{ vendorId: "nimbus", account: "card:5555" }] };
    expect(rules(covered)).toEqual([]);
    // A ticket for another vendor or merchant covers nothing.
    expect(rules({ ...changed, tickets: [{ vendorId: "acme", account: "card:5555" }] })).toContain(
      "unknown_payee",
    );
  });

  it("flag a transaction the gate never approved as bypassed, whatever the rules say", () => {
    const v = evaluateGateInput({ ...card, stage: "transaction", gateApproved: false });
    expect(v).toMatchObject({ ok: true, rules: [], bypassed: true });
    expect(evaluateGateInput(card)).toMatchObject({ ok: true, bypassed: false });
    // Unpaid invoice, so a stranger's charge is lost money; a known vendor's overcharge isn't.
    expect(evaluateGateInput(from("9999", "Quick Pay"))).toMatchObject({ lossCents: 61_240 });
    expect(
      evaluateGateInput({ ...card, attempt: { ...card.attempt, amountCents: 65_000 } }),
    ).toMatchObject({ lossCents: 0, overpaidCents: 3_760 });
  });
});
