#!/usr/bin/env node
/**
 * The example investing agent (investing-agent.mjs) in Agent URL mode: no runner. Bonded POSTs
 * each stock-trading episode to this server; it checks the signature, answers 202 at once, then
 * works the episode over its MCP tools and posts to its done URL.
 *
 *   BONDED_AGENT_SECRET=bonded_as_... OPENROUTER_API_KEY=... PORT=8080 node brokerage-url-agent.mjs
 *
 * Put it behind HTTPS (a reverse proxy, your platform's TLS, or a tunnel such as
 * `cloudflared tunnel --url http://127.0.0.1:8080`) and register that URL on Test your agent,
 * with "Stock trading" chosen. It takes stock-trading episodes only: a crypto-trading (vault)
 * episode is refused with 422, as `createBondedHandler` refuses an episode it has no handler for.
 *
 * Signature checking uses only node:crypto, so it ports to any language: HMAC-SHA256 of
 * "<timestamp>.<raw body>", and the verify answer's proof is HMAC-SHA256 of "verify.<challenge>".
 */
import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { invest, modelConfig } from "./investing-agent.mjs";

const SECRET = process.env.BONDED_AGENT_SECRET;
if (!SECRET) throw new Error("set BONDED_AGENT_SECRET to the agent secret Bonded gave you");
const config = modelConfig();
const VERSION = process.env.AGENT_VERSION ?? "investing-example-1";
const TOLERANCE_SECONDS = 300;

/** Signatures already accepted, so a captured call can't be replayed. */
const seen = new Map();

/** Checks bonded-timestamp and bonded-signature against the raw body. */
function verified(headers, raw) {
  const timestamp = Number(headers["bonded-timestamp"]);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(timestamp) || Math.abs(now - timestamp) > TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", SECRET).update(`${timestamp}.`).update(raw).digest();
  const given = String(headers["bonded-signature"] ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1="))
    .map((part) => Buffer.from(part.slice(3), "hex"));
  const match = given.find(
    (sig) => sig.length === expected.length && timingSafeEqual(sig, expected),
  );
  if (!match) return false;
  for (const [sig, ts] of seen) if (ts < now - TOLERANCE_SECONDS) seen.delete(sig);
  const key = match.toString("hex");
  if (seen.has(key)) return false;
  seen.set(key, timestamp);
  return true;
}

/** Episodes in progress, so a cancel can stop one. */
const running = new Map();

/** One episode: the investing agent, then /done with what it said. */
async function work(episode, signal) {
  let finalMessage;
  try {
    finalMessage = await invest({
      task: episode.task,
      mcpUrl: episode.endpoints.mcp,
      signal,
      config,
    });
  } catch (error) {
    finalMessage = `The agent failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  await fetch(episode.endpoints.done, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ finalMessage: finalMessage.slice(0, 4000) }),
  });
  console.log(`episode ${episode.episodeId}: ${finalMessage.slice(0, 200)}`);
}

const json = (res, status, body) =>
  void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

const server = createServer((req, res) => {
  if (req.method !== "POST") return void res.writeHead(405).end();
  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > 512 * 1024) req.destroy();
    else chunks.push(chunk);
  });
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    if (!verified(req.headers, raw)) return void res.writeHead(401).end();
    let message;
    try {
      message = JSON.parse(raw.toString("utf8"));
    } catch {
      return void res.writeHead(400).end();
    }
    if (message.type === "verify") {
      // The proof shows this server holds the secret: HMAC-SHA256 of "verify." + challenge.
      const proof = createHmac("sha256", SECRET)
        .update(`verify.${message.challenge}`)
        .digest("hex");
      return json(res, 200, { challenge: message.challenge, proof, version: VERSION });
    }
    if (message.type === "cancel") {
      running.get(message.episodeId)?.abort();
      return void res.writeHead(204).end();
    }
    if (message.type !== "episode") return void res.writeHead(400).end();
    if (message.world !== "brokerage")
      return json(res, 422, { error: "this agent takes stock-trading (brokerage) episodes only" });
    // Answer within 10 seconds, then do the work.
    res.writeHead(202).end();
    const controller = new AbortController();
    running.set(message.episodeId, controller);
    setTimeout(() => controller.abort(), message.deadlineMs).unref();
    work(message, controller.signal)
      .catch((error) => console.error(`episode ${message.episodeId}: ${error.message}`))
      .finally(() => running.delete(message.episodeId));
  });
});

server.listen(Number(process.env.PORT ?? 8080), process.env.HOST ?? "127.0.0.1", () =>
  console.log(`listening on http://${process.env.HOST ?? "127.0.0.1"}:${server.address().port}`),
);
