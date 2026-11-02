import {
  evaluateGateInput,
  gateInputHash,
  gateReceiptHash,
  verifyGateLogProof,
  verifyGateReceipt,
  type GateInput,
  type GateLogProof,
  type SignedGateReceipt,
} from "@bondedhq/shared";
import type { Address, Hex } from "viem";
import { ApiError, request } from "./api";

/**
 * The payment gate's rules page (/gate): the owner's gate accounts, their mandate and its
 * history, the decision log, and a check of each decision anyone could run (apps/api/GATE.md).
 * Each call is one function on `gateApi`, so tests can replace any of them.
 */

/** Where a hash was posted on chain (GateAnchor); null while it isn't. */
export interface AnchorPost {
  chainId: number;
  contract: string;
  /** Null when the keeper found it already posted. */
  txHash: string | null;
  postedAt: string;
}

export interface GateAccount {
  id: string;
  name: string;
  mode: "monitor" | "enforce";
  maxPaymentUsd: number;
  maxDailyUsd: number;
  freezeOnBreach: boolean;
  frozen: boolean;
  frozenAt: string | null;
  mandate: { version: number; hash: string };
  /** The mandate in plain words (`describePaymentMandate`). */
  rules: string[];
  createdAt: string;
}

export interface GateVendor {
  id: string;
  name: string;
  account: string;
}

export interface GateMandateVersion {
  version: number;
  hash: string;
  createdBy: string;
  createdAt: string;
  rules: string[];
  mandate: { vendors: GateVendor[] };
  posted: AnchorPost | null;
}

export interface GateDecision {
  id: string;
  kind: "invoice" | "refund" | "bank_change";
  decision: "pass" | "breach" | "frozen";
  result: "allowed" | "blocked" | "refused";
  message: string;
  rules: string[];
  reasons: { rule: string; words: string }[];
  amountUsd: number;
  payee: string;
  vendorId: string | null;
  reference: string;
  inputHash: string;
  /** What the rules were given; null for decisions made before it was kept. */
  input: GateInput | null;
  mandate: { version: number; hash: string };
  createdAt: string;
  receipt: SignedGateReceipt;
}

export interface GateProof {
  decisionId: string;
  day: string;
  dayNumber: number;
  accountKey: Hex;
  receiptHash: Hex;
  root: Hex;
  proof: GateLogProof;
  posted: AnchorPost | null;
}

export interface Page<T> {
  items: T[];
  next: string | null;
}

const bearer = (session: string) => ({ headers: { Authorization: `Bearer ${session}` } });
const account = (id: string) => `/gate/accounts/${encodeURIComponent(id)}`;
const before = (cursor?: string) => (cursor ? `?before=${encodeURIComponent(cursor)}` : "");

export const gateApi = {
  /** GET /gate/accounts: the signed-in wallet's gate accounts. */
  accounts: (session: string) =>
    request<{ items: GateAccount[] }>("/gate/accounts", bearer(session)),
  /** GET …/vendors: the vendor master, each vendor's verified account. */
  vendors: (session: string, id: string) =>
    request<{ items: GateVendor[] }>(`${account(id)}/vendors`, bearer(session)),
  /** GET …/mandates: every version of the mandate, newest first. */
  mandates: (session: string, id: string, cursor?: string) =>
    request<Page<GateMandateVersion>>(`${account(id)}/mandates${before(cursor)}`, bearer(session)),
  /** GET …/decisions: the decision log, newest first. */
  decisions: (session: string, id: string, cursor?: string) =>
    request<Page<GateDecision>>(`${account(id)}/decisions${before(cursor)}`, bearer(session)),
  /** GET …/decisions/:id/proof: where the receipt sits in its day's log root. */
  proof: (session: string, id: string, decisionId: string) =>
    request<GateProof>(
      `${account(id)}/decisions/${encodeURIComponent(decisionId)}/proof`,
      bearer(session),
    ),
  /** GET /gate/receipt-key: the address every receipt is signed with. Public. */
  receiptKey: () => request<{ address: Address }>("/gate/receipt-key"),
};

/** One check of a decision: passed, failed, or not possible (with why). */
export interface VerifyStep {
  ok: boolean | null;
  detail: string;
}

export interface Verification {
  /** Bonded's signature, against the key the API publishes. */
  signature: VerifyStep;
  /** The receipt's input hash, recomputed from what the rules were given. */
  input: VerifyStep;
  /** The open rule engine, run again on that input. */
  rules: VerifyStep;
  /** The receipt is in its day's log root, the one posted on chain when it is. */
  log: VerifyStep;
}

/**
 * Check a decision the way anyone holding it could: the signature against the published receipt
 * key, the input hash and the rules recomputed in the browser, and the receipt's proof against
 * its day's root. `chainRoot` reads the root posted on chain when the page can reach that chain
 * (it answers null when it can't). Never throws: a step that can't run says why.
 */
export async function verifyDecision(
  decision: GateDecision,
  deps: {
    receiptKey: () => Promise<{ address: Address }>;
    proof: () => Promise<GateProof>;
    chainRoot?: (proof: GateProof) => Promise<Hex | null>;
  },
): Promise<Verification> {
  const { receipt } = decision.receipt;
  const [signature, log] = await Promise.all([
    deps
      .receiptKey()
      .then(async (key) =>
        (await verifyGateReceipt(decision.receipt, key.address))
          ? { ok: true, detail: "Signed by Bonded's published receipt key." }
          : { ok: false, detail: "The signature doesn't match the receipt or the published key." },
      )
      .catch(() => ({ ok: null, detail: "Couldn't load the receipt key. Try again." })),
    checkLog(decision, deps),
  ]);
  let input: VerifyStep;
  let rules: VerifyStep;
  if (!decision.input) {
    const detail = "This decision's input wasn't kept (made before inputs were stored).";
    input = { ok: null, detail };
    rules = { ok: null, detail };
  } else {
    input =
      safe(() => gateInputHash(decision.input!)) === receipt.inputHash
        ? { ok: true, detail: "The input's hash matches the receipt." }
        : { ok: false, detail: "The input's hash doesn't match the receipt." };
    if (receipt.decision === "frozen")
      rules = { ok: null, detail: "The rules didn't run: the account was frozen." };
    else {
      const verdict = safe(() => evaluateGateInput(decision.input!));
      rules =
        verdict?.ok && same(verdict.rules, receipt.rules)
          ? {
              ok: true,
              detail: verdict.rules.length
                ? "The rules, run again here, break the same rules."
                : "The rules, run again here, pass it too.",
            }
          : { ok: false, detail: "The rules, run again here, give a different answer." };
    }
  }
  return { signature, input, rules, log };
}

async function checkLog(
  decision: GateDecision,
  deps: {
    proof: () => Promise<GateProof>;
    chainRoot?: (proof: GateProof) => Promise<Hex | null>;
  },
): Promise<VerifyStep> {
  let proof: GateProof;
  try {
    proof = await deps.proof();
  } catch (e) {
    // 409: the day hasn't ended yet, or its log can't be proved any more.
    return {
      ok: null,
      detail:
        e instanceof ApiError && e.status === 409
          ? e.message
          : "Couldn't load the proof. Try again.",
    };
  }
  const onChain =
    proof.posted && deps.chainRoot ? await deps.chainRoot(proof).catch(() => null) : null;
  const root = onChain ?? proof.root;
  const inRoot = verifyGateLogProof(
    safe(() => gateReceiptHash(decision.receipt.receipt)) ?? "0x",
    proof.proof,
    root,
  );
  if (!inRoot)
    return {
      ok: false,
      detail: onChain
        ? `Not in the root posted on chain for ${proof.day}.`
        : `Not in the log root for ${proof.day}.`,
    };
  return {
    ok: true,
    detail: onChain
      ? `In the root posted on chain for ${proof.day}.`
      : proof.posted
        ? `In the log root for ${proof.day}. It's posted on chain; this page didn't read it there.`
        : `In the log root for ${proof.day}. It isn't posted on chain yet.`,
  };
}

const safe = <T>(fn: () => T): T | undefined => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};
const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
