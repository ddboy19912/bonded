import { createHmac, timingSafeEqual } from "node:crypto";
import { CARD_BLOCKED_CATEGORIES } from "@bondedhq/shared";

/**
 * The few Stripe Issuing calls the payment gate's card route makes (gate-card.ts), behind a small
 * interface that tests replace with a fake, and Stripe's webhook signature check. Plain fetch: three
 * form-encoded calls and one HMAC don't justify the `stripe` package. Checked against Stripe's
 * docs on 2026-11-03:
 *
 * - Webhook signatures: https://docs.stripe.com/webhooks?verify=verify-manually ("Verify webhook
 *   signatures manually"): `Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=...][,v0=...]`; the
 *   signature is HMAC-SHA256 of "<t>.<raw body>" keyed with the endpoint's `whsec_` secret; only
 *   `v1` counts; several `v1` values appear while a rolled secret is still live; Stripe's
 *   libraries allow 5 minutes between `t` and now.
 * - Direct response to `issuing_authorization.request`:
 *   https://docs.stripe.com/issuing/controls/real-time-authorizations ("Respond directly"):
 *   HTTP 200, a `Stripe-Version` header, `Content-Type: application/json`, body
 *   `{ "approved": true | false }`, within 2 seconds or Stripe applies the timeout setting (or
 *   Autopilot). Webhook failures show as `request_history[].reason` `webhook_timeout` or
 *   `webhook_error` on `issuing_authorization.created` / `.updated`.
 * - Cards: https://docs.stripe.com/api/issuing/cards/create, single use through
 *   `lifecycle_controls[cancel_after][payment_count]=1`
 *   (https://docs.stripe.com/issuing/controls/lifecycle-controls), an `all_time` spending limit
 *   and `blocked_categories` (https://docs.stripe.com/issuing/controls/spending-controls).
 *   The number and CVC come only from retrieving the card with `expand[]=number&expand[]=cvc`.
 *   A card is cancelled with `status=canceled`.
 * - Connecting an account: https://docs.stripe.com/connect/oauth-reference (`/oauth/authorize`,
 *   `/oauth/token`, `/oauth/deauthorize`; a code works once, for 5 minutes; use the `Stripe-Account`
 *   header, not the deprecated `access_token`). Issuing on accounts with their own dashboard has to
 *   be enabled by Stripe support: https://docs.stripe.com/issuing/connect.
 * - Test helpers that simulate each path in test mode:
 *   https://docs.stripe.com/issuing/purchases/transactions and
 *   https://docs.stripe.com/issuing/purchases/authorizations (`/v1/test_helpers/issuing/...`:
 *   authorizations, `/capture`, `/increment`, `/reverse`, `/expire`,
 *   `transactions/create_force_capture`), listed in GATE.md.
 */

/**
 * The API version the gate sends and answers with (`Stripe-Version`), from Stripe's published
 * OpenAPI spec (github.com/stripe/openapi). STRIPE_API_VERSION overrides it.
 */
export const STRIPE_API_VERSION = "2026-09-30.endive";

/** A card as the gate keeps it: never the number or CVC. */
export interface StripeCard {
  id: string;
  last4: string;
  brand: string;
  expMonth: number;
  expYear: number;
  status: string;
}

/** A virtual card's details, as Stripe returns them to the platform. Passed to the agent once. */
export interface StripeCardDetails extends StripeCard {
  number: string;
  cvc: string;
}

export interface NewGateCard {
  cardholder: string;
  /** The invoice amount, in cents: the card's all-time spending limit. */
  amountCents: number;
  metadata: Record<string, string>;
}

/**
 * Who a call runs as: the gate account's own restricted key, or Bonded's platform key acting for a
 * connected account (the `Stripe-Account` header).
 */
export type StripeAuth = string | { key: string; account: string };

/** A company cardholder made for a connected account. Stripe's name rules apply. */
export interface NewGateCardholder {
  name: string;
  line1: string;
  city: string;
  state?: string | undefined;
  postalCode: string;
  country: string;
}

/** What the gate asks of Stripe. */
export interface StripeIssuingClient {
  /** A single-use virtual USD card limited to the amount, cash categories blocked. */
  createCard(key: StripeAuth, card: NewGateCard, idempotencyKey: string): Promise<StripeCard>;
  /** The card's number and CVC (retrieve with expand). */
  revealCard(key: StripeAuth, cardId: string): Promise<StripeCardDetails>;
  cancelCard(key: StripeAuth, cardId: string): Promise<void>;
  /** Turns the code Stripe sent back after the owner approved Bonded into their account id. */
  exchangeCode(platformKey: string, code: string): Promise<{ account: string; livemode: boolean }>;
  createCardholder(
    key: StripeAuth,
    cardholder: NewGateCardholder,
    idempotencyKey: string,
  ): Promise<{ id: string }>;
  /** Ends Bonded's access to a connected account. */
  deauthorize(platformKey: string, clientId: string, account: string): Promise<void>;
}

/** Sends the owner to Stripe to approve Bonded. `state` comes back with the code. */
export function stripeConnectUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: options.clientId,
    scope: "read_write",
    redirect_uri: options.redirectUri,
    state: options.state,
  });
  return `https://connect.stripe.com/oauth/authorize?${query}`;
}

/** Stripe refused or failed a call. Never carries the key, the card number or the CVC. */
export class StripeCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(`Stripe answered ${status}${code ? ` (${code})` : ""}`);
  }
}

/** Form-encodes nested params as Stripe expects: `a[b][0][c]=v`. */
export function stripeForm(params: Record<string, unknown>): URLSearchParams {
  const form = new URLSearchParams();
  const add = (prefix: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((v, i) => add(`${prefix}[${i}]`, v));
    else if (typeof value === "object")
      for (const [k, v] of Object.entries(value)) add(`${prefix}[${k}]`, v);
    else form.append(prefix, String(value));
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  return form;
}

const card = (c: Record<string, unknown>): StripeCard => ({
  id: c.id as string,
  last4: c.last4 as string,
  brand: c.brand as string,
  expMonth: c.exp_month as number,
  expYear: c.exp_year as number,
  status: c.status as string,
});

const CONNECT_HOST = "https://connect.stripe.com";

/** The real client, over fetch. Each call times out after `timeoutMs` (default 10 s). */
export function stripeIssuingClient(
  options: { apiVersion?: string; fetch?: typeof fetch; timeoutMs?: number } = {},
): StripeIssuingClient {
  const send = async (
    auth: StripeAuth,
    method: "GET" | "POST",
    path: string,
    params?: Record<string, unknown>,
    idempotencyKey?: string,
    host = "https://api.stripe.com",
  ) => {
    const form = params ? stripeForm(params) : undefined;
    const url = method === "GET" && form ? `${host}${path}?${form}` : `${host}${path}`;
    const res = await (options.fetch ?? fetch)(url, {
      method,
      headers: {
        Authorization: `Bearer ${typeof auth === "string" ? auth : auth.key}`,
        ...(typeof auth === "string" ? {} : { "Stripe-Account": auth.account }),
        "Stripe-Version": options.apiVersion ?? STRIPE_API_VERSION,
        ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      ...(method === "POST" && form ? { body: form.toString() } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const error = body.error as { code?: string; type?: string } | undefined;
      throw new StripeCallError(res.status, error?.code ?? error?.type);
    }
    return body;
  };
  return {
    async createCard(key, c, idempotencyKey) {
      return card(
        await send(
          key,
          "POST",
          "/v1/issuing/cards",
          {
            cardholder: c.cardholder,
            currency: "usd",
            type: "virtual",
            status: "active",
            lifecycle_controls: { cancel_after: { payment_count: 1 } },
            spending_controls: {
              spending_limits: [{ amount: c.amountCents, interval: "all_time" }],
              blocked_categories: [...CARD_BLOCKED_CATEGORIES],
            },
            metadata: c.metadata,
          },
          idempotencyKey,
        ),
      );
    },
    async revealCard(key, cardId) {
      const c = await send(key, "GET", `/v1/issuing/cards/${encodeURIComponent(cardId)}`, {
        expand: ["number", "cvc"],
      });
      return { ...card(c), number: c.number as string, cvc: c.cvc as string };
    },
    async cancelCard(key, cardId) {
      await send(key, "POST", `/v1/issuing/cards/${encodeURIComponent(cardId)}`, {
        status: "canceled",
      });
    },
    async exchangeCode(platformKey, code) {
      const body = await send(
        platformKey,
        "POST",
        "/oauth/token",
        { grant_type: "authorization_code", code },
        undefined,
        CONNECT_HOST,
      );
      return { account: body.stripe_user_id as string, livemode: body.livemode === true };
    },
    async createCardholder(key, c, idempotencyKey) {
      const body = await send(
        key,
        "POST",
        "/v1/issuing/cardholders",
        {
          type: "company",
          status: "active",
          name: c.name,
          billing: {
            address: {
              line1: c.line1,
              city: c.city,
              state: c.state,
              postal_code: c.postalCode,
              country: c.country,
            },
          },
        },
        idempotencyKey,
      );
      return { id: body.id as string };
    },
    async deauthorize(platformKey, clientId, account) {
      await send(
        platformKey,
        "POST",
        "/oauth/deauthorize",
        { client_id: clientId, stripe_user_id: account },
        undefined,
        CONNECT_HOST,
      );
    },
  };
}

/**
 * Whether `header` (Stripe-Signature) signs `payload` with one of `secrets`, within
 * `toleranceSeconds` (default 300, as Stripe's libraries) of now. Only `v1` signatures count.
 * Constant-time compare. Never throws.
 */
export function verifyStripeSignature(
  payload: string,
  header: string | undefined,
  secrets: readonly string[],
  options: { nowSeconds?: number; toleranceSeconds?: number } = {},
): boolean {
  if (!header || !secrets.length) return false;
  let timestamp: number | undefined;
  const signatures: Buffer[] = [];
  for (const part of header.split(",")) {
    const at = part.indexOf("=");
    if (at < 1) continue;
    const name = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (name === "t" && /^\d{1,12}$/.test(value)) timestamp = Number(value);
    else if (name === "v1" && /^[0-9a-f]{64}$/.test(value))
      signatures.push(Buffer.from(value, "hex"));
  }
  if (timestamp === undefined || !signatures.length) return false;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (options.toleranceSeconds ?? 300)) return false;
  for (const secret of secrets) {
    const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest();
    if (signatures.some((s) => s.length === expected.length && timingSafeEqual(s, expected)))
      return true;
  }
  return false;
}
