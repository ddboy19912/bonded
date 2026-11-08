import {
  type BudgetTerms,
  checkBudget,
  checkGeneralPayment,
  checkInvoicePayment,
  checkRefundPayment,
  GATE_RULE_WORDS,
  type GateRule,
  isVerifiedChange,
  type KnownPayee,
  normalAccount,
  type PaidPayment,
  type PayableInvoice,
  type PayableRefund,
  type PaymentAttempt,
  type PaymentLimits,
  type SignedGateReceipt,
  utcDay,
  usdToMicros,
  type VerifiedChange,
} from "@bondedhq/shared";
import { BudgetBase, type BudgetRequest, type BudgetSpend, type PaymentBudget } from "./budget.js";
import {
  BondedError,
  PaymentBlockedError,
  PaymentFrozenError,
  PaymentGateError,
} from "./errors.js";

/** The off-chain payment mandate an agent's payments are checked against. */
export interface PaymentMandate extends PaymentLimits {
  /** Monitor lets a breaking payment through and reports it; Enforce blocks it. */
  mode: "monitor" | "enforce";
  /** After the first breach, refuse every payment until a person unfreezes the guard. */
  freezeOnBreach: boolean;
  /**
   * False when your payments have no invoices: a payment needs a vendor on the list and to stay
   * within the limits, and its reference is optional. Refunds still need an approved refund.
   */
  invoiceMatching?: boolean;
  /** Payments allowed in any hour, with invoice matching off. No limit unless set. */
  maxPaymentsPerHour?: number;
}

/** A supplier as your vendor master holds it. Its account is one the agent may pay. */
export interface PaymentVendor {
  id: string;
  /** Bank account (an IBAN or account number). Compared without spaces, case-insensitively. */
  account: string;
  name?: string;
}

/** A list the guard reads on every check: fixed, or read from your own system each time. */
export type PaymentSource<T> = readonly T[] | (() => readonly T[] | Promise<readonly T[]>);

/** What the guard remembers between payments. Persist it to keep it across restarts. */
export interface PaymentGuardState {
  /** Payments made through the guard (and any made before it, if you restore them), oldest first. */
  payments: PaidPayment[];
  /** Frozen after a breach: every payment is refused until `unfreeze()`. */
  frozen: boolean;
  /**
   * Bank changes made without a verified ticket (let through in Monitor mode). The vendor master
   * may now show these accounts, but they never count as the vendor's: paying one is
   * `unknown_payee`.
   */
  unverifiedChanges: VerifiedChange[];
  /**
   * Open budgets (`budget()`): their terms and what was counted against them. Each one's whole
   * amount is in `payments` until it closes. Absent in state saved before budgets existed.
   */
  budgets?: LocalBudgetState[];
  /** When budget payments were made in the last hour (Unix milliseconds), for the hourly limit. */
  budgetSpends?: number[];
}

/** An open local budget, as the guard's state keeps it. */
export interface LocalBudgetState {
  id: string;
  terms: BudgetTerms;
  spentMicros: number;
  payments: number;
}

/** One payment (or bank change) that broke the mandate, as the guard reports it. */
export interface PaymentBreach {
  kind: "invoice" | "refund" | "vendor_change" | "budget";
  /** Every rule broken, most serious first. */
  rules: GateRule[];
  /** Each rule in plain words (`GATE_RULE_WORDS`), in the same order. */
  reasons: string[];
  /** Enforce mode stopped it: the pay function was not called. */
  blocked: boolean;
  account: string;
  /** The invoice or refund reference; empty for a bank change or a budget. */
  reference: string;
  /** The vendor whose verified account this is (or, for a bank change, the vendor changed). */
  vendorId: string | null;
  amountUsd: number;
  /** If it went out: paid to an account outside the vendor master, gone for good. */
  lossUsd: number;
  /** If it went out: paid to a known payee beyond what it was owed, claimable back. */
  overpaidUsd: number;
  /** UTC day it counts against, YYYY-MM-DD. */
  day: string;
  /** From the hosted gate (`PaymentGate`): the decision's id in its log. */
  decisionId?: string;
  /** From the hosted gate: Bonded's signed receipt for the decision. */
  receipt?: SignedGateReceipt;
}

/** The rule verdict for a payment, without making it. */
export interface PaymentVerdict {
  /** Every rule the payment breaks, most serious first. Empty when it is allowed. */
  rules: GateRule[];
  reasons: string[];
  amountUsd: number;
  reference: string;
  vendorId: string | null;
  lossUsd: number;
  overpaidUsd: number;
  /** The guard is frozen: the payment would be refused whatever the rules say. */
  frozen: boolean;
}

export interface PaymentGuardOptions {
  mandate: PaymentMandate;
  /** The vendor master: each vendor's account on file. */
  vendors: PaymentSource<PaymentVendor>;
  /** Invoices the business approved for payment. */
  invoices?: PaymentSource<PayableInvoice>;
  /** Customer refunds finance approved. */
  refunds?: PaymentSource<PayableRefund>;
  /**
   * Bank changes finance verified out of band (a call to the number on file). A ticket's account
   * is a known payee for its vendor, and the only way a vendor's account may change.
   */
  changes?: PaymentSource<VerifiedChange>;
  /** State to start from, as `onStateChange` last saved it (or `state()` returned). */
  state?: PaymentGuardState;
  /** Called with the new state after every change, inside the guard's lock. Save it here. */
  onStateChange?: (state: PaymentGuardState) => void | Promise<void>;
  /**
   * Called with every breach before the guard acts on it: blocked in Enforce mode, let through
   * in Monitor mode. If it throws, the payment is not made.
   */
  onBreach?: (breach: PaymentBreach) => void | Promise<void>;
  now?: () => Date;
}

const read = async <T>(source: PaymentSource<T> | undefined): Promise<readonly T[]> =>
  typeof source === "function" ? await source() : (source ?? []);

const copy = (state: PaymentGuardState): PaymentGuardState => ({
  payments: state.payments.map((p) => ({ ...p })),
  frozen: state.frozen,
  unverifiedChanges: state.unverifiedChanges.map((c) => ({ ...c })),
  budgets: (state.budgets ?? []).map((b) => ({ ...b, terms: { ...b.terms } })),
  budgetSpends: [...(state.budgetSpends ?? [])],
});

/** The reference a local budget's reservation is recorded under. */
const budgetReference = (id: string) => `budget:${id}`;

/**
 * The payment mandate, checked inside your own process: the same rules (`@bondedhq/shared`'s
 * payment mandate) the Arena rates agents against, with no network and no model. You give it the
 * mandate and your vendor master, approved invoices and refunds, and verified bank changes; it
 * keeps the payments made and the frozen flag, and hands them to `onStateChange` to persist.
 *
 * Wrap your pay function with `guardPayments` (or a framework helper) so every payment is checked
 * first. In Enforce mode a payment that breaks a rule throws `PaymentBlockedError` and your pay
 * function is never called; in Monitor mode it goes through and `onBreach` reports it. A frozen
 * guard refuses everything (`PaymentFrozenError`).
 *
 * It is a local check: the agent's code can still call the pay function without it, and it makes
 * no receipts. Payments are checked and made one at a time, so two at once can't both pass the
 * duplicate or daily checks.
 */
export class PaymentGuard {
  readonly mandate: Readonly<PaymentMandate>;
  #options: PaymentGuardOptions;
  #state: PaymentGuardState;
  #queue: Promise<unknown> = Promise.resolve();
  #now: () => Date;

  constructor(options: PaymentGuardOptions) {
    this.mandate = Object.freeze({ ...options.mandate });
    this.#options = options;
    this.#state = copy(options.state ?? { payments: [], frozen: false, unverifiedChanges: [] });
    this.#now = options.now ?? (() => new Date());
  }

  get frozen(): boolean {
    return this.#state.frozen;
  }

  /** A copy of what the guard remembers, to persist or inspect. */
  state(): PaymentGuardState {
    return copy(this.#state);
  }

  /** Lets payments through again after a freeze. For a person who reviewed the breach. */
  unfreeze(): Promise<void> {
    return this.#exclusive(async () => {
      if (!this.#state.frozen) return;
      this.#state.frozen = false;
      await this.#save();
    });
  }

  /** The rule verdict for a payment, without making or recording it. */
  async check(
    attempt: PaymentAttempt,
    kind: "invoice" | "refund" = "invoice",
  ): Promise<PaymentVerdict> {
    const check = await this.#check(attempt, kind, utcDay(this.#now()));
    const { rules, amountUsd, reference, vendorId, lossUsd, overpaidUsd } = check;
    return {
      rules,
      reasons: words(rules),
      amountUsd,
      reference,
      vendorId,
      lossUsd,
      overpaidUsd,
      frozen: this.frozen,
    };
  }

  /**
   * Checks a payment, then calls `pay` if the mandate allows it (or Monitor mode lets it through)
   * and records it once `pay` returns. Throws `PaymentBlockedError` (Enforce), `PaymentFrozenError`
   * or `BondedError` `INVALID_PAYMENT` without calling `pay`. A `pay` that throws records nothing.
   */
  pay<R>(
    attempt: PaymentAttempt,
    pay: () => R | Promise<R>,
    kind: "invoice" | "refund" = "invoice",
  ): Promise<R> {
    return this.#exclusive(async () => {
      if (this.#state.frozen) throw new PaymentFrozenError();
      const now = this.#now();
      const day = utcDay(now);
      const check = await this.#check(attempt, kind, day);
      if (check.rules.length > 0) {
        await this.#breach({
          kind,
          rules: check.rules,
          reasons: words(check.rules),
          blocked: this.mandate.mode === "enforce",
          account: attempt.account,
          reference: check.reference,
          vendorId: check.vendorId,
          amountUsd: check.amountUsd,
          lossUsd: check.lossUsd,
          overpaidUsd: check.overpaidUsd,
          day,
        });
      }
      const result = await pay();
      this.#state.payments.push({
        account: attempt.account,
        // A refund settles no supplier invoice, as in the Arena's ledger.
        vendorId: kind === "refund" ? null : check.vendorId,
        amountUsd: check.amountUsd,
        invoiceReference: check.reference,
        day,
        ...(this.mandate.invoiceMatching === false ? { at: now.toISOString() } : {}),
        ...(kind === "refund" ? { kind } : {}),
      });
      await this.#save();
      return result;
    });
  }

  /**
   * Checks a vendor bank change, then calls `update` if a verified ticket covers that vendor and
   * account (or Monitor mode lets it through). An unverified change breaks
   * `unverified_vendor_change`; let through in Monitor mode, its account still never counts as
   * the vendor's.
   */
  changeVendorAccount<R>(
    request: { vendorId: string; account: string },
    update: () => R | Promise<R>,
  ): Promise<R> {
    return this.#exclusive(async () => {
      if (this.#state.frozen) throw new PaymentFrozenError();
      if (!normalAccount(request.account))
        throw new BondedError("INVALID_PAYMENT", "account is required");
      // Already a known payee for this vendor (its account on file, or a ticket's): no change to
      // verify. Marking it unverified would make the vendor's own account unpayable.
      if (!isVerifiedChange(await this.#payees(), request)) {
        const rules: GateRule[] = ["unverified_vendor_change"];
        await this.#breach({
          kind: "vendor_change",
          rules,
          reasons: words(rules),
          blocked: this.mandate.mode === "enforce",
          account: request.account,
          reference: "",
          vendorId: request.vendorId,
          amountUsd: 0,
          lossUsd: 0,
          overpaidUsd: 0,
          day: utcDay(this.#now()),
        });
        this.#state.unverifiedChanges.push({
          vendorId: request.vendorId,
          account: request.account,
        });
        await this.#save();
      }
      return update();
    });
  }

  /**
   * Opens a budget: one check for many small payments to one payee (see `PaymentBudget`). Needs
   * `invoiceMatching: false`. The payee must be a vendor's account (`unknown_payee`), the whole
   * budget must fit in what's left of the day's limit (`over_daily_cap`), and with
   * `maxPaymentsPerHour` there must be room for a payment (`over_hourly_limit`); the budget then
   * covers what's left of the hour. Enforce mode throws `PaymentBlockedError`; Monitor mode opens it
   * and reports the breach. The whole budget counts toward the day until `close()`, when what was
   * spent (rounded up to the cent) counts instead. A budget past its end is closed the next time
   * one is opened.
   */
  budget(request: BudgetRequest): Promise<PaymentBudget> {
    return this.#exclusive(async () => {
      if (this.#state.frozen) throw new PaymentFrozenError();
      if (this.mandate.invoiceMatching !== false)
        throw new BondedError("CONFIG", "budgets need invoiceMatching: false on the mandate");
      const now = this.#now();
      const day = utcDay(now);
      if (this.#settleExpired(now.getTime())) await this.#save();
      const ttlSeconds = request.ttlSeconds ?? 3600;
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 3600)
        throw new BondedError(
          "INVALID_PAYMENT",
          "ttlSeconds must be a whole number from 60 to 3,600",
        );
      const maxAll = usdToMicros(this.mandate.maxPaymentUsd) ?? 0;
      const asked =
        request.maxPaymentUsd === undefined ? maxAll : usdToMicros(request.maxPaymentUsd);
      if (asked === undefined || asked <= 0)
        throw new BondedError(
          "INVALID_PAYMENT",
          "maxPaymentUsd must be positive, with at most six decimals",
        );
      const check = checkBudget(
        {
          limits: {
            ...this.mandate,
            maxPaymentsPerHour: this.mandate.maxPaymentsPerHour ?? null,
          },
          payees: await this.#payees(),
          payments: this.#state.payments,
          paymentsLastHour: this.#paymentsLastHour(),
          reservedPayments: this.#reservedPayments(),
          day,
        },
        { account: request.account, budgetUsd: request.amountUsd },
      );
      if (!check.ok) throw new BondedError("INVALID_PAYMENT", check.error);
      const id = `local-${crypto.randomUUID()}`;
      if (check.rules.length > 0)
        await this.#breach({
          kind: "budget",
          rules: check.rules,
          reasons: words(check.rules),
          blocked: this.mandate.mode === "enforce",
          account: request.account,
          reference: "",
          vendorId: check.vendorId,
          amountUsd: request.amountUsd,
          lossUsd: 0,
          overpaidUsd: 0,
          day,
        });
      const terms: BudgetTerms = {
        account: normalAccount(request.account),
        budgetMicros: Math.round(request.amountUsd * 100) * 10_000,
        maxPaymentMicros: Math.min(asked, maxAll),
        maxPayments: check.maxPayments,
        startsAtMs: now.getTime(),
        expiresAtMs: now.getTime() + ttlSeconds * 1000,
      };
      // The reservation: no time, so it doesn't count as a payment for the hourly limit.
      this.#state.payments.push({
        account: request.account,
        vendorId: check.vendorId,
        amountUsd: Math.round(request.amountUsd * 100) / 100,
        invoiceReference: budgetReference(id),
        day,
      });
      const kept: LocalBudgetState = { id, terms, spentMicros: 0, payments: 0 };
      this.#state.budgets = [...(this.#state.budgets ?? []), kept];
      await this.#save();
      return new LocalBudget(id, terms, this.mandate.mode, () => this.#now().getTime(), {
        frozen: () => this.#state.frozen,
        report: (breach) => this.#report(breach),
        recorded: (spend) =>
          this.#exclusive(async () => {
            const b = this.#state.budgets?.find((x) => x.id === id);
            if (b) {
              b.spentMicros += spend.amountMicros;
              b.payments += 1;
            }
            this.#state.budgetSpends = [...(this.#state.budgetSpends ?? []), spend.atMs];
            await this.#save();
          }),
        released: (spend) =>
          void this.#exclusive(async () => {
            const b = this.#state.budgets?.find((x) => x.id === id);
            if (b) {
              b.spentMicros -= spend.amountMicros;
              b.payments -= 1;
            }
            const spends = this.#state.budgetSpends ?? [];
            const at = spends.lastIndexOf(spend.atMs);
            if (at >= 0) spends.splice(at, 1);
            await this.#save();
          }),
        close: () =>
          this.#exclusive(async () => {
            if (this.#closeBudget(id)) await this.#save();
          }),
      });
    });
  }

  /** Payments open budgets may still make, for the hourly limit. A budget past its end makes none. */
  #reservedPayments(): number {
    const now = this.#now().getTime();
    return (this.#state.budgets ?? []).reduce(
      (sum, b) =>
        b.terms.maxPayments === null || b.terms.expiresAtMs <= now
          ? sum
          : sum + Math.max(0, b.terms.maxPayments - b.payments),
      0,
    );
  }

  /** Closes budgets past their end. True when any closed. */
  #settleExpired(nowMs: number): boolean {
    const expired = (this.#state.budgets ?? []).filter((b) => b.terms.expiresAtMs <= nowMs);
    for (const b of expired) this.#closeBudget(b.id);
    return expired.length > 0;
  }

  /** The budget's reservation becomes what it spent, rounded up to the cent. */
  #closeBudget(id: string): boolean {
    const budget = this.#state.budgets?.find((b) => b.id === id);
    if (!budget) return false;
    this.#state.budgets = this.#state.budgets!.filter((b) => b.id !== id);
    const at = this.#state.payments.findIndex((p) => p.invoiceReference === budgetReference(id));
    if (at >= 0) {
      const cents = Math.ceil(budget.spentMicros / 10_000);
      if (cents > 0)
        this.#state.payments[at] = { ...this.#state.payments[at]!, amountUsd: cents / 100 };
      else this.#state.payments.splice(at, 1);
    }
    return true;
  }

  /** Runs the shared rule check against the builder's data and the guard's payments. */
  async #check(attempt: PaymentAttempt, kind: "invoice" | "refund", day: string) {
    const payees = await this.#payees();
    const limits = this.mandate;
    const payments = this.#state.payments;
    const check =
      kind === "refund"
        ? checkRefundPayment(
            { limits, payees, refunds: await read(this.#options.refunds), payments, day },
            attempt,
          )
        : this.mandate.invoiceMatching === false
          ? checkGeneralPayment(
              {
                limits: { ...limits, maxPaymentsPerHour: limits.maxPaymentsPerHour ?? null },
                payees,
                payments,
                // Payments open budgets may still make count toward the hourly limit too.
                paymentsLastHour: this.#paymentsLastHour() + this.#reservedPayments(),
                day,
              },
              attempt,
            )
          : checkInvoicePayment(
              { limits, payees, invoices: await read(this.#options.invoices), payments, day },
              attempt,
            );
    if (!check.ok) throw new BondedError("INVALID_PAYMENT", check.error);
    return check;
  }

  /**
   * Payments in the last hour, budget payments included. One restored from before the guard kept
   * times doesn't count.
   */
  #paymentsLastHour(): number {
    const since = this.#now().getTime() - 3_600_000;
    this.#state.budgetSpends = (this.#state.budgetSpends ?? []).filter((at) => at >= since);
    return (
      this.#state.payments.filter((p) => p.at !== undefined && Date.parse(p.at) >= since).length +
      this.#state.budgetSpends.length
    );
  }

  /**
   * Known payees: each vendor's account on file, unless it got there through an unverified
   * change, and every account a verified ticket covers.
   */
  async #payees(): Promise<KnownPayee[]> {
    const unverified = this.#state.unverifiedChanges;
    const onFile = (await read(this.#options.vendors))
      .map((v) => ({ vendorId: v.id, account: v.account }))
      .filter(
        (p) =>
          !unverified.some(
            (u) =>
              u.vendorId === p.vendorId && normalAccount(u.account) === normalAccount(p.account),
          ),
      );
    const ticketed = (await read(this.#options.changes)).map((c) => ({
      vendorId: c.vendorId,
      account: c.account,
    }));
    return [...onFile, ...ticketed];
  }

  /** Reports a breach, freezes if the mandate says so, and throws when Enforce mode blocks it. */
  async #breach(breach: PaymentBreach): Promise<void> {
    await this.#report(breach);
    if (breach.blocked) throw new PaymentBlockedError(breach);
  }

  /** Freezes if the mandate says so, and tells `onBreach`. */
  async #report(breach: PaymentBreach): Promise<void> {
    if (this.mandate.freezeOnBreach) {
      this.#state.frozen = true;
      await this.#save();
    }
    await this.#options.onBreach?.({
      ...breach,
      rules: [...breach.rules],
      reasons: [...breach.reasons],
    });
  }

  async #save(): Promise<void> {
    await this.#options.onStateChange?.(this.state());
  }

  /** One check-and-pay at a time, so the duplicate and daily checks see every payment. */
  #exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }
}

const words = (rules: readonly GateRule[]) => rules.map((r) => GATE_RULE_WORDS[r]);

/** A budget the local guard opened: spends are counted in its state, nothing is sent anywhere. */
class LocalBudget extends BudgetBase {
  constructor(
    id: string,
    terms: BudgetTerms,
    mode: "monitor" | "enforce",
    now: () => number,
    private readonly ledger: {
      frozen: () => boolean;
      report: (breach: PaymentBreach) => Promise<void>;
      recorded: (spend: BudgetSpend) => Promise<void>;
      released: (spend: BudgetSpend) => void;
      close: () => Promise<void>;
    },
  ) {
    super(id, terms, mode, now, (breach) => ledger.report(breach));
  }

  override spend(amountMicros: number, options?: { id?: string; reference?: string }) {
    if (this.ledger.frozen()) return Promise.reject(new PaymentFrozenError());
    return super.spend(amountMicros, options);
  }
  protected recorded(spend: BudgetSpend) {
    return this.ledger.recorded(spend);
  }
  protected releasable() {
    return !this.closed;
  }
  protected released(spend: BudgetSpend) {
    this.ledger.released(spend);
  }
  flush() {
    return Promise.resolve();
  }
  async close() {
    this.markClosed();
    await this.ledger.close();
  }
}

/** A payment guard: see `PaymentGuard`. */
export function paymentGuard(options: PaymentGuardOptions): PaymentGuard {
  return new PaymentGuard(options);
}

export interface GuardPaymentsOptions<I> {
  /**
   * A `PaymentGuard`, or the hosted `PaymentGate`. Share one between your invoice and refund
   * functions, so limits and freezes are shared.
   */
  guard: Pick<PaymentGuard, "pay">;
  /** `invoice` (the default) pays approved invoices; `refund` pays approved customer refunds. */
  kind?: "invoice" | "refund";
  /**
   * Reads the payment from your function's first argument. Default: `{ account, amountUsd,
   * invoiceReference }` (or `reference`), the Arena's `pay_invoice` and `issue_refund` arguments.
   */
  toPayment?: (input: I) => PaymentAttempt;
}

/**
 * Wraps your own pay function so every call is checked against the payment mandate first. The
 * wrapped function takes the same arguments and returns what yours returns. In Enforce mode a
 * payment that breaks a rule throws `PaymentBlockedError` and your function is not called; in
 * Monitor mode it is called and the guard's `onBreach` reports the breach. A frozen guard throws
 * `PaymentFrozenError`.
 *
 * ```ts
 * const guard = paymentGuard({ mandate, vendors, invoices, onBreach: alert });
 * const pay = guardPayments(bank.pay, { guard });
 * await pay({ account: "DE89 3704 0044 0532 0130 00", amountUsd: 1840.5, invoiceReference: "ACM-2291" });
 * ```
 *
 * A local check: it makes no receipts, and code that calls your function directly skips it.
 */
export function guardPayments<I, Rest extends unknown[], R>(
  pay: (input: I, ...rest: Rest) => R | Promise<R>,
  options: GuardPaymentsOptions<I>,
): (input: I, ...rest: Rest) => Promise<R> {
  const toPayment = options.toPayment ?? defaultPayment;
  return async (input, ...rest) =>
    options.guard.pay(toPayment(input), () => pay(input, ...rest), options.kind ?? "invoice");
}

export interface GuardVendorChangesOptions<I> {
  /** A `PaymentGuard`, or the hosted `PaymentGate`. */
  guard: Pick<PaymentGuard, "changeVendorAccount">;
  /**
   * Reads the change from your function's first argument. Default: `{ vendorId, account }`, and
   * `ticket` when there is one (the hosted gate checks it).
   */
  toChange?: (input: I) => { vendorId: string; account: string; ticket?: string };
}

/**
 * Wraps your own "change a vendor's bank account" function: a change no verified ticket covers
 * breaks `unverified_vendor_change`. Enforce mode throws `PaymentBlockedError` without calling
 * it; Monitor mode calls it, reports the breach, and never treats the new account as the vendor's.
 */
export function guardVendorChanges<I, Rest extends unknown[], R>(
  update: (input: I, ...rest: Rest) => R | Promise<R>,
  options: GuardVendorChangesOptions<I>,
): (input: I, ...rest: Rest) => Promise<R> {
  const toChange = options.toChange ?? defaultChange;
  return async (input, ...rest) =>
    options.guard.changeVendorAccount(toChange(input), () => update(input, ...rest));
}

/**
 * The payment guard or gate refused (blocked, frozen, arguments it can't check, or the gate gave no
 * answer to act on): no money moved.
 */
export function isPaymentRefusal(
  error: unknown,
): error is PaymentBlockedError | PaymentFrozenError | PaymentGateError | BondedError {
  return (
    error instanceof PaymentBlockedError ||
    error instanceof PaymentFrozenError ||
    error instanceof PaymentGateError ||
    (error instanceof BondedError && error.code === "INVALID_PAYMENT")
  );
}

const field = (input: Record<string, unknown>, name: string): string => {
  const value = input[name];
  if (typeof value !== "string")
    throw new BondedError("INVALID_PAYMENT", `${name} must be a string`);
  return value;
};

const asObject = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== "object")
    throw new BondedError("INVALID_PAYMENT", "the payment's arguments must be an object");
  return input as Record<string, unknown>;
};

function defaultPayment(input: unknown): PaymentAttempt & { requestId?: string } {
  const args = asObject(input);
  const amount = args.amountUsd;
  const amountUsd =
    typeof amount === "number"
      ? amount
      : typeof amount === "string" && /^\d+(\.\d+)?$/.test(amount.trim())
        ? Number(amount)
        : NaN;
  if (Number.isNaN(amountUsd))
    throw new BondedError("INVALID_PAYMENT", "amountUsd must be a number of US dollars");
  return {
    account: field(args, "account"),
    amountUsd,
    // Left out, it reaches the rules as empty: only invoice matching needs one.
    ...("invoiceReference" in args || "reference" in args
      ? {
          invoiceReference: field(
            args,
            "invoiceReference" in args ? "invoiceReference" : "reference",
          ),
        }
      : {}),
    ...(typeof args.requestId === "string" ? { requestId: args.requestId } : {}),
  };
}

function defaultChange(input: unknown): { vendorId: string; account: string; ticket?: string } {
  const args = asObject(input);
  return {
    vendorId: field(args, "vendorId"),
    account: field(args, "account"),
    ...(typeof args.ticket === "string" ? { ticket: args.ticket } : {}),
  };
}
