import {
  type GateInput,
  type GateLogProof,
  normalAccount,
  type PaymentAttempt,
  type PaymentRule,
  type SignedGateReceipt,
  verifyGateReceipt,
} from "@bondedhq/shared";
import { type Address, type Hex, isAddress } from "viem";
import {
  BondedError,
  PaymentBlockedError,
  PaymentFrozenError,
  PaymentGateError,
} from "./errors.js";
import type { PaymentBreach } from "./payments.js";

/** Bonded's hosted API. */
export const BONDED_API_URL = "https://api-production-ba50.up.railway.app";

/** A payment for the gate. Pass the same `requestId` to retry one: see `PaymentGate.pay`. */
export type GatePayment = PaymentAttempt & { requestId?: string };

/** A vendor bank change for the gate. `ticket` names the finance ticket that verified it. */
export interface GateVendorChange {
  vendorId: string;
  account: string;
  ticket?: string;
  requestId?: string;
}

/** What `POST /payments/check` takes. */
export type GateCheck =
  (GatePayment & { kind?: "invoice" | "refund" }) | (GateVendorChange & { kind: "bank_change" });

/** A decision, as the gate's log keeps it. */
export interface GateDecision {
  id: string;
  kind: "invoice" | "refund" | "bank_change" | "card";
  decision: "pass" | "breach" | "frozen";
  result: "allowed" | "blocked" | "refused";
  allowed: boolean;
  message: string;
  mode: "monitor" | "enforce";
  /** Every rule broken, most serious first. */
  rules: PaymentRule[];
  /** Each rule in plain words, in the same order. */
  reasons: string[];
  amountUsd: number;
  lossUsd: number;
  overpaidUsd: number;
  payee: string;
  vendorId: string | null;
  reference: string;
  requestId: string | null;
  inputHash: Hex;
  /** What the rules were given. */
  input?: GateInput | null;
  mandate: { version: number; hash: Hex };
  createdAt: string;
  /** Bonded's signed receipt. Anyone can check it at bondedhq.xyz/gate/verify. */
  receipt: SignedGateReceipt;
}

/** The gate's answer to one check. */
export interface GateAnswer extends GateDecision {
  frozen: boolean;
  /** The same `requestId` was checked before: this is that first decision, unchanged. */
  replayed: boolean;
}

/** Where a receipt sits in its day's log root, and where that root is on chain. */
export interface GateReceiptProof {
  decisionId: string;
  day: string;
  dayNumber: number;
  accountKey: Hex;
  receiptHash: Hex;
  root: Hex;
  proof: GateLogProof;
  posted: { chainId: number; contract: Address; txHash: Hex | null; postedAt: string } | null;
}

export interface PaymentGateOptions {
  /** The gate account's API key (`bonded_gk_...`), from bondedhq.xyz/gate. Keep it server side. */
  apiKey: string;
  /** Default: Bonded's hosted API. */
  apiUrl?: string;
  /**
   * The address receipts must be signed by. Default: the one `GET /gate/receipt-key` publishes,
   * read once. Pin it so that a wrong API address can't vouch for itself.
   */
  receiptKey?: Address;
  /** Check each answer's signed receipt before acting on it (default true). */
  verifyReceipts?: boolean;
  /**
   * Called with every breach before the gate acts on it: blocked in Enforce mode, let through in
   * Monitor mode. If it throws, the payment is not made.
   */
  onBreach?: (breach: PaymentBreach) => void | Promise<void>;
  /** How long to wait for each try, in milliseconds (default 10,000). */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** One retry of a check the gate may not have answered: its request id makes that safe. */
const TRIES = 2;

/**
 * The hosted payment gate: every payment goes to Bonded before it is made, and comes back allowed
 * or blocked with a signed receipt. The rules are the ones the Arena rates agents against, the
 * vendors and invoices are the gate account's (set up at bondedhq.xyz/gate), and the decisions are
 * logged where the owner can see them and anyone can check them.
 *
 * It fails closed: if the gate can't be reached, or its answer doesn't check out, your pay function
 * isn't called and `PaymentGateError` says why. Pass it as `guard` to `guardPayments` or a framework
 * helper in place of a `PaymentGuard`. Like the guard, it only sees payments your code sends it:
 * keep the unwrapped pay function out of the agent's reach.
 */
export class PaymentGate {
  #options: PaymentGateOptions;
  #url: string;
  #signer: Promise<Address> | undefined;

  constructor(options: PaymentGateOptions) {
    if (!options.apiKey) throw new BondedError("INVALID_PAYMENT", "apiKey is required");
    this.#options = options;
    this.#url = (options.apiUrl ?? BONDED_API_URL).replace(/\/+$/, "");
  }

  /** Asks the gate about a payment or bank change. An allowed payment counts as made from here. */
  async check(check: GateCheck): Promise<GateAnswer> {
    // Only what the API takes: it refuses unknown fields, and a caller's `toPayment` may add some.
    const requestId = check.requestId ?? crypto.randomUUID();
    const body: GateCheck =
      check.kind === "bank_change"
        ? {
            kind: check.kind,
            vendorId: check.vendorId,
            account: check.account,
            ...(check.ticket === undefined ? {} : { ticket: check.ticket }),
            requestId,
          }
        : {
            kind: check.kind ?? "invoice",
            account: check.account,
            amountUsd: check.amountUsd,
            invoiceReference: check.invoiceReference,
            requestId,
          };
    let last: unknown;
    for (let attempt = 0; attempt < TRIES; attempt++) {
      try {
        const answer = await this.#request<GateAnswer>("/payments/check", {
          method: "POST",
          body: JSON.stringify(body),
        });
        await this.#verify(answer, body);
        return answer;
      } catch (error) {
        last = error;
        // Only a check the gate may not have answered is worth asking again.
        const unanswered =
          error instanceof PaymentGateError && (!error.status || error.status >= 500);
        if (!unanswered || error.receipt) throw error;
      }
    }
    throw last;
  }

  /**
   * Checks a payment, then calls `pay` if the gate allows it. Throws `PaymentBlockedError`
   * (Enforce), `PaymentFrozenError` or `PaymentGateError` without calling `pay`.
   *
   * The gate counts an allowed payment as made, so if `pay` fails and you try again, pass the same
   * `requestId` both times: the gate gives the first decision back instead of a duplicate breach.
   */
  async pay<R>(
    attempt: GatePayment,
    pay: () => R | Promise<R>,
    kind: "invoice" | "refund" = "invoice",
  ): Promise<R> {
    await this.#settle(await this.check({ ...attempt, kind }));
    return pay();
  }

  /** The same for a vendor bank change: `update` runs only if the gate allows the change. */
  async changeVendorAccount<R>(
    request: GateVendorChange,
    update: () => R | Promise<R>,
  ): Promise<R> {
    await this.#settle(await this.check({ ...request, kind: "bank_change" }));
    return update();
  }

  /** The gate account's decisions, newest first. Pass `next` back as `before` for older ones. */
  decisions(
    query: { limit?: number; before?: string; result?: GateDecision["result"] } = {},
  ): Promise<{ items: GateDecision[]; next: string | null }> {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query))
      if (value !== undefined) params.set(name, String(value));
    return this.#request(`/payments/decisions${params.size ? `?${params}` : ""}`);
  }

  /** One decision with its receipt. */
  decision(id: string): Promise<GateDecision> {
    return this.#request(`/payments/decisions/${encodeURIComponent(id)}`);
  }

  /** A receipt's proof in its day's log root. The gate has one once that UTC day has ended. */
  proof(id: string): Promise<GateReceiptProof> {
    return this.#request(`/payments/decisions/${encodeURIComponent(id)}/proof`);
  }

  /** Reports a breach, then stops the payment unless the gate allowed it. */
  async #settle(answer: GateAnswer): Promise<void> {
    if (answer.decision === "frozen") throw new PaymentFrozenError();
    if (answer.decision === "breach") await this.#options.onBreach?.(breachOf(answer));
    if (!answer.allowed) throw new PaymentBlockedError(breachOf(answer));
  }

  async #verify(answer: GateAnswer, asked: GateCheck): Promise<void> {
    if (this.#options.verifyReceipts === false) return;
    const wrong = (what: string) =>
      new PaymentGateError(`the gate's answer can't be trusted: ${what}`, undefined, {
        receipt: true,
      });
    const signed = answer.receipt;
    if (!signed?.receipt) throw wrong("it has no receipt");
    const signer = await this.#receiptSigner();
    if (!(await verifyGateReceipt(signed, signer).catch(() => false)))
      throw wrong("its receipt isn't signed by Bonded's receipt key");
    const r = signed.receipt;
    const matches =
      r.decisionId === answer.id &&
      r.decision === answer.decision &&
      r.result === answer.result &&
      answer.allowed === (r.result === "allowed") &&
      r.rules.join() === answer.rules.join() &&
      r.payee === normalAccount(asked.account) &&
      (asked.kind === "bank_change"
        ? r.kind === "bank_change"
        : r.kind === (asked.kind ?? "invoice") &&
          r.amountCents === Math.round(asked.amountUsd * 100) &&
          r.reference === asked.invoiceReference.trim());
    if (!matches) throw wrong("its receipt is for a different decision or payment");
  }

  #receiptSigner(): Promise<Address> {
    if (this.#options.receiptKey) return Promise.resolve(this.#options.receiptKey);
    this.#signer ??= this.#request<{ address: Address }>("/gate/receipt-key")
      .then((key) => {
        // Without an address verifyGateReceipt would accept any self-signed receipt.
        if (!isAddress(key?.address))
          throw new PaymentGateError("the gate's receipt key is not an address");
        return key.address;
      })
      .catch((error: unknown) => {
        this.#signer = undefined;
        throw error;
      });
    return this.#signer;
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${this.#url}${path}`;
    let response: Response;
    try {
      response = await (this.#options.fetch ?? fetch)(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.#options.apiKey}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
        signal: AbortSignal.timeout(this.#options.timeoutMs ?? 10_000),
      });
    } catch (error) {
      throw new PaymentGateError(`couldn't reach ${url}: ${(error as Error).message}`, undefined, {
        cause: error,
      });
    }
    const body = (await response.json().catch(() => undefined)) as
      (T & { error?: string }) | undefined;
    if (response.ok && body) return body;
    const message = typeof body?.error === "string" ? body.error : `unexpected answer from ${url}`;
    if (response.status === 400) throw new BondedError("INVALID_PAYMENT", message);
    throw new PaymentGateError(message, response.status);
  }
}

/** The hosted payment gate: see `PaymentGate`. */
export function paymentGate(options: PaymentGateOptions): PaymentGate {
  return new PaymentGate(options);
}

function breachOf(answer: GateAnswer): PaymentBreach {
  return {
    kind:
      answer.kind === "bank_change"
        ? "vendor_change"
        : answer.kind === "refund"
          ? "refund"
          : "invoice",
    rules: answer.rules,
    reasons: answer.reasons,
    blocked: !answer.allowed,
    account: answer.payee,
    reference: answer.reference,
    vendorId: answer.vendorId,
    amountUsd: answer.amountUsd,
    lossUsd: answer.lossUsd,
    overpaidUsd: answer.overpaidUsd,
    day: answer.createdAt.slice(0, 10),
    decisionId: answer.id,
    receipt: answer.receipt,
  };
}
