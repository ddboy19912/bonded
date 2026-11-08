import {
  type BudgetTerms,
  evaluateGateInput,
  type GateInput,
  gateInputHash,
  type GateLogProof,
  type GateRule,
  normalAccount,
  type PaymentAttempt,
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
import { BudgetBase, type BudgetRequest, type BudgetSpend, type PaymentBudget } from "./budget.js";

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
  kind: "invoice" | "refund" | "bank_change" | "card" | "payment" | "budget" | "budget_close";
  decision: "pass" | "breach" | "frozen";
  result: "allowed" | "blocked" | "refused";
  allowed: boolean;
  message: string;
  mode: "monitor" | "enforce";
  /** Every rule broken, most serious first. */
  rules: GateRule[];
  /** Each rule in plain words, in the same order. */
  reasons: { rule: GateRule; words: string }[];
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
            ...(check.invoiceReference?.trim() ? { invoiceReference: check.invoiceReference } : {}),
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

  /**
   * Opens a budget: one check for many small payments to one payee (see `PaymentBudget`). The gate
   * checks it against the general rules (the account needs invoice matching off), reserves the
   * whole budget against the day's limit and signs a receipt whose input commits to the terms;
   * this checks the receipt, then recomputes the input's hash and reruns its rules. Each `spend`
   * is checked here with no network call; payments go to the gate in the background (every
   * `flushMs`, 5 seconds by default, once `holdMs` has passed so a turned-down payment can be taken
   * back) and on `close()`, whose receipt commits to every one. Throws `PaymentBlockedError`
   * (Enforce), `PaymentFrozenError` or `PaymentGateError` without opening one.
   */
  async budget(
    request: BudgetRequest,
    options: { flushMs?: number; holdMs?: number; onError?: (error: unknown) => void } = {},
  ): Promise<PaymentBudget> {
    const body = {
      account: request.account,
      amountUsd: request.amountUsd,
      ...(request.maxPaymentUsd === undefined ? {} : { maxPaymentUsd: request.maxPaymentUsd }),
      ...(request.ttlSeconds === undefined ? {} : { ttlSeconds: request.ttlSeconds }),
      requestId: request.requestId ?? crypto.randomUUID(),
    };
    let answer: GateAnswer | undefined;
    let last: unknown;
    for (let attempt = 0; attempt < TRIES && !answer; attempt++) {
      try {
        answer = await this.#request<GateAnswer>("/payments/budgets", {
          method: "POST",
          body: JSON.stringify(body),
        });
      } catch (error) {
        last = error;
        const unanswered =
          error instanceof PaymentGateError && (!error.status || error.status >= 500);
        if (!unanswered) throw error;
      }
    }
    if (!answer) throw last;
    const terms = await this.#verifyBudget(answer, body);
    await this.#settle(answer);
    return new HostedBudget(answer.id, terms, answer.mode, Date.now, this.#options.onBreach, {
      flushMs: options.flushMs ?? 5_000,
      holdMs: options.holdMs ?? 10_000,
      onError: options.onError ?? (() => undefined),
      send: (spends) =>
        this.#request<{ problems: { id: string; problem: string }[]; frozen: boolean }>(
          `/payments/budgets/${encodeURIComponent(answer!.id)}/spends`,
          {
            method: "POST",
            body: JSON.stringify({
              spends: spends.map((s) => ({
                id: s.id,
                amountMicros: s.amountMicros,
                reference: s.reference,
                at: new Date(s.atMs).toISOString(),
              })),
            }),
          },
        ),
      close: async () => {
        const closed = await this.#request<GateAnswer>(
          `/payments/budgets/${encodeURIComponent(answer!.id)}/close`,
          { method: "POST" },
        );
        await this.#verifyClose(closed, answer!.id);
        return closed;
      },
    });
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
        : // An account with invoice matching off answers an invoice check as kind "payment".
          (r.kind === (asked.kind ?? "invoice") ||
            (r.kind === "payment" && (asked.kind ?? "invoice") === "invoice")) &&
          r.amountCents === Math.round(asked.amountUsd * 100) &&
          r.reference === (asked.invoiceReference ?? "").trim());
    if (!matches) throw wrong("its receipt is for a different decision or payment");
  }

  /** The budget answer's receipt and input check out; returns the terms it grants. */
  async #verifyBudget(
    answer: GateAnswer,
    asked: { account: string; amountUsd: number; maxPaymentUsd?: number; ttlSeconds?: number },
  ): Promise<BudgetTerms> {
    const wrong = (what: string) =>
      new PaymentGateError(`the gate's budget can't be trusted: ${what}`, undefined, {
        receipt: true,
      });
    const signed = answer.receipt;
    if (!signed?.receipt) throw wrong("it has no receipt");
    if (this.#options.verifyReceipts !== false) {
      const signer = await this.#receiptSigner();
      if (!(await verifyGateReceipt(signed, signer).catch(() => false)))
        throw wrong("its receipt isn't signed by Bonded's receipt key");
    }
    const r = signed.receipt;
    const input = answer.input;
    if (
      r.kind !== "budget" ||
      r.decisionId !== answer.id ||
      r.decision !== answer.decision ||
      r.result !== answer.result ||
      answer.allowed !== (r.result === "allowed") ||
      r.payee !== normalAccount(asked.account) ||
      r.amountCents !== Math.round(asked.amountUsd * 100)
    )
      throw wrong("its receipt is for a different budget");
    if (!input || input.kind !== "budget" || gateInputHash(input) !== r.inputHash)
      throw wrong("its input doesn't match the receipt");
    if (r.decision !== "frozen") {
      const verdict = evaluateGateInput(input);
      if (!verdict.ok || verdict.rules.join() !== r.rules.join())
        throw wrong("its rules don't follow from its input");
    }
    const t = input.terms;
    const ttlMs = (asked.ttlSeconds ?? 3600) * 1000;
    const maxAsked =
      asked.maxPaymentUsd === undefined ? Infinity : Math.round(asked.maxPaymentUsd * 1e6);
    if (
      t.account !== r.payee ||
      t.budgetMicros !== r.amountCents * 10_000 ||
      t.expiresAtMs - t.startsAtMs !== ttlMs ||
      t.maxPaymentMicros > maxAsked
    )
      throw wrong("its terms aren't the ones asked for");
    return t;
  }

  /** A budget close's receipt checks out and commits to its input. */
  async #verifyClose(answer: GateAnswer, budgetId: string): Promise<void> {
    if (this.#options.verifyReceipts === false) return;
    const wrong = (what: string) =>
      new PaymentGateError(`the gate's budget close can't be trusted: ${what}`, undefined, {
        receipt: true,
      });
    const signed = answer.receipt;
    if (!signed?.receipt) throw wrong("it has no receipt");
    const signer = await this.#receiptSigner();
    if (!(await verifyGateReceipt(signed, signer).catch(() => false)))
      throw wrong("its receipt isn't signed by Bonded's receipt key");
    const r = signed.receipt;
    if (r.kind !== "budget_close" || r.reference !== budgetId || r.decisionId !== answer.id)
      throw wrong("its receipt is for a different budget");
    if (answer.input && gateInputHash(answer.input) !== r.inputHash)
      throw wrong("its input doesn't match the receipt");
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

/**
 * A budget the hosted gate opened. Spends wait `holdMs` (so one the payee turned down can be taken
 * back), then go to the gate every `flushMs`; `close()` sends the rest and closes it.
 */
class HostedBudget extends BudgetBase {
  #pending: BudgetSpend[] = [];
  #sending: Promise<void> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #closing: Promise<void> | undefined;

  constructor(
    id: string,
    terms: BudgetTerms,
    mode: "monitor" | "enforce",
    now: () => number,
    onBreach: ((breach: PaymentBreach) => void | Promise<void>) | undefined,
    private readonly link: {
      flushMs: number;
      holdMs: number;
      onError: (error: unknown) => void;
      send: (
        spends: BudgetSpend[],
      ) => Promise<{ problems: { id: string; problem: string }[]; frozen: boolean }>;
      close: () => Promise<GateAnswer>;
    },
  ) {
    super(id, terms, mode, now, onBreach);
  }

  /** The close decision, once closed. */
  closeDecision: GateAnswer | undefined;

  protected recorded(spend: BudgetSpend) {
    this.#pending.push(spend);
    if (!this.#timer) {
      this.#timer = setInterval(() => {
        this.#send(false).catch(this.link.onError);
      }, this.link.flushMs);
      this.#timer.unref?.();
    }
    return Promise.resolve();
  }
  protected releasable(spend: BudgetSpend) {
    return this.#pending.includes(spend);
  }
  protected released(spend: BudgetSpend) {
    this.#pending = this.#pending.filter((s) => s !== spend);
  }

  flush() {
    return this.#send(true);
  }

  close() {
    this.#closing ??= (async () => {
      this.markClosed();
      if (this.#timer) clearInterval(this.#timer);
      while (this.#pending.length > 0 || this.#sending) await this.#send(true);
      this.closeDecision = await this.link.close();
    })().catch((error: unknown) => {
      // Nothing is lost: what wasn't sent is still pending, so closing again tries again.
      this.#closing = undefined;
      throw error;
    });
    return this.#closing;
  }

  /** Sends what's due (everything when `all`), 500 at a time, one send at a time. */
  async #send(all: boolean): Promise<void> {
    while (this.#sending) await this.#sending;
    const cutoff = this.now() - this.link.holdMs;
    const due = this.#pending.filter((s) => all || s.atMs <= cutoff).slice(0, 500);
    if (due.length === 0) return;
    this.#sending = (async () => {
      const answer = await this.link.send(due);
      this.#pending = this.#pending.filter((s) => !due.includes(s));
      if (answer.frozen) this.markClosed();
    })().finally(() => {
      this.#sending = undefined;
    });
    await this.#sending;
    if (all && this.#pending.length > 0) await this.#send(true);
  }
}

function breachOf(answer: GateAnswer): PaymentBreach {
  return {
    kind:
      answer.kind === "bank_change"
        ? "vendor_change"
        : answer.kind === "refund"
          ? "refund"
          : answer.kind === "budget"
            ? "budget"
            : "invoice",
    rules: answer.rules,
    reasons: answer.reasons.map((r) => (typeof r === "string" ? r : r.words)),
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
