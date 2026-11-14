#!/usr/bin/env node
/**
 * The example investing agent (investing-agent.mjs) in Agent URL mode: no runner. Bonded POSTs
 * each stock-trading episode to this server; it checks the call is signed by Bonded for its
 * owner, answers 202 at once, then works the episode over its MCP tools and posts to its done URL.
 *
 *   BONDED_AGENT_OWNER=0xYourWallet OPENROUTER_API_KEY=... PORT=8080 node brokerage-url-agent.mjs
 *
 * BONDED_AGENT_OWNER is the wallet you save the URL from on Bonded: public, not a secret. Put the
 * server behind HTTPS (a reverse proxy, your platform's TLS, or a tunnel such as
 * `cloudflared tunnel --url http://127.0.0.1:8080`) and save that URL on Test your agent, with
 * "Stock trading" chosen. It takes stock-trading episodes only: a crypto-trading (vault) episode
 * is refused with 422, as `createBondedHandler` refuses an episode it has no handler for.
 *
 * The signature check uses only node:crypto, so it ports to any language: Ed25519 over
 * "v2.<key id>.<timestamp>.<owner>.<raw body>", with Bonded's public keys from
 * https://www.bondedhq.xyz/.well-known/bonded-agent-keys.json (or BONDED_API_URL's, for a local
 * Arena's gateway).
 */
import { Buffer } from "node:buffer";
import { createPublicKey, verify } from "node:crypto";
import { createServer } from "node:http";
import { invest, modelConfig } from "./investing-agent.mjs";

const config = modelConfig();
const OWNER = (process.env.BONDED_AGENT_OWNER ?? "").toLowerCase();
if (!/^0x[0-9a-f]{40}$/.test(OWNER))
  throw new Error("set BONDED_AGENT_OWNER to the wallet you save this URL from on Bonded");
// On Bonded's own domain, so this address keeps working if Bonded's API moves.
const KEYS_URL = `${(process.env.BONDED_API_URL ?? "https://www.bondedhq.xyz").replace(/\/+$/, "")}/.well-known/bonded-agent-keys.json`;
const VERSION = process.env.AGENT_VERSION ?? "investing-example-1";
const TOLERANCE_SECONDS = 300;

/**
 * Bonded's public keys by id: fetched again every day (a key taken off the published set stops
 * working) and at once, at most once a minute, for a key not seen yet. One fetch at a time: calls
 * that arrive meanwhile wait for it. A set that is a day old and can't be refetched is dropped.
 */
const DAY_MS = 86_400_000;
let keys = new Map();
let fetchedAt = 0;
let triedAt = 0;
let inFlight;
async function refresh() {
  inFlight ??= (async () => {
    triedAt = Date.now();
    try {
      const res = await fetch(KEYS_URL, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) throw new Error(`the keys answered ${res.status}`);
      const set = await res.json();
      keys = new Map(
        set.keys.map((k) => [
          k.kid,
          createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: k.x }, format: "jwk" }),
        ]),
      );
      fetchedAt = Date.now();
    } catch (error) {
      console.error(`couldn't fetch Bonded's keys: ${error.message}`);
      if (Date.now() - fetchedAt > DAY_MS) keys = new Map();
    } finally {
      inFlight = undefined;
    }
  })();
  return inFlight;
}
async function keyFor(kid) {
  const stale = Date.now() - fetchedAt > DAY_MS;
  const unknown = !keys.has(kid) && Date.now() - triedAt > 60_000;
  if (inFlight || stale || unknown) await refresh();
  return keys.get(kid);
}

/** Signatures already accepted, so a captured call can't be replayed. */
const seen = new Map();

/** Checks bonded-timestamp, bonded-owner and bonded-signature against the raw body. */
async function verified(headers, raw) {
  const timestamp = Number(headers["bonded-timestamp"]);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(timestamp) || Math.abs(now - timestamp) > TOLERANCE_SECONDS) return false;
  const owner = String(headers["bonded-owner"] ?? "").toLowerCase();
  for (const part of String(headers["bonded-signature"] ?? "").split(",")) {
    const match = /^v2=([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/.exec(part.trim());
    if (!match) continue;
    const [, kid, signature] = match;
    const key = await keyFor(kid);
    if (!key) continue;
    const payload = Buffer.concat([Buffer.from(`v2.${kid}.${timestamp}.${owner}.`), raw]);
    const bytes = Buffer.from(signature, "base64url");
    if (!verify(null, payload, key, bytes)) continue;
    // Signed by Bonded; now, for whose wallet: calls for anyone else's are refused, so nobody can
    // claim this URL as theirs (checked after the signature, so an unsigned call learns nothing).
    if (owner !== OWNER) return false;
    // Keyed by the signature's bytes: two spellings of one signature are the same call.
    const replayKey = bytes.toString("base64url");
    for (const [sig, ts] of seen) if (ts < now - TOLERANCE_SECONDS) seen.delete(sig);
    if (seen.has(replayKey)) return false;
    seen.set(replayKey, timestamp);
    return true;
  }
  return false;
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
  req.on("end", async () => {
    const raw = Buffer.concat(chunks);
    if (!(await verified(req.headers, raw).catch(() => false)))
      return void res.writeHead(401).end();
    let message;
    try {
      message = JSON.parse(raw.toString("utf8"));
    } catch {
      return void res.writeHead(400).end();
    }
    if (message.type === "verify") {
      // The owner it answers for: Bonded checks it is the wallet that saved the URL.
      return json(res, 200, { challenge: message.challenge, owner: OWNER, version: VERSION });
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
