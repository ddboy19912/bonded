import { z } from "zod";
import { BrokerageEpisodeMessage, CancelMessage, codeHashOf, EpisodeMessage } from "./runner.js";

/**
 * Agent URL mode: the second way to connect an agent to the Arena (the first is the runner).
 * Instead of a runner launching a command, the Arena Gateway calls the agent's own HTTPS endpoint:
 *
 * - each episode: `POST <agent url>` with the runner's `episode` message as the JSON body. The
 *   agent answers 2xx within AGENT_URL_ANSWER_MS (it may keep working after it answers), then
 *   uses the episode's endpoints and posts to its done URL, exactly as a runner-launched agent;
 * - cancel: `POST <agent url>` with `{ type: "cancel", episodeId }` (best effort);
 * - verify, once the agent has its secret (and again whenever its owner asks): `POST <agent url>`
 *   with `{ type: "verify", challenge }`; the agent answers 200 with `{ challenge, proof,
 *   version? }`, where `proof` is HMAC-SHA256(secret, "verify." + challenge), so only a holder of
 *   the secret passes.
 *
 * Every call is signed with the agent secret (shown once when the URL is registered):
 * `bonded-timestamp` is unix seconds, and `bonded-signature` is `v1=` and the hex HMAC-SHA256 of
 * `<timestamp>.<raw body>`. The agent checks the signature and the timestamp before acting
 * (`verifyAgentUrlRequest` does both, and with an AgentUrlReplayGuard also refuses a replay).
 *
 * HMAC runs on WebCrypto, so these helpers work in Node 22+, browsers and edge runtimes.
 */

/** Header with the unix time (seconds) a call was signed at. */
export const AGENT_URL_TIMESTAMP_HEADER = "bonded-timestamp";
/** Header with the signature: `v1=<hex>` (several, comma-separated, while a secret rotates). */
export const AGENT_URL_SIGNATURE_HEADER = "bonded-signature";
/** Most `v1=` values a signature header may carry (more than one only while a secret rotates). */
export const AGENT_URL_MAX_SIGNATURES = 4;
/** The signature scheme's version tag. */
export const AGENT_URL_SIGNATURE_VERSION = "v1";
/** Every agent secret starts with this, so one is recognisable in a config file or a log. */
export const AGENT_SECRET_PREFIX = "bonded_as_";
/** How old (or how far in the future) a signed call may be before the agent should refuse it. */
export const AGENT_URL_TOLERANCE_SECONDS = 300;
/** How long the agent has to answer any call. */
export const AGENT_URL_ANSWER_MS = 10_000;
/** The most of an agent's answer the gateway reads. */
export const AGENT_URL_MAX_RESPONSE_BYTES = 64 * 1024;
/** Largest body the gateway sends (an episode message is a few KB). */
export const AGENT_URL_MAX_BODY_BYTES = 256 * 1024;

/** Whether text is shaped like an agent secret (the prefix, then base64url). */
export function isWellFormedAgentSecret(secret: string): boolean {
  return /^bonded_as_[A-Za-z0-9_-]{16,128}$/.test(secret);
}

/** A fresh agent secret: the prefix and 32 random bytes, base64url. */
export function newAgentSecret(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `${AGENT_SECRET_PREFIX}${base64url(bytes)}`;
}

/** The ownership check. `challenge` is random; the agent sends it back with its proof. */
export const AgentUrlVerifyMessage = z.object({
  type: z.literal("verify"),
  challenge: z.string().min(16).max(128),
});
export type AgentUrlVerifyMessage = z.infer<typeof AgentUrlVerifyMessage>;

/**
 * The agent's answer to `verify`: the challenge back, and `proof`, the hex
 * HMAC-SHA256(secret, "verify." + challenge) (`agentUrlVerifyProof`), so only a holder of the
 * secret can pass (an echo server can't). `version` names the agent's code version (a git
 * commit, a release tag, an image digest): with no declared code hash, the rating records
 * `agentUrlCodeHash(version)`, labelled as reported by the agent. `answerAgentUrlVerify` builds
 * the whole answer.
 */
export const AgentUrlVerifyAnswer = z.object({
  challenge: z.string().max(128),
  proof: z.string().regex(/^[0-9a-fA-F]{64}$/, "64 hex digits"),
  version: z.string().min(1).max(200).optional(),
});
export type AgentUrlVerifyAnswer = z.infer<typeof AgentUrlVerifyAnswer>;

/** Every body the gateway POSTs to an agent URL. */
export const AgentUrlMessage = z.union([
  BrokerageEpisodeMessage,
  EpisodeMessage,
  CancelMessage,
  AgentUrlVerifyMessage,
]);
export type AgentUrlMessage = z.infer<typeof AgentUrlMessage>;

/** The code hash for an Agent URL's reported version: keccak256 of `"url:<version>"`. */
export function agentUrlCodeHash(version: string): `0x${string}` {
  return codeHashOf("url", version);
}

const encoder = new TextEncoder();

function bytesOf(body: string | Uint8Array): Uint8Array {
  return typeof body === "string" ? encoder.encode(body) : body;
}

async function hmacKey(secret: string, usage: "sign" | "verify") {
  return globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

/** What is signed: `<timestamp>.` followed by the raw body bytes. */
function signedPayload(timestamp: number, body: string | Uint8Array): Uint8Array<ArrayBuffer> {
  const prefix = encoder.encode(`${timestamp}.`);
  const raw = bytesOf(body);
  const out = new Uint8Array(prefix.length + raw.length);
  out.set(prefix, 0);
  out.set(raw, prefix.length);
  return out;
}

/** The `bonded-signature` value for a body signed at `timestamp`: `v1=<hex HMAC-SHA256>`. */
export async function agentUrlSignature(
  secret: string,
  timestamp: number,
  body: string | Uint8Array,
): Promise<string> {
  const key = await hmacKey(secret, "sign");
  const mac = await globalThis.crypto.subtle.sign("HMAC", key, signedPayload(timestamp, body));
  return `${AGENT_URL_SIGNATURE_VERSION}=${hex(new Uint8Array(mac))}`;
}

/** The ownership proof for a verify challenge: hex HMAC-SHA256(secret, "verify." + challenge). */
export async function agentUrlVerifyProof(secret: string, challenge: string): Promise<string> {
  const key = await hmacKey(secret, "sign");
  const mac = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`verify.${challenge}`) as Uint8Array<ArrayBuffer>,
  );
  return hex(new Uint8Array(mac));
}

/** The answer an agent sends to a verify message: `{ challenge, proof, version? }`. */
export async function answerAgentUrlVerify(
  secret: string,
  message: AgentUrlVerifyMessage,
  version?: string,
): Promise<AgentUrlVerifyAnswer> {
  return {
    challenge: message.challenge,
    proof: await agentUrlVerifyProof(secret, message.challenge),
    ...(version ? { version } : {}),
  };
}

/**
 * Whether a verify answer proves the secret: the challenge sent and its proof (compared in
 * constant time). The gateway's check.
 */
export async function checkAgentUrlVerifyProof(
  secret: string,
  challenge: string,
  answer: Pick<AgentUrlVerifyAnswer, "challenge" | "proof">,
): Promise<boolean> {
  if (answer.challenge !== challenge || !/^[0-9a-fA-F]{64}$/.test(answer.proof)) return false;
  const key = await hmacKey(secret, "verify");
  return globalThis.crypto.subtle.verify(
    "HMAC",
    key,
    unhex(answer.proof),
    encoder.encode(`verify.${challenge}`) as Uint8Array<ArrayBuffer>,
  );
}

/** The two headers for a call to an agent URL, signed now (or at `nowMs`). */
export async function signAgentUrlRequest(
  secret: string,
  body: string | Uint8Array,
  nowMs: number = Date.now(),
): Promise<Record<string, string>> {
  const timestamp = Math.floor(nowMs / 1000);
  return {
    [AGENT_URL_TIMESTAMP_HEADER]: String(timestamp),
    [AGENT_URL_SIGNATURE_HEADER]: await agentUrlSignature(secret, timestamp, body),
  };
}

/**
 * Remembers the signatures it has accepted until they are too old to be accepted anyway, so a
 * captured call can't be replayed within the tolerance window. One per agent process.
 */
export class AgentUrlReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly toleranceSeconds = AGENT_URL_TOLERANCE_SECONDS,
    private readonly maxEntries = 10_000,
  ) {}

  /** Records the signature; false when it was already seen (a replay). */
  accept(signature: string, timestamp: number, nowSeconds: number): boolean {
    for (const [sig, ts] of this.seen) {
      if (ts >= nowSeconds - this.toleranceSeconds && this.seen.size < this.maxEntries) break;
      this.seen.delete(sig);
    }
    if (this.seen.has(signature)) return false;
    this.seen.set(signature, timestamp);
    return true;
  }
}

export type AgentUrlHeaders =
  Headers | Record<string, string | string[] | undefined> | { get(name: string): string | null };

function header(headers: AgentUrlHeaders, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function")
    return (headers as Headers).get(name) ?? undefined;
  const record = headers as Record<string, string | string[] | undefined>;
  const value =
    record[name] ??
    Object.entries(record).find(([key]) => key.toLowerCase() === name)?.[1] ??
    undefined;
  return Array.isArray(value) ? value.join(",") : value;
}

export type AgentUrlVerification =
  | { ok: true; message: AgentUrlMessage; timestamp: number }
  | {
      ok: false;
      /** The status to answer with: 401 for a bad or stale signature, 400 for a bad body. */
      status: 400 | 401;
      reason: string;
    };

export interface VerifyAgentUrlRequestOptions {
  /** The agent secret, or several while rotating (any one may match). */
  secret: string | string[];
  /** The raw body, exactly as received (before any JSON parsing). */
  body: string | Uint8Array;
  headers: AgentUrlHeaders;
  /** Now, in milliseconds (default Date.now()). */
  nowMs?: number;
  toleranceSeconds?: number;
  /** Refuses a signature seen before. Without one, replays within the tolerance pass. */
  replay?: AgentUrlReplayGuard;
}

/**
 * Checks a call from the Arena Gateway in the agent's handler: the timestamp is within the
 * tolerance, a `v1` signature matches (compared in constant time by WebCrypto), it is not a
 * replay, and the body is one of the gateway's messages. Answer `status` with the reason when it
 * fails; act only on `message` when it passes.
 */
export async function verifyAgentUrlRequest(
  options: VerifyAgentUrlRequestOptions,
): Promise<AgentUrlVerification> {
  const refuse = (status: 400 | 401, reason: string): AgentUrlVerification => ({
    ok: false,
    status,
    reason,
  });
  const tsText = header(options.headers, AGENT_URL_TIMESTAMP_HEADER);
  const sigText = header(options.headers, AGENT_URL_SIGNATURE_HEADER);
  if (!tsText || !sigText) return refuse(401, "the call is not signed");
  if (!/^\d{1,12}$/.test(tsText.trim())) return refuse(401, "the timestamp is not unix seconds");
  const timestamp = Number(tsText.trim());
  const now = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const tolerance = options.toleranceSeconds ?? AGENT_URL_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance)
    return refuse(401, "the timestamp is too old or in the future");
  const signatures = sigText
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${AGENT_URL_SIGNATURE_VERSION}=`))
    .map((part) => part.slice(AGENT_URL_SIGNATURE_VERSION.length + 1))
    .filter((value) => /^[0-9a-f]{64}$/i.test(value));
  if (signatures.length === 0) return refuse(401, "no v1 signature");
  if (signatures.length > AGENT_URL_MAX_SIGNATURES) return refuse(401, "too many signatures");
  const payload = signedPayload(timestamp, options.body);
  const secrets = Array.isArray(options.secret) ? options.secret : [options.secret];
  let matched: string | undefined;
  for (const secret of secrets) {
    const key = await hmacKey(secret, "verify");
    for (const signature of signatures) {
      if (await globalThis.crypto.subtle.verify("HMAC", key, unhex(signature), payload)) {
        matched = signature.toLowerCase();
        break;
      }
    }
    if (matched) break;
  }
  if (!matched) return refuse(401, "the signature doesn't match");
  if (options.replay && !options.replay.accept(matched, timestamp, now))
    return refuse(401, "this call was already received (a replay)");
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytesOf(options.body)));
  } catch {
    return refuse(400, "the body is not JSON");
  }
  const parsed = AgentUrlMessage.safeParse(raw);
  if (!parsed.success) return refuse(400, "the body is not a Bonded message");
  return { ok: true, message: parsed.data, timestamp };
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function unhex(text: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
