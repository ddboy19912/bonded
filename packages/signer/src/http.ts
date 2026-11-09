import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  X402_SIGNER_PATHS,
  type X402SignerInfo,
  type X402SignerProblem,
  type X402SignRequest,
  type X402SignResponse,
} from "@bondedhq/sdk/x402";
import { type X402Signer, X402SignerRefusal } from "./signer.js";

/** Requests bigger than this are refused before parsing: a payment request is well under 2 KB. */
const MAX_BODY_BYTES = 16_384;

export interface X402SignerHandlerOptions {
  /**
   * Tokens agents send as `Authorization: Bearer <token>`. Each at least 32 characters; give each
   * agent its own, so one can be revoked. A token can only ask for x402 payments.
   */
  tokens: readonly string[];
  /** Called with every error the signer couldn't turn into an answer (sent as HTTP 500). */
  onError?: (error: unknown) => void;
}

/**
 * The signer's HTTP API as a fetch-style handler (`Request` in, `Response` out), for any server
 * that speaks web requests. `serveX402Signer` runs it on Node's own HTTP server.
 *
 * - `GET /healthz`: `{ ok: true }`, no token needed.
 * - `GET /v1/x402/signer`: the signer's address and networks.
 * - `POST /v1/x402/sign`: `{ typedData }` in, `{ signature }` out; 403 `refused` when the payment
 *   breaks its budget or the gate can't be reached, 400 `invalid` for anything that isn't an x402
 *   USDC payment from this signer.
 */
export function x402SignerHandler(
  signer: X402Signer,
  options: X402SignerHandlerOptions,
): (request: Request) => Promise<Response> {
  if (options.tokens.length === 0) throw new Error("the x402 signer needs at least one token");
  for (const token of options.tokens)
    if (token.length < 32) throw new Error("each x402 signer token must be at least 32 characters");
  const digests = options.tokens.map(sha256);

  const authorized = (request: Request) => {
    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) return false;
    const digest = sha256(match[1]!);
    // Compare every token's digest in constant time, so timing says nothing about any of them.
    return digests.reduce((ok, d) => timingSafeEqual(d, digest) || ok, false);
  };

  return async (request) => {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/healthz" && request.method === "GET") return json(200, { ok: true });
      if (path !== X402_SIGNER_PATHS.info && path !== X402_SIGNER_PATHS.sign)
        return problem(404, "not_found", "no such route");
      if (!authorized(request)) return problem(401, "unauthorized", "missing or unknown token");
      if (path === X402_SIGNER_PATHS.info) {
        if (request.method !== "GET") return problem(404, "not_found", "use GET");
        return json(200, {
          address: signer.address,
          networks: [...signer.networks],
        } satisfies X402SignerInfo);
      }
      if (request.method !== "POST") return problem(404, "not_found", "use POST");
      const text = await readCapped(request);
      if (text === undefined) return problem(400, "invalid", "the request is too large");
      let body: Partial<X402SignRequest>;
      try {
        body = JSON.parse(text) as Partial<X402SignRequest>;
      } catch {
        return problem(400, "invalid", "the body isn't JSON");
      }
      if (!body || typeof body !== "object" || !body.typedData)
        return problem(400, "invalid", "send { typedData }");
      const signature = await signer.sign(body.typedData);
      return json(200, { signature } satisfies X402SignResponse);
    } catch (error) {
      if (error instanceof X402SignerRefusal)
        return problem(error.kind === "refused" ? 403 : 400, error.kind, error.message);
      options.onError?.(error);
      return problem(500, "error", "the signer failed; nothing was signed");
    }
  };
}

export interface ServeX402SignerOptions extends X402SignerHandlerOptions {
  /** Default 8402. */
  port?: number;
  /** Default `127.0.0.1`: only this machine. Set `0.0.0.0` in a container. */
  host?: string;
}

/** Runs the signer's HTTP API on Node's HTTP server. Resolves once it's listening. */
export async function serveX402Signer(
  signer: X402Signer,
  options: ServeX402SignerOptions,
): Promise<Server> {
  const handle = x402SignerHandler(signer, options);
  const host = options.host ?? "127.0.0.1";
  const server = createServer((req, res) => {
    void respond(req, res, handle).catch((error) => {
      options.onError?.(error);
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    });
  });
  // Agents keep connections open between payments; drop idle ones well before load balancers do.
  server.keepAliveTimeout = 5_000;
  server.requestTimeout = 30_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8402, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function respond(
  req: IncomingMessage,
  res: ServerResponse,
  handle: (request: Request) => Promise<Response>,
) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid", reason: "the request is too large" }));
      req.destroy();
      return;
    }
    chunks.push(chunk as Buffer);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers))
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(", "));
  const method = req.method ?? "GET";
  const request = new Request(`http://signer${req.url ?? "/"}`, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
  });
  const response = await handle(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

function sha256(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function problem(status: number, error: X402SignerProblem["error"], reason: string): Response {
  return json(status, { error, reason } satisfies X402SignerProblem);
}

/** The body as text, or `undefined` once it passes `MAX_BODY_BYTES`: never reads more than that. */
async function readCapped(request: Request): Promise<string | undefined> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return undefined;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
