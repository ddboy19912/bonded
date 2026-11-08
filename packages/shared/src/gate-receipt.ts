import {
  type Address,
  type Hex,
  hashTypedData,
  isAddressEqual,
  recoverTypedDataAddress,
  sha256,
  stringToBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalJson } from "./canonical.js";
import {
  type BudgetSpend,
  type BudgetTerms,
  checkBudget,
  MAX_BUDGET_MS,
  microsToCentsUp,
  replayBudget,
} from "./payment-budget.js";
import {
  checkGeneralPayment,
  checkInvoicePayment,
  checkRefundPayment,
  GATE_RULES,
  isVerifiedChange,
  normalAccount,
  PAYMENT_RULES,
  type GateRule,
  type KnownPayee,
  type PaymentRule,
} from "./payment-mandate.js";

/**
 * The payment gate's check (`POST /payments/check` on the Bonded API): what it checks, the inputs
 * it hashes and the receipt it signs. Anyone holding a receipt and its input can run
 * `evaluateGateInput` and get the same rules, recompute `gateInputHash`, and check Bonded's
 * signature with `verifyGateReceipt`, offline. Amounts are whole cents so every hash is exact.
 */

export const GATE_MODES = ["monitor", "enforce"] as const;
export type GateMode = (typeof GATE_MODES)[number];

/**
 * What a check is about: a supplier invoice, a customer refund, a vendor's bank change, a
 * supplier invoice paid with a gate card (Stripe Issuing asking before a charge, or a card
 * transaction that settled), a payment on an account with invoice matching off, a budget for many
 * small payments to one payee, or the close of a budget with everything spent against it.
 */
export const GATE_CHECK_KINDS = [
  "invoice",
  "refund",
  "bank_change",
  "card",
  "payment",
  "budget",
  "budget_close",
] as const;
export type GateCheckKind = (typeof GATE_CHECK_KINDS)[number];

/** The rule verdict: no rule broken, a rule broken, or not checked (the account is frozen). */
export type GateDecision = "pass" | "breach" | "frozen";
/** What actually happened: let through, stopped by Enforce mode, or refused while frozen. */
export type GateResult = "allowed" | "blocked" | "refused";

/**
 * One version of a gate account's mandate: its mode, limits, freeze setting and vendor master
 * (each vendor's verified account, compared without spaces). Every change makes a new version,
 * and each receipt names the hash of the version it was checked against.
 */
export interface GateMandate {
  mode: GateMode;
  maxPaymentCents: number;
  maxDailyCents: number;
  freezeOnBreach: boolean;
  /** False when payments have no invoices to match. Left out when on. */
  invoiceMatching?: false;
  /** Payments allowed in any hour, with invoice matching off. Left out when there's no limit. */
  maxPaymentsPerHour?: number;
  vendors: {
    id: string;
    name: string;
    account: string;
    /** The vendor's card merchant, when it takes cards: its name and Stripe network id. */
    cardMerchant?: { name: string; networkId: string } | undefined;
  }[];
}

/**
 * The mandate's hash: SHA-256 of its canonical JSON, vendors in id order, accounts normalised. A
 * vendor without a card merchant hashes as it did before card merchants existed, and a mandate
 * with invoice matching on and no hourly limit as it did before those settings existed.
 */
export function gateMandateHash(mandate: GateMandate): Hex {
  const vendors = mandate.vendors
    .map((v) => ({
      id: v.id,
      name: v.name,
      account: normalAccount(v.account),
      ...(v.cardMerchant
        ? { cardMerchant: { name: v.cardMerchant.name, networkId: v.cardMerchant.networkId } }
        : {}),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sha256(stringToBytes(canonicalJson({ ...mandate, vendors })));
}

interface Attempt {
  account: string;
  amountCents: number;
  reference: string;
}
interface Limits {
  maxPaymentCents: number;
  maxDailyCents: number;
}
/** A payment already made, as the duplicate and daily checks see it. */
export interface GatePaidPayment {
  account: string;
  vendorId: string | null;
  amountCents: number;
  reference: string;
  /** UTC day, YYYY-MM-DD. */
  day: string;
  kind: "invoice" | "refund";
}

/**
 * Exactly what the rule engine was given for one check: the attempt and the part of the
 * account's state the rules read (the payees matching the account, the approved invoices or
 * refunds matching it, the payments of the day or of the reference, the tickets for the change).
 * Its hash goes in the receipt.
 */
export type GateInput =
  | {
      kind: "invoice";
      day: string;
      limits: Limits;
      attempt: Attempt;
      payees: KnownPayee[];
      invoices: { reference: string; vendorId: string; amountCents: number }[];
      payments: GatePaidPayment[];
    }
  | {
      kind: "refund";
      day: string;
      limits: Limits;
      attempt: Attempt;
      payees: KnownPayee[];
      refunds: { reference: string; account: string; amountCents: number }[];
      payments: GatePaidPayment[];
    }
  | {
      kind: "bank_change";
      vendorId: string;
      account: string;
      tickets: { vendorId: string; account: string }[];
    }
  | GateCardInput
  | GatePaymentInput
  | GateCardChargeInput
  | GateBudgetInput
  | GateBudgetCloseInput;

/**
 * A budget: many small payments to one payee, checked once (`checkBudget`). `attempt.amountCents`
 * is the budget and `reference` is empty. `terms` is what the gate grants; the receipt's input
 * hash commits to them, and `evaluateGateInput` checks they follow from the rest of the input.
 */
export interface GateBudgetInput {
  kind: "budget";
  day: string;
  limits: Limits & { maxPaymentsPerHour: number | null };
  attempt: Attempt;
  payees: KnownPayee[];
  payments: GatePaidPayment[];
  /** Payments made in the hour before this check. */
  paymentsLastHour: number;
  /** Payments open budgets may still make. */
  reservedPayments: number;
  terms: BudgetTerms;
}

/**
 * A budget's close: its terms and every payment reported against it, in the order they were
 * reported. The receipt's amount is what was spent, in cents rounded up; the input hash commits
 * to each payment's exact amount. `over_budget` when any payment broke the terms.
 */
export interface GateBudgetCloseInput {
  kind: "budget_close";
  /** The budget's decision id. */
  budgetId: string;
  terms: BudgetTerms;
  spends: BudgetSpend[];
}

/** A payment on an account with invoice matching off (`checkGeneralPayment`). */
export interface GatePaymentInput {
  kind: "payment";
  day: string;
  limits: Limits & { maxPaymentsPerHour: number | null };
  /** `reference` is empty when the payment has none. */
  attempt: Attempt;
  payees: KnownPayee[];
  payments: GatePaidPayment[];
  /** Payments made in the hour before this check. */
  paymentsLastHour: number;
}

/** The card programs whose real-time approval question the gate answers (a card hook). */
export const CARD_HOOK_PROVIDERS = ["stripe", "lithic", "marqeta"] as const;
export type CardHookProvider = (typeof CARD_HOOK_PROVIDERS)[number];

/**
 * A charge on a card the business issued in its own card program, which asked the gate before
 * approving it (a card hook). Bonded holds no key for the program. Checked with the general rules
 * (`checkGeneralPayment`), the merchant as the payee: `unknown_payee` when the merchant isn't any
 * vendor's card merchant on file, the limits, and the hourly limit. A charge has no invoice, so
 * invoice matching doesn't apply. A merchant whose category is cash, quasi-cash or gambling
 * (`CARD_HOOK_BLOCKED_MCCS`) breaks `blocked_merchant`.
 */
export interface GateCardChargeInput {
  kind: "card_charge";
  provider: CardHookProvider;
  day: string;
  limits: Limits & { maxPaymentsPerHour: number | null };
  /** `account` is the merchant's key (`cardMerchantKey`); `reference` is empty. */
  attempt: Attempt;
  /** The merchant charging, as the card program reports it. `mcc` is its category code. */
  merchant: { key: string; name: string; mcc: string };
  /** Vendors whose card merchant on file is this merchant. */
  payees: KnownPayee[];
  payments: GatePaidPayment[];
  /** Payments made in the hour before this charge. */
  paymentsLastHour: number;
}

/**
 * Merchant category codes a card hook never lets an agent pay without breaking a rule: cash at a
 * bank or ATM (6010, 6011), financial institutions (6012), money orders and quasi-cash (6051),
 * stored-value loads (6540), wires and money orders (4829), and gambling (7995). The same
 * categories as `CARD_BLOCKED_CATEGORIES`, by code, since every card program reports the code.
 */
export const CARD_HOOK_BLOCKED_MCCS = ["4829", "6010", "6011", "6012", "6051", "6540", "7995"];

/**
 * A charge on a gate card, checked as an invoice payment whose payee is the card merchant
 * (`cardMerchantKey`). The card was issued for one approved invoice of one vendor, and the vendor
 * master holds each vendor's card merchant. On the card path:
 *
 * - `unknown_payee`: the merchant isn't any vendor's merchant on file.
 * - `unverified_vendor_change`: the merchant goes by the card's vendor's name but isn't its
 *   merchant on file, and no verified ticket covers the change (the ticket's account is
 *   `card:<network id>`). A verified ticket makes it the vendor's merchant.
 * - `unmatched_invoice`: no approved invoice of that vendor behind the card, the amount isn't the
 *   invoice's amount, or the merchant's category is cash or quasi-cash
 *   (`CARD_BLOCKED_CATEGORIES`), which is no invoice payment.
 * - `duplicate_payment`: the invoice is already paid, or held by a charge already approved.
 * - `over_payment_cap`, `over_daily_cap`: over the mandate's limits.
 *
 * `stage` is "authorization" when Stripe asks before the charge and "transaction" when money
 * settled. `gateApproved` is false for a transaction the gate never approved (a stand-in or
 * offline authorization, or a force capture): a breach whatever the rules say.
 */
export interface GateCardInput {
  kind: "card";
  stage: "authorization" | "transaction";
  gateApproved: boolean;
  day: string;
  limits: Limits;
  /** `account` is the merchant's key; `reference` the card's invoice. */
  attempt: Attempt;
  /** The vendor the card was issued to pay, and its card merchant on file. */
  vendorId: string;
  vendorMerchant: { key: string; name: string } | null;
  /** The merchant charging, as Stripe reports it (`merchant_data`). */
  merchant: { key: string; name: string; category: string };
  /** Vendors whose card merchant on file is this merchant. */
  payees: KnownPayee[];
  invoices: { reference: string; vendorId: string; amountCents: number }[];
  /** Payments made on the day or against the reference, and charges approved and still held. */
  payments: GatePaidPayment[];
  /** Verified tickets covering this vendor and this merchant. */
  tickets: { vendorId: string; account: string }[];
}

/**
 * Merchant categories a gate card never pays, since they aren't invoice payments: cash (ATM and
 * over the counter) and quasi-cash (money orders, wires, stored-value loads, gambling, other
 * financial institutions). Stripe Issuing's category names
 * (https://docs.stripe.com/issuing/categories). The card blocks them, and a charge from one
 * breaks `unmatched_invoice`.
 */
export const CARD_BLOCKED_CATEGORIES = [
  "automated_cash_disburse",
  "manual_cash_disburse",
  "financial_institutions",
  "non_fi_money_orders",
  "non_fi_stored_value_card_purchase_load",
  "wires_money_orders",
  "betting_casino_gambling",
] as const;

/** The key a card merchant is compared by: "CARD:" and its network id, no spaces, upper case. */
export const cardMerchantKey = (networkId: string) => normalAccount(`card:${networkId}`);

/** Merchant names compare by their letters and digits only, in any case. */
export function sameMerchantName(a: string, b: string): boolean {
  const plain = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return plain(a) !== "" && plain(a) === plain(b);
}

/** SHA-256 of the input's canonical JSON. */
export const gateInputHash = (input: GateInput): Hex => sha256(stringToBytes(canonicalJson(input)));

export type GateVerdict =
  | { ok: false; error: string }
  | {
      ok: true;
      /** Every rule broken, most serious first; empty when the check passes. */
      rules: GateRule[];
      /** The vendor whose verified account is paid, or null. */
      vendorId: string | null;
      /** If it went out: paid to an account outside the vendor master (`paymentLoss`). */
      lossCents: number;
      /** If it went out: paid to a known payee beyond what it was owed. */
      overpaidCents: number;
      /** A card transaction that settled without the gate's approval (kind "card" only). */
      bypassed?: boolean;
    };

const usd = (cents: number) => cents / 100;
const cents = (usd: number) => Math.round(usd * 100);
const paid = (payments: readonly GatePaidPayment[]) =>
  payments.map((p) => ({
    account: p.account,
    vendorId: p.vendorId,
    amountUsd: usd(p.amountCents),
    invoiceReference: p.reference,
    day: p.day,
    ...(p.kind === "refund" ? { kind: "refund" as const } : {}),
  }));

/** Run the shared rule engine (payment-mandate.ts) on a check's input. Same input, same answer. */
export function evaluateGateInput(input: GateInput): GateVerdict {
  if (input.kind === "bank_change") {
    const verified = isVerifiedChange(input.tickets, {
      vendorId: input.vendorId,
      account: input.account,
    });
    return {
      ok: true,
      rules: verified ? [] : ["unverified_vendor_change"],
      vendorId: input.vendorId,
      lossCents: 0,
      overpaidCents: 0,
    };
  }
  if (input.kind === "card") return evaluateCardInput(input);
  if (input.kind === "payment") return evaluatePaymentInput(input);
  if (input.kind === "card_charge") return evaluateCardChargeInput(input);
  if (input.kind === "budget") return evaluateBudgetInput(input);
  if (input.kind === "budget_close") {
    const replay = replayBudget(input.terms, input.spends);
    return {
      ok: true,
      rules: replay.problems.length ? ["over_budget"] : [],
      vendorId: null,
      lossCents: 0,
      overpaidCents: 0,
    };
  }
  const limits = {
    maxPaymentUsd: usd(input.limits.maxPaymentCents),
    maxDailyUsd: usd(input.limits.maxDailyCents),
  };
  const attempt = {
    account: input.attempt.account,
    amountUsd: usd(input.attempt.amountCents),
    invoiceReference: input.attempt.reference,
  };
  const check =
    input.kind === "invoice"
      ? checkInvoicePayment(
          {
            limits,
            payees: input.payees,
            invoices: input.invoices.map((i) => ({ ...i, amountUsd: usd(i.amountCents) })),
            payments: paid(input.payments),
            day: input.day,
          },
          attempt,
        )
      : checkRefundPayment(
          {
            limits,
            payees: input.payees,
            refunds: input.refunds.map((r) => ({ ...r, amountUsd: usd(r.amountCents) })),
            payments: paid(input.payments),
            day: input.day,
          },
          attempt,
        );
  if (!check.ok) return check;
  return {
    ok: true,
    rules: check.rules,
    vendorId: check.vendorId,
    lossCents: cents(check.lossUsd),
    overpaidCents: cents(check.overpaidUsd),
  };
}

/** The card mapping (see `GateCardInput`) on top of the shared invoice check. */
function evaluateCardInput(input: GateCardInput): GateVerdict {
  const merchant = input.merchant.key;
  const verified = isVerifiedChange(input.tickets, { vendorId: input.vendorId, account: merchant });
  // A verified change makes the merchant the vendor's, as a verified bank change does.
  const payees =
    verified &&
    !input.payees.some(
      (p) => p.vendorId === input.vendorId && normalAccount(p.account) === merchant,
    )
      ? [...input.payees, { vendorId: input.vendorId, account: merchant }]
      : input.payees;
  const check = checkInvoicePayment(
    {
      limits: {
        maxPaymentUsd: usd(input.limits.maxPaymentCents),
        maxDailyUsd: usd(input.limits.maxDailyCents),
      },
      payees,
      invoices: input.invoices.map((i) => ({ ...i, amountUsd: usd(i.amountCents) })),
      payments: paid(input.payments),
      day: input.day,
    },
    {
      account: input.attempt.account,
      amountUsd: usd(input.attempt.amountCents),
      invoiceReference: input.attempt.reference,
    },
  );
  if (!check.ok) return check;
  const changed =
    !verified &&
    input.vendorMerchant !== null &&
    input.vendorMerchant.key !== merchant &&
    sameMerchantName(input.vendorMerchant.name, input.merchant.name);
  const broken = new Set<PaymentRule>(check.rules);
  if (changed) broken.add("unverified_vendor_change");
  if ((CARD_BLOCKED_CATEGORIES as readonly string[]).includes(input.merchant.category))
    broken.add("unmatched_invoice");
  // The card pays its own vendor's invoice only: another vendor's merchant charging it, even for
  // an approved invoice of that vendor with the same reference, has no invoice behind this card.
  if (check.vendorId !== null && check.vendorId !== input.vendorId) broken.add("unmatched_invoice");
  return {
    ok: true,
    rules: PAYMENT_RULES.filter((r) => broken.has(r)),
    vendorId: check.vendorId,
    lossCents: cents(check.lossUsd),
    overpaidCents: cents(check.overpaidUsd),
    bypassed: !input.gateApproved,
  };
}

function evaluatePaymentInput(input: GatePaymentInput): GateVerdict {
  const check = checkGeneralPayment(
    {
      limits: {
        maxPaymentUsd: usd(input.limits.maxPaymentCents),
        maxDailyUsd: usd(input.limits.maxDailyCents),
        maxPaymentsPerHour: input.limits.maxPaymentsPerHour,
      },
      payees: input.payees,
      payments: paid(input.payments),
      paymentsLastHour: input.paymentsLastHour,
      day: input.day,
    },
    {
      account: input.attempt.account,
      amountUsd: usd(input.attempt.amountCents),
      invoiceReference: input.attempt.reference,
    },
  );
  if (!check.ok) return check;
  return {
    ok: true,
    rules: check.rules,
    vendorId: check.vendorId,
    lossCents: cents(check.lossUsd),
    overpaidCents: cents(check.overpaidUsd),
  };
}

function evaluateCardChargeInput(input: GateCardChargeInput): GateVerdict {
  const verdict = evaluatePaymentInput({
    kind: "payment",
    day: input.day,
    limits: input.limits,
    attempt: input.attempt,
    payees: input.payees,
    payments: input.payments,
    paymentsLastHour: input.paymentsLastHour,
  });
  if (!verdict.ok || !CARD_HOOK_BLOCKED_MCCS.includes(input.merchant.mcc)) return verdict;
  const rules = new Set([...verdict.rules, "blocked_merchant"]);
  return { ...verdict, rules: GATE_RULES.filter((r) => rules.has(r)) };
}

function evaluateBudgetInput(input: GateBudgetInput): GateVerdict {
  const check = checkBudget(
    {
      limits: {
        maxPaymentUsd: usd(input.limits.maxPaymentCents),
        maxDailyUsd: usd(input.limits.maxDailyCents),
        maxPaymentsPerHour: input.limits.maxPaymentsPerHour,
      },
      payees: input.payees,
      payments: paid(input.payments),
      paymentsLastHour: input.paymentsLastHour,
      reservedPayments: input.reservedPayments,
      day: input.day,
    },
    { account: input.attempt.account, budgetUsd: usd(input.attempt.amountCents) },
  );
  if (!check.ok) return check;
  const t = input.terms;
  const consistent =
    t.account === normalAccount(input.attempt.account) &&
    t.budgetMicros === input.attempt.amountCents * 10_000 &&
    t.maxPayments === check.maxPayments &&
    Number.isSafeInteger(t.maxPaymentMicros) &&
    t.maxPaymentMicros > 0 &&
    t.maxPaymentMicros <= input.limits.maxPaymentCents * 10_000 &&
    t.expiresAtMs > t.startsAtMs &&
    t.expiresAtMs - t.startsAtMs <= MAX_BUDGET_MS;
  if (!consistent) return { ok: false, error: "the budget's terms don't follow from its input" };
  return { ok: true, rules: check.rules, vendorId: check.vendorId, lossCents: 0, overpaidCents: 0 };
}

/** What a budget close's receipt counts as spent: every payment, in whole cents rounded up. */
export const budgetCloseCents = (input: GateBudgetCloseInput) =>
  microsToCentsUp(replayBudget(input.terms, input.spends).spentMicros);

/** A decision as Bonded signs it. */
export interface GateReceipt {
  decisionId: string;
  gateAccountId: string;
  kind: GateCheckKind;
  decision: GateDecision;
  result: GateResult;
  mode: GateMode;
  /** The rules broken, most serious first. */
  rules: GateRule[];
  /**
   * Zero for a bank change. A budget's is the budget; a budget close's is what was spent, rounded
   * up to the cent (the exact amounts are in its input).
   */
  amountCents: number;
  /** The account paid (or, for a bank change, the new account), as `normalAccount` gives it. */
  payee: string;
  /** The reference as given, trimmed; empty for a bank change or a payment without one. */
  reference: string;
  /** `gateInputHash` of the check's input. */
  inputHash: Hex;
  /** `gateMandateHash` of the mandate version it was checked against. */
  mandateHash: Hex;
  mandateVersion: number;
  /** When it was decided, in Unix seconds. */
  checkedAt: number;
}

export interface SignedGateReceipt {
  receipt: GateReceipt;
  /** The receipt key's address, as served at `GET /gate/receipt-key`. */
  signer: Address;
  signature: Hex;
}

/** No chain or contract: a receipt is checked off chain, against the published key. */
export const GATE_RECEIPT_DOMAIN = { name: "Bonded Payment Gate", version: "1" } as const;

export const GATE_RECEIPT_TYPES = {
  GateReceipt: [
    { name: "decisionId", type: "string" },
    { name: "gateAccountId", type: "string" },
    { name: "kind", type: "string" },
    { name: "decision", type: "string" },
    { name: "result", type: "string" },
    { name: "mode", type: "string" },
    { name: "rules", type: "string[]" },
    { name: "amountCents", type: "uint256" },
    { name: "payee", type: "string" },
    { name: "reference", type: "string" },
    { name: "inputHash", type: "bytes32" },
    { name: "mandateHash", type: "bytes32" },
    { name: "mandateVersion", type: "uint256" },
    { name: "checkedAt", type: "uint256" },
  ],
} as const;

/** The receipt as EIP-712 typed data. */
export function gateReceiptTypedData(receipt: GateReceipt) {
  return {
    domain: GATE_RECEIPT_DOMAIN,
    types: GATE_RECEIPT_TYPES,
    primaryType: "GateReceipt" as const,
    message: {
      decisionId: receipt.decisionId,
      gateAccountId: receipt.gateAccountId,
      kind: receipt.kind,
      decision: receipt.decision,
      result: receipt.result,
      mode: receipt.mode,
      rules: [...receipt.rules],
      amountCents: BigInt(receipt.amountCents),
      payee: receipt.payee,
      reference: receipt.reference,
      inputHash: receipt.inputHash,
      mandateHash: receipt.mandateHash,
      mandateVersion: BigInt(receipt.mandateVersion),
      checkedAt: BigInt(receipt.checkedAt),
    },
  };
}

/** The EIP-712 digest the receipt key signs. */
export const gateReceiptHash = (receipt: GateReceipt): Hex =>
  hashTypedData(gateReceiptTypedData(receipt));

export async function signGateReceipt(
  receipt: GateReceipt,
  privateKey: Hex,
): Promise<SignedGateReceipt> {
  const account = privateKeyToAccount(privateKey);
  const signature = await account.signTypedData(gateReceiptTypedData(receipt));
  return { receipt, signer: account.address, signature };
}

/**
 * Whether a receipt was signed by its stated signer and, when given, by `expectedSigner` (the
 * address `GET /gate/receipt-key` publishes). Any edit to the receipt breaks it. Never throws.
 */
export async function verifyGateReceipt(
  signed: SignedGateReceipt,
  expectedSigner?: Address,
): Promise<boolean> {
  try {
    const recovered = await recoverTypedDataAddress({
      ...gateReceiptTypedData(signed.receipt),
      signature: signed.signature,
    });
    if (!isAddressEqual(recovered, signed.signer)) return false;
    return expectedSigner === undefined || isAddressEqual(recovered, expectedSigner);
  } catch {
    return false;
  }
}
