import {
  evaluateGateInput,
  gateAccountKey,
  gateDayNumber,
  gateInputHash,
  gateReceiptDay,
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
 * Where to read a day's root on chain: the account and the day come from the signed receipt, never
 * from the API, and `posted` is what the API says about it.
 */
export interface ChainRootQuery {
  accountKey: Hex;
  dayNumber: number;
  posted: AnchorPost | null;
}

const ZERO_ROOT = `0x${"0".repeat(64)}`;

/**
 * Check a decision the way anyone holding it could: the signature against the published receipt
 * key, that the signed receipt says what the page shows, the input hash and the rules recomputed in
 * the browser, and the receipt's proof against its day's root. `chainRoot` reads the root posted on
 * chain, from the app's own GateAnchor address, for the receipt's account and day: it answers the
 * zero hash when none is posted, and null when it can't read it. Never throws: a step that can't
 * run says why.
 */
export async function verifyDecision(
  decision: GateDecision,
  deps: {
    receiptKey: () => Promise<{ address: Address }>;
    proof: () => Promise<GateProof>;
    chainRoot?: (at: ChainRootQuery) => Promise<Hex | null>;
  },
): Promise<Verification> {
  const { receipt } = decision.receipt;
  const [signature, log] = await Promise.all([
    deps
      .receiptKey()
      .then(async (key): Promise<VerifyStep> => {
        if (!(await verifyGateReceipt(decision.receipt, key.address)))
          return {
            ok: false,
            detail: "The signature doesn't match the receipt or the published key.",
          };
        const differs = shownDiffers(decision);
        return differs
          ? {
              ok: false,
              detail: `Signed by Bonded, but the receipt doesn't match the decision shown here (its ${differs}).`,
            }
          : { ok: true, detail: "Signed by Bonded's published receipt key." };
      })
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

/**
 * The first thing the page shows about a decision that its signed receipt doesn't say, or null.
 * The signature only vouches for the receipt, so what is shown has to match it.
 */
function shownDiffers(decision: GateDecision): string | null {
  const r = decision.receipt.receipt;
  const checks: [string, boolean][] = [
    ["decision id", r.decisionId === decision.id],
    ["kind", r.kind === decision.kind],
    ["decision", r.decision === decision.decision],
    ["result", r.result === decision.result],
    ["rules", same(r.rules, decision.rules)],
    ["amount", r.amountCents === Math.round(decision.amountUsd * 100)],
    ["payee", r.payee === decision.payee],
    ["reference", r.reference === decision.reference],
    ["input hash", r.inputHash === decision.inputHash],
    ["mandate version", r.mandateVersion === decision.mandate.version],
    ["mandate hash", r.mandateHash.toLowerCase() === decision.mandate.hash.toLowerCase()],
  ];
  return checks.find(([, ok]) => !ok)?.[0] ?? null;
}

async function checkLog(
  decision: GateDecision,
  deps: {
    proof: () => Promise<GateProof>;
    chainRoot?: (at: ChainRootQuery) => Promise<Hex | null>;
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
  // The account and day come from the signed receipt: a proof for another one proves nothing.
  const { receipt } = decision.receipt;
  const accountKey = safe(() => gateAccountKey(receipt.gateAccountId));
  const day = safe(() => gateReceiptDay(receipt));
  const dayNumber = day === undefined ? undefined : safe(() => gateDayNumber(day));
  if (
    !accountKey ||
    !day ||
    dayNumber === undefined ||
    proof.day !== day ||
    proof.accountKey?.toLowerCase() !== accountKey
  )
    return { ok: false, detail: "The proof is for another account or day than the receipt." };
  const read = deps.chainRoot
    ? await deps.chainRoot({ accountKey, dayNumber, posted: proof.posted }).catch(() => null)
    : null;
  if (read?.toLowerCase() === ZERO_ROOT && proof.posted)
    return {
      ok: false,
      detail: `The API says the root for ${day} is on chain, but GateAnchor has none.`,
    };
  const onChain = read && read.toLowerCase() !== ZERO_ROOT ? read : null;
  const root = onChain ?? proof.root;
  const inRoot = verifyGateLogProof(
    safe(() => gateReceiptHash(receipt)) ?? "0x",
    proof.proof,
    root,
  );
  if (!inRoot)
    return {
      ok: false,
      detail: onChain
        ? `Not in the root posted on chain for ${day}.`
        : `Not in the log root for ${day}.`,
    };
  return {
    ok: true,
    detail: onChain
      ? `In the root posted on chain for ${day}.`
      : proof.posted
        ? `In the log root for ${day}. It's posted on chain; this page didn't read it there.`
        : `In the log root for ${day}. It isn't posted on chain yet.`,
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
