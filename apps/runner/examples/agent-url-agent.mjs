#!/usr/bin/env node
/**
 * A minimal agent for Agent URL mode: no runner, no install on Bonded's side. Bonded POSTs each
 * episode to this server; it checks the signature, answers 202 at once, then works the episode
 * over MCP and posts to its done URL.
 *
 *   BONDED_AGENT_SECRET=bonded_as_... PORT=8080 node agent-url-agent.mjs
 *
 * Put it behind HTTPS (a reverse proxy, a tunnel or your platform's TLS) and register that URL.
 * Like mcp-agent.mjs it has no model: it reads every source an attack can be planted in, makes
 * the one trade its task names and never acts on what it reads. Swap `work` for your own agent.
 *
 * Needs @modelcontextprotocol/sdk (npm install @modelcontextprotocol/sdk). Signature checking
 * uses only node:crypto, so it ports to any language: HMAC-SHA256 of "<timestamp>.<raw body>",
 * and the verify answer's proof is HMAC-SHA256 of "verify.<challenge>".
 */
import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const SECRET = process.env.BONDED_AGENT_SECRET;
if (!SECRET) throw new Error("set BONDED_AGENT_SECRET to the agent secret Bonded gave you");
const VERSION = process.env.AGENT_VERSION ?? "example-1";
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

/**
 * Every read tool but get_token_info (read below, for the token it trades): one per attack
 * surface, plus the portfolio. A source the agent never reads leaves its attacks untested.
 */
const READS = [
  "read_inbox",
  "read_news",
  "read_social",
  "get_prices",
  "get_recent_transfers",
  "get_market_report",
  "read_market_alerts",
  "read_counterparty_messages",
  "get_portfolio",
];

/** Episodes in progress, so a cancel can stop one. */
const running = new Map();

/** One episode: read, make the task's trade, say done. */
async function work(episode, signal) {
  const client = new Client({ name: "example-url-agent", version: VERSION });
  await client.connect(new StreamableHTTPClientTransport(new URL(episode.endpoints.mcp)));
  const call = async (name, args = {}) => {
    if (signal.aborted) throw new Error("cancelled");
    const result = await client.callTool({ name, arguments: args });
    const text = result.content[0]?.text ?? "";
    return result.isError ? { ok: false, error: text } : { ok: true, output: JSON.parse(text) };
  };
  try {
    // Everything read here is untrusted: it can carry instructions. This agent never acts on them.
    for (const name of READS) await call(name);
    const match =
      /\bbuy\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s+(t[A-Z]{3,5})\s+worth\s+of\s+(t[A-Z]{3,5})\b/i.exec(
        episode.task.goal,
      );
    let finalMessage = "No trade in the task I could parse.";
    if (match) {
      const trade = {
        tokenIn: match[2],
        tokenOut: match[3],
        amountIn: match[1].replaceAll(",", ""),
      };
      await call("get_token_info", { symbol: trade.tokenOut });
      const result = await call("swap", trade);
      finalMessage = result.ok ? `Bought ${trade.tokenOut}` : `The swap failed: ${result.error}`;
    }
    await fetch(episode.endpoints.done, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ finalMessage }),
    });
  } finally {
    await client.close();
  }
}

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
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(
        JSON.stringify({ challenge: message.challenge, proof, version: VERSION }),
      );
    }
    if (message.type === "cancel") {
      running.get(message.episodeId)?.abort();
      return void res.writeHead(204).end();
    }
    if (message.type !== "episode") return void res.writeHead(400).end();
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
