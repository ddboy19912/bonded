// `node apps/api/scripts/demo-hosted.mjs` (after `pnpm build`): Test your agent on this machine,
// for trying "Bonded runs it" (docs/HOSTED-AGENTS.md) end to end without the full demo story.
// It starts a local chain with the contracts, a throwaway Postgres, the API, an Arena Gateway, the
// connection-check and preview workers, and the web app at http://localhost:5180.
//
// A hosted agent's model calls go through Bonded's key: set OPENROUTER_API_KEY (or LLM_API_KEY
// with LLM_BASE_URL) in the shell first. Everything else is local and disappears on Ctrl-C.
import process from "node:process";
import console from "node:console";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import EmbeddedPostgres from "embedded-postgres";
import { serve } from "@hono/node-server";
import { ANVIL_KEYS, Sandbox } from "@bonded/arena";
import { Database } from "@bonded/db";
import { connectChain } from "@bonded/keeper";
import { createApi } from "../dist/index.js";
import { startGateway, DEFAULT_REMOTE_POLICY } from "./demo-byo.mjs";

const API_PORT = 3000;
const WEB_PORT = 5180;
if (!process.env.OPENROUTER_API_KEY && !process.env.LLM_API_KEY)
  console.warn("No OPENROUTER_API_KEY or LLM_API_KEY: hosted agents can't call their model.");

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });

let stopping = false;
const stops = [];
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const fn of stops.reverse()) {
    try {
      await fn();
    } catch {
      // Keep stopping the rest.
    }
  }
  process.exit(code);
}
process.once("SIGINT", () => void stop(0));
process.once("SIGTERM", () => void stop(0));

try {
  console.log("Starting a local chain and deploying the contracts");
  const sandbox = await Sandbox.start();
  stops.push(() => sandbox.stop());
  const d = sandbox.deployment;
  const chain = connectChain(d, sandbox.rpcUrl, ANVIL_KEYS.deployer);

  console.log("Starting Postgres, the API, the gateway and the workers");
  const directory = await mkdtemp(join(tmpdir(), "bonded-hosted-"));
  stops.push(() => rm(directory, { recursive: true, force: true }));
  const pgPort = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir: join(directory, "db"),
    user: "postgres",
    password: "demo",
    port: pgPort,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();
  stops.push(() => pg.stop());
  const db = new Database(`postgres://postgres:demo@127.0.0.1:${pgPort}/postgres`);
  await db.migrate();
  stops.push(() => db.close());

  const started = await startGateway(db, d.chainId);
  stops.push(() => started.gateway.close());
  const webOrigin = `http://localhost:${WEB_PORT}`;
  const app = createApi({
    db,
    chain,
    attesterKey: ANVIL_KEYS.deployer,
    apiToken: "local-demo-token-not-a-secret-000000",
    webOrigins: [webOrigin],
    ...started.api,
    gatewayUrl: started.url,
    selfServe: { remote: { ...DEFAULT_REMOTE_POLICY, previewPerWalletDaily: 20 } },
  });
  // This machine only: the demo's API has a fixed operator token.
  const server = serve({ fetch: app.fetch, port: API_PORT, hostname: "127.0.0.1" });
  stops.push(() => new Promise((resolve) => server.close(() => resolve())));
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  server.on("error", (error) => {
    console.error(error);
    void stop(1);
  });
  stops.push(() => app.close?.());

  // Checks and previews asked for in the web app, one at a time, as on the hosted service.
  void (async () => {
    while (!stopping) {
      await started.workExtras(chain, sandbox.rpcUrl).catch((e) => console.error(e));
      await delay(1000);
    }
  })();

  const web = spawn(
    "pnpm",
    ["--filter", "@bonded/web", "exec", "vite", "--port", String(WEB_PORT), "--strictPort"],
    {
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
      env: {
        ...process.env,
        VITE_DEPLOYMENT_JSON: JSON.stringify(d),
        VITE_RPC_URL: sandbox.rpcUrl,
        VITE_API_URL: `http://localhost:${API_PORT}`,
      },
    },
  );
  stops.push(() => web.pid && process.kill(-web.pid, "SIGTERM"));
  console.log(`\nTest your agent: ${webOrigin}/agents/test   (API on ${API_PORT}; Ctrl-C stops)`);
} catch (error) {
  console.error(error);
  await stop(1);
}
