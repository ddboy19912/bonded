import { defineRailway, github, postgres, preserve, project, service, volume } from "railway/iac";

// Bonded's Railway project. One Docker image runs as three services; ROLE selects what each does.
// See docs/DEVELOPING.md ("Deploying"). Signing keys and the API token are secrets set in Railway, never here:
// preserve() keeps the value already stored on Railway.
export default defineRailway(() => {
  const repo = github("ddboy19912/bonded", { branch: "main", checkSuites: false });

  const Postgres = postgres("Postgres", { region: "sfo" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const postgresVolume = volume("postgres-volume", {
    alerts: { usage: { "80": {}, "95": {}, "100": {} } },
    allowOnlineResize: true,
    region: "sfo",
    sizeMB: 5000,
  });

  const shared = {
    DATABASE_URL: Postgres.env.DATABASE_URL,
    RPC_URL: "https://rpc.testnet.chain.robinhood.com/rpc",
    DEPLOYMENT_FILE: "contracts/evm/deployments/46630.json",
    // Complete set of agents the worker may rate; see docs/AGENTS.md.
    AGENTS_FILE: "config/agents.46630.json",
  };
  const role = (deploy: { healthcheckPath?: string; healthcheckTimeout?: number }) => ({
    source: repo,
    build: { builder: "DOCKERFILE" as const, dockerfilePath: "Dockerfile" },
    deploy: {
      // Restart on failure (10 retries) and sleeping off are Railway's defaults; Railway stores
      // defaults as null, so spelling them out here makes every plan show a false change.
      startCommand: "node apps/api/dist/main.js",
      ...deploy,
    },
    replicas: { sfo: 1 },
  });

  // Sentinel (services/sentinel, docs/SENTINEL.md): Laya's server in its own Python image,
  // reachable only on the private network at http://sentinel.railway.internal:8000. Railway has
  // no GPUs, so it runs on CPU at about 2.5 s a check. The model downloads on start, hence the
  // long health check. HF_TOKEN is a read-only Hugging Face token for the private model repo;
  // LAYA_API_KEY is the bearer key callers send. Both are set in Railway, never here.
  const sentinel = service("sentinel", {
    source: github("ddboy19912/bonded", {
      branch: "main",
      checkSuites: false,
      rootDirectory: "services/sentinel",
    }),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile",
      watchPatterns: ["services/sentinel/**"],
    },
    deploy: {
      healthcheckPath: "/health",
      healthcheckTimeout: 600,
      // The container uses a little over 2 GB after loading and more while checking; Railway
      // bills memory used, not this cap.
      limitOverride: { containers: { cpu: 2, memoryBytes: 4 * 1024 ** 3 } },
    },
    // No networking block: its private address comes from the service name. Railway keeps a
    // privateNetworkEndpoint only for databases, so setting one here showed as a change in
    // every plan.
    replicas: { sfo: 1 },
    env: {
      PORT: "8000",
      LAYA_THREADS: "2",
      SENTINEL_MODEL_REPO: "ddboy19912/bonded-sentinel-laya",
      // Fine-tune v5, two questions: callers must ask the v3 question set (manipulated,
      // injection_in_inputs). Promoted with one recorded exception to gate 2
      // (docs/SENTINEL-STRESS.md, "v5 gate results"). v1, the rollback, is
      // 22d2ad765058158a1a3c7472ac551690a05fe1e6 with the v1 question set.
      SENTINEL_MODEL_REVISION: "f8d305790ca9e6811e91da88d6c00c862554b0f9",
      HF_TOKEN: preserve(),
      LAYA_API_KEY: preserve(),
    },
  });

  // The API (Sentinel checks for agents) and the worker (ratings with Sentinel on) call Sentinel
  // on the private network, with the key it checks.
  const sentinelClient = {
    SENTINEL_URL: "http://sentinel.railway.internal:8000",
    LAYA_API_KEY: sentinel.env.LAYA_API_KEY,
    // The checkpoint it serves, so a rating's report names it.
    SENTINEL_MODEL_REPO: sentinel.env.SENTINEL_MODEL_REPO,
    SENTINEL_MODEL_REVISION: sentinel.env.SENTINEL_MODEL_REVISION,
  };

  // The Arena Gateway (bring your own agent, docs/BRING-YOUR-OWN-AGENT.md) runs in the
  // arena-worker: runners connect to it over a WebSocket and agents reach their episodes over
  // MCP and HTTP, so it needs a public domain. The API shows the URL in the runner command.
  // Railway's own domain for the service: the earlier custom "bonded-arena-gateway" name was
  // never attached by config apply, so the generated one is used, routed to GATEWAY_PORT.
  const GATEWAY_DOMAIN = "arena-worker-production.up.railway.app";
  const GATEWAY_PORT = "8080";
  const gateway = { GATEWAY_PUBLIC_URL: `https://${GATEWAY_DOMAIN}` };
  // Preview ratings are free to the user and paid for in compute, so they are tightly capped
  // (spelled out so a plan shows them). The API and the worker read the same. 3 a wallet while
  // builders test with us, so "fix it and rate again" works the same day; the code's default is 1.
  const previews = { PREVIEW_PER_WALLET_DAILY: "3", PREVIEW_DAILY: "20" };

  const api = service("api", {
    ...role({ healthcheckPath: "/health", healthcheckTimeout: 120 }),
    env: {
      ...shared,
      ROLE: "api",
      // Browser origins allowed by CORS (comma-separated): the hosted web app (bondedhq.xyz, and its old Vercel address), its
      // preview deployments (one `*`, see apps/api/src/origins.ts), and local dev.
      WEB_ORIGINS:
        "https://www.bondedhq.xyz,https://bondedhq.xyz,https://bonded-nu.vercel.app,https://bonded-*-ddboy19912s-projects.vercel.app,http://localhost:5173",
      ...sentinelClient,
      ...gateway,
      API_TOKEN: preserve(),
      ATTESTER_KEY: preserve(),
      // Encrypts Agent URL and webhook secrets at rest (bring your own agent, round 2): 32 bytes
      // set by the founder in Railway (openssl rand -hex 32). The arena-worker reads the same.
      AGENT_URL_SECRET_KEY: preserve(),
      ...previews,
      // Telegram alerts (docs/PLAN.md, Day 13 workstream 6): set by the founder, kept here.
      TELEGRAM_BOT_TOKEN: preserve(),
      TELEGRAM_CHAT_ID: preserve(),
    },
  });
  // The keeper has no HTTP listener, so no health check; the worker's only listener is the
  // gateway, which has its own checks.
  const keeper = service("keeper", {
    ...role({}),
    env: {
      ...shared,
      ROLE: "keeper",
      KEEPER_KEY: preserve(),
      TELEGRAM_BOT_TOKEN: preserve(),
      TELEGRAM_CHAT_ID: preserve(),
    },
  });
  const arenaWorker = service("arena-worker", {
    ...role({}),
    networking: { serviceDomains: { [GATEWAY_DOMAIN]: { port: Number(GATEWAY_PORT) } } },
    env: {
      ...shared,
      ...sentinelClient,
      ...gateway,
      GATEWAY_PORT,
      // Railway's edge proxy is the one hop in front of the gateway.
      GATEWAY_TRUST_PROXY: "1",
      ROLE: "arena-worker",
      ATTESTER_KEY: preserve(),
      // Decrypts Agent URL secrets to sign calls to agents, and webhook secrets for notifications.
      AGENT_URL_SECRET_KEY: api.env.AGENT_URL_SECRET_KEY,
      ...previews,
    },
  });

  return project("zippy-spirit", {
    resources: [Postgres, postgresVolume, api, keeper, arenaWorker, sentinel],
  });
});
