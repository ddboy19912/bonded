/**
 * Webhook signatures: how a webhook receiver knows a notification really comes from Bonded.
 *
 * Bonded signs each webhook call with the webhook's secret (shown once when it is set):
 * `bonded-timestamp` is unix seconds, and `bonded-signature` is `v1=` and the hex HMAC-SHA256 of
 * `<timestamp>.<raw body>`. Agent URLs don't use this: they are signed by Bonded's own key
 * (agent-url.ts).
 */

/** Header with the unix time (seconds) a webhook call was signed at. */
export const WEBHOOK_TIMESTAMP_HEADER = "bonded-timestamp";
/** Header with the webhook signature: `v1=<hex HMAC-SHA256>`. */
export const WEBHOOK_SIGNATURE_HEADER = "bonded-signature";

const encoder = new TextEncoder();

/** The `bonded-signature` value for a body signed at `timestamp`: `v1=<hex HMAC-SHA256>`. */
export async function webhookSignature(
  secret: string,
  timestamp: number,
  body: string | Uint8Array,
): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const prefix = encoder.encode(`${timestamp}.`);
  const raw = typeof body === "string" ? encoder.encode(body) : body;
  const payload = new Uint8Array(prefix.length + raw.length);
  payload.set(prefix, 0);
  payload.set(raw, prefix.length);
  const mac = new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, payload));
  let hex = "";
  for (const byte of mac) hex += byte.toString(16).padStart(2, "0");
  return `v1=${hex}`;
}

/** The two headers for a webhook call, signed now (or at `nowMs`). */
export async function signWebhookRequest(
  secret: string,
  body: string | Uint8Array,
  nowMs: number = Date.now(),
): Promise<Record<string, string>> {
  const timestamp = Math.floor(nowMs / 1000);
  return {
    [WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
    [WEBHOOK_SIGNATURE_HEADER]: await webhookSignature(secret, timestamp, body),
  };
}
