import { randomUUID, createHash } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type {
  Connection,
  Database,
  GateAccountRecord,
  GateBudgetRecord,
  GateBudgetStore,
  GateDecisionRecord,
  GateStore,
} from "@bonded/db";
import {
  BUDGET_DRIFT_MS,
  budgetCloseCents,
  budgetSpendProblem,
  type BudgetTerms,
  canonicalJson,
  checkBudget,
  evaluateGateInput,
  type GateBudgetCloseInput,
  type GateBudgetInput,
  gateInputHash,
  MAX_BUDGET_MS,
  MICROS_PER_USD,
  normalAccount,
  signGateReceipt,
  utcDay,
  type GateReceipt,
} from "@bondedhq/shared";
import type { Hex } from "viem";
import { Refused, handle } from "./refused.js";
import { gateNotification, type Notifier } from "./notifications.js";
import { decisionView } from "./gate-check.js";
import { alertWatched, judgeWatched, type WatchedOutcome } from "./gate-watch.js";
import type { GateWatchStore } from "@bonded/db";

/** Clock drift allowed between a reported payment and the same payment seen in a wallet. */
const WATCH_DRIFT_MS = 5 * 60_000;

/**
 * Budgets (apps/api/GATE.md, "Budgets"): one check covers many small payments to one payee, for
 * payments too small and too frequent to check one at a time (x402 calls of $0.001).
 *
 * - `POST /payments/budgets` checks the budget against the general rules (`checkBudget`) and signs
 *   a receipt whose input commits to the terms: the payee, the budget, the per-payment limit, how
 *   many payments it covers and when it expires (an hour at most). The whole budget is reserved
 *   against the daily limit.
 * - The agent's code (the SDK) spends against it with no network call, in micro-dollars, and
 *   reports each payment to `POST /payments/budgets/:id/spends`. A payment that breaks the terms
 *   alerts the owner, and freezes the account if it freezes on a breach.
 * - `POST /payments/budgets/:id/close`, or the sweep once it has expired, closes it: a second
 *   decision whose receipt commits to every payment's exact amount, and the reservation becomes
 *   what was spent (rounded up to the cent).
 *
 * Every step holds the account's row lock, as a check does.
 */

/** Payments may be reported this long after a budget expires before the sweep closes it. */
export const BUDGET_REPORT_GRACE_MS = 10 * 60_000;
/** The most payments in one report. */
const MAX_SPENDS_PER_REPORT = 500;

const sha256 = (value: string) => `0x${createHash("sha256").update(value).digest("hex")}`;

export interface BudgetDeps {
  db: Database;
  store: GateStore;
  budgets: GateBudgetStore;
  /** Watched payments under a budget that close finds unreported are judged here. */
  watch: GateWatchStore;
  /** Tells the owner about those payments. */
  notifier?: Notifier | undefined;
  receiptKey: Hex;
  now: () => number;
}

export interface BudgetOutcome {
  decision: GateDecisionRecord;
  /** The rule engine's input; null when an earlier decision is replayed. */
  input: GateBudgetInput | null;
  budget: GateBudgetRecord | null;
  replayed: boolean;
  froze: boolean;
  account: GateAccountRecord;
}

/** Ask for a budget. Allowed (or let through by Monitor mode), it opens and reserves its amount. */
export async function openBudget(
  deps: BudgetDeps,
  auth: { accountId: string; keyId: string | null },
  request: {
    account: string;
    budgetCents: number;
    maxPaymentMicros?: number | undefined;
    ttlMs: number;
    requestId?: string | undefined;
  },
): Promise<BudgetOutcome> {
  const { db, store, budgets } = deps;
  const { requestId, ...asked } = request;
  const requestHash = sha256(canonicalJson({ kind: "budget", ...asked }));
  const seen: WatchedOutcome[] = [];
  const outcome = await db.transaction(async (c): Promise<BudgetOutcome> => {
    const account = await store.lockAccount(c, auth.accountId);
    if (!account) throw new Refused(404, "No such gate account.");
    if (requestId) {
      const earlier = await store.decisionByRequest(c, account.id, requestId);
      if (earlier) {
        if (earlier.requestHash !== requestHash)
          throw new Refused(409, "That request id was already used for a different check.");
        return {
          decision: earlier,
          input: null,
          budget: (await budgets.budget(account.id, earlier.id, c)) ?? null,
          replayed: true,
          froze: false,
          account,
        };
      }
    }
    if (account.invoiceMatching)
      throw new Refused(
        409,
        "Budgets are for payments with no invoices: turn invoice matching off on this gate account.",
      );
    const at = new Date(deps.now());
    await closeExpiredIn(c, deps, account, at, seen);
    const day = utcDay(at);
    await store.countCheck(c, account.id, day);
    if (auth.keyId) await store.keyUsed(c, auth.keyId);

    const accountNorm = normalAccount(request.account);
    const state = await store.checkState(c, account.id, {
      kind: "payment",
      accountNorm,
      referenceNorm: "",
      day,
    });
    const paymentsLastHour = await store.paymentsSince(
      c,
      account.id,
      new Date(at.getTime() - 3_600_000),
    );
    const reservedPayments = await budgets.reservedPayments(c, account.id, at);
    const limits = {
      maxPaymentCents: account.maxPaymentCents,
      maxDailyCents: account.maxDailyCents,
      maxPaymentsPerHour: account.maxPaymentsPerHour,
    };
    const check = checkBudget(
      {
        limits: {
          maxPaymentUsd: limits.maxPaymentCents / 100,
          maxDailyUsd: limits.maxDailyCents / 100,
          maxPaymentsPerHour: limits.maxPaymentsPerHour,
        },
        payees: state.payees,
        payments: state.payments.map((p) => ({
          account: p.account,
          vendorId: p.vendorId,
          amountUsd: p.amountCents / 100,
          invoiceReference: p.reference,
          day: p.day,
        })),
        paymentsLastHour,
        reservedPayments,
        day,
      },
      { account: request.account, budgetUsd: request.budgetCents / 100 },
    );
    if (!check.ok) throw new Refused(400, check.error);
    const accountMax = account.maxPaymentCents * 10_000;
    const terms: BudgetTerms = {
      account: accountNorm,
      budgetMicros: request.budgetCents * 10_000,
      maxPaymentMicros: Math.min(request.maxPaymentMicros ?? accountMax, accountMax),
      maxPayments: check.maxPayments,
      startsAtMs: at.getTime(),
      expiresAtMs: at.getTime() + request.ttlMs,
    };
    const input: GateBudgetInput = {
      kind: "budget",
      day,
      limits,
      attempt: { account: accountNorm, amountCents: request.budgetCents, reference: "" },
      payees: state.payees,
      payments: state.payments,
      paymentsLastHour,
      reservedPayments,
      terms,
    };

    const frozen = account.frozenAt !== null;
    const verdict = frozen ? undefined : evaluateGateInput(input);
    if (verdict && !verdict.ok) throw new Refused(400, verdict.error);
    const rules = verdict?.ok ? verdict.rules : [];
    const decision = frozen ? "frozen" : rules.length ? "breach" : "pass";
    const result = frozen
      ? "refused"
      : rules.length && account.mode === "enforce"
        ? "blocked"
        : "allowed";
    const id = randomUUID();
    const record = await addSignedDecision(c, deps, account, {
      id,
      keyId: auth.keyId,
      requestId: requestId ?? null,
      requestHash: requestId ? requestHash : null,
      kind: "budget",
      decision,
      result,
      rules,
      amountCents: request.budgetCents,
      payee: accountNorm,
      vendorId: check.vendorId,
      input,
      at,
    });
    let budget: GateBudgetRecord | null = null;
    if (result === "allowed") {
      budget = await budgets.add(c, {
        id,
        accountId: account.id,
        keyId: auth.keyId,
        payee: request.account,
        payeeNorm: accountNorm,
        vendorId: check.vendorId,
        budgetMicros: terms.budgetMicros,
        maxPaymentMicros: terms.maxPaymentMicros,
        maxPayments: terms.maxPayments,
        startsAt: at,
        expiresAt: new Date(terms.expiresAtMs),
        terms,
      });
      await store.addPayment(
        account.id,
        {
          decisionId: id,
          source: "budget",
          kind: "invoice",
          payee: request.account,
          payeeNorm: accountNorm,
          vendorId: check.vendorId,
          amountCents: request.budgetCents,
          reference: "",
          referenceNorm: "",
          day,
        },
        c,
      );
    }
    const froze = decision === "breach" && account.freezeOnBreach;
    if (froze) await store.freeze(c, account.id, id);
    return {
      decision: record,
      input,
      budget,
      replayed: false,
      froze,
      account: (await store.account(account.id, c))!,
    };
  });
  alertUnreported(deps, seen);
  return outcome;
}

export interface SpendReport {
  id: string;
  amountMicros: number;
  reference: string;
  at: Date;
}

export interface SpendOutcome {
  budget: GateBudgetRecord;
  /** Payments recorded now (not reported before). */
  recorded: number;
  /** Payments whose id was reported before: nothing changed for them. */
  repeated: number;
  /** Payments recorded now that broke the budget's terms. */
  problems: { id: string; problem: string; amountMicros: number }[];
  froze: boolean;
  account: GateAccountRecord;
}

/** Record payments made against a budget. A payment that breaks the terms is still recorded. */
export async function reportSpends(
  deps: BudgetDeps,
  auth: { accountId: string },
  budgetId: string,
  spends: readonly SpendReport[],
): Promise<SpendOutcome> {
  const { db, store, budgets } = deps;
  return db.transaction(async (c) => {
    const account = await store.lockAccount(c, auth.accountId);
    if (!account) throw new Refused(404, "No such gate account.");
    const budget = await budgets.budget(account.id, budgetId, c);
    if (!budget) throw new Refused(404, "No such budget on this gate account.");
    if (budget.closedAt) throw new Refused(409, "That budget is closed: open a new one.");
    const terms = budget.terms as BudgetTerms;
    let spentMicros = budget.spentMicros;
    let payments = budget.payments;
    let recorded = 0;
    const problems: SpendOutcome["problems"] = [];
    for (const s of spends) {
      const problem = budgetSpendProblem(
        terms,
        { spentMicros, payments },
        { amountMicros: s.amountMicros, atMs: s.at.getTime() },
      );
      const added = await budgets.addSpend(c, {
        budgetId,
        accountId: account.id,
        spendId: s.id,
        amountMicros: s.amountMicros,
        reference: s.reference,
        paidAt: s.at,
        problem: problem ?? null,
      });
      if (!added) continue;
      // Watch may have seen it in the wallet first: that payment is this one.
      await budgets.linkSpend(c, {
        budgetId,
        spendId: added.id,
        amountMicros: s.amountMicros,
        paidAt: s.at,
        driftMs: WATCH_DRIFT_MS,
      });
      recorded += 1;
      spentMicros += s.amountMicros;
      payments += 1;
      if (problem) problems.push({ id: s.id, problem, amountMicros: s.amountMicros });
    }
    const froze = problems.length > 0 && account.freezeOnBreach && account.frozenAt === null;
    if (froze) await store.freeze(c, account.id, budgetId);
    return {
      budget: (await budgets.budget(account.id, budgetId, c))!,
      recorded,
      repeated: spends.length - recorded,
      problems,
      froze,
      account: (await store.account(account.id, c))!,
    };
  });
}

/** Close a budget now. Closing a closed one gives back its close decision. */
export async function closeBudget(
  deps: BudgetDeps,
  auth: { accountId: string; keyId: string | null },
  budgetId: string,
): Promise<{
  decision: GateDecisionRecord;
  budget: GateBudgetRecord;
  input: GateBudgetCloseInput | null;
}> {
  const { db, store, budgets } = deps;
  const seen: WatchedOutcome[] = [];
  const result = await db.transaction(async (c) => {
    const account = await store.lockAccount(c, auth.accountId);
    if (!account) throw new Refused(404, "No such gate account.");
    const budget = await budgets.budget(account.id, budgetId, c);
    if (!budget) throw new Refused(404, "No such budget on this gate account.");
    if (budget.closeDecision) {
      const earlier = await store.decision(account.id, budget.closeDecision);
      if (!earlier) throw new Refused(409, "That budget was closed and its log entry has expired.");
      return { decision: earlier, budget, input: null };
    }
    const closed = await closeIn(c, deps, account, budget, new Date(deps.now()), auth.keyId, seen);
    return { ...closed, budget: (await budgets.budget(account.id, budgetId, c))! };
  });
  alertUnreported(deps, seen);
  return result;
}

/** Close the account's budgets that expired more than the grace period ago. */
export async function closeExpired(deps: BudgetDeps, accountId: string): Promise<number> {
  const seen: WatchedOutcome[] = [];
  const closed = await deps.db.transaction(async (c) => {
    const account = await deps.store.lockAccount(c, accountId);
    if (!account) return 0;
    return closeExpiredIn(c, deps, account, new Date(deps.now()), seen);
  });
  alertUnreported(deps, seen);
  return closed;
}

/** Tell the owner about wallet payments a closed budget never had reported. After the commit. */
function alertUnreported(deps: BudgetDeps, seen: readonly WatchedOutcome[]) {
  if (deps.notifier) for (const outcome of seen) alertWatched(deps.notifier, outcome);
}

/** Close every expired budget on the service, a batch of accounts at a time. */
export async function sweepBudgets(deps: BudgetDeps): Promise<number> {
  const before = new Date(deps.now() - BUDGET_REPORT_GRACE_MS);
  let closed = 0;
  for (const accountId of await deps.budgets.accountsWithExpired(before))
    closed += await closeExpired(deps, accountId);
  return closed;
}

async function closeExpiredIn(
  c: Connection,
  deps: BudgetDeps,
  account: GateAccountRecord,
  at: Date,
  seen: WatchedOutcome[],
): Promise<number> {
  const expired = await deps.budgets.expired(
    c,
    account.id,
    new Date(at.getTime() - BUDGET_REPORT_GRACE_MS),
  );
  for (const budget of expired) await closeIn(c, deps, account, budget, at, null, seen);
  return expired.length;
}

/** The close decision: a receipt for every payment, and the reservation settled at what was spent. */
async function closeIn(
  c: Connection,
  deps: BudgetDeps,
  account: GateAccountRecord,
  budget: GateBudgetRecord,
  at: Date,
  keyId: string | null,
  seen: WatchedOutcome[],
): Promise<{ decision: GateDecisionRecord; input: GateBudgetCloseInput }> {
  const spends = await deps.budgets.spends(c, budget.id);
  const input: GateBudgetCloseInput = {
    kind: "budget_close",
    budgetId: budget.id,
    terms: budget.terms as BudgetTerms,
    spends: spends.map((s) => ({
      id: s.spendId,
      amountMicros: s.amountMicros,
      reference: s.reference,
      atMs: s.paidAt.getTime(),
    })),
  };
  const verdict = evaluateGateInput(input);
  const rules = verdict.ok ? verdict.rules : [];
  const cents = budgetCloseCents(input);
  const id = randomUUID();
  const decision = await addSignedDecision(c, deps, account, {
    id,
    keyId,
    requestId: null,
    requestHash: null,
    kind: "budget_close",
    decision: rules.length ? "breach" : "pass",
    // Closing stops nothing: the payments were already made.
    result: "allowed",
    rules,
    amountCents: cents,
    payee: budget.payeeNorm,
    vendorId: budget.vendorId,
    reference: budget.id,
    input,
    at,
  });
  await deps.budgets.close(c, budget.id, id, at);
  await deps.store.settleBudgetPayment(c, budget.id, cents);
  // Wallet payments under the budget that no reported payment matched: the agent paid without its
  // code reporting it (a skipped SDK, or a crash before it sent). Judged as payments with no check,
  // so they count toward the limits and alert like any other.
  for (const id of await deps.budgets.unreported(c, budget.id)) {
    const [payment] = await deps.watch.watchedByIds(account.id, [id], c);
    if (!payment) continue;
    const judged = await judgeWatched(c, deps.store, account, payment);
    const rejudged = await deps.watch.rejudge(c, id, judged.verdict);
    seen.push({ payment: rejudged, repeated: false, froze: judged.froze, account });
    if (judged.froze) account = { ...account, frozenAt: at };
  }
  return { decision, input };
}

async function addSignedDecision(
  c: Connection,
  deps: BudgetDeps,
  account: GateAccountRecord,
  d: {
    id: string;
    keyId: string | null;
    requestId: string | null;
    requestHash: string | null;
    kind: "budget" | "budget_close";
    decision: GateDecisionRecord["decision"];
    result: GateDecisionRecord["result"];
    rules: GateReceipt["rules"];
    amountCents: number;
    payee: string;
    vendorId: string | null;
    reference?: string;
    input: GateBudgetInput | GateBudgetCloseInput;
    at: Date;
  },
): Promise<GateDecisionRecord> {
  const inputHash = gateInputHash(d.input);
  const receipt: GateReceipt = {
    decisionId: d.id,
    gateAccountId: account.id,
    kind: d.kind,
    decision: d.decision,
    result: d.result,
    mode: account.mode,
    rules: d.rules,
    amountCents: d.amountCents,
    payee: d.payee,
    reference: d.reference ?? "",
    inputHash,
    mandateHash: account.mandateHash as Hex,
    mandateVersion: account.mandateVersion,
    checkedAt: Math.floor(d.at.getTime() / 1000),
  };
  const signed = await signGateReceipt(receipt, deps.receiptKey);
  return deps.store.addDecision(c, {
    id: d.id,
    accountId: account.id,
    keyId: d.keyId,
    requestId: d.requestId,
    requestHash: d.requestHash,
    kind: d.kind,
    decision: d.decision,
    result: d.result,
    mode: account.mode,
    rules: d.rules,
    amountCents: d.amountCents,
    lossCents: 0,
    overpaidCents: 0,
    payee: d.payee,
    vendorId: d.vendorId,
    reference: d.reference ?? "",
    inputHash,
    input: d.input,
    mandateHash: account.mandateHash,
    mandateVersion: account.mandateVersion,
    receipt: signed,
    createdAt: d.at,
  });
}

const usd = (micros: number) => micros / MICROS_PER_USD;

/** A budget as the API returns it. */
export function budgetView(b: GateBudgetRecord) {
  return {
    id: b.id,
    payee: b.payeeNorm,
    vendorId: b.vendorId,
    budgetUsd: usd(b.budgetMicros),
    maxPaymentUsd: usd(b.maxPaymentMicros),
    maxPayments: b.maxPayments,
    startsAt: b.startsAt.toISOString(),
    expiresAt: b.expiresAt.toISOString(),
    spentUsd: usd(b.spentMicros),
    payments: b.payments,
    open: b.closedAt === null,
    closedAt: b.closedAt?.toISOString() ?? null,
    closeDecision: b.closeDecision,
    terms: b.terms,
  };
}

/** Tell the owner about a budget the gate blocked or let through with a breach, and a freeze. */
export function alertBudget(notifier: Notifier, outcome: BudgetOutcome): void {
  const { decision: d, account } = outcome;
  if (outcome.replayed || d.decision !== "breach") return;
  const what = `a budget of ${dollars(d.amountCents)} for ${d.payee}`;
  const reasons = decisionView(d)
    .reasons.map((r) => r.words)
    .join("; ");
  const details = { decisionId: d.id, kind: d.kind, rules: d.rules.join(","), payee: d.payee };
  const at = d.createdAt.toISOString();
  notifier.notify(
    account.owner,
    gateNotification(
      d.result === "blocked"
        ? {
            type: "payment_blocked",
            dedupeKey: `gate:${d.id}:payment_blocked`,
            gateAccountId: account.id,
            message: `The payment gate blocked ${what}: ${reasons}.`,
            details,
            at,
          }
        : {
            type: "payment_breach",
            dedupeKey: `gate:${d.id}:payment_breach`,
            gateAccountId: account.id,
            message: `${what[0]!.toUpperCase()}${what.slice(1)} broke the mandate and went through (Monitor mode): ${reasons}.`,
            details,
            at,
          },
    ),
  );
  if (outcome.froze) frozenAlert(notifier, account, d.id, at);
}

/** Tell the owner about payments that broke their budget's terms. */
export function alertSpends(notifier: Notifier, outcome: SpendOutcome): void {
  if (outcome.problems.length === 0) return;
  const { budget: b, account } = outcome;
  const first = outcome.problems[0]!;
  const at = new Date().toISOString();
  notifier.notify(
    account.owner,
    gateNotification({
      type: "payment_breach",
      dedupeKey: `gate:budget:${b.id}:${first.id}:payment_breach`,
      gateAccountId: account.id,
      message: `${outcome.problems.length === 1 ? "A payment" : `${outcome.problems.length} payments`} against a budget for ${b.payeeNorm} broke it: ${first.problem}.`,
      details: {
        budgetId: b.id,
        rules: "over_budget",
        payee: b.payeeNorm,
        spends: outcome.problems.map((p) => p.id).join(","),
      },
      at,
    }),
  );
  if (outcome.froze) frozenAlert(notifier, account, b.id, at);
}

function frozenAlert(notifier: Notifier, account: GateAccountRecord, id: string, at: string) {
  notifier.notify(
    account.owner,
    gateNotification({
      type: "gate_frozen",
      dedupeKey: `gate:${id}:gate_frozen`,
      gateAccountId: account.id,
      message: `The payment gate froze ${account.name ? `"${account.name}"` : "a gate account"} after a breach; every check is refused until you lift the freeze.`,
      details: { decisionId: id },
      at,
    }),
  );
}

const dollars = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Dollars with at most two decimals, as whole cents. */
const cents = z
  .number()
  .positive()
  .max(100_000_000_000)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, "at most two decimals")
  .transform((v) => Math.round(v * 100));
/** Dollars with at most six decimals, as micro-dollars. */
const micros = z
  .number()
  .positive()
  .max(100_000_000_000)
  .refine((v) => Math.abs(v * 1e6 - Math.round(v * 1e6)) < 1e-3, "at most six decimals")
  .transform((v) => Math.round(v * 1e6));
const payee = z
  .string()
  .max(100)
  .regex(/^[\x20-\x7E]+$/)
  .refine((v) => normalAccount(v).length > 0);
const requestId = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const budgetInput = z.strictObject({
  account: payee,
  /** The budget: at most two decimals. */
  amountUsd: cents,
  /** The most one payment may be, up to six decimals. Default: the account's per-payment limit. */
  maxPaymentUsd: micros.optional(),
  /** How long it lasts: a minute to an hour (the default). */
  ttlSeconds: z
    .number()
    .int()
    .min(60)
    .max(MAX_BUDGET_MS / 1000)
    .default(MAX_BUDGET_MS / 1000),
  requestId: requestId.optional(),
});
const spendsInput = z.strictObject({
  spends: z
    .array(
      z.strictObject({
        /** Your id for the payment: reporting it again records nothing. */
        id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
        amountMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        reference: z
          .string()
          .max(200)
          .regex(/^[^\p{Cc}]*$/u)
          .default(""),
        at: z.iso.datetime({ offset: true }),
      }),
    )
    .min(1)
    .max(MAX_SPENDS_PER_REPORT),
});
const listQuery = z.strictObject({
  open: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.iso.datetime({ offset: true }).optional(),
});
const uuid = z.uuid();

export function gateBudgetRoutes(
  app: Hono,
  deps: {
    db: Database;
    store: GateStore;
    budgets: GateBudgetStore;
    notifier: Notifier;
    receiptKey: Hex | undefined;
    now: () => number;
    watch: GateWatchStore;
    owned: (c: Context) => Promise<{ account: GateAccountRecord }>;
    keyed: (c: Context) => Promise<{ accountId: string; keyId: string }>;
    allowCheck: (accountId: string) => boolean;
  },
) {
  const { budgets, notifier, now } = deps;
  const ready = (): BudgetDeps => {
    // Fail closed: a decision without a signed receipt is never given.
    if (!deps.receiptKey)
      throw new Refused(503, "The payment gate's receipt key isn't set up on this service.");
    return {
      db: deps.db,
      store: deps.store,
      budgets,
      watch: deps.watch,
      notifier,
      receiptKey: deps.receiptKey,
      now,
    };
  };
  const budgetId = (c: Context) => {
    const parsed = uuid.safeParse(c.req.param("budgetId"));
    if (!parsed.success) throw new Refused(404, "No such budget on this gate account.");
    return parsed.data;
  };
  const list = async (c: Context, accountId: string) => {
    const q = listQuery.parse(c.req.query());
    const page = await budgets.budgets(accountId, {
      ...(q.open ? { open: q.open === "true" } : {}),
      ...(q.limit ? { limit: q.limit } : {}),
      ...(q.before ? { before: q.before } : {}),
    });
    return c.json({ items: page.items.map(budgetView), next: page.next });
  };
  const one = async (c: Context, accountId: string) => {
    const b = await budgets.budget(accountId, budgetId(c));
    if (!b) throw new Refused(404, "No such budget on this gate account.");
    const spends = await budgets.spends(deps.db.pool, b.id);
    return c.json({
      ...budgetView(b),
      spends: spends.map((s) => ({
        id: s.spendId,
        amountUsd: s.amountMicros / MICROS_PER_USD,
        reference: s.reference,
        paidAt: s.paidAt.toISOString(),
        problem: s.problem,
      })),
    });
  };

  /** Ask for a budget: one check for many small payments to one payee. */
  app.post(
    "/payments/budgets",
    handle(async (c) => {
      const auth = await deps.keyed(c);
      if (!deps.allowCheck(auth.accountId))
        throw new Refused(429, "Too many checks for this gate account. Try again in a minute.");
      const ready_ = ready();
      const body = budgetInput.parse(await c.req.json());
      const outcome = await openBudget(ready_, auth, {
        account: body.account,
        budgetCents: body.amountUsd,
        maxPaymentMicros: body.maxPaymentUsd,
        ttlMs: body.ttlSeconds * 1000,
        requestId: body.requestId,
      });
      alertBudget(notifier, outcome);
      c.header("Cache-Control", "no-store");
      return c.json(
        {
          ...decisionView(outcome.decision),
          frozen: outcome.account.frozenAt !== null,
          replayed: outcome.replayed,
          ...(outcome.input ? { input: outcome.input } : {}),
          budget: outcome.budget ? budgetView(outcome.budget) : null,
        },
        outcome.replayed ? 200 : 201,
      );
    }),
  );
  /** Report payments made against a budget. */
  app.post(
    "/payments/budgets/:budgetId/spends",
    handle(async (c) => {
      const auth = await deps.keyed(c);
      const id = budgetId(c);
      const { spends } = spendsInput.parse(await c.req.json());
      const latest = now() + BUDGET_DRIFT_MS;
      for (const s of spends)
        if (Date.parse(s.at) > latest)
          throw new Refused(400, `Payment ${s.id} is dated in the future.`);
      const outcome = await reportSpends(
        ready(),
        auth,
        id,
        spends.map((s) => ({ ...s, at: new Date(s.at) })),
      );
      alertSpends(notifier, outcome);
      return c.json({
        budget: budgetView(outcome.budget),
        recorded: outcome.recorded,
        repeated: outcome.repeated,
        problems: outcome.problems.map((p) => ({ id: p.id, problem: p.problem })),
        frozen: outcome.account.frozenAt !== null,
      });
    }),
  );
  /** Close a budget: its receipt commits to every payment, and the unspent part is released. */
  app.post(
    "/payments/budgets/:budgetId/close",
    handle(async (c) => {
      const auth = await deps.keyed(c);
      const closed = await closeBudget(ready(), auth, budgetId(c));
      c.header("Cache-Control", "no-store");
      return c.json({
        ...decisionView(closed.decision),
        ...(closed.input ? { input: closed.input } : {}),
        budget: budgetView(closed.budget),
      });
    }),
  );
  app.get(
    "/payments/budgets",
    handle(async (c) => list(c, (await deps.keyed(c)).accountId)),
  );
  app.get(
    "/payments/budgets/:budgetId",
    handle(async (c) => one(c, (await deps.keyed(c)).accountId)),
  );
  app.get(
    "/gate/accounts/:id/budgets",
    handle(async (c) => list(c, (await deps.owned(c)).account.id)),
  );
  app.get(
    "/gate/accounts/:id/budgets/:budgetId",
    handle(async (c) => one(c, (await deps.owned(c)).account.id)),
  );
}
