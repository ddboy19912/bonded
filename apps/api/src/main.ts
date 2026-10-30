import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { ArenaGateway, assertHeldOutOffMetaApi, loadDotEnv } from "@bonded/arena";
import { Database } from "@bonded/db";
import { Keeper, SolanaKeeper, connectChain, connectSolana, parseSolanaKey } from "@bonded/keeper";
import { parseEvmDeployment } from "@bondedhq/shared";
import { z } from "zod";
import { createApi } from "./index.js";
import { runTeeChecks, teeCheckInterval } from "./tee-watch.js";
import { agentConfig, workOne } from "./worker.js";
import { remotePolicyFromEnv, remoteQuota } from "./remote-policy.js";
import { remoteRatingProblem } from "./eligibility.js";
import { sentinelFromEnv } from "./sentinel.js";
import { workBountyOne } from "./bounty-worker.js";
import { Alerter, LoopHealth, Watchdog, describeFailure, telegramFromEnv } from "./alerts.js";
import { renewExpiringScores } from "./live-loop.js";
import {
  bondedRegistryAbi,
  chatClientFromEnv,
  isMetaModel,
  UNDERWRITING_COVER_CAP_USD,
} from "@bondedhq/shared";
import { REMOTE_EPISODE_TIMEOUT_MS, gatewayAgents } from "./remote-agent.js";
import { DbRunnerAuth, RunnerPresenceWriter } from "./runners.js";
import { secretBoxFromEnv } from "./secrets.js";
import { Notifier, emailFromEnv } from "./notifications.js";
import { workPreviewOne } from "./preview-worker.js";
import { workCheckOne } from "./check-worker.js";
import { gatewayCheckRunner } from "./connections.js";
import { AgentStatusReader } from "./agent-status.js";
import { OwnerAlerts } from "./owner-alerts.js";
import { adoptDeployment } from "./deployment-guard.js";

loadDotEnv();
const role = process.env.ROLE ?? "api";
// Operations alerts (docs/SERVICES.md "Alerts"); a no-op unless the Telegram secrets are set.
const alerter = new Alerter(telegramFromEnv(), { source: role });
/** Any error that would end the process: alert (bounded by a timeout), then exit for a restart. */
let crashing = false;
const crash = async (error: unknown) => {
  if (crashing) return;
  crashing = true;
  const kind = error instanceof Error ? error.name : "unknown error";
  console.error("service crashed:", kind);
  await Promise.race([
    alerter.alert("crash", `Crashed (${kind}). Railway restarts it up to 10 times.`),
    delay(5000),
  ]);
  process.exit(1);
};
process.on("uncaughtException", (error) => void crash(error));
/** Read a required variable without including its value in errors. */
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
/** Validate only the signing key required by the selected role. */
const key = (name: string) =>
  z
    .templateLiteral(["0x", z.string()])
    .refine((v) => /^0x[0-9a-fA-F]{64}$/.test(v))
    .parse(required(name));
/** A cover cap in whole tUSDG from the environment, or its default. */
const usdCap = (name: string, fallback: number) =>
  z.coerce
    .number()
    .int()
    .min(0)
    .parse(process.env[name] ?? fallback);
/**
 * The gateway's public URL: GATEWAY_PUBLIC_URL, a full URL or a bare host (Railway's
 * RAILWAY_PUBLIC_DOMAIN of the arena-worker), which is taken as https.
 */
const gatewayUrl = () => {
  const value = process.env.GATEWAY_PUBLIC_URL?.trim();
  if (!value) return undefined;
  return z
    .url({ protocol: /^https?$/ })
    .parse(/^https?:\/\//.test(value) ? value : `https://${value}`);
};
/** Sizes, caps and budgets for operator-run agents' ratings: the one configured policy. */
const remotePolicy = remotePolicyFromEnv();
// Agent URL and webhook secrets are stored encrypted with AGENT_URL_SECRET_KEY; without it, Agent
// URL mode and webhooks are refused (a malformed key stops the service here).
const secrets = secretBoxFromEnv();
// Notification email, only when RESEND_API_KEY and EMAIL_FROM are both set.
const email = emailFromEnv();
/**
 * Hosts an Agent URL or webhook may never be (beyond BONDED_OWN_HOSTS in @bonded/arena): any in
 * BONDED_OWN_HOSTS (comma-separated), this service's own Railway domain, and the web origins.
 */
const ownHosts = [
  ...(process.env.BONDED_OWN_HOSTS ?? "").split(","),
  process.env.RAILWAY_PUBLIC_DOMAIN ?? "",
  (process.env.GATEWAY_PUBLIC_URL ?? "").replace(/^https?:\/\//, "").split("/")[0] ?? "",
  ...(process.env.WEB_ORIGINS ?? "").split(",").map(
    (origin) =>
      origin
        .trim()
        .replace(/^https?:\/\//, "")
        .replace(/^\*\./, "")
        .split("/")[0] ?? "",
  ),
]
  .map((d) => d.trim().toLowerCase())
  .filter((d) => d && !d.includes("*") && !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(d));
/**
 * Plain-http, loopback Agent URLs and webhooks: a local demo only (AGENT_URL_ALLOW_LOOPBACK=1),
 * never hosted.
 */
const allowLoopback = process.env.AGENT_URL_ALLOW_LOOPBACK === "1";
const db = new Database(required("DATABASE_URL"));
await db.migrate();
if (role === "migrate") {
  await db.close();
} else {
  if (!["api", "keeper", "arena-worker", "all"].includes(role)) throw new Error("invalid ROLE");
  const deployment = parseEvmDeployment(await readFile(required("DEPLOYMENT_FILE"), "utf8"));
  const rpc = required("RPC_URL");
  const keeperKey = role === "keeper" || role === "all" ? key("KEEPER_KEY") : key("ATTESTER_KEY");
  const chain = connectChain(deployment, rpc, keeperKey);
  if ((await chain.read.getChainId()) !== deployment.chainId) throw new Error("RPC chain mismatch");
  await adoptDeployment(db, deployment, role, process.env.ADOPT_DEPLOYMENT);
  if (process.env.AGENTS_FILE) {
    const configs = z
      .array(agentConfig)
      .parse(JSON.parse(await readFile(process.env.AGENTS_FILE, "utf8")));
    // Validate the entire file before changing the currently enabled set.
    if (configs.some((config) => config.mandate.chain.chainId !== deployment.chainId))
      throw new Error("agent chain mismatch");
    if (new Set(configs.map((config) => config.mandate.agentId)).size !== configs.length)
      throw new Error("duplicate configured agent");
    await db.reconcileAgents(
      deployment.chainId,
      configs.map((config) => ({ agentId: config.mandate.agentId, config })),
    );
  }

  const abort = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => abort.abort());
  const tasks: Promise<void>[] = [];
  /** Retry a role iteration until shutdown; an aborted delay exits promptly. */
  const loop = async (name: string, fn: () => Promise<unknown>, ms: number) => {
    const health = new LoopHealth(alerter, name);
    while (!abort.signal.aborted) {
      try {
        await fn();
        await health.succeeded();
      } catch (error) {
        console.error(`${name} iteration failed; retrying (${describeFailure(error)})`);
        await health.failed(error);
      }
      await delay(ms, undefined, { signal: abort.signal }).catch(() => {});
    }
  };
  // Production Sentinel (SENTINEL_URL and LAYA_API_KEY), for checks and Sentinel-on ratings.
  const sentinel = sentinelFromEnv();
  let server: ReturnType<typeof serve> | undefined;
  let gateway: ArenaGateway | undefined;
  let api: ReturnType<typeof createApi> | undefined;
  if (role === "api" || role === "all") {
    api = createApi({
      db,
      chain,
      attesterKey: key("ATTESTER_KEY"),
      apiToken: required("API_TOKEN"),
      webOrigins: (process.env.WEB_ORIGINS ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
      // Sentinel checks for agents, when SENTINEL_URL is set (docs/SENTINEL.md).
      ...(sentinel ? { sentinel } : {}),
      // The Arena Gateway's public URL (the arena-worker's domain), for the runner command.
      ...(gatewayUrl() ? { gatewayUrl: gatewayUrl()! } : {}),
      // Underwriting policy for agents their operators run: total cover caps by binding.
      // The same configured policy for operator-run agents as the worker and keeper use.
      selfServe: { remote: remotePolicy },
      coverCaps: {
        declared: usdCap("DECLARED_COVER_CAP_USD", UNDERWRITING_COVER_CAP_USD.declared),
        tee: usdCap("TEE_COVER_CAP_USD", UNDERWRITING_COVER_CAP_USD.tee),
      },
      ...(secrets ? { secrets } : {}),
      ...(email ? { email } : {}),
      // Bonded's own hosts, which an Agent URL or webhook may not point at (the web origins and
      // the gateway are added from their own settings).
      ownDomains: ownHosts,
      ...(allowLoopback ? { allowLoopbackUrls: true } : {}),
      // Shown by GET /status: BONDED_VERSION, else the deploy's commit.
      version:
        process.env.BONDED_VERSION?.trim() ||
        process.env.RAILWAY_GIT_COMMIT_SHA?.trim().slice(0, 12) ||
        null,
    });
    server = serve({
      fetch: api.fetch,
      port: z.coerce
        .number()
        .int()
        .min(1)
        .max(65535)
        .parse(process.env.PORT ?? 3000),
    });
  }
  if (role === "keeper" || role === "all") {
    const confirmations = z.coerce
      .number()
      .int()
      .min(0)
      .parse(process.env.KEEPER_CONFIRMATIONS ?? 5);
    // Premium accrual sends one transaction per active policy, so it runs hourly by default.
    const accrueEvery = z.coerce
      .number()
      .int()
      .min(5000)
      .parse(process.env.KEEPER_ACCRUE_MS ?? 3_600_000);
    const keeper = new Keeper(db, chain, BigInt(confirmations), accrueEvery);
    tasks.push(loop("The EVM keeper", () => keeper.tick(), 5000));
    // Solana claims (ADR-011), only when a Solana RPC and a fee-paying key are configured.
    const solanaRpc = process.env.SOLANA_RPC_URL;
    const solanaKey = process.env.SOLANA_KEEPER_KEY;
    if (solanaRpc && solanaKey) {
      const solana = new SolanaKeeper(db, connectSolana(solanaRpc, parseSolanaKey(solanaKey)));
      tasks.push(loop("The Solana keeper", () => solana.tick(), 15_000));
    }
    // Re-check TEE-hosted agents against their rated measurement. A stopped VM is just "unreachable".
    const teeEvery = teeCheckInterval.parse(process.env.TEE_CHECK_MS ?? 600_000);
    tasks.push(
      loop(
        "TEE checks",
        () =>
          runTeeChecks(db, chain, undefined, {
            quota: remoteQuota(remotePolicy, Date.now()),
            rerateGapMs: remotePolicy.perAgentMs,
          }),
        teeEvery,
      ),
    );
    // The keeper role is always deployed once, so it owns event retention.
    const retentionDays = z.coerce
      .number()
      .int()
      .min(1)
      .parse(process.env.EVENTS_RETENTION_DAYS ?? 30);
    tasks.push(
      loop(
        "Event retention",
        async () => {
          const before = new Date(Date.now() - retentionDays * 86_400_000);
          await db.pruneEvents(before);
          await db.pruneSentinelChecks(before);
          // Used sign-in signatures and long-expired sessions (a day past their window).
          await db.pruneOwnerAuth();
          // The owners' in-app notification lists keep 90 days.
          await db.pruneNotifications(new Date(Date.now() - 90 * 86_400_000));
        },
        3_600_000,
      ),
    );
    // Owners' alerts about their agents (score expiring, runner offline, breaches, claims, cover
    // lapsing, low gas): the keeper is deployed once, so each is sent once.
    const ownerAlerts = new OwnerAlerts(
      db,
      deployment.chainId,
      new Notifier(db, {
        ...(secrets ? { secrets } : {}),
        ...(allowLoopback ? { allowLoopback: true } : {}),
        ...(email ? { email } : {}),
        log: (line) => console.error(line),
      }),
      new AgentStatusReader(db, chain, { ttlMs: 0 }),
    );
    tasks.push(
      loop(
        "Owner alerts",
        () => ownerAlerts.sweep(),
        z.coerce
          .number()
          .int()
          .min(10_000)
          .parse(process.env.OWNER_ALERTS_MS ?? 60_000),
      ),
    );
    // The keeper is deployed once, so it also watches for a lagging keeper, stuck claims and
    // failed ratings or accruals (issue #24).
    if (alerter.enabled) {
      const watchdog = new Watchdog(db, chain, alerter);
      tasks.push(loop("The alert watchdog", () => watchdog.check(), 60_000));
    }
  }
  if (role === "arena-worker" || role === "all") {
    // Separate account/nonce flow from the keeper, even in all mode.
    const worker = connectChain(deployment, rpc, key("ATTESTER_KEY"));
    // The Arena Gateway (bring your own agent, docs/BRING-YOUR-OWN-AGENT.md): runners of agents
    // their operators run connect to it, and their agents reach their episodes through it. It
    // starts when GATEWAY_PORT is set; without it a remote agent's rating fails at once with
    // "gateway not available".
    const gatewayPort = process.env.GATEWAY_PORT
      ? z.coerce.number().int().min(1).max(65535).parse(process.env.GATEWAY_PORT)
      : undefined;
    if (gatewayPort) {
      const presence = new RunnerPresenceWriter(db, (line) => console.error(line));
      const publicUrl = gatewayUrl();
      gateway = new ArenaGateway({
        // A token stops working when the agent changes hands: the registry is checked too.
        tokens: new DbRunnerAuth(db, deployment.chainId, async (agentId) =>
          worker.read.readContract({
            address: deployment.registry,
            abi: bondedRegistryAbi,
            functionName: "agentOwner",
            args: [BigInt(agentId)],
          }),
        ),
        ...(publicUrl ? { publicUrl } : {}),
        onRunnerPresence: presence.onEvent,
        // Agent URL mode: never call Bonded's own hosts.
        agentUrl: { refusedHosts: ownHosts, ...(allowLoopback ? { allowLoopback: true } : {}) },
        // Proxies in front of the gateway whose X-Forwarded-For it trusts for per-address limits:
        // 1 behind Railway's edge, 0 (the socket's address) anywhere else.
        trustProxy: z.coerce
          .number()
          .int()
          .min(0)
          .max(5)
          .parse(process.env.GATEWAY_TRUST_PROXY ?? 0),
        // Agent ids only; never a token or an episode's capability.
        log: (line) => console.info(`gateway: ${line}`),
      });
      await gateway.listen({ port: gatewayPort, host: "0.0.0.0" });
      console.info(`Arena Gateway listening on port ${gatewayPort}`);
    }
    // Held-out variants for remote ratings: drafted by a cheap model when a key is set (it is
    // advisory text; every variant is still checked against the undefended reference agent),
    // otherwise deterministic rewrites.
    const heldOutModel = process.env.HELD_OUT_MODEL ?? "deepseek/deepseek-v4.1-flash";
    // Held-out attacks never go to Meta Model API: refuse to start rather than fail each rating.
    assertHeldOutOffMetaApi([{ role: "HELD_OUT_MODEL", model: heldOutModel }]);
    const llmKey = isMetaModel(heldOutModel)
      ? process.env.MODEL_API_KEY
      : (process.env.LLM_API_KEY ?? process.env.OPENROUTER_API_KEY);
    const heldOut = {
      perClass: remotePolicy.heldOutPerClass,
      ...(llmKey
        ? {
            llm: {
              client: chatClientFromEnv(),
              model: heldOutModel,
              maxUsd: z.coerce
                .number()
                .min(0)
                .parse(process.env.HELD_OUT_MAX_USD ?? 0.25),
            },
          }
        : {}),
    };
    const ms = (name: string, fallback: number) =>
      z.coerce
        .number()
        .int()
        .min(1000)
        .parse(process.env[name] ?? fallback);
    // Owners hear when a rating of their agent or a preview ends; never blocking the rating.
    const notifier = new Notifier(db, {
      ...(secrets ? { secrets } : {}),
      ...(allowLoopback ? { allowLoopback: true } : {}),
      ...(email ? { email } : {}),
      log: (line) => console.error(line),
    });
    // Connection checks: a lane of their own. Without a gateway able to run them, each check
    // fails at once with a plain reason instead of waiting.
    tasks.push(
      loop(
        "Connection checks",
        () =>
          workCheckOne(db, deployment.chainId, {
            runCheck: gateway ? gatewayCheckRunner(gateway) : undefined,
            secrets,
            log: (line) => console.error(line),
          }),
        1000,
      ),
    );
    if (gateway) {
      // Two lanes, each with its own lock: Bonded's own ratings never wait behind an operator's
      // agent, and remote ratings take turns by owner.
      const remote = gatewayAgents(gateway, {
        episodeTimeoutMs: ms("REMOTE_EPISODE_TIMEOUT_MS", REMOTE_EPISODE_TIMEOUT_MS),
      });
      const ownerOf = (agentId: string) =>
        worker.read.readContract({
          address: deployment.registry,
          abi: bondedRegistryAbi,
          functionName: "agentOwner",
          args: [BigInt(agentId)],
        });
      tasks.push(
        loop(
          "The rating worker",
          () =>
            workOne(db, worker, rpc, key("ATTESTER_KEY"), undefined, sentinel, {
              lane: "builtin",
            }),
          1000,
        ),
        loop(
          "The remote rating worker",
          () =>
            (async () =>
              // Previews only when no official remote rating is waiting, in the same lane.
              (await workOne(db, worker, rpc, key("ATTESTER_KEY"), undefined, sentinel, {
                lane: "remote",
                remote,
                heldOut,
                remotePolicy,
                ownerOf,
                ...(secrets ? { secrets } : {}),
                notifier,
              })) ||
              (await workPreviewOne(db, worker, rpc, {
                remote,
                heldOut,
                policy: remotePolicy,
                ...(secrets ? { secrets } : {}),
                notifier,
              })))(),
          1000,
        ),
      );
    } else
      tasks.push(
        loop(
          "The rating worker",
          async () =>
            (await workOne(db, worker, rpc, key("ATTESTER_KEY"), undefined, sentinel, {
              heldOut,
              notifier,
            })) ||
            // Without a gateway a preview can't run: it fails at once, saying why.
            (await workPreviewOne(db, worker, rpc, { heldOut, policy: remotePolicy, notifier })),
          1000,
        ),
      );
    // Renew bring-your-own agents' scores before they lapse, while their runners are connected.
    tasks.push(
      loop(
        "Score renewals",
        () =>
          renewExpiringScores(db, deployment.chainId, undefined, {
            quota: remoteQuota(remotePolicy, Date.now()),
            problem: async (agentKey) => {
              const record = await db.agentRecord(agentKey);
              return remoteRatingProblem(worker, agentKey.split(":")[1]!, record?.owner ?? null);
            },
          }),
        z.coerce
          .number()
          .int()
          .min(60_000)
          .parse(process.env.RENEW_CHECK_MS ?? 600_000),
      ),
    );
    // Error names only: messages can carry the RPC URL and its key.
    const bountyError = (e: unknown) =>
      console.error("bounty validation failed:", e instanceof Error ? e.name : "unknown error");
    tasks.push(loop("The bounty worker", () => workBountyOne(db, worker, rpc, bountyError), 5000));
  }
  console.info(`Bonded service ready: ${role}`);
  // Also the per-service test alert: each deploy or restart announces itself once.
  void alerter.alert("started", `Started on chain ${deployment.chainId}.`);
  if (!abort.signal.aborted)
    await new Promise<void>((resolve) =>
      abort.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  const httpClosed = new Promise<void>((resolve, reject) => {
    if (!server) return resolve();
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await api?.close();
  await gateway?.close();
  // Streams have released their listeners; reap sockets that became idle during that drain.
  if (server && "closeIdleConnections" in server) server.closeIdleConnections();
  await Promise.all([...tasks, httpClosed]);
  await db.close();
}
