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
 * - verify, when the owner saves the URL (and again whenever they ask): `POST <agent url>` with
 *   `{ type: "verify", challenge }`; the agent answers 200 with `{ challenge, owner, version? }`.
 *
 * Every call is signed by Bonded with Ed25519 (docs/AGENT-URL-SIGNED-CALLS.md). There is no
 * shared secret: the agent checks the signature against Bonded's published public keys
 * (AGENT_URL_KEYS_PATH on the API), and checks that the call is for its owner, the wallet written
 * in its own code. Headers:
 *
 * - `bonded-timestamp`: unix seconds;
 * - `bonded-owner`: the wallet (lowercase) that saved the URL on Bonded;
 * - `bonded-signature`: `v2=<key id>:<base64url Ed25519 signature>` over
 *   `v2.<key id>.<timestamp>.<owner>.<raw body>`.
 *
 * Bonded signs a call for wallet W only for a URL that W saved. So someone who saves another
 * person's URL gets calls signed for their own wallet, which that agent refuses: they can't
 * verify it, and Bonded never sends it their episodes. The owner travels in a header, never in
 * the verify body, so a server that echoes the body back can't answer with it.
 *
 * Ed25519 runs on WebCrypto, so these helpers work in Node 22+, browsers and edge runtimes.
 */

/** Header with the unix time (seconds) a call was signed at. */
export const AGENT_URL_TIMESTAMP_HEADER = "bonded-timestamp";
/** Header with the wallet the call is for: the one that saved the URL. */
export const AGENT_URL_OWNER_HEADER = "bonded-owner";
/** Header with the signature: `v2=<key id>:<signature>` (several, comma-separated, while keys rotate). */
export const AGENT_URL_SIGNATURE_HEADER = "bonded-signature";
/** Most `v2=` values a signature header may carry. */
export const AGENT_URL_MAX_SIGNATURES = 4;
/** The signature scheme's version tag. */
export const AGENT_URL_SIGNATURE_VERSION = "v2";
/** Where the API publishes the public keys that sign calls to agents. */
export const AGENT_URL_KEYS_PATH = "/.well-known/bonded-agent-keys.json";
/** How old (or how far in the future) a signed call may be before the agent should refuse it. */
export const AGENT_URL_TOLERANCE_SECONDS = 300;
/** How long the agent has to answer any call. */
export const AGENT_URL_ANSWER_MS = 10_000;
/** The most of an agent's answer the gateway reads. */
export const AGENT_URL_MAX_RESPONSE_BYTES = 64 * 1024;
/** Largest body the gateway sends (an episode message is a few KB). */
export const AGENT_URL_MAX_BODY_BYTES = 256 * 1024;

/**
 * The `code` an agent answers (with 401) to a call for a wallet it isn't set up for, so Bonded can
 * tell its owner exactly that. The answer never names the agent's own wallet: anyone can save a
 * URL, and shouldn't learn whose it is.
 */
export const AGENT_URL_WRONG_OWNER = "wrong-owner";

/** A wallet address, the way an owner is written: 0x and 40 hex digits. */
export const AgentUrlOwner = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "a wallet address (0x…)");

/** Whether text is a wallet address an agent can name as its owner. */
export function isAgentUrlOwner(owner: string): boolean {
  return AgentUrlOwner.safeParse(owner).success;
}

/** One public key that signs calls to agents: Ed25519, its 32 bytes base64url in `x`. */
export const AgentUrlPublicKey = z.object({
  kid: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/),
  alg: z.literal("Ed25519"),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "32 bytes, base64url"),
});
export type AgentUrlPublicKey = z.infer<typeof AgentUrlPublicKey>;

/** The published key set (AGENT_URL_KEYS_PATH): every key that may sign, the current one first. */
/** The most keys the published set holds (the signing one and those still being rotated out). */
export const AGENT_URL_MAX_KEYS = 8;
export const AgentUrlKeySet = z.object({
  keys: z.array(AgentUrlPublicKey).max(AGENT_URL_MAX_KEYS),
});
export type AgentUrlKeySet = z.infer<typeof AgentUrlKeySet>;

/** The ownership check. `challenge` is random; the agent sends it back with its owner. */
export const AgentUrlVerifyMessage = z.object({
  type: z.literal("verify"),
  challenge: z.string().min(16).max(128),
});
export type AgentUrlVerifyMessage = z.infer<typeof AgentUrlVerifyMessage>;

/**
 * The agent's answer to `verify`: the challenge back, and `owner`, the wallet written in its code.
 * Bonded marks the URL verified when that is the wallet that saved it. `version` names the
 * agent's code version (a git commit, a release tag, an image digest): with no declared code
 * hash, the rating records `agentUrlCodeHash(version)`, labelled as reported by the agent.
 */
export const AgentUrlVerifyAnswer = z.object({
  challenge: z.string().max(128),
  owner: AgentUrlOwner,
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

/** The answer an agent sends to a verify message: `{ challenge, owner, version? }`. */
export function answerAgentUrlVerify(
  owner: string,
  message: AgentUrlVerifyMessage,
  version?: string,
): AgentUrlVerifyAnswer {
  return {
    challenge: message.challenge,
    owner: owner.toLowerCase(),
    ...(version ? { version } : {}),
  };
}

/** Whether a verify answer is for this challenge and this owner. The gateway's check. */
export function checkAgentUrlVerifyAnswer(
  owner: string,
  challenge: string,
  answer: Pick<AgentUrlVerifyAnswer, "challenge" | "owner">,
): boolean {
  return answer.challenge === challenge && answer.owner.toLowerCase() === owner.toLowerCase();
}

const encoder = new TextEncoder();

/** WebCrypto's key type, named without the DOM library. */
type WebKey = Awaited<ReturnType<typeof globalThis.crypto.subtle.importKey>>;

function bytesOf(body: string | Uint8Array): Uint8Array {
  return typeof body === "string" ? encoder.encode(body) : body;
}

/** What is signed: `v2.<kid>.<timestamp>.<owner>.` followed by the raw body bytes. */
function signedPayload(
  kid: string,
  timestamp: number,
  owner: string,
  body: string | Uint8Array,
): Uint8Array<ArrayBuffer> {
  const prefix = encoder.encode(
    `${AGENT_URL_SIGNATURE_VERSION}.${kid}.${timestamp}.${owner.toLowerCase()}.`,
  );
  const raw = bytesOf(body);
  const out = new Uint8Array(prefix.length + raw.length);
  out.set(prefix, 0);
  out.set(raw, prefix.length);
  return out;
}

/** Signs calls to agents: Bonded's side. Made from private keys with `agentUrlSigner`. */
export interface AgentUrlSigner {
  /** The key id that signs (the first key's). */
  readonly kid: string;
  /** The headers for a call to `owner`'s agent, signed now (or at `nowMs`). */
  sign(owner: string, body: string | Uint8Array, nowMs?: number): Promise<Record<string, string>>;
  /** The public keys to publish at AGENT_URL_KEYS_PATH: every key given, the signing one first. */
  keySet(): AgentUrlKeySet;
}

/**
 * A key id from the public key: the first 12 characters of base64url(SHA-256(public key)), so it
 * needs no configuring and two keys never share one by accident.
 */
async function keyIdOf(publicKey: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", publicKey));
  return base64url(digest).slice(0, 12);
}

/**
 * A signer from private keys, each the base64url PKCS#8 of an Ed25519 key, comma-separated (the
 * form of AGENT_URL_SIGNING_KEY; `newAgentUrlSigningKey` makes one). The first signs; all are
 * published, so a new key can be put first while handlers still trust the old one.
 */
export async function agentUrlSigner(privateKeys: string): Promise<AgentUrlSigner> {
  const texts = privateKeys
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (texts.length === 0) throw new Error("no agent URL signing key");
  if (texts.length > AGENT_URL_MAX_KEYS)
    throw new Error(
      `at most ${AGENT_URL_MAX_KEYS} agent URL signing keys (the published set's limit)`,
    );
  const keys = await Promise.all(
    texts.map(async (text) => {
      let key: WebKey;
      try {
        key = await globalThis.crypto.subtle.importKey(
          "pkcs8",
          unbase64url(text),
          { name: "Ed25519" },
          true,
          ["sign"],
        );
      } catch {
        throw new Error("an agent URL signing key isn't a base64url PKCS#8 Ed25519 key");
      }
      const jwk = await globalThis.crypto.subtle.exportKey("jwk", key);
      const x = jwk.x!;
      const kid = await keyIdOf(unbase64url(x));
      return { key, publicKey: { kid, alg: "Ed25519" as const, x } };
    }),
  );
  const signing = keys[0]!;
  return {
    kid: signing.publicKey.kid,
    async sign(owner, body, nowMs = Date.now()) {
      const timestamp = Math.floor(nowMs / 1000);
      const payload = signedPayload(signing.publicKey.kid, timestamp, owner, body);
      const signature = new Uint8Array(
        await globalThis.crypto.subtle.sign({ name: "Ed25519" }, signing.key, payload),
      );
      return {
        [AGENT_URL_TIMESTAMP_HEADER]: String(timestamp),
        [AGENT_URL_OWNER_HEADER]: owner.toLowerCase(),
        [AGENT_URL_SIGNATURE_HEADER]: `${AGENT_URL_SIGNATURE_VERSION}=${signing.publicKey.kid}:${base64url(signature)}`,
      };
    },
    keySet: () => ({ keys: keys.map((k) => k.publicKey) }),
  };
}

/** A new Ed25519 signing key, as base64url PKCS#8 (one AGENT_URL_SIGNING_KEY value). */
export async function newAgentUrlSigningKey(): Promise<string> {
  const pair = (await globalThis.crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as { privateKey: WebKey; publicKey: WebKey };
  return base64url(
    new Uint8Array(await globalThis.crypto.subtle.exportKey("pkcs8", pair.privateKey)),
  );
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
  | { ok: true; message: AgentUrlMessage; timestamp: number; owner: string }
  | {
      ok: false;
      /** The status to answer with: 401 for a bad or stale signature, 400 for a bad body. */
      status: 400 | 401;
      reason: string;
      /** Set when the call was for a wallet this agent isn't set up for (answered as `code`). */
      code?: typeof AGENT_URL_WRONG_OWNER;
    };

export interface VerifyAgentUrlRequestOptions {
  /** The wallet this agent belongs to (or several, for a team): calls for anyone else are refused. */
  owner: string | string[];
  /** Bonded's public keys (the published key set's `keys`). */
  keys: AgentUrlPublicKey[];
  /** The raw body, exactly as received (before any JSON parsing). */
  body: string | Uint8Array;
  headers: AgentUrlHeaders;
  /** Now, in milliseconds (default Date.now()). */
  nowMs?: number;
  toleranceSeconds?: number;
  /** Refuses a signature seen before. Without one, replays within the tolerance pass. */
  replay?: AgentUrlReplayGuard;
}

const publicKeys = new Map<string, Promise<WebKey>>();
function importPublicKey(key: AgentUrlPublicKey): Promise<WebKey> {
  const id = `${key.kid}:${key.x}`;
  let imported = publicKeys.get(id);
  if (!imported) {
    imported = globalThis.crypto.subtle.importKey(
      "raw",
      unbase64url(key.x),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    publicKeys.set(id, imported);
  }
  return imported;
}

/**
 * Checks a call from Bonded in the agent's handler: the timestamp is within the tolerance, the
 * call is for this agent's owner, a `v2` signature verifies under one of Bonded's keys, it is not
 * a replay, and the body is one of Bonded's messages. Answer `status` with the reason when it
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
  const ownerText = header(options.headers, AGENT_URL_OWNER_HEADER)?.trim().toLowerCase();
  if (!tsText || !sigText || !ownerText) return refuse(401, "the call is not signed");
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
    .map((value) => /^([A-Za-z0-9_-]{4,64}):([A-Za-z0-9_-]{86})$/.exec(value))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ kid: m[1]!, signature: m[2]! }));
  if (signatures.length === 0) return refuse(401, "no v2 signature");
  if (signatures.length > AGENT_URL_MAX_SIGNATURES) return refuse(401, "too many signatures");
  let matched: string | undefined;
  let knownKey = false;
  for (const { kid, signature } of signatures) {
    const key = options.keys.find((k) => k.kid === kid);
    if (!key) continue;
    knownKey = true;
    const ok = await globalThis.crypto.subtle.verify(
      { name: "Ed25519" },
      await importPublicKey(key),
      unbase64url(signature),
      signedPayload(kid, timestamp, ownerText, options.body),
    );
    if (ok) {
      // Keyed by the signature's bytes: base64url text has spare bits in its last character, so
      // two spellings of one signature must count as the same call.
      matched = base64url(unbase64url(signature));
      break;
    }
  }
  if (!knownKey) return refuse(401, "the call is signed with a key this agent doesn't know");
  if (!matched) return refuse(401, "the signature doesn't match");
  // Only a call Bonded really signed learns it's for another wallet: an unsigned one can't probe
  // whose agent this is.
  const owners = (Array.isArray(options.owner) ? options.owner : [options.owner]).map((o) =>
    o.toLowerCase(),
  );
  if (!owners.includes(ownerText))
    return {
      ok: false,
      status: 401,
      reason: "this agent is set up for another wallet, not the one this call is for",
      code: AGENT_URL_WRONG_OWNER,
    };
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
  return { ok: true, message: parsed.data, timestamp, owner: ownerText };
}

/**
 * Fetches Bonded's published key set from `url`, keeping it for `maxAgeMs` (a day by default) and
 * fetching again at once when a call names a key it hasn't seen (at most once a minute), so a new
 * key is picked up the day it starts signing. A set older than that is not trusted if it can't be
 * refetched. `fallback` keys are used only when the set can't be fetched and none was ever
 * fetched, so a handler still starts while the address is down.
 */
export class AgentUrlKeys {
  private cached: { keys: AgentUrlPublicKey[]; at: number } | undefined;
  private pending: Promise<AgentUrlPublicKey[]> | undefined;
  private lastFetch = -Infinity;

  constructor(
    private readonly url: string,
    private readonly options: {
      fetch?: typeof fetch;
      now?: () => number;
      maxAgeMs?: number;
      fallback?: AgentUrlPublicKey[];
      /** How long a fetch of the set may take (default 8 s). */
      timeoutMs?: number;
    } = {},
  ) {}

  /** The keys, fresh enough; `kid` is a key a call was signed with, fetched for when unknown. */
  async get(kid?: string): Promise<AgentUrlPublicKey[]> {
    const now = (this.options.now ?? Date.now)();
    const maxAge = this.options.maxAgeMs ?? 86_400_000;
    const fresh = this.cached && now - this.cached.at < maxAge;
    const unknown = kid !== undefined && !this.cached?.keys.some((k) => k.kid === kid);
    if (fresh && !(unknown && now - this.lastFetch > 60_000)) return this.cached!.keys;
    if (!fresh || unknown) {
      try {
        return await this.fetchKeys(now);
      } catch (error) {
        // A set older than maxAgeMs is no longer trusted: a key taken off it must stop working.
        if (fresh) return this.cached!.keys;
        // The built-in keys stand in only for a call they can check: a key id they don't have (a
        // newer key) is "can't fetch, try again", not a bad signature.
        const fallback = this.options.fallback ?? [];
        if (
          !this.cached &&
          fallback.length &&
          (kid === undefined || fallback.some((k) => k.kid === kid))
        )
          return fallback;
        throw error;
      }
    }
    return this.cached!.keys;
  }

  private fetchKeys(now: number): Promise<AgentUrlPublicKey[]> {
    this.pending ??= (async () => {
      this.lastFetch = now;
      try {
        // Within the gateway's 10-second answer budget, so a slow keys address can't hang a call.
        const res = await (this.options.fetch ?? fetch)(this.url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 8_000),
        });
        if (!res.ok) throw new Error(`Bonded's keys answered ${res.status}`);
        const set = AgentUrlKeySet.parse(await res.json());
        this.cached = { keys: set.keys, at: now };
        return set.keys;
      } finally {
        this.pending = undefined;
      }
    })();
    return this.pending;
  }
}

/** The key id each `v2` signature in a header names (to look up an unknown key before checking). */
export function agentUrlSignatureKeyIds(headers: AgentUrlHeaders): string[] {
  const text = header(headers, AGENT_URL_SIGNATURE_HEADER) ?? "";
  return text
    .split(",")
    .map((part) => /^v2=([A-Za-z0-9_-]{4,64}):/.exec(part.trim())?.[1])
    .filter((kid): kid is string => kid !== undefined)
    .slice(0, AGENT_URL_MAX_SIGNATURES);
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function unbase64url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
