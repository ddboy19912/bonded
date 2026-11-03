import type { PayoutCredential } from "@bondedhq/shared";
import {
  ProviderRefused,
  ProviderUnknown,
  type PayoutDestination,
  type PayoutProvider,
  type PayoutRecord,
  type PayoutRequest,
} from "./provider.js";

/**
 * Stripe Global Payouts: an OutboundPayment from the account's financial account to a recipient's
 * payout method (https://docs.stripe.com/global-payouts/send-money, "Outbound Payments API").
 * Each OutboundPayment is one attempt that Stripe never retries or reroutes, which suits a proxy
 * that pays exactly what one receipt allows. Sandbox keys work with the API, and Stripe's test
 * bank accounts simulate failed and returned payouts
 * (https://docs.stripe.com/global-payouts/testing).
 *
 * The key the owner links needs only "Money Management Outbound Payments: Write" (and "Financial
 * Accounts: Read"); it can't add recipients or bank accounts, so a payout can only reach a payout
 * method someone already set up in Stripe.
 */

export const STRIPE_PAYOUTS_API_VERSION = "2026-10-28.endive";

/** "stripe:<recipient acct id>:<payout method id>", the ids as Stripe writes them. */
const DESTINATION = /^stripe:(acct_[A-Za-z0-9_]{1,64}):([a-z]{2,8}_[A-Za-z0-9_]{1,100})$/;

export function stripePayouts(
  options: {
    apiVersion?: string;
    baseUrl?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
  } = {},
): PayoutProvider {
  const base = options.baseUrl ?? "https://api.stripe.com";
  const doFetch = options.fetch ?? fetch;
  const version = options.apiVersion ?? STRIPE_PAYOUTS_API_VERSION;

  async function call(
    credential: PayoutCredential,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${credential.secretKey}`,
          "Stripe-Version": version,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
        redirect: "error",
      });
    } catch {
      throw new ProviderUnknown("Stripe did not answer");
    }
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.ok) return json;
    const error = (json.error ?? {}) as Record<string, unknown>;
    const code = typeof error.code === "string" ? error.code : `http_${response.status}`;
    // 4xx is a refusal (nothing was made), except a rate limit or an idempotency clash, which say
    // nothing about whether an earlier attempt went through.
    if (response.status >= 400 && response.status < 500 && ![409, 429].includes(response.status))
      throw new ProviderRefused(code);
    throw new ProviderUnknown(`Stripe answered ${response.status} (${code})`);
  }

  const record = (o: Record<string, unknown>): PayoutRecord => {
    const amount = (o.amount ?? {}) as Record<string, unknown>;
    const to = (o.to ?? {}) as Record<string, unknown>;
    const metadata = (o.metadata ?? {}) as Record<string, unknown>;
    return {
      id: String(o.id ?? ""),
      status: String(o.status ?? "unknown"),
      amountCents: typeof amount.value === "number" ? amount.value : 0,
      currency: String(amount.currency ?? ""),
      destination: `stripe:${String(to.recipient ?? "")}:${String(to.payout_method ?? "")}`,
      gateDecision:
        typeof metadata.bonded_gate_decision === "string" ? metadata.bonded_gate_decision : null,
      livemode: o.livemode === true,
    };
  };

  return {
    name: "stripe",
    destination(text: string): PayoutDestination | undefined {
      const m = DESTINATION.exec(text.trim());
      return m ? { provider: "stripe", recipient: m[1]!, payoutMethod: m[2]! } : undefined;
    },
    validCredential(c) {
      return (
        c.provider === "stripe" &&
        /^(rk|sk)_(test|live)_[A-Za-z0-9]{10,247}$/.test(c.secretKey) &&
        /^fa_[A-Za-z0-9_]{1,200}$/.test(c.financialAccount)
      );
    },
    async pay(credential: PayoutCredential, p: PayoutRequest): Promise<PayoutRecord> {
      const made = await call(
        credential,
        "POST",
        "/v2/money_management/outbound_payments",
        {
          from: { financial_account: credential.financialAccount, currency: p.currency },
          to: {
            recipient: p.destination.recipient,
            payout_method: p.destination.payoutMethod,
            currency: p.currency,
          },
          amount: { value: p.amountCents, currency: p.currency },
          description: `Invoice ${p.reference}`.slice(0, 200),
          metadata: {
            bonded_gate_decision: p.decisionId,
            bonded_gate_account: p.gateAccountId,
            invoice_reference: p.reference.slice(0, 100),
          },
        },
        // The same decision always asks Stripe for the same payout, so a retry never makes two.
        `bonded-gate-payout-${p.decisionId}`,
      );
      return record(made);
    },
    async lookup(credential, payoutId) {
      if (!/^obp_[A-Za-z0-9_]{1,200}$/.test(payoutId)) throw new ProviderRefused("bad_id");
      return record(
        await call(credential, "GET", `/v2/money_management/outbound_payments/${payoutId}`),
      );
    },
  };
}
