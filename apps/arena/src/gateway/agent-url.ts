import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import {
  AGENT_URL_ANSWER_MS,
  AGENT_URL_MAX_BODY_BYTES,
  AGENT_URL_MAX_RESPONSE_BYTES,
  type AgentUrlMessage,
  AgentUrlVerifyAnswer,
  agentUrlCodeHash,
  checkAgentUrlVerifyProof,
  signAgentUrlRequest,
} from "@bondedhq/shared";
import {
  AddressNotAdmittedError,
  FetchTimeoutError,
  publicAddress,
  safeRequest,
  UnsafeUrlError,
} from "../safe-fetch.js";
import { addressGroup } from "./address.js";

/**
 * The gateway's side of Agent URL mode (the protocol is in @bondedhq/shared, agent-url.ts): every
 * call the Arena makes to an agent's own HTTPS endpoint. The URL is chosen by an untrusted
 * operator, so every call:
 * - goes through safe-fetch: https on port 443 only, every resolved address public (checked when
 *   connecting), no redirects, one deadline for the whole call (AGENT_URL_ANSWER_MS) and at most
 *   AGENT_URL_MAX_RESPONSE_BYTES of the answer read;
 * - is refused before any name lookup for Bonded's own hosts (BONDED_OWN_HOSTS, the gateway's own
 *   URL, and any the caller adds) and for names that can only be internal (one label, .local,
 *   .internal, ...);
 * - is rate limited. Episode and cancel calls are limited per registration (the agent or preview
 *   the URL belongs to), so one operator can't use up another's allowance. Verify calls, which
 *   anyone registering a URL can cause, are limited per host name, per registrable domain and per
 *   resolved address (IPv4, or IPv6 by /64), so the Arena can't be aimed at one site;
 * - is signed with the agent secret.
 *
 * Failures come back as plain sentences for the operator ("Your URL answered 404"), never thrown,
 * and never with more detail than the operator needs (no internal error text: that goes to `log`).
 */

/** Bonded's own deployed hosts: never an agent URL (subdomains included). */
export const BONDED_OWN_HOSTS: readonly string[] = [
  "bondedhq.xyz",
  "bonded-nu.vercel.app",
  "api-production-ba50.up.railway.app",
  "arena-worker-production.up.railway.app",
  "bonded-arena-gateway.up.railway.app",
];

/** Name suffixes that only exist on private networks: refused before any lookup. */
const INTERNAL_SUFFIXES = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "intranet",
  "lan",
  "corp",
  "home.arpa",
  "arpa",
  "invalid",
  "onion",
];

/**
 * Suffixes under which each name is a separate site (a short excerpt of the Public Suffix List:
 * common country second levels and hosting platforms), for the per-domain verify limit.
 */
const PUBLIC_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.jp",
  "co.nz",
  "co.in",
  "co.za",
  "com.br",
  "com.cn",
  "com.mx",
  "com.sg",
  "up.railway.app",
  "railway.app",
  "vercel.app",
  "netlify.app",
  "herokuapp.com",
  "fly.dev",
  "onrender.com",
  "github.io",
  "pages.dev",
  "workers.dev",
  "ngrok-free.app",
  "ngrok.app",
  "ngrok.io",
  "trycloudflare.com",
  "azurewebsites.net",
  "cloudfunctions.net",
  "run.app",
  "appspot.com",
  "amazonaws.com",
  "replit.app",
  "repl.co",
  "deno.dev",
  "glitch.me",
  "modal.run",
]);

/** The site a host belongs to: the label before its public suffix (example.co.uk, a.vercel.app). */
export function registrableDomain(host: string): string {
  const clean = host.toLowerCase().replace(/\.$/, "");
  if (isIP(clean.replace(/^\[|\]$/g, ""))) return clean;
  const labels = clean.split(".");
  for (let take = Math.min(labels.length - 1, 3); take >= 2; take--)
    if (PUBLIC_SUFFIXES.has(labels.slice(-take).join(".")))
      return labels.slice(-(take + 1)).join(".");
  return labels.slice(-2).join(".");
}

export interface AgentUrlLimits {
  /** Deadline for each call, from the name lookup to the last byte of the answer. */
  answerMs: number;
  /** The most of an answer read. */
  maxResponseBytes: number;
  /** Episode and cancel calls per registration per minute, on average, with this burst. */
  callsPerMinute: number;
  callBurst: number;
  /** Verify calls per host name, per registrable domain and per address, per minute, and burst. */
  verifiesPerMinute: number;
  verifyBurst: number;
  /** How long an episode waits for its registration's rate limit before giving up. */
  slotWaitMs: number;
  /** Rate-limit buckets kept (the longest idle are dropped first). */
  maxBuckets: number;
}

export const DEFAULT_AGENT_URL_LIMITS: AgentUrlLimits = {
  answerMs: AGENT_URL_ANSWER_MS,
  maxResponseBytes: AGENT_URL_MAX_RESPONSE_BYTES,
  callsPerMinute: 30,
  callBurst: 10,
  verifiesPerMinute: 10,
  verifyBurst: 5,
  slotWaitMs: 5_000,
  maxBuckets: 10_000,
};

export interface AgentUrlClientOptions {
  /** Allow http and loopback addresses, on any port (a local CLI rating or tests; never hosted). */
  allowLoopback?: boolean;
  /** More hosts to refuse, beyond BONDED_OWN_HOSTS (e.g. from an env variable). */
  refusedHosts?: readonly string[];
  limits?: Partial<AgentUrlLimits>;
  /** Where failure details go (server side only: the host and the error, never the secret). */
  log?: (message: string) => void;
}

/** The outcome of one call: the answer, or why there is none, as a sentence for the operator. */
export type AgentUrlCall =
  | { ok: true; status: number; text: string }
  | {
      ok: false;
      problem: string;
      /** The status the URL answered with, when it answered. */
      status?: number;
      /**
       * Who the failure is down to: "agent" (its URL refused, failed, timed out or isn't
       * allowed), or "bonded" (a rate limit Bonded applies: not the agent's fault).
       */
      caused: "agent" | "bonded";
    };

export type AgentUrlVerifyResult =
  | {
      ok: true;
      /** The version the agent reported, if any. */
      version?: string;
      /** keccak256("url:" + version), when it reported one: reported by the agent, not verified. */
      codeHash?: `0x${string}`;
    }
  | { ok: false; problem: string };

/** One sentence for "it doesn't resolve" and "it resolves somewhere private", so neither leaks. */
const NOT_PUBLIC =
  "Your URL's host isn't reachable on the public internet: it must resolve to a public address";
const RATE_LIMITED = "Bonded has called your URL too often in the last minute; try again shortly";

interface Bucket {
  allowance: number;
  refilled: number;
}

export class AgentUrlClient {
  readonly limits: AgentUrlLimits;
  private readonly refusedHosts = new Set<string>();
  private readonly refusedOrigins = new Set<string>();
  private readonly buckets = new Map<string, Bucket>();
  private readonly busy = new Map<string, string>();
  private readonly log: (message: string) => void;

  constructor(private readonly options: AgentUrlClientOptions = {}) {
    this.limits = { ...DEFAULT_AGENT_URL_LIMITS, ...options.limits };
    this.log = options.log ?? (() => {});
    for (const host of [...BONDED_OWN_HOSTS, ...(options.refusedHosts ?? [])])
      this.refuseHost(host);
  }

  /** Never call this host or any subdomain of it. */
  refuseHost(host: string): void {
    const clean = host.trim().toLowerCase().replace(/\.$/, "");
    if (clean) this.refusedHosts.add(clean);
  }

  /** Never call this exact origin (scheme, host and port): the gateway's own, when it's local. */
  refuseOrigin(origin: string): void {
    this.refusedOrigins.add(new URL(origin).origin);
  }

  /** Why `text` can't be an agent URL (a sentence), or undefined when it can. */
  urlProblem(text: string): string | undefined {
    if (text.length > 2_048) return "Your URL is too long";
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return "That isn't a URL";
    }
    const host = hostOf(url);
    const bare = host.replace(/^\[|\]$/g, "");
    const loopbackAllowed = Boolean(this.options.allowLoopback);
    // This machine: only when loopback is allowed (a local rating), and then plain http too.
    const loopback =
      host === "localhost" ||
      (isIP(bare) !== 0 && publicAddress(bare, true) && !publicAddress(bare));
    const local = loopbackAllowed && loopback;
    if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
      return "Your URL must use https";
    if (url.username || url.password) return "Your URL can't carry a user name or password";
    if (url.port !== "" && url.port !== "443" && !local)
      return "Your URL must use the standard https port (443)";
    if (this.refusedOrigins.has(url.origin)) return "Your URL is one of Bonded's own addresses";
    for (const refused of this.refusedHosts)
      if (host === refused || host.endsWith(`.${refused}`))
        return "Your URL is one of Bonded's own addresses";
    if (local) return undefined;
    if (isIP(bare)) return publicAddress(bare) ? undefined : NOT_PUBLIC;
    // Names that only exist inside a network are refused before any lookup.
    if (!host.includes(".")) return NOT_PUBLIC;
    for (const suffix of INTERNAL_SUFFIXES)
      if (host === suffix || host.endsWith(`.${suffix}`)) return NOT_PUBLIC;
    return undefined;
  }

  /**
   * POSTs one signed message to the agent's URL. Episodes and cancels name the `registration`
   * they belong to (the agent or preview id), whose rate limit they use; an episode waits up to
   * `waitMs` for it. Verify calls use the per-host, per-domain and per-address limits.
   */
  async send(
    url: string,
    secret: string,
    message: AgentUrlMessage,
    options: { registration?: string; waitMs?: number } = {},
  ): Promise<AgentUrlCall> {
    const problem = this.urlProblem(url);
    if (problem) return { ok: false, problem, caused: "agent" };
    const target = new URL(url);
    const host = hostOf(target);
    const verifying = message.type === "verify";
    if (verifying) {
      if (!this.takeAll([`host:${host}`, `domain:${registrableDomain(host)}`], "verify"))
        return { ok: false, problem: RATE_LIMITED, caused: "bonded" };
    } else {
      const key = `registration:${options.registration ?? `host:${host}`}`;
      if (!(await this.slot(key, options.waitMs ?? 0)))
        return { ok: false, problem: RATE_LIMITED, caused: "bonded" };
    }
    const body = JSON.stringify(message);
    if (Buffer.byteLength(body) > AGENT_URL_MAX_BODY_BYTES)
      return { ok: false, problem: "the message is too large to send", caused: "bonded" };
    try {
      const { status, text } = await safeRequest(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Bonded-Gateway/1",
          ...(await signAgentUrlRequest(secret, body)),
        },
        body,
        timeoutMs: this.limits.answerMs,
        maxBytes: this.limits.maxResponseBytes,
        ...(this.options.allowLoopback ? { allowLoopback: true } : {}),
        // Verify calls are also limited per address the name resolves to, at connect time.
        ...(verifying
          ? {
              admit: (addresses: string[]) =>
                this.takeAll(
                  [...new Set(addresses.map((a) => `address:${addressGroup(a)}`))],
                  "verify",
                )
                  ? undefined
                  : RATE_LIMITED,
            }
          : {}),
      });
      if (status < 200 || status > 299)
        return { ok: false, problem: statusProblem(status), status, caused: "agent" };
      return { ok: true, status, text };
    } catch (error) {
      if (error instanceof AddressNotAdmittedError)
        return { ok: false, problem: RATE_LIMITED, caused: "bonded" };
      return { ok: false, problem: this.failureProblem(error, host), caused: "agent" };
    }
  }

  /**
   * The ownership check: POSTs `{ type: "verify", challenge }` and expects 200 with
   * `{ challenge, proof, version? }`, where proof is HMAC-SHA256(secret, "verify." + challenge):
   * only a holder of the secret can answer, so an echo server can't pass.
   */
  async verify(url: string, secret: string): Promise<AgentUrlVerifyResult> {
    const challenge = randomBytes(24).toString("base64url");
    const call = await this.send(url, secret, { type: "verify", challenge });
    if (!call.ok) return { ok: false, problem: call.problem };
    if (call.status !== 200)
      return {
        ok: false,
        problem: `Your URL answered ${call.status} to the check; it must be 200`,
      };
    let raw: unknown;
    try {
      raw = JSON.parse(call.text);
    } catch {
      return { ok: false, problem: "Your URL answered the check, but not with JSON" };
    }
    const answer = AgentUrlVerifyAnswer.safeParse(raw);
    if (!answer.success || !(await checkAgentUrlVerifyProof(secret, challenge, answer.data)))
      return {
        ok: false,
        problem:
          'Your URL answered the check without proving it holds the agent secret: answer verify with { challenge, proof } (proof = HMAC-SHA256 of "verify." + challenge with your secret)',
      };
    const version = answer.data.version;
    return version ? { ok: true, version, codeHash: agentUrlCodeHash(version) } : { ok: true };
  }

  /**
   * Reserves a registration (an agent or preview) for one episode, waiting up to `waitMs` for an
   * episode already running to finish: one episode at a time per agent, however many ratings or
   * checks ask. Returns the release function.
   */
  async acquire(registration: string, episodeId: string, waitMs: number): Promise<() => void> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      if (!this.busy.has(registration)) {
        this.busy.set(registration, episodeId);
        return () => {
          if (this.busy.get(registration) === episodeId) this.busy.delete(registration);
        };
      }
      if (Date.now() >= deadline)
        throw new Error(`the agent is still busy with episode ${this.busy.get(registration)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Takes one call from a bucket, waiting up to `waitMs` for one. */
  private async slot(key: string, waitMs: number): Promise<boolean> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      if (this.takeAll([key], "call")) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /** Takes one from every bucket, or from none when any is empty. */
  private takeAll(keys: string[], kind: "call" | "verify"): boolean {
    const now = Date.now();
    const [perMinute, burst] =
      kind === "call"
        ? [this.limits.callsPerMinute, this.limits.callBurst]
        : [this.limits.verifiesPerMinute, this.limits.verifyBurst];
    const buckets = keys.map((key) => {
      const bucket = this.buckets.get(key) ?? { allowance: burst, refilled: now };
      bucket.allowance = Math.min(
        burst,
        bucket.allowance + ((now - bucket.refilled) / 60_000) * perMinute,
      );
      bucket.refilled = now;
      // Most recently used last, so eviction drops the longest-idle bucket.
      this.buckets.delete(key);
      this.buckets.set(key, bucket);
      return bucket;
    });
    while (this.buckets.size > this.limits.maxBuckets) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
    if (buckets.some((bucket) => bucket.allowance < 1)) return false;
    for (const bucket of buckets) bucket.allowance -= 1;
    return true;
  }

  private failureProblem(error: unknown, host: string): string {
    const seconds = Math.round(this.limits.answerMs / 100) / 10;
    if (error instanceof FetchTimeoutError)
      return `Your URL didn't answer within ${seconds} seconds`;
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string } | undefined)?.code ?? "";
    this.log(`agent URL call to ${host} failed: ${code} ${message}`.slice(0, 300));
    if (error instanceof UnsafeUrlError) {
      if (/redirect/.test(message))
        return "Your URL answered with a redirect; Bonded doesn't follow redirects, so give the final URL";
      if (/private or internal/.test(message)) return NOT_PUBLIC;
      if (/over \d+ bytes/.test(message))
        return `Your URL's answer was over ${Math.round(this.limits.maxResponseBytes / 1024)} KiB`;
      if (/https/.test(message)) return "Your URL must use https";
    }
    if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NONAME") return NOT_PUBLIC;
    if (code === "ECONNREFUSED") return "Nothing accepted a connection at your URL";
    if (code === "ECONNRESET" || /closed before/.test(message))
      return "Your URL closed the connection before answering";
    if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO/.test(code))
      return "Your URL's TLS certificate wasn't accepted (it must be valid for the host name)";
    return "Bonded couldn't reach your URL";
  }
}

/** The host name, lowercase, without a trailing dot. */
function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, "");
}

function statusProblem(status: number): string {
  if (status === 401 || status === 403)
    return `Your URL answered ${status}: check that your agent uses the agent secret Bonded gave you`;
  return `Your URL answered ${status}`;
}

/**
 * The ownership check on its own (registration, before a check or a rating): POSTs a signed
 * `{ type: "verify", challenge }` and expects `{ challenge, proof, version? }` within 10 seconds.
 * Pass the gateway's client (`gateway.agentUrls`) so the rate limits are shared.
 */
export function verifyAgentUrl(
  url: string,
  secret: string,
  options: AgentUrlClientOptions | { client: AgentUrlClient } = {},
): Promise<AgentUrlVerifyResult> {
  const client = "client" in options ? options.client : new AgentUrlClient(options);
  return client.verify(url, secret);
}
