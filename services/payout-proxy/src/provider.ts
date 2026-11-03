import type { PayoutCredential, PayoutProviderName } from "@bondedhq/shared";

/**
 * A payout provider behind one small interface, so others can be added next to Stripe. The proxy
 * calls it only after the gate's receipt has been checked; nothing here decides whether to pay.
 */

/** Where a payout goes, parsed from the payee text "provider:...". */
export interface PayoutDestination {
  provider: PayoutProviderName;
  /** The provider's recipient (Stripe: a v2 Account configured as a recipient, `acct_...`). */
  recipient: string;
  /** The recipient's bank account at the provider (Stripe: a payout method, `usba_...`). */
  payoutMethod: string;
}

/** A payout as the provider records it. */
export interface PayoutRecord {
  id: string;
  /** processing, posted, failed, returned or canceled (Stripe's OutboundPayment statuses). */
  status: string;
  amountCents: number;
  currency: string;
  /** "provider:recipient:payout method", case as the provider gives it. */
  destination: string;
  /** The gate decision named in the payout's metadata, if any. */
  gateDecision: string | null;
  livemode: boolean;
}

export interface PayoutRequest {
  decisionId: string;
  gateAccountId: string;
  amountCents: number;
  currency: "usd";
  destination: PayoutDestination;
  /** The invoice reference, as the receipt has it. */
  reference: string;
}

/** The provider refused: no payout was made (Stripe answered 4xx). */
export class ProviderRefused extends Error {
  constructor(readonly code: string) {
    super(`the provider refused the payout (${code})`);
    this.name = "ProviderRefused";
  }
}

/**
 * The provider's answer was lost or it failed on its side: the payout may or may not exist. A
 * retry with the same decision is safe, because the provider dedupes on the decision id.
 */
export class ProviderUnknown extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnknown";
  }
}

export interface PayoutProvider {
  readonly name: PayoutProviderName;
  /** The destination named by a payee's text, or undefined when it isn't one of this provider's. */
  destination(text: string): PayoutDestination | undefined;
  /** Whether a credential is well formed for this provider (its mode is checked separately). */
  validCredential(credential: PayoutCredential): boolean;
  /** Make the payout once: the provider dedupes on `decisionId`. */
  pay(credential: PayoutCredential, payout: PayoutRequest): Promise<PayoutRecord>;
  /** The provider's record of one payout. */
  lookup(credential: PayoutCredential, payoutId: string): Promise<PayoutRecord>;
}
