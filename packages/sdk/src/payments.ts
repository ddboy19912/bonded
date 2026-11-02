import {
  checkInvoicePayment,
  checkRefundPayment,
  isVerifiedChange,
  type KnownPayee,
  normalAccount,
  type PaidPayment,
  type PayableInvoice,
  type PayableRefund,
  type PaymentAttempt,
  type PaymentLimits,
  type PaymentRule,
  PAYMENT_RULE_WORDS,
  utcDay,
  type VerifiedChange,
} from "@bondedhq/shared";
import { BondedError, PaymentBlockedError, PaymentFrozenError } from "./errors.js";

/** The off-chain payment mandate an agent's payments are checked against. */
export interface PaymentMandate extends PaymentLimits {
  /** Monitor lets a breaking payment through and reports it; Enforce blocks it. */
  mode: "monitor" | "enforce";
  /** After the first breach, refuse every payment until a person unfreezes the guard. */
  freezeOnBreach: boolean;
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
}

/** One payment (or bank change) that broke the mandate, as the guard reports it. */
export interface PaymentBreach {
  kind: "invoice" | "refund" | "vendor_change";
  /** Every rule broken, most serious first. */
  rules: PaymentRule[];
  /** Each rule in plain words (`PAYMENT_RULE_WORDS`), in the same order. */
  reasons: string[];
  /** Enforce mode stopped it: the pay function was not called. */
  blocked: boolean;
  account: string;
  /** The invoice or refund reference; empty for a bank change. */
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
}

/** The rule verdict for a payment, without making it. */
export interface PaymentVerdict {
  /** Every rule the payment breaks, most serious first. Empty when it is allowed. */
  rules: PaymentRule[];
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
});

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
      const day = utcDay(this.#now());
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
      const changes = await read(this.#options.changes);
      if (!isVerifiedChange(changes, request)) {
        const rules: PaymentRule[] = ["unverified_vendor_change"];
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
        : checkInvoicePayment(
            { limits, payees, invoices: await read(this.#options.invoices), payments, day },
            attempt,
          );
    if (!check.ok) throw new BondedError("INVALID_PAYMENT", check.error);
    return check;
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
    if (this.mandate.freezeOnBreach) {
      this.#state.frozen = true;
      await this.#save();
    }
    await this.#options.onBreach?.({
      ...breach,
      rules: [...breach.rules],
      reasons: [...breach.reasons],
    });
    if (breach.blocked) throw new PaymentBlockedError(breach);
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

const words = (rules: readonly PaymentRule[]) => rules.map((r) => PAYMENT_RULE_WORDS[r]);

/** A payment guard: see `PaymentGuard`. */
export function paymentGuard(options: PaymentGuardOptions): PaymentGuard {
  return new PaymentGuard(options);
}

export interface GuardPaymentsOptions<I> {
  /** Share one guard between your invoice and refund functions, so limits and freezes are shared. */
  guard: PaymentGuard;
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
  guard: PaymentGuard;
  /** Reads the change from your function's first argument. Default: `{ vendorId, account }`. */
  toChange?: (input: I) => { vendorId: string; account: string };
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

/** The payment guard refused (blocked, frozen, or arguments it can't check): no money moved. */
export function isPaymentRefusal(
  error: unknown,
): error is PaymentBlockedError | PaymentFrozenError | BondedError {
  return (
    error instanceof PaymentBlockedError ||
    error instanceof PaymentFrozenError ||
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

function defaultPayment(input: unknown): PaymentAttempt {
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
    invoiceReference: field(args, "invoiceReference" in args ? "invoiceReference" : "reference"),
  };
}

function defaultChange(input: unknown): { vendorId: string; account: string } {
  const args = asObject(input);
  return { vendorId: field(args, "vendorId"), account: field(args, "account") };
}
