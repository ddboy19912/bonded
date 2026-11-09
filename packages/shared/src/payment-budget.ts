import {
  GATE_RULES,
  type GateRule,
  type GeneralPaymentLimits,
  type KnownPayee,
  normalAccount,
  type PaidPayment,
} from "./payment-mandate.js";

/**
 * Payment budgets: one check covers many small payments to one payee. The gate (or the SDK's
 * local guard) checks the budget once against the rules and reserves it against the daily limit;
 * the agent's code then spends against it with no network call, in exact micro-dollars, and
 * reports what it spent. Closing the budget counts what was spent instead of the reservation.
 *
 * For payments too small and too frequent to check one by one, such as x402 calls of $0.001.
 * Gate-only: none of this is in `PAYMENT_RULES`, so it can't touch a rating (docs/SCORING.md).
 */

/** Millionths of a US dollar, the unit USDC counts in: an x402 price of $0.001 is 1,000. */
export const MICROS_PER_USD = 1_000_000;
const MICROS_PER_CENT = 10_000;

/** The longest a budget lasts, so the hourly limit still holds across one. */
export const MAX_BUDGET_MS = 3_600_000;
/** Clock drift allowed between the gate and a spend's stated time. */
export const BUDGET_DRIFT_MS = 5 * 60_000;

/** Dollars as whole micro-dollars; undefined unless finite, not negative, and at most 6 decimals. */
export function usdToMicros(usd: number): number | undefined {
  if (!Number.isFinite(usd) || usd < 0) return undefined;
  const micros = Math.round(usd * MICROS_PER_USD);
  if (Math.abs(usd * MICROS_PER_USD - micros) > 1e-3 || !Number.isSafeInteger(micros))
    return undefined;
  return micros;
}

/** Micro-dollars as whole cents, rounded up: what a budget's spending counts as on the day. */
export const microsToCentsUp = (micros: number) => Math.ceil(micros / MICROS_PER_CENT);

/** What a budget allows, as the gate signed it (in the budget check's input). */
export interface BudgetTerms {
  /** The one account it pays, as `normalAccount` gives it. */
  account: string;
  budgetMicros: number;
  /** The most one payment may be. */
  maxPaymentMicros: number;
  /** The most payments it covers (what the hourly limit had room for); null for no limit. */
  maxPayments: number | null;
  /** When it opens and expires, in Unix milliseconds. */
  startsAtMs: number;
  expiresAtMs: number;
}

/** One payment made against a budget, as the agent's code reports it. */
export interface BudgetSpend {
  /** The spender's id for it: the same id twice is one spend. */
  id: string;
  amountMicros: number;
  /** What it paid for or settled as (an x402 transaction hash or the resource); may be empty. */
  reference: string;
  /** When it was made, in Unix milliseconds. */
  atMs: number;
}

export type BudgetCheck =
  | { ok: false; error: string }
  | {
      ok: true;
      vendorId: string | null;
      /** Every rule broken, most serious first. */
      rules: GateRule[];
      /** How many payments the budget may cover; null when there's no hourly limit. */
      maxPayments: number | null;
    };

/**
 * Check a budget request against the general rules (invoice matching off): the payee must be a
 * vendor's account (`unknown_payee`), the whole budget must fit in what's left of the day's limit
 * (`over_daily_cap`), and with an hourly limit there must be room for at least one more payment
 * (`over_hourly_limit`), counting payments open budgets may still make. The per-payment limit
 * applies to each payment against the budget, not to the budget.
 */
export function checkBudget(
  context: {
    limits: GeneralPaymentLimits;
    payees: readonly KnownPayee[];
    /** Payments that count against the day, including other budgets' reservations. */
    payments: readonly PaidPayment[];
    paymentsLastHour: number;
    /** Payments open budgets may still make. */
    reservedPayments: number;
    day: string;
  },
  request: { account: string; budgetUsd: number },
): BudgetCheck {
  const budget = Math.round(request.budgetUsd * 100);
  if (!Number.isFinite(request.budgetUsd) || budget <= 0)
    return { ok: false, error: "budgetUsd must be a positive number" };
  if (Math.abs(request.budgetUsd * 100 - budget) > 1e-6)
    return { ok: false, error: "budgetUsd has more than two decimals" };
  const account = normalAccount(request.account);
  if (!account) return { ok: false, error: "account is required" };
  const vendorId =
    context.payees.find((p) => normalAccount(p.account) === account)?.vendorId ?? null;
  const paidToday = context.payments
    .filter((p) => p.day === context.day)
    .reduce((sum, p) => sum + Math.round(p.amountUsd * 100), 0);
  const limit = context.limits.maxPaymentsPerHour;
  const room =
    limit === null
      ? null
      : Math.max(0, limit - context.paymentsLastHour - context.reservedPayments);
  const broken = new Set<GateRule>();
  if (vendorId === null) broken.add("unknown_payee");
  if (paidToday + budget > Math.round(context.limits.maxDailyUsd * 100))
    broken.add("over_daily_cap");
  if (room === 0) broken.add("over_hourly_limit");
  return {
    ok: true,
    vendorId,
    rules: GATE_RULES.filter((r) => broken.has(r)),
    maxPayments: room,
  };
}

/** Why a spend breaks its budget, in plain words; undefined when it fits. */
export function budgetSpendProblem(
  terms: BudgetTerms,
  before: { spentMicros: number; payments: number },
  spend: Pick<BudgetSpend, "amountMicros" | "atMs">,
): string | undefined {
  if (!Number.isSafeInteger(spend.amountMicros) || spend.amountMicros <= 0)
    return "the amount isn't a positive whole number of micro-dollars";
  if (spend.atMs > terms.expiresAtMs + BUDGET_DRIFT_MS)
    return "it was paid after the budget expired";
  if (spend.atMs < terms.startsAtMs - BUDGET_DRIFT_MS)
    return "it was paid before the budget opened";
  if (spend.amountMicros > terms.maxPaymentMicros) return "it is over the per-payment limit";
  if (terms.maxPayments !== null && before.payments + 1 > terms.maxPayments)
    return "the budget covers no more payments";
  if (before.spentMicros + spend.amountMicros > terms.budgetMicros)
    return "it goes past the budget";
  return undefined;
}

/**
 * Every spend counted in order: what was spent and which spends broke the budget. A spend that
 * breaks it still counts, since the money left.
 */
export function replayBudget(
  terms: BudgetTerms,
  spends: readonly BudgetSpend[],
): {
  spentMicros: number;
  payments: number;
  problems: { id: string; problem: string }[];
} {
  let spentMicros = 0;
  let payments = 0;
  const problems: { id: string; problem: string }[] = [];
  for (const spend of spends) {
    const problem = budgetSpendProblem(terms, { spentMicros, payments }, spend);
    if (problem) problems.push({ id: spend.id, problem });
    spentMicros += Number.isSafeInteger(spend.amountMicros) ? Math.max(0, spend.amountMicros) : 0;
    payments += 1;
  }
  return { spentMicros, payments, problems };
}
