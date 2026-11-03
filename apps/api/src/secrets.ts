import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Secrets Bonded must be able to use, not just check: the agent secret that signs every call to an
 * Agent URL, and the webhook secret that signs notifications. Each is shown to its owner once and
 * stored only encrypted (AES-256-GCM with AGENT_URL_SECRET_KEY), bound to the row it belongs to,
 * so a ciphertext copied to another row doesn't decrypt. They are never logged or returned again.
 */

/** Prefix of an agent secret (Agent URL mode): @bondedhq/shared's. */
export { AGENT_SECRET_PREFIX } from "@bondedhq/shared";
/** Prefix of a webhook signing secret. */
export const WEBHOOK_SECRET_PREFIX = "bonded_ws_";

/** A new secret: the prefix and 32 random bytes, base64url. */
export function newSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

/** Why a feature that needs AGENT_URL_SECRET_KEY is off. */
export const SECRET_KEY_MISSING =
  "Agent URL mode and webhooks are off on this service: AGENT_URL_SECRET_KEY isn't set.";

export class SecretBox {
  private readonly key: Buffer;
  /** Which key encrypted a value (the first 8 hex of its sha256), so a wrong key is named. */
  readonly keyId: string;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("AGENT_URL_SECRET_KEY must be 32 bytes");
    this.key = key;
    this.keyId = createHash("sha256").update(key).digest("hex").slice(0, 8);
  }

  /** "v1.<key id>.<iv>.<tag>.<ciphertext>", base64url; `context` must match to decrypt. */
  encrypt(plaintext: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", this.keyId, iv, cipher.getAuthTag(), body]
      .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
      .join(".");
  }

  /** The plaintext, or an error that names no part of the secret. */
  decrypt(sealed: string, context: string): string {
    const [version, keyId, iv, tag, body] = sealed.split(".");
    if (version !== "v1" || !iv || !tag || body === undefined)
      throw new Error("the stored secret is malformed");
    if (keyId !== this.keyId)
      throw new Error("the stored secret was encrypted with another AGENT_URL_SECRET_KEY");
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(body, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new Error("the stored secret could not be decrypted");
    }
  }
}

/**
 * The secret box from AGENT_URL_SECRET_KEY, or the variable `name` (32 bytes as 64 hex
 * characters, or base64), or undefined when it isn't set: Agent URL mode and webhooks are then
 * refused. A malformed key stops the service at start, naming the variable but not its value.
 */
export function secretBoxFromEnv(
  env: Record<string, string | undefined> = process.env,
  name = "AGENT_URL_SECRET_KEY",
): SecretBox | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  const key = /^[0-9a-fA-F]{64}$/.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes: 64 hex characters, or base64`);
  return new SecretBox(key);
}

/** Where an agent URL's secret is bound: its row. */
export const agentUrlContext = (id: string) => `agent-url:${id}`;
/** Where an owner's webhook secret is bound. */
export const webhookContext = (owner: string) => `webhook:${owner.toLowerCase()}`;
/**
 * Where a gate account's Stripe secrets are bound (gate-card.ts): its restricted key, and the
 * signing secrets of its real-time authorization and events endpoints.
 */
export const gateStripeContext = (accountId: string, what: "key" | "authorization" | "events") =>
  `gate-stripe:${accountId}:${what}`;
/**
 * Where a gate account's payout events endpoint secret is bound (gate-payout.ts). The payout
 * credential itself is never in the secret box: it is sealed to the payout proxy in the TEE.
 */
export const gatePayoutContext = (accountId: string) => `gate-payout:${accountId}:events`;

/**
 * Checks a signed webhook call's headers: `bonded-timestamp` and `bonded-signature:
 * v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`, as `signAgentUrlRequest` in
 * @bondedhq/shared makes them (for tests and receivers written in TypeScript).
 */
export function verifySignature(
  secret: string,
  body: string,
  headers: { timestamp: string | undefined; signature: string | undefined },
  options: { nowSeconds?: number; toleranceSeconds?: number } = {},
): boolean {
  const ts = Number(headers.timestamp);
  if (!Number.isInteger(ts)) return false;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > (options.toleranceSeconds ?? 300)) return false;
  const mac = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  const expected = Buffer.from(`v1=${mac}`);
  const got = Buffer.from(headers.signature ?? "");
  return got.length === expected.length && timingSafeEqual(got, expected);
}
