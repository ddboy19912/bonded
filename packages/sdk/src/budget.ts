import {
  budgetSpendProblem,
  type BudgetTerms,
  GATE_RULE_WORDS,
  type GateRule,
  MICROS_PER_USD,
  utcDay,
} from "@bondedhq/shared";
import { BondedError, PaymentBlockedError } from "./errors.js";
import type { PaymentBreach } from "./payments.js";

/**
 * A budget: one check for many small payments to one payee (an x402 API, say). Ask for one with
 * `guard.budget(...)` on the local `PaymentGuard` or the hosted `PaymentGate`; then check each
 * payment with `spend` before making it. `spend` needs no network: it checks the payment against
 * the budget's terms (the payee, the per-payment limit, how many payments it covers, its end, and
 * what's left) in exact micro-dollars, so a $0.001 call counts as $0.001.
 *
 * In Enforce mode a payment that breaks the terms throws `PaymentBlockedError` and isn't counted;
 * in Monitor mode it is counted and reported to `onBreach`. A hosted budget sends its payments to
 * the gate in the background and on `close()`; closing it gets a receipt that commits to every one.
 */
export interface PaymentBudget {
  /** The budget's id: the hosted gate's decision id, or a local one. */
  readonly id: string;
  /** What it allows: payee, budget, per-payment limit, payment count and end. */
  readonly terms: Readonly<BudgetTerms>;
  readonly mode: "monitor" | "enforce";
  /** Micro-dollars counted so far, released payments left out. */
  readonly spentMicros: number;
  /** Payments counted so far. */
  readonly payments: number;
  /** Closed, or past its end. */
  readonly closed: boolean;
  /** What a payment of this size would break, in plain words; undefined when it fits. */
  problem(amountMicros: number): string | undefined;
  /** Check a payment against the terms and count it. See the interface's description. */
  spend(amountMicros: number, options?: { id?: string; reference?: string }): Promise<BudgetSpend>;
  /**
   * Take back a payment that never went out (the payee turned it down). Only before it was sent to
   * the gate; returns whether it was taken back.
   */
  release(spendId: string): boolean;
  /** Attach what the payment settled as (an x402 transaction hash) before it is sent. */
  settle(spendId: string, reference: string): void;
  /** Send payments to the gate now (hosted budgets; nothing to do locally). */
  flush(): Promise<void>;
  /** Send what's left and close: the unspent part stops counting toward the day's limit. */
  close(): Promise<void>;
}

/** A payment counted against a budget. */
export interface BudgetSpend {
  id: string;
  amountMicros: number;
  reference: string;
  /** Unix milliseconds. */
  atMs: number;
}

/** What `guard.budget(...)` takes. */
export interface BudgetRequest {
  /** The one account it pays: an x402 service's `payTo` address, say. */
  account: string;
  /** The budget, in US dollars with at most two decimals. */
  amountUsd: number;
  /** The most one payment may be, up to six decimals. Default: the mandate's per-payment limit. */
  maxPaymentUsd?: number;
  /** How long it lasts, 60 to 3,600 seconds (the default). */
  ttlSeconds?: number;
  /** Hosted gate: the same id again gives back the first budget instead of a second one. */
  requestId?: string;
}

/** Spends are refused this long before the budget's end, so they reach the gate inside it. */
const END_MARGIN_MS = 5_000;

/** The bookkeeping both kinds of budget share: the terms check and the running totals. */
export abstract class BudgetBase implements PaymentBudget {
  #spentMicros = 0;
  #payments = 0;
  #closed = false;
  protected readonly counted = new Map<string, BudgetSpend>();

  constructor(
    readonly id: string,
    readonly terms: Readonly<BudgetTerms>,
    readonly mode: "monitor" | "enforce",
    protected readonly now: () => number,
    protected readonly onBreach?: (breach: PaymentBreach) => void | Promise<void>,
  ) {}

  get spentMicros() {
    return this.#spentMicros;
  }
  get payments() {
    return this.#payments;
  }
  get closed() {
    return this.#closed || this.now() >= this.terms.expiresAtMs - END_MARGIN_MS;
  }
  protected markClosed() {
    this.#closed = true;
  }

  problem(amountMicros: number): string | undefined {
    if (this.#closed) return "the budget is closed";
    const atMs = this.now();
    if (atMs >= this.terms.expiresAtMs - END_MARGIN_MS)
      return "it was paid after the budget expired";
    return budgetSpendProblem(
      this.terms,
      { spentMicros: this.#spentMicros, payments: this.#payments },
      { amountMicros, atMs },
    );
  }

  async spend(
    amountMicros: number,
    options: { id?: string; reference?: string } = {},
  ): Promise<BudgetSpend> {
    if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0)
      throw new BondedError("INVALID_PAYMENT", "amountMicros must be a positive whole number");
    const problem = this.problem(amountMicros);
    const spend: BudgetSpend = {
      id: options.id ?? crypto.randomUUID(),
      amountMicros,
      reference: options.reference ?? "",
      atMs: this.now(),
    };
    if (problem) {
      const breach = this.breachOf(spend, problem);
      await this.onBreach?.(breach);
      if (breach.blocked) throw new PaymentBlockedError(breach);
    }
    this.#spentMicros += amountMicros;
    this.#payments += 1;
    this.counted.set(spend.id, spend);
    await this.recorded(spend);
    return spend;
  }

  release(spendId: string): boolean {
    const spend = this.counted.get(spendId);
    if (!spend || !this.releasable(spend)) return false;
    this.counted.delete(spendId);
    this.#spentMicros -= spend.amountMicros;
    this.#payments -= 1;
    this.released(spend);
    return true;
  }

  settle(spendId: string, reference: string): void {
    const spend = this.counted.get(spendId);
    if (spend) spend.reference = reference.slice(0, 200);
  }

  /** The spend was counted. */
  protected abstract recorded(spend: BudgetSpend): Promise<void>;
  /** Whether a counted spend can still be taken back. */
  protected abstract releasable(spend: BudgetSpend): boolean;
  /** The spend was taken back. */
  protected abstract released(spend: BudgetSpend): void;
  abstract flush(): Promise<void>;
  abstract close(): Promise<void>;

  private breachOf(spend: BudgetSpend, problem: string): PaymentBreach {
    const rules: GateRule[] = ["over_budget"];
    return {
      kind: "budget",
      rules,
      reasons: [`${GATE_RULE_WORDS.over_budget}: ${problem}`],
      blocked: this.mode === "enforce",
      account: this.terms.account,
      reference: spend.reference,
      vendorId: null,
      amountUsd: spend.amountMicros / MICROS_PER_USD,
      lossUsd: 0,
      overpaidUsd: 0,
      day: utcDay(new Date(spend.atMs)),
      decisionId: this.id,
    };
  }
}
