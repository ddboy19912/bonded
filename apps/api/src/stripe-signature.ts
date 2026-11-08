import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe's webhook signature check, for card hooks on Stripe Issuing (gate-card-hook.ts). Plain
 * crypto: one HMAC doesn't justify the `stripe` package. Checked against Stripe's docs on
 * 2026-11-03:
 *
 * - Webhook signatures: https://docs.stripe.com/webhooks?verify=verify-manually ("Verify webhook
 *   signatures manually"): `Stripe-Signature: t=<unix seconds>,v1=<hex>[,v1=...][,v0=...]`; the
 *   signature is HMAC-SHA256 of "<t>.<raw body>" keyed with the endpoint's `whsec_` secret; only
 *   `v1` counts; several `v1` values appear while a rolled secret is still live; Stripe's
 *   libraries allow 5 minutes between `t` and now.
 * - Direct response to `issuing_authorization.request`:
 *   https://docs.stripe.com/issuing/controls/real-time-authorizations ("Respond directly"):
 *   HTTP 200, a `Stripe-Version` header, `Content-Type: application/json`, body
 *   `{ "approved": true | false }`, within 2 seconds or Stripe applies the timeout setting.
 */

/**
 * The API version the gate answers with (`Stripe-Version`), from Stripe's published OpenAPI spec
 * (github.com/stripe/openapi). STRIPE_API_VERSION overrides it.
 */
export const STRIPE_API_VERSION = "2026-09-30.endive";

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
