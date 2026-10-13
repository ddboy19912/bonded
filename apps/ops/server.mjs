// Local-only ops dashboard. Run from the repo root with `pnpm ops`, then open the printed URL.
// Binds to 127.0.0.1 so the keys in .env never leave this machine.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { runChecks } from "./checks.mjs";

const port = Number(process.env.OPS_PORT || 4545);
const page = new URL("./index.html", import.meta.url);

createServer(async (req, res) => {
  try {
    if (req.url === "/api/status") {
      const body = JSON.stringify(await runChecks());
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body);
      return;
    }
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(await readFile(page));
      return;
    }
    res.writeHead(404).end("Not found");
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain" }).end(String(error));
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Bonded ops dashboard: http://127.0.0.1:${port}`);
});
