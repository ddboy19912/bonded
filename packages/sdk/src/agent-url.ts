import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AGENT_URL_MAX_BODY_BYTES,
  AGENT_URL_TOLERANCE_SECONDS,
  AgentUrlKeys,
  type AgentUrlPublicKey,
  AgentUrlReplayGuard,
  type AgentUrlMessage,
  agentUrlSignatureKeyIds,
  answerAgentUrlVerify,
  isAgentUrlOwner,
  verifyAgentUrlRequest,
} from "@bondedhq/shared/agent-url";
import { BONDED_AGENT_API_URL, keysUrlOf } from "./signature.js";
import type { BondedBrokerageEpisode, BondedEpisode } from "./episode.js";
import { finishEpisode } from "./done.js";
import type { EpisodeUsage } from "./mcp.js";

/** For your own handler: the verify answer, and the request check. */
export {
  AGENT_URL_KEYS_PATH,
  AgentUrlKeys,
  type AgentUrlPublicKey,
  answerAgentUrlVerify,
  verifyAgentUrlRequest,
} from "@bondedhq/shared/agent-url";
export {
  BONDED_AGENT_API_URL,
  createTestSigner,
  keysUrlOf,
  OWNER_HEADER,
  SIGNATURE_HEADER,
  SIGNATURE_TOLERANCE_SECONDS,
  TIMESTAMP_HEADER,
} from "./signature.js";

/**
 * Agent URL mode: instead of running the Bonded runner, an agent serves one HTTPS endpoint and
 * Bonded calls it once per episode. Every call is a signed `POST` of one JSON message:
 *
 * - `{ type: "verify", challenge }` when the URL is saved: answer
 *   `200 { challenge, owner, version? }`, where `owner` is your wallet.
 * - `{ type: "episode", ... }` (the runner protocol's `EpisodeMessage`): answer `2xx` within
 *   10 seconds, then work: call the episode's tools and `POST {done}` when finished.
 * - `{ type: "cancel", episodeId }`: stop that episode (best effort).
 *
 * Every call is signed by Bonded's own key and names the owner it is for; there is no secret to
 * set. `createBondedHandler` does all of that: it checks signatures against Bonded's published
 * keys, refuses calls for any wallet but `owner`, answers challenges, acknowledges an
 * episode at once and runs your `onEpisode` in the background, aborts it on cancel or at the
 * deadline, and posts `/done` (with the usage you return) when it resolves.
 */

/** What `onEpisode` may return: posted to the episode's `/done`. */
export interface EpisodeOutcome {
  finalMessage?: string;
  /** Your model's usage for the episode; Bonded uses it to estimate a full rating's cost. */
  usage?: EpisodeUsage;
}

export interface EpisodeContext {
  /**
   * Aborted when Bonded cancels the episode or its deadline passes. Stop then: the episode is
   * over and its endpoints refuse further calls. Pass it to your model and HTTP calls.
   */
  signal: AbortSignal;
}

export interface BondedHandlerOptions {
  /**
   * Your wallet: the one you sign in to Bonded with and save this URL from (or several, for a
   * team). Bonded signs each call for the wallet that saved the URL, and the handler refuses calls
   * for anyone else, so nobody can claim your URL as theirs. It's public, not a secret.
   */
  owner: string | string[];
  /**
   * Bonded's API, where its signing keys are published. Default: Bonded's production API. Set it
   * when you rate against another Bonded deployment (a local Arena, a staging API).
   */
  apiUrl?: string;
  /** Bonded's public keys, given directly instead of fetched (for tests: `createTestSigner`). */
  keys?: AgentUrlPublicKey[];
  /** Runs one episode. Resolve when the agent is finished; the handler then posts `/done`. */
  onEpisode(
    episode: BondedEpisode,
    context: EpisodeContext,
  ): Promise<EpisodeOutcome | void> | EpisodeOutcome | void;
  /**
   * Runs one brokerage episode (a simulated brokerage account; docs/BROKERAGE.md). Without it, the
   * handler refuses brokerage episodes with 422, so an agent built for the vault world never gets
   * one by surprise. Errors are passed to `onBrokerageError` (default `console.error`).
   */
  onBrokerageEpisode?(
    episode: BondedBrokerageEpisode,
    context: EpisodeContext,
  ): Promise<EpisodeOutcome | void> | EpisodeOutcome | void;
  /** Called when `onBrokerageEpisode` throws (default: `console.error`). `/done` is still posted. */
  onBrokerageError?: (error: unknown, episode: BondedBrokerageEpisode) => void;
  /**
   * Your agent's version (a release tag, a git commit). Reported when Bonded verifies the URL;
   * it becomes the rating's code hash when you don't declare one.
   */
  version?: string;
  /** Called when `onEpisode` throws (default: `console.error`). `/done` is still posted. */
  onError?: (error: unknown, episode: BondedEpisode) => void;
  /**
   * Keeps the background work alive on platforms that stop at the response (Cloudflare's
   * `ctx.waitUntil`, Vercel's `waitUntil`, Next.js `after`). The handler's second argument wins.
   */
  waitUntil?: (work: Promise<unknown>) => void;
  /** How far a request's timestamp may be from this server's clock. Default 300 seconds. */
  toleranceSeconds?: number;
  /** Largest request body accepted. Default 256 KiB (the most Bonded sends). */
  maxBodyBytes?: number;
  /** Most episodes run at once (Bonded sends one at a time per agent). Default 8. */
  maxConcurrent?: number;
  /** For tests: the clock, in milliseconds. */
  now?: () => number;
  /** For tests: the `fetch` used to post `/done`. */
  fetch?: typeof fetch;
}

/** A standard Fetch API handler: Hono, Next.js route handlers, Bun, Deno, Cloudflare Workers. */
export type BondedHandler = (
  request: Request,
  context?: { waitUntil?: (work: Promise<unknown>) => void },
) => Promise<Response>;

/**
 * An Agent URL endpoint for your agent.
 *
 * ```ts
 * const handler = createBondedHandler({
 *   owner: "0xYourWallet",
 *   version: process.env.GIT_SHA,
 *   async onEpisode(episode, { signal }) {
 *     const tools = await bondedAiSdkTools(episode);
 *     const { usage } = await generateText({ model, tools, prompt: episode.task.goal, abortSignal: signal });
 *     return { usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 } };
 *   },
 * });
 * export const POST = handler; // Next.js; or app.post("/bonded", (c) => handler(c.req.raw)) in Hono
 * ```
 */
export function createBondedHandler(options: BondedHandlerOptions): BondedHandler {
  const owners = Array.isArray(options.owner) ? options.owner : [options.owner];
  if (owners.length === 0 || !owners.every((o) => typeof o === "string" && isAgentUrlOwner(o)))
    throw new Error(
      "createBondedHandler needs owner: your wallet address (0x…), the one you save this URL from",
    );
  const keyStore = options.keys
    ? undefined
    : new AgentUrlKeys(keysUrlOf(options.apiUrl ?? BONDED_AGENT_API_URL), {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
  const now = options.now ?? Date.now;
  const tolerance = options.toleranceSeconds ?? AGENT_URL_TOLERANCE_SECONDS;
  const maxBody = options.maxBodyBytes ?? AGENT_URL_MAX_BODY_BYTES;
  const maxConcurrent = options.maxConcurrent ?? 8;
  const onError =
    options.onError ??
    ((error: unknown, episode: BondedEpisode) =>
      console.error(`Bonded episode ${episode.episodeId} failed:`, error));
  /** Signatures already accepted, until they fall out of the window: replays are refused. */
  const replay = new AgentUrlReplayGuard(tolerance);
  const running = new Map<string, AbortController>();

  const onBrokerageError =
    options.onBrokerageError ??
    ((error: unknown, episode: BondedBrokerageEpisode) =>
      console.error(`Bonded brokerage episode ${episode.episodeId} failed:`, error));

  const run = async <E extends BondedEpisode | BondedBrokerageEpisode>(
    episode: E,
    controller: AbortController,
    work: (
      episode: E,
      context: EpisodeContext,
    ) => Promise<EpisodeOutcome | void> | EpisodeOutcome | void,
    reportError: (error: unknown, episode: E) => void,
  ) => {
    const deadline = setTimeout(
      () => controller.abort(new Error("the episode's deadline passed")),
      episode.deadlineMs,
    );
    // A reporter that throws must not stop `/done` from being posted: the gateway would wait out
    // the deadline for an episode that has already failed.
    const report = (error: unknown) => {
      try {
        reportError(error, episode);
      } catch (reporterError) {
        console.error(
          `Bonded episode ${episode.episodeId}: the error reporter threw:`,
          reporterError,
        );
      }
    };
    let outcome: EpisodeOutcome | void;
    let failed = false;
    try {
      outcome = await work(episode, { signal: controller.signal });
    } catch (error) {
      failed = true;
      if (!controller.signal.aborted) report(error);
      outcome = {
        finalMessage:
          `the agent failed: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            4_000,
          ),
      };
    } finally {
      clearTimeout(deadline);
      running.delete(episode.episodeId);
    }
    // Cancelled or past its deadline: the episode is already over at the gateway.
    if (controller.signal.aborted) return;
    try {
      await finishEpisode(
        episode,
        {
          ...(outcome?.finalMessage !== undefined
            ? { finalMessage: outcome.finalMessage.slice(0, 4_000) }
            : {}),
          ...(outcome?.usage ? { usage: outcome.usage } : {}),
        },
        options.fetch ? { fetch: options.fetch } : {},
      );
    } catch (error) {
      if (!failed) report(error);
    }
  };

  return async (request, context) => {
    if (request.method !== "POST")
      return json(405, { error: "Bonded calls this endpoint with POST" }, { allow: "POST" });
    const body = await readCapped(request, maxBody);
    if (body === undefined) return json(413, { error: `the body is over ${maxBody} bytes` });

    let keys: AgentUrlPublicKey[];
    try {
      keys =
        options.keys ??
        (await keyStore!.get(agentUrlSignatureKeyIds(request.headers).find(Boolean)));
    } catch (error) {
      console.error("Bonded: couldn't fetch Bonded's signing keys:", error);
      return json(503, { error: "the agent couldn't fetch Bonded's signing keys; try again" });
    }
    const check = await verifyAgentUrlRequest({
      owner: owners,
      keys,
      body,
      headers: request.headers,
      nowMs: now(),
      toleranceSeconds: tolerance,
      replay,
    });
    if (!check.ok) return json(check.status, { error: check.reason });
    const message = check.message;

    // The answer names the owner the call was signed for (one of ours, checked above). The verify
    // body carries no owner, so a server that echoes it back can't pass.
    if (message.type === "verify")
      return json(200, answerAgentUrlVerify(check.owner, message, options.version));

    if (message.type === "cancel") {
      const controller = running.get(message.episodeId);
      controller?.abort(new Error("Bonded cancelled the episode"));
      return json(200, { ok: true, cancelled: controller !== undefined });
    }

    if (message.world === "brokerage" && !options.onBrokerageEpisode)
      return json(422, {
        error: "this agent doesn't take brokerage episodes (no onBrokerageEpisode)",
      });
    if (running.has(message.episodeId))
      return json(200, { ok: true, episodeId: message.episodeId, alreadyRunning: true });
    if (running.size >= maxConcurrent)
      return json(429, { error: `already running ${running.size} episodes` });
    const controller = new AbortController();
    running.set(message.episodeId, controller);
    const work =
      message.world === "brokerage"
        ? run(
            toBrokerageEpisode(message),
            controller,
            (e, c) => options.onBrokerageEpisode!(e, c),
            onBrokerageError,
          )
        : run(toEpisode(message), controller, (e, c) => options.onEpisode(e, c), onError);
    // Called as a method: Cloudflare's ctx.waitUntil needs its `this`.
    if (context?.waitUntil) context.waitUntil(work);
    else options.waitUntil?.(work);
    return json(202, { ok: true, episodeId: message.episodeId });
  };
}

/** A brokerage episode as the agent sees it (the same shape `fromBondedBrokerageEnv` returns). */
function toBrokerageEpisode(
  message: Extract<AgentUrlMessage, { type: "episode"; world: "brokerage" }>,
): BondedBrokerageEpisode {
  return {
    world: "brokerage",
    episodeId: message.episodeId,
    task: message.task,
    mode: "tools",
    endpoints: message.endpoints,
    deadlineMs: message.deadlineMs,
  };
}

/** The episode as the agent sees it (the same shape `fromBondedEnv` returns). */
function toEpisode(
  message: Exclude<Extract<AgentUrlMessage, { type: "episode" }>, { world: "brokerage" }>,
): BondedEpisode {
  // The runner protocol's message, minus `type`, `nonce` and `teeKeyId` (TEE-bound agents use
  // the runner).
  return {
    episodeId: message.episodeId,
    task: message.task,
    mode: message.mode,
    endpoints: message.endpoints,
    vault: message.vault,
    chainId: message.chainId,
    contracts: { exchange: message.contracts.exchange, tokens: message.contracts.tokens },
    ...(message.sessionKey ? { sessionKey: message.sessionKey } : {}),
    deadlineMs: message.deadlineMs,
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** The body as text, or undefined when it is over `max` bytes (read no further than that). */
async function readCapped(request: Request, max: number): Promise<string | undefined> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > max) return undefined;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * The handler as a Node `http` / Express / Fastify-style listener:
 *
 * ```ts
 * app.post("/bonded", toNodeHandler(handler)); // Express: mount it before express.json()
 * http.createServer(toNodeHandler(handler)).listen(8080);
 * ```
 *
 * The signature covers the raw body, so the body must reach it unparsed: either nothing has read
 * the stream yet, or `req.body` is the raw `Buffer` or string (`express.raw()`/`express.text()`).
 */
export function toNodeHandler(
  handler: BondedHandler,
): (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    let body: RequestInit["body"] | undefined;
    if (typeof req.body === "string" || req.body instanceof Uint8Array) {
      body = req.body as string | Uint8Array<ArrayBuffer>;
    } else if (req.body !== undefined && req.body !== null && !isEmptyObject(req.body)) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error:
            "the body was already parsed, so its signature can't be checked: mount the Bonded handler before express.json(), or use express.raw({ type: 'application/json' })",
        }),
      );
      return;
    } else if (req.method === "POST") {
      body = new ReadableStream<Uint8Array>({
        start(controller) {
          req.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
          req.on("end", () => controller.close());
          req.on("error", (error) => controller.error(error));
        },
        cancel() {
          req.destroy();
        },
      });
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers))
      if (typeof value === "string") headers.set(name, value);
      else if (Array.isArray(value)) headers.set(name, value.join(", "));
    const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
      method: req.method ?? "GET",
      headers,
      ...(body !== undefined ? { body, duplex: "half" } : {}),
    } as RequestInit);
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}

function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}
