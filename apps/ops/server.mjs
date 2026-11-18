// The ops dashboard. Locally: `pnpm ops` from the repo root, then open the printed URL; it binds to
// 127.0.0.1, so the keys in .env never leave this machine. Hosted (Railway, the "ops" service): it
// listens publicly behind a password (OPS_PASSWORD, required), watches wallets by address only
// (OPS_WATCH_ADDRESSES, no keys), and posts to Telegram when a check goes low or down.
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setInterval } from "node:timers";
import { alertsFor, sendTelegram } from "./alerts.mjs";
import { runChecks } from "./checks.mjs";

const env = process.env;
const port = Number(env.OPS_PORT || env.PORT || 4545);
const host = env.OPS_HOST || "127.0.0.1";
const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
const password = env.OPS_PASSWORD?.trim() ?? "";
const page = new URL("./index.html", import.meta.url);

if (!loopback && password.length < 12) {
  console.error("ops: refusing to listen publicly without OPS_PASSWORD (12 characters or more)");
  process.exit(1);
}

/** Basic auth with any user name and the password; compared in constant time. */
function authorized(req) {
  if (!password) return true;
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const given = Buffer.from(decoded.slice(decoded.indexOf(":") + 1));
  const want = Buffer.from(password);
  return given.length === want.length && timingSafeEqual(given, want);
}

createServer(async (req, res) => {
  try {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (!authorized(req)) {
      res
        .writeHead(401, { "www-authenticate": 'Basic realm="Bonded ops", charset="UTF-8"' })
        .end("Sign in");
      return;
    }
    if (req.url === "/api/status") {
      const body = JSON.stringify(await runChecks());
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body);
      return;
    }
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(await readFile(page));
      return;
    }
    res.writeHead(404).end("Not found");
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain" }).end(String(error));
  }
}).listen(port, host, () => {
  console.log(`Bonded ops dashboard: http://${loopback ? "127.0.0.1" : host}:${port}`);
});

// Alerts: only when Telegram is configured (the hosted service), every OPS_ALERT_MS.
if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
  const every = Math.max(60_000, Number(env.OPS_ALERT_MS || 5 * 60 * 1000));
  const state = new Map();
  const link = env.OPS_PUBLIC_URL ? `\n${env.OPS_PUBLIC_URL}` : "";
  const round = async () => {
    try {
      const { results } = await runChecks();
      const messages = alertsFor(results, state);
      if (messages.length) await sendTelegram(`Bonded ops\n${messages.join("\n")}${link}`);
    } catch {
      console.warn("ops: a round of checks failed");
    }
  };
  round();
  setInterval(round, every);
}
