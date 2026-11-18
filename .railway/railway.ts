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
      // Sleeps after 5 to 10 minutes without traffic, and isn't billed while asleep: awake all
      // month, its 2 GB was about $20 of the project's $25 to $30. A request on the private
      // network wakes it in about 15 s; the API and the worker wait for that (wake in
      // apps/api/src/sentinel.ts), and a Sentinel-on rating keeps it awake to the end.
      sleepApplication: true,
    },
    // No networking block: its private address comes from the service name. Railway keeps a
    // privateNetworkEndpoint only for databases, so setting one here showed as a change in
    // every plan.
    replicas: { sfo: 1 },
    env: {
      PORT: "8000",
      LAYA_THREADS: "2",
      // Nothing outbound while idle, so it can sleep (any outbound traffic keeps it awake).
      HF_HUB_DISABLE_TELEMETRY: "1",
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
  // What hosted agents ("Bonded runs it") may spend on the model key in a day, in all: $5 while
  // the OpenRouter balance is small (the code's default is 10). The API refuses a test past it and
  // the worker stops one, so both read it.
  const hostedSpend = { HOSTED_DAILY_USD: "5" };
  // Notification email through Resend (docs/DEVELOPING.md): set by the founder in Railway on all
  // three services, kept here so an apply never deletes them and turns email off.
  const email = { RESEND_API_KEY: preserve(), EMAIL_FROM: preserve() };

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
      // Encrypts webhook secrets at rest: 32 bytes set by the founder in Railway (openssl rand
      // -hex 32). The arena-worker reads the same.
      AGENT_URL_SECRET_KEY: preserve(),
      // Signs every call to an agent's URL (Ed25519; docs/AGENT-URL-SIGNED-CALLS.md), and the API
      // publishes its public key. Made by the founder with `pnpm --filter @bonded/api
      // agent-url-key` and set in Railway. The arena-worker's gateway signs with the same key.
      AGENT_URL_SIGNING_KEY: preserve(),
      // Signs the payment gate's check receipts (apps/api/GATE.md): a new 32-byte key set by the
      // founder in Railway, never the attester's. Without it, checks are refused.
      GATE_RECEIPT_PRIVATE_KEY: preserve(),
      // "true" lets the payment gate's card hooks answer Stripe live-mode charges; otherwise they
      // are declined (apps/api/src/gate-card-hook.ts). Set by the founder in Railway, kept here.
      GATE_ALLOW_LIVE_CHARGES: preserve(),
      ...email,
      ...previews,
      ...hostedSpend,
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
      // Posts the payment gate's daily log roots to GateAnchor (gateAnchor in the deployment
      // file; apps/api/GATE.md). Its own key, not KEEPER_KEY, so the two never race for a nonce;
      // GateAnchor's owner allows its address with setPoster. Set by the founder in Railway.
      GATE_ANCHOR_KEY: preserve(),
      ...email,
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
      // Decrypts webhook secrets for notifications.
      AGENT_URL_SECRET_KEY: api.env.AGENT_URL_SECRET_KEY,
      // Signs calls to agents' URLs: the same key the API publishes.
      AGENT_URL_SIGNING_KEY: api.env.AGENT_URL_SIGNING_KEY,
      ...email,
      ...previews,
      ...hostedSpend,
      // Telegram alerts for its own crashes and failing loops (docs/SERVICES.md, "Alerts"): the
      // same bot and chat as the API, set by the founder, kept here.
      TELEGRAM_BOT_TOKEN: preserve(),
      TELEGRAM_CHAT_ID: preserve(),
      // Model calls for hosted agents ("Bonded runs it", docs/HOSTED-AGENTS.md) and for drafting
      // each rating's held-out attacks. Set by the founder in Railway, kept here.
      OPENROUTER_API_KEY: preserve(),
    },
  });

  // The ops dashboard (apps/ops): what Bonded pays for or depends on, viewable from any device
  // behind a password, and Telegram alerts when something goes low or down. It watches wallets
  // by address only (no keys) and reads the OpenRouter balance with the worker's key.
  const OPS_DOMAIN = "bonded-ops-production.up.railway.app";
  const ops = service("ops", {
    source: github("ddboy19912/bonded", {
      branch: "main",
      checkSuites: false,
      rootDirectory: "apps/ops",
    }),
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile", watchPatterns: ["apps/ops/**"] },
    deploy: { healthcheckPath: "/health", healthcheckTimeout: 60 },
    networking: { serviceDomains: { [OPS_DOMAIN]: { port: 8080 } } },
    replicas: { sfo: 1 },
    env: {
      OPS_HOST: "0.0.0.0",
      OPS_PORT: "8080",
      OPS_PUBLIC_URL: `https://${OPS_DOMAIN}`,
      // Set by the founder in Railway: 12 characters or more. The service won't start without it.
      OPS_PASSWORD: preserve(),
      // Public addresses of the wallets Railway's services sign with (keeper, attester and the
      // gate's poster): balances only, no keys.
      OPS_WATCH_ADDRESSES:
        "Keeper=0x4B9e61d0c590d1e279D67eeE33Dd07e2Ad4C7632,Attester=0x6eB99ec2A4b5b7379E07a53352B41D132BE5443b,Gate anchor=0xdD42a11738529B7B4b6c7F75D2Edc7a01cE64416",
      RPC_URL: shared.RPC_URL,
      OPENROUTER_API_KEY: arenaWorker.env.OPENROUTER_API_KEY,
      TELEGRAM_BOT_TOKEN: api.env.TELEGRAM_BOT_TOKEN,
      TELEGRAM_CHAT_ID: api.env.TELEGRAM_CHAT_ID,
    },
  });

  return project("zippy-spirit", {
    resources: [Postgres, postgresVolume, api, keeper, arenaWorker, sentinel, ops],
  });
});
