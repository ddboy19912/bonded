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
  checkInvoicePayment,
  checkRefundPayment,
  isVerifiedChange,
  normalAccount,
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

/** What a check is about: a supplier invoice, a customer refund, or a vendor's bank change. */
export const GATE_CHECK_KINDS = ["invoice", "refund", "bank_change"] as const;
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
  vendors: { id: string; name: string; account: string }[];
}

/** The mandate's hash: SHA-256 of its canonical JSON, vendors in id order, accounts normalised. */
export function gateMandateHash(mandate: GateMandate): Hex {
  const vendors = mandate.vendors
    .map((v) => ({ id: v.id, name: v.name, account: normalAccount(v.account) }))
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
    };

/** SHA-256 of the input's canonical JSON. */
export const gateInputHash = (input: GateInput): Hex => sha256(stringToBytes(canonicalJson(input)));

export type GateVerdict =
  | { ok: false; error: string }
  | {
      ok: true;
      /** Every rule broken, most serious first; empty when the check passes. */
      rules: PaymentRule[];
      /** The vendor whose verified account is paid, or null. */
      vendorId: string | null;
      /** If it went out: paid to an account outside the vendor master (`paymentLoss`). */
      lossCents: number;
      /** If it went out: paid to a known payee beyond what it was owed. */
      overpaidCents: number;
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

/** A decision as Bonded signs it. */
export interface GateReceipt {
  decisionId: string;
  gateAccountId: string;
  kind: GateCheckKind;
  decision: GateDecision;
  result: GateResult;
  mode: GateMode;
  /** The rules broken, most serious first. */
  rules: PaymentRule[];
  /** Zero for a bank change. */
  amountCents: number;
  /** The account paid (or, for a bank change, the new account), without spaces, upper case. */
  payee: string;
  /** The invoice or refund reference as given, trimmed; empty for a bank change. */
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
