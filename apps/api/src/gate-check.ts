import { createHash, randomUUID } from "node:crypto";
import type {
  Connection,
  Database,
  GateAccountRecord,
  GateDecisionRecord,
  GateStore,
} from "@bonded/db";
import {
  canonicalJson,
  evaluateGateInput,
  gateInputHash,
  normalAccount,
  normalReference,
  GATE_RULE_WORDS,
  signGateReceipt,
  utcDay,
  type GateInput,
  type GateReceipt,
  type GateRule,
} from "@bondedhq/shared";
import type { Hex } from "viem";
import { Refused } from "./refused.js";
import { gateNotification, type Notifier } from "./notifications.js";

/**
 * One payment gate check (`POST /payments/check`, gate.ts): read the account's state, run the
 * shared rule engine on it, apply the account's mode and freeze, record the decision (and the
 * payment, when it goes out), and sign the receipt. It all happens in one transaction holding the
 * account's row lock, so two checks of the same account run one after the other: two checks of
 * the same invoice can't both pass the duplicate rule, and the day's total is always right.
 */

export type GateCheckRequest =
  | {
      kind: "invoice" | "refund";
      account: string;
      amountCents: number;
      reference: string;
      requestId?: string | undefined;
    }
  | {
      kind: "bank_change";
      vendorId: string;
      account: string;
      /** The ticket id the agent quotes: paperwork only, as in the Arena's ledger. */
      ticket?: string | undefined;
      requestId?: string | undefined;
    };

export interface GateCheckOutcome {
  decision: GateDecisionRecord;
  /** The rule engine's input, for the caller to keep; null when an earlier decision is replayed. */
  input: GateInput | null;
  /** The same request id came again: this is the first decision, unchanged. */
  replayed: boolean;
  /** This check froze the account. */
  froze: boolean;
  account: GateAccountRecord;
}

const sha256 = (value: string) => `0x${createHash("sha256").update(value).digest("hex")}`;

export async function runGateCheck(
  deps: {
    db: Database;
    store: GateStore;
    receiptKey: Hex;
    now: () => number;
    /**
     * With the account's invoice matching off, an invoice check runs as kind "payment". Only
     * `POST /payments/check` sets this, and it is never read from a request: an agent's key can't
     * choose the weaker check, and the payout route stays on invoices.
     */
    followInvoiceSetting?: boolean;
  },
  auth: { accountId: string; keyId: string },
  request: GateCheckRequest,
  /**
   * Runs at the end of a new check, inside its transaction with the account still locked (the
   * payout route records its payout there, gate-payout.ts). Not run for a replayed request id.
   */
  inside?: (c: Connection, outcome: GateCheckOutcome) => Promise<void>,
): Promise<GateCheckOutcome> {
  const { db, store } = deps;
  const { requestId, ...asked } = request;
  const requestHash = sha256(canonicalJson(asked));
  return db.transaction(async (c) => {
    const account = await store.lockAccount(c, auth.accountId);
    if (!account) throw new Refused(404, "No such gate account.");
    if (requestId) {
      const earlier = await store.decisionByRequest(c, account.id, requestId);
      if (earlier) {
        if (earlier.requestHash !== requestHash)
          throw new Refused(409, "That request id was already used for a different check.");
        return { decision: earlier, input: null, replayed: true, froze: false, account };
      }
    }
    const at = new Date(deps.now());
    const day = utcDay(at);
    await store.countCheck(c, account.id, day);
    await store.keyUsed(c, auth.keyId);

    const accountNorm = normalAccount(request.account);
    const general =
      request.kind === "invoice" &&
      deps.followInvoiceSetting === true &&
      account.invoiceMatching === false;
    const kind = general ? "payment" : request.kind;
    let input: GateInput;
    let reference = "";
    let amountCents = 0;
    if (request.kind === "bank_change") {
      if (!(await store.vendorExists(c, account.id, request.vendorId)))
        throw new Refused(404, "No such vendor on this gate account.");
      const state = await store.checkState(c, account.id, {
        kind: "bank_change",
        vendorId: request.vendorId,
        accountNorm,
      });
      input = {
        kind: "bank_change",
        vendorId: request.vendorId,
        account: accountNorm,
        tickets: state.tickets,
      };
    } else {
      reference = request.reference.trim();
      amountCents = request.amountCents;
      const state = await store.checkState(c, account.id, {
        kind: general ? "payment" : request.kind,
        accountNorm,
        referenceNorm: normalReference(reference),
        day,
      });
      const common = {
        day,
        limits: { maxPaymentCents: account.maxPaymentCents, maxDailyCents: account.maxDailyCents },
        attempt: { account: accountNorm, amountCents, reference },
        payees: state.payees,
        payments: state.payments,
      };
      input = general
        ? {
            kind: "payment",
            ...common,
            limits: { ...common.limits, maxPaymentsPerHour: account.maxPaymentsPerHour },
            paymentsLastHour: await store.paymentsSince(
              c,
              account.id,
              new Date(at.getTime() - 3_600_000),
            ),
          }
        : request.kind === "invoice"
          ? { kind: "invoice", ...common, invoices: state.invoices }
          : { kind: "refund", ...common, refunds: state.refunds };
    }

    // A frozen account is refused before the rules run.
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
    const wentOut = result === "allowed";
    const id = randomUUID();
    const inputHash = gateInputHash(input);
    const receipt: GateReceipt = {
      decisionId: id,
      gateAccountId: account.id,
      kind,
      decision,
      result,
      mode: account.mode,
      rules,
      amountCents,
      payee: accountNorm,
      reference,
      inputHash,
      mandateHash: account.mandateHash as Hex,
      mandateVersion: account.mandateVersion,
      checkedAt: Math.floor(at.getTime() / 1000),
    };
    const signed = await signGateReceipt(receipt, deps.receiptKey);
    const vendorId =
      request.kind === "bank_change" ? request.vendorId : verdict?.ok ? verdict.vendorId : null;
    const record = await store.addDecision(c, {
      id,
      accountId: account.id,
      keyId: auth.keyId,
      requestId: requestId ?? null,
      requestHash: requestId ? requestHash : null,
      kind,
      decision,
      result,
      mode: account.mode,
      rules,
      amountCents,
      // What left: nothing when it was blocked or refused.
      lossCents: wentOut && verdict?.ok ? verdict.lossCents : 0,
      overpaidCents: wentOut && verdict?.ok ? verdict.overpaidCents : 0,
      payee: accountNorm,
      vendorId,
      reference,
      inputHash,
      // Kept so the owner can recompute the hash and rerun the rules (the rules page).
      input,
      mandateHash: account.mandateHash,
      mandateVersion: account.mandateVersion,
      receipt: signed,
      createdAt: at,
    });

    if (wentOut && request.kind !== "bank_change")
      await store.addPayment(
        account.id,
        {
          decisionId: id,
          source: "check",
          kind: request.kind,
          payee: request.account,
          payeeNorm: accountNorm,
          // A refund settles no supplier invoice, as in the Arena's ledger.
          vendorId: request.kind === "refund" ? null : vendorId,
          amountCents,
          reference,
          referenceNorm: normalReference(reference),
          day,
        },
        c,
      );
    // A verified bank change becomes the vendor's verified account: a new mandate version. An
    // unverified one never does, even when Monitor mode lets it through, so payments to that
    // account still count as an unknown payee.
    // The ticket is used up: it can't later switch the vendor back to this account.
    if (request.kind === "bank_change" && decision === "pass") {
      await store.updateVendor(
        account.id,
        request.vendorId,
        { account: request.account, accountNorm },
        `bank_change:${id}`,
        c,
      );
      await store.useTickets(c, account.id, request.vendorId, accountNorm, id);
    }
    const froze = decision === "breach" && account.freezeOnBreach;
    if (froze) await store.freeze(c, account.id, id);
    const outcome: GateCheckOutcome = {
      decision: record,
      input,
      replayed: false,
      froze,
      account: (await store.account(account.id, c))!,
    };
    if (inside) await inside(c, outcome);
    return outcome;
  });
}

const dollars = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Each broken rule in plain words. */
export const ruleWords = (rules: readonly string[]) =>
  rules.map((rule) => ({ rule, words: GATE_RULE_WORDS[rule as GateRule] ?? rule }));

/** The decision in one sentence, for the agent and the log. */
export function decisionMessage(d: GateDecisionRecord): string {
  if (d.decision === "frozen")
    return "Refused: the gate account is frozen after a breach, until its owner lifts the freeze.";
  if (d.decision === "pass") return "Allowed: no rule broken.";
  const words = ruleWords(d.rules)
    .map((r) => r.words)
    .join("; ");
  return d.result === "blocked"
    ? `Blocked: ${words}.`
    : `Allowed in Monitor mode, but it broke the mandate: ${words}.`;
}

/** A decision as the API returns it. */
export function decisionView(d: GateDecisionRecord) {
  return {
    id: d.id,
    kind: d.kind,
    decision: d.decision,
    result: d.result,
    allowed: d.result === "allowed",
    message: decisionMessage(d),
    mode: d.mode,
    rules: d.rules,
    reasons: ruleWords(d.rules),
    amountUsd: d.amountCents / 100,
    lossUsd: d.lossCents / 100,
    overpaidUsd: d.overpaidCents / 100,
    payee: d.payee,
    vendorId: d.vendorId,
    reference: d.reference,
    requestId: d.requestId,
    inputHash: d.inputHash,
    /** What the rules were given; null for decisions made before it was kept. */
    input: d.input,
    mandate: { version: d.mandateVersion, hash: d.mandateHash },
    createdAt: d.createdAt.toISOString(),
    receipt: d.receipt,
  };
}

/**
 * Tell the owner (in-app list, webhook, email) about a block, a breach Monitor mode let through,
 * and a freeze. Once per decision. Never waits on the network and never fails the check.
 */
export function alertOwner(notifier: Notifier, outcome: GateCheckOutcome): void {
  const { decision: d, account } = outcome;
  if (outcome.replayed || d.decision !== "breach") return;
  const what =
    d.kind === "bank_change"
      ? `a bank change for vendor ${d.vendorId} to ${d.payee}`
      : `a ${d.kind === "refund" ? "refund" : "payment"} of ${dollars(d.amountCents)} to ${d.payee}`;
  const words = ruleWords(d.rules)
    .map((r) => r.words)
    .join("; ");
  const details = {
    decisionId: d.id,
    kind: d.kind,
    rules: d.rules.join(","),
    amountUsd: d.amountCents / 100,
    payee: d.payee,
    reference: d.reference,
  };
  const at = d.createdAt.toISOString();
  notifier.notify(
    account.owner,
    gateNotification(
      d.result === "blocked"
        ? {
            type: "payment_blocked",
            dedupeKey: `gate:${d.id}:payment_blocked`,
            gateAccountId: account.id,
            message: `The payment gate blocked ${what}: ${words}.`,
            details,
            at,
          }
        : {
            type: "payment_breach",
            dedupeKey: `gate:${d.id}:payment_breach`,
            gateAccountId: account.id,
            message: `${what[0]!.toUpperCase()}${what.slice(1)} broke the mandate and went through (Monitor mode): ${words}.`,
            details,
            at,
          },
    ),
  );
  if (outcome.froze)
    notifier.notify(
      account.owner,
      gateNotification({
        type: "gate_frozen",
        dedupeKey: `gate:${d.id}:gate_frozen`,
        gateAccountId: account.id,
        message: `The payment gate froze ${account.name ? `"${account.name}"` : "a gate account"} after a breach; every check is refused until you lift the freeze.`,
        details: { decisionId: d.id },
        at,
      }),
    );
}
