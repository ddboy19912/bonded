import { randomBytes } from "node:crypto";
import type { PayoutCredential } from "@bondedhq/shared";
import {
  ProviderRefused,
  ProviderUnknown,
  type PayoutProvider,
  type PayoutRecord,
  type PayoutRequest,
} from "./provider.js";
import { stripePayouts } from "./stripe.js";

/**
 * A stand-in for Stripe that moves no money: payouts in memory, every call recorded. It reads
 * destinations and credentials as Stripe would. For tests and the local run (`PAYOUT_PROVIDER=fake`
 * with `TEE_BACKEND=mock`); main.ts refuses it on a real TEE.
 */
export class FakePayoutProvider implements PayoutProvider {
  readonly name = "stripe" as const;
  private readonly shape = stripePayouts();
  readonly payouts = new Map<string, PayoutRecord & { idempotencyKey: string }>();
  calls: { method: "pay" | "lookup"; secretKey: string; request?: PayoutRequest }[] = [];
  /** What the next `pay` does: make it, refuse it, or lose the answer. */
  next: "ok" | "refuse" | "unknown" = "ok";

  destination(text: string) {
    return this.shape.destination(text);
  }

  validCredential(credential: PayoutCredential) {
    return this.shape.validCredential(credential);
  }

  async pay(credential: PayoutCredential, p: PayoutRequest): Promise<PayoutRecord> {
    this.calls.push({ method: "pay", secretKey: credential.secretKey, request: p });
    const mode = this.next;
    this.next = "ok";
    if (mode === "refuse") throw new ProviderRefused("insufficient_funds");
    const key = `bonded-gate-payout-${p.decisionId}`;
    const earlier = [...this.payouts.values()].find((x) => x.idempotencyKey === key);
    if (earlier) return earlier;
    const made = {
      id: `obp_test_${randomBytes(12).toString("hex")}`,
      status: "processing",
      amountCents: p.amountCents,
      currency: p.currency,
      destination: `stripe:${p.destination.recipient}:${p.destination.payoutMethod}`,
      gateDecision: p.decisionId,
      livemode: credential.secretKey.includes("_live_"),
      idempotencyKey: key,
    };
    this.payouts.set(made.id, made);
    if (mode === "unknown") throw new ProviderUnknown("the answer was lost");
    return made;
  }

  async lookup(credential: PayoutCredential, payoutId: string): Promise<PayoutRecord> {
    this.calls.push({ method: "lookup", secretKey: credential.secretKey });
    const found = this.payouts.get(payoutId);
    if (!found) throw new ProviderRefused("resource_missing");
    return found;
  }

  /** A payout made outside the proxy (someone with the key, in Stripe's dashboard). */
  outside(p: Omit<PayoutRecord, "id">): PayoutRecord {
    const made = { ...p, id: `obp_test_${randomBytes(12).toString("hex")}`, idempotencyKey: "" };
    this.payouts.set(made.id, made);
    return made;
  }
}
