import type { Hex } from "viem";
import type { DryRunResult, VaultBreach } from "./breaches.js";
import type { PaymentBreach } from "./payments.js";

/** Base class for every error the SDK throws on purpose. `code` is stable; messages may change. */
export class BondedError extends Error {
  override readonly name: string = "BondedError";
  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The signing key isn't the vault's agent key: only that key can call `execute`. */
export class NotAgentError extends BondedError {
  override readonly name = "NotAgentError";
  constructor(
    readonly vault: Hex,
    readonly signer: Hex | undefined,
    options?: { cause?: unknown },
  ) {
    super(
      "NOT_AGENT",
      `${signer ?? "this account"} is not the agent key of vault ${vault}; only the vault's agent can act through it`,
      options,
    );
  }
}

/**
 * The vault is frozen: its guardian froze it, or a breach did (freeze on breach). Nothing the
 * agent sends will run until the guardian unfreezes it.
 */
export class VaultFrozenError extends BondedError {
  override readonly name = "VaultFrozenError";
  constructor(
    readonly vault: Hex,
    /** Set when this action froze it: the vault found an earlier unexplained outflow first. */
    readonly breach?: VaultBreach,
    /** The transaction that froze it, when this action did. */
    readonly hash?: Hex,
    options?: { cause?: unknown },
  ) {
    super(
      "VAULT_FROZEN",
      breach
        ? `vault ${vault} froze before acting: it found an earlier outflow it couldn't explain (breach ${breach.id})`
        : `vault ${vault} is frozen; its guardian has to unfreeze it`,
      options,
    );
  }
}

/** Enforce mode stopped the action: the vault recorded the attempt as a breach and moved nothing. */
export class BlockedByMandateError extends BondedError {
  override readonly name = "BlockedByMandateError";
  constructor(
    readonly breach: VaultBreach,
    readonly hash: Hex,
  ) {
    super(
      "BLOCKED_BY_MANDATE",
      `the vault blocked this action (${breach.type}): ${breach.reason}. The attempt is recorded as breach ${breach.id}`,
    );
  }
}

/** A guarded vault refused to send an action because its dry run predicts a breach. */
export class PredictedBreachError extends BondedError {
  override readonly name = "PredictedBreachError";
  constructor(readonly dryRun: DryRunResult) {
    const breach = dryRun.breach;
    super(
      "PREDICTED_BREACH",
      breach
        ? `refused: the vault would record a breach (${breach.type}): ${breach.reason}`
        : "refused: the vault would not run this action",
    );
  }
}

/** Sentinel's answer for a proposed action, as `POST /sentinel/check` returns it. */
export interface SentinelVerdict {
  /** True when Sentinel advises against the action (manipulated at or above the threshold). */
  blocked: boolean;
  /** How strongly the action looks driven by the untrusted inputs, 0 to 1. */
  manipulated: number;
  /** How strongly the inputs look like they contain instructions for the agent, 0 to 1. */
  injection: number;
  blockThreshold: number;
  model: string;
  latencyMs: number;
  advice: string;
}

/** A guarded vault refused an action because Sentinel advised against it. */
export class SentinelRefusedError extends BondedError {
  override readonly name = "SentinelRefusedError";
  constructor(readonly verdict: SentinelVerdict) {
    super(
      "SENTINEL_REFUSED",
      `refused on Sentinel's advice (manipulated ${verdict.manipulated.toFixed(2)} ≥ ${verdict.blockThreshold}): ${verdict.advice}`,
    );
  }
}

/** The Sentinel API didn't give an answer: refused the request, was busy, or couldn't be reached. */
export class SentinelError extends BondedError {
  override readonly name = "SentinelError";
  constructor(
    message: string,
    /** HTTP status, when the API answered. */
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super("SENTINEL_ERROR", message, options);
  }
}

/** The call the agent asked the vault to make reverted (e.g. not enough balance). Nothing changed. */
export class CallRevertedError extends BondedError {
  override readonly name = "CallRevertedError";
  constructor(
    message: string,
    /** The revert data, when the node returned it. */
    readonly data?: Hex,
    options?: { cause?: unknown },
  ) {
    super("CALL_REVERTED", message, options);
  }
}

/**
 * The payment guard stopped a payment (or a vendor bank change) in Enforce mode: it breaks the
 * payment mandate. The pay function was never called; `error.breach` names every rule broken.
 */
export class PaymentBlockedError extends BondedError {
  override readonly name = "PaymentBlockedError";
  constructor(readonly breach: PaymentBreach) {
    super(
      "PAYMENT_BLOCKED",
      `${breach.kind === "vendor_change" ? "bank change" : "payment"} blocked by the mandate: ${breach.reasons.join("; ")}. Nothing was ${breach.kind === "vendor_change" ? "changed" : "paid"}`,
    );
  }
}

/**
 * The hosted payment gate gave no answer to act on: it couldn't be reached, refused the request,
 * or its answer didn't check out. It fails closed: the pay function was not called.
 */
export class PaymentGateError extends BondedError {
  override readonly name = "PaymentGateError";
  /** The answer came back, but its signed receipt didn't check out. */
  readonly receipt: boolean;
  constructor(
    message: string,
    /** HTTP status, when the API answered. */
    readonly status?: number,
    options?: { cause?: unknown; receipt?: boolean },
  ) {
    super("PAYMENT_GATE_ERROR", message, options);
    this.receipt = options?.receipt ?? false;
  }
}

/** The payment guard is frozen after a breach (freeze on breach). It refuses until unfrozen. */
export class PaymentFrozenError extends BondedError {
  override readonly name = "PaymentFrozenError";
  constructor() {
    super(
      "PAYMENT_FROZEN",
      "payments are frozen after a breach; a person has to review it and unfreeze the payment guard",
    );
  }
}
