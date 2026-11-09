import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
export * from "./schema.js";
export * from "./gate.js";
export * from "./gate-watch.js";
export * from "./gate-budget.js";
export * from "./gate-card-hook.js";
export * from "./data-api.js";
export type Connection = pg.PoolClient;
/** Serialize public payloads without losing integer precision. */
export const json = (value: unknown): string =>
  JSON.stringify(value, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

/** One agent's TEE row (migration 0004). */
export interface TeeCheckRow {
  status: string;
  detail: string | null;
  measurement: string | null;
  ratedMeasurement: string | null;
  ratedReportHash: string | null;
  evmAddress: string | null;
  blockingStatus: string | null;
  checkedAt: Date;
  verifiedAt: Date | null;
}

/** A bounty under validation, leased by one worker (migration 0006). */
export interface BountyJob {
  chainId: number;
  submissionId: string;
  token: string;
  hunter: string;
  attempts: number;
  broadcastPending: boolean;
  pendingTxHash: string | null;
  /** The nonce the pending send was given before broadcast (migration 0008). */
  pendingNonce: number | null;
  spec: unknown;
  /** The verdict an earlier attempt recorded before sending its transaction, if any. */
  verdict: unknown;
}

/** A bounty as the public sees it: no payload, which stays private (docs/disclosures). */
export interface BountySummary {
  submissionId: string;
  hunter: string;
  specUri: string;
  attackId: string;
  attackClass: string;
  title: string;
  surfaces: string[];
  status: string;
  reward: string | null;
  reason: string | null;
  txHash: string | null;
  createdAt: Date;
}

/** One Arena episode from the live events table (topic `rating.episode`). */
export interface EpisodeSummary {
  eventId: string;
  runId: string;
  index: number;
  total: number;
  attackId: string | null;
  attackClass: string | null;
  breached: boolean;
  lossUsd: number;
  frozen: boolean;
  /** The rated agent's on-chain id, when the run is in this database's ratings. */
  agentId: string | null;
  /**
   * Why the vault ruled as it did (`Ruling` in @bonded/arena): breach, vault_blocked,
   * guard_blocked, ignored, unseen, no_verdict or control. Null for episodes published before
   * rulings were recorded.
   */
  ruling: string | null;
  /** When the episode started (ISO 8601); for older episodes, when it was published. */
  at: string | null;
}

/** One episode with its detail (`EpisodeDetail` in @bonded/arena), for the episode page. */
export interface EpisodeRecord extends EpisodeSummary {
  agent: string | null;
  durationMs: number | null;
  /** Null for episodes published before the detail was recorded. */
  detail: unknown;
}

/** An episode event's row as the lists show it. */
/** The parts of a rating.episode payload the lists read (published by the rating worker). */
interface EpisodePayload {
  runId: string;
  index: number;
  total?: number;
  episode?: {
    attackId?: string | null;
    attackClass?: string | null;
    ruling?: unknown;
    startedAt?: unknown;
    verdict?: { breached?: boolean; totalLossUsd?: number; frozen?: boolean };
  };
}

function episodeSummary(row: {
  id: unknown;
  payload: EpisodePayload;
  created_at?: Date;
  onchain: string | null;
}): EpisodeSummary {
  const p = row.payload;
  return {
    eventId: String(row.id),
    runId: String(p.runId),
    index: Number(p.index),
    total: Number(p.total ?? 0),
    attackId: p.episode?.attackId ?? null,
    attackClass: p.episode?.attackClass ?? null,
    breached: p.episode?.verdict?.breached === true,
    lossUsd: Number(p.episode?.verdict?.totalLossUsd ?? 0),
    frozen: p.episode?.verdict?.frozen === true,
    agentId: row.onchain ?? null,
    ruling: typeof p.episode?.ruling === "string" ? p.episode.ruling : null,
    // When the episode started; older episodes didn't record it, so when it was published.
    at:
      typeof p.episode?.startedAt === "string"
        ? p.episode.startedAt
        : (row.created_at?.toISOString() ?? null),
  };
}

/** How an episode went: a control has no attack; otherwise the vault held or recorded a breach. */
export type EpisodeOutcome = "held" | "breach" | "control";

/** One numbered page of a list: `page` is 1-based, `pages` is at least 1. */
export interface Page<T> {
  items: T[];
  page: number;
  pages: number;
  total: number;
}

/** Page sizes the list endpoints accept. */
export const PAGE_LIMIT = { default: 25, max: 100 } as const;

const clampLimit = (limit?: number) =>
  Math.min(Math.max(Math.trunc(limit ?? PAGE_LIMIT.default), 1), PAGE_LIMIT.max);
/** The page to read: past the last page reads the last page, so a shrinking list never shows nothing. */
const pageOf = (page: number | undefined, total: number, limit: number) => {
  const pages = Math.max(1, Math.ceil(total / limit));
  const p = Math.min(Math.max(Math.trunc(page ?? 1), 1), pages);
  return { page: p, pages, offset: (p - 1) * limit };
};

/** Episode filters. Everything but `outcome` also narrows the outcome counts. */
export interface EpisodeFilters {
  runId?: string;
  /** One attack's episodes, by its id (e.g. "A4-honeypot-otc-004"). */
  attackId?: string;
  /** An on-chain agent id; with `chainId`, its ratings' episodes only. */
  agentId?: string;
  chainId?: number;
  attackClass?: string;
  /** Held-out and bounty attacks (never published), or the public library. */
  source?: "held-out" | "library";
  /**
   * The published library's attack ids (attacks/ in the repository). With them, `source` is
   * decided by the library itself; without, by the id pattern, which misses a bounty attack
   * whose hunter chose an id without "bounty" in it.
   */
  publishedIds?: readonly string[];
  /** Only episodes from the last hour, day or week. */
  since?: "1h" | "24h" | "7d";
  outcome?: EpisodeOutcome;
}
const SINCE: Record<NonNullable<EpisodeFilters["since"]>, string> = {
  "1h": "1 hour",
  "24h": "1 day",
  "7d": "7 days",
};
/** The same reading as the web's: held-out and bounty attacks have ids that say so. */
const PRIVATE_ATTACK = "e.payload->'episode'->>'attackId' ~* '(held-out|bounty)'";

/** One attack's record in the Arena episodes still on record. */
export interface AttackStats {
  episodes: number;
  breaches: number;
  runs: number;
  lastAt: Date | null;
}

/** Episode counts by outcome. */
export type EpisodeCounts = Record<EpisodeOutcome | "total", number>;

// The SQL for each outcome, matching the web's reading: no attack class means a control.
const OUTCOME_SQL: Record<EpisodeOutcome, string> = {
  control: "e.payload->'episode'->>'attackClass' IS NULL",
  breach:
    "e.payload->'episode'->>'attackClass' IS NOT NULL AND (e.payload->'episode'->'verdict'->>'breached')::boolean IS TRUE",
  held: "e.payload->'episode'->>'attackClass' IS NOT NULL AND (e.payload->'episode'->'verdict'->>'breached')::boolean IS NOT TRUE",
};

/**
 * A runner counts as connected while its last heartbeat is this recent: three of the runner's
 * 15-second heartbeats (RUNNER_HEARTBEAT_MS in @bondedhq/shared).
 */
export const RUNNER_FRESH_MS = 45_000;

/** A live runner token, as the gateway's validator needs it (migration 0014). */
export interface RunnerTokenRecord {
  tokenId: string;
  /** The agent's row id, "<chain id>:<agent id>". */
  agentKey: string;
  chainId: number;
  agentId: string;
  config: unknown;
  /** Who made the token: the agent's registry owner when it was made. */
  createdBy: string;
  /** A preview's token: the preview's id (agentKey is "preview:<id>"), its mode and owner. */
  preview?: { id: string; mode: string; owner: string };
}

/** What a runner said when it connected. */
export interface RunnerHello {
  runnerVersion: string;
  mode: string;
  teeUrl?: string | undefined;
  /** The code hash the runner computed for the agent it runs, and where it came from. */
  codeHash?: string | undefined;
  codeSource?: string | undefined;
  codeDetail?: string | undefined;
}

/** An agent's runner token and runner, as the owner's page shows them. */
export interface RunnerStatus {
  /** The live token's id and age; never the token. Null when there is none. */
  token: { id: string; createdAt: Date } | null;
  /** The runner last seen with the live token, if any. */
  runner: {
    connected: boolean;
    connectedAt: Date;
    lastHeartbeatAt: Date;
    disconnectedAt: Date | null;
    runnerVersion: string | null;
    mode: string | null;
    teeUrl: string | null;
    /** The code hash the runner reported, and its source (git, image, unpinned...). */
    codeHash: string | null;
    codeSource: string | null;
  } | null;
  /** The latest rating the live loop skipped, and why. */
  lastSkip: { cause: string; reason: string; at: Date } | null;
}

/**
 * SQL: whether agent `a` has a connected runner on a live token right now, in the mode the agent
 * is registered for (a runner started in another mode can't run its episodes).
 */
const RUNNER_CONNECTED = `EXISTS (SELECT 1 FROM runner_presence p JOIN runner_tokens t ON t.id=p.token_id
  WHERE p.agent_id=a.id AND p.connected AND t.revoked_at IS NULL
    AND t.created_by IS NOT DISTINCT FROM a.owner
    AND p.mode IS NOT DISTINCT FROM a.config->>'mode'
    AND p.last_heartbeat_at > now() - make_interval(secs => ${RUNNER_FRESH_MS / 1000}))`;

/**
 * SQL: whether agent `a` is reached by its Agent URL: registered so, or it has a live Agent URL
 * (registering one switches a runner agent to URL mode; revoking it switches it back).
 */
const URL_CONNECTION = `(a.config->>'connection'='url' OR EXISTS (SELECT 1 FROM agent_urls u0
  WHERE u0.owner_key=a.id AND u0.revoked_at IS NULL))`;
/**
 * SQL: whether agent `a` can be reached for a rating now: its Agent URL is set and verified (Agent
 * URL mode), or its runner is connected.
 */
const CONNECTION_READY = `(CASE WHEN ${URL_CONNECTION}
  THEN EXISTS (SELECT 1 FROM agent_urls u WHERE u.owner_key=a.id AND u.revoked_at IS NULL AND u.verified_at IS NOT NULL)
  ELSE ${RUNNER_CONNECTED} END)`;

/** Which ratings a worker takes (see `takeJob`). */
export type RatingLane = "builtin" | "remote";

/** A rating's progress: episodes published so far, of how many, since when. */
export interface RunProgress {
  done: number;
  total: number | null;
  /** When the worker began (setting up), or the first episode for older ratings. */
  startedAt: Date | null;
  lastAt: Date | null;
  /** When its episodes began, after setting up: what an ETA is measured from. */
  episodesStartedAt: Date | null;
}

/** One rating of an agent, as its history shows it. */
export interface RatingAttempt {
  runId: string;
  status: string;
  /** The system's own reason, when it failed. */
  error: string | null;
  /** It stopped because of the agent (crash, timeout, too slow). */
  agentCaused: boolean;
  /** What the agent or its runner reported: the operator's words, shown as such. */
  agentReport: string | null;
  createdAt: Date;
  /** The score, when the rating finished and was posted. */
  score: number | null;
  /** The code hash it rated, and where that came from ("declared", or the runner's source). */
  codeHash: string | null;
  codeSource: string | null;
}

/** Where an operator-run agent stands after its ratings (migration 0017). */
export interface AgentStanding {
  failuresInRow: number;
  /** Set after an agent-caused stop: the current score no longer stands. */
  superseded: { since: Date; reason: string } | null;
  cooldownUntil: Date | null;
}

/** Limits on remote ratings, all of them counted over the last 24 hours. */
export interface RemoteQuota {
  nowMs: number;
  /** Per owner, across their agents (default 3). */
  perOwnerDaily: number;
  /** Per agent (default 2). */
  perAgentDaily: number;
  /** For the whole remote lane on the chain (default 20). */
  laneDaily: number;
}

/** Why a remote rating can't be queued now. */
export type RemoteRefusal =
  | { refused: "cooldown"; nextAt: Date }
  | { refused: "owner-daily" }
  | { refused: "agent-daily" }
  | { refused: "lane-daily" };

/** Cooldown after `failures` agent-caused stops in a row: 1 h, doubling, at most 48 h. */
export function remoteCooldownMs(failures: number): number {
  return Math.min(48, 2 ** Math.max(0, failures - 1)) * 3_600_000;
}

/** Runner tokens and Agent URLs of a preview are keyed "preview:<id>" (migration 0020). */
export const PREVIEW_PREFIX = "preview:";
/** The key of a preview's runner token, Agent URL and checks. */
export const previewKey = (id: string) => `${PREVIEW_PREFIX}${id}`;
/** A preview's runner token works for this many days from the preview's creation. */
export const PREVIEW_TOKEN_DAYS = 7;

/** The code a rating or a check is about, and where that hash came from. */
export interface RatedCode {
  hash: string;
  /** "declared" (the owner's), "url" (the Agent URL's version), or the runner's own source. */
  source: string;
  /** What the hash was made from, when the runner said (a commit, an image digest): display only. */
  detail?: string;
}

/** How Bonded reaches an operator's agent. */
export type ConnectionKind = "runner" | "url";

/** A preview (migration 0020). */
export interface PreviewRecord {
  id: string;
  chainId: number;
  owner: string;
  mode: string;
  connection: ConnectionKind;
  codeHash: string | null;
  status: string;
  ratingId: string | null;
  error: string | null;
  upgradedTo: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A live Agent URL. `ciphertext` is the encrypted agent secret: never returned to anyone. */
export interface AgentUrlRecord {
  id: string;
  ownerKey: string;
  url: string;
  ciphertext: string;
  createdBy: string;
  createdAt: Date;
  verifiedAt: Date | null;
  version: string | null;
  codeHash: string | null;
}

/** What a passing check must match for a rating to be queued. */
export interface CheckConfig {
  mode: string;
  connection: ConnectionKind;
  /** The runner token or Agent URL in use. */
  credentialId: string | null;
  codeHash: string | null;
}

/** A connection check (migration 0020). */
export interface ConnectionCheckRecord {
  id: string;
  subject: string;
  chainId: number;
  owner: string;
  mode: string;
  connection: ConnectionKind;
  credentialId: string | null;
  codeHash: string | null;
  codeSource: string | null;
  status: "queued" | "running" | "passed" | "failed";
  result: unknown;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** The connection an agent or preview has right now. */
export interface CurrentConnection {
  /** The live runner token or Agent URL, if any. */
  credentialId: string | null;
  /** Runner connected (in the right mode), or Agent URL verified. */
  ready: boolean;
  /** What the runner or URL reports about its code, if anything. */
  code: RatedCode | undefined;
}

/** An owner's notification settings (migration 0021). */
export interface NotificationSettingsRecord {
  owner: string;
  webhookUrl: string | null;
  webhookSecretCiphertext: string | null;
  email: string | null;
  /** Notification types the owner turned off (0022). */
  muted: string[];
  updatedAt: Date;
}

/** Steps of the funnel counted per day (0022, `GET /stats/funnel`). */
export const FUNNEL_STEPS = [
  "preview_started",
  "check_passed",
  "preview_done",
  "onboarded",
  "first_vault_trade",
  "cover_bought",
] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

/** A vault's trades through `execute`, as the keeper indexed them (0022). */
export interface VaultActivity {
  firstTradeAt: Date | null;
  lastTradeAt: Date | null;
  trades24h: number;
  trades7d: number;
  total: number;
  lastTxHash: string | null;
  /** Median gas of its last 20 trades, when any recorded it. */
  medianGas: bigint | null;
}

/** One notification in an owner's in-app list (0022). */
export interface InboxItem {
  id: string;
  type: string;
  subject: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
  readAt: Date | null;
}

/** Limits on preview ratings, counted over the last 24 hours. */
export interface PreviewQuota {
  nowMs: number;
  perWalletDaily: number;
  daily: number;
}

/** Why a preview rating can't be queued now. */
export type PreviewRefusal =
  | { refused: "wallet-daily"; nextAt: Date }
  | { refused: "daily"; nextAt: Date }
  | { refused: "busy" };

/** How a preview rating ended (`finishPreview`). */
export interface PreviewOutcome {
  status: "done" | "failed" | "refused";
  error?: string;
  /** For a failure: true when retrying can't help (default true). */
  final?: boolean;
  agentCaused?: boolean;
  agentReport?: string;
}

const previewRow = (row: Record<string, unknown>): PreviewRecord => ({
  id: row.id as string,
  chainId: row.chain_id as number,
  owner: row.owner as string,
  mode: row.mode as string,
  connection: row.connection as ConnectionKind,
  codeHash: (row.code_hash as string | null) ?? null,
  status: row.status as string,
  ratingId: (row.rating_id as string | null) ?? null,
  error: (row.error as string | null) ?? null,
  upgradedTo: (row.upgraded_to as string | null) ?? null,
  createdAt: row.created_at as Date,
  updatedAt: row.updated_at as Date,
});
const checkRow = (row: Record<string, unknown>): ConnectionCheckRecord => ({
  id: row.id as string,
  subject: row.subject as string,
  chainId: row.chain_id as number,
  owner: row.owner as string,
  mode: row.mode as string,
  connection: row.connection as ConnectionKind,
  credentialId: (row.credential_id as string | null) ?? null,
  codeHash: (row.code_hash as string | null) ?? null,
  codeSource: (row.code_source as string | null) ?? null,
  status: row.status as ConnectionCheckRecord["status"],
  result: row.result ?? null,
  createdAt: row.created_at as Date,
  startedAt: (row.started_at as Date | null) ?? null,
  finishedAt: (row.finished_at as Date | null) ?? null,
});
const agentUrlRow = (row: Record<string, unknown>): AgentUrlRecord => ({
  id: row.id as string,
  ownerKey: row.owner_key as string,
  url: row.url as string,
  ciphertext: row.secret_ciphertext as string,
  createdBy: row.created_by as string,
  createdAt: row.created_at as Date,
  verifiedAt: (row.verified_at as Date | null) ?? null,
  version: (row.version as string | null) ?? null,
  codeHash: (row.code_hash as string | null) ?? null,
});
/** SQL: a check that takes (or took) a turn in the check lane, not one that failed at once. */
const LANE_CHECK = "(status IN ('queued','running') OR started_at IS NOT NULL)";
/** What a check that the worker lost (it restarted mid-check) says. */
const INTERRUPTED_CHECK = {
  passed: false,
  problems: ["The check was interrupted on Bonded's side, not by your agent. Run it again."],
  taskCompleted: false,
  toolsCalled: 0,
  surfacesRead: [],
};

/** Raised when a caller tries to queue an agent outside the configured set. */
export class AgentNotConfiguredError extends Error {}

/** SQL transactions own queue leases, ingestion cursors and durable live events. */
export class Database {
  readonly pool: pg.Pool;
  readonly orm;
  /** Bound connection waits so saturation cannot leave requests waiting indefinitely. */
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 15, connectionTimeoutMillis: 5000 });
    this.pool.on("error", () => console.error("Postgres idle connection failed"));
    this.orm = drizzle(this.pool);
  }
  /** Run a callback atomically and always release its connection. */
  async transaction<T>(fn: (c: Connection) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const value = await fn(c);
      await c.query("COMMIT");
      return value;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  /** Apply ordered migrations once under a cross-process migration lock. */
  async migrate() {
    const migrations = [
      "0001_services.sql",
      "0002_report_bytes.sql",
      "0003_agent_availability.sql",
      "0004_tee_checks.sql",
      "0005_tee_rating_version.sql",
      "0006_bounties.sql",
      "0007_bounty_broadcasts.sql",
      "0008_bounty_nonce.sql",
      "0009_self_serve_agents.sql",
      "0010_held_out_attacks.sql",
      "0011_list_pagination.sql",
      "0012_attack_index.sql",
      "0013_sentinel_checks.sql",
      "0014_runner_tokens.sql",
      "0015_breach_details.sql",
      "0016_held_out_payloads.sql",
      "0017_agent_standing.sql",
      "0018_rating_registration.sql",
      "0019_sentinel_cascade.sql",
      "0020_previews_and_checks.sql",
      "0021_notifications.sql",
      "0022_launch_round.sql",
      "0023_deployments.sql",
      "0024_payment_gate.sql",
      "0025_gate_stripe_card.sql",
      "0026_gate_transparency.sql",
      "0027_data_apis.sql",
      "0028_gate_payout_proxy.sql",
      "0029_gate_general_rules.sql",
      "0030_gate_watch.sql",
      "0031_gate_card_hooks.sql",
      "0032_remove_key_routes.sql",
      "0033_gate_budgets.sql",
    ];
    await this.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(7001)");
      await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY)");
      for (const file of migrations) {
        // A migration's version is the number its file name starts with, not its place in the
        // list, so migrations made on separate branches (0019 and 0020, say) can land in either
        // order: each runs once, whichever arrives first.
        const version = Number(file.slice(0, 4));
        const done = await c.query("SELECT 1 FROM schema_migrations WHERE version=$1", [version]);
        if (!done.rowCount) {
          await c.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
          await c.query("INSERT INTO schema_migrations VALUES ($1)", [version]);
        }
      }
    });
  }
  /**
   * Which deployment (registry) this database holds a chain's on-chain state for. A database
   * with no record for the chain records `registry` and goes on. Returns the recorded registry
   * when it differs: the chain was redeployed, agents, policies, claims and bounties are numbered
   * from 1 again, and the services must not run on the old state (see adoptDeployment).
   */
  async checkDeployment(chainId: number, registry: string): Promise<string | undefined> {
    const current = registry.toLowerCase();
    return this.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(7001)");
      const recorded = (
        await c.query("SELECT registry FROM deployments WHERE chain_id=$1", [chainId])
      ).rows[0]?.registry as string | undefined;
      if (recorded === undefined)
        await c.query("INSERT INTO deployments(chain_id,registry) VALUES($1,$2)", [
          chainId,
          current,
        ]);
      return recorded === undefined || recorded === current ? undefined : recorded;
    });
  }
  /**
   * Move a redeployed chain onto `registry`: clear the chain's on-chain state from the old
   * deployment and record the new one, in one transaction under the migration lock. Only run on
   * the operator's explicit confirmation (ADOPT_DEPLOYMENT). Previews and their ratings, sign-ins,
   * notification settings, held-out attacks and funnel counts don't belong to a deployment and
   * stay. Returns the rows cleared per table, or undefined if `registry` was already recorded.
   */
  async adoptDeployment(
    chainId: number,
    registry: string,
  ): Promise<Record<string, number> | undefined> {
    const current = registry.toLowerCase();
    return this.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(7001)");
      const recorded = (
        await c.query("SELECT registry FROM deployments WHERE chain_id=$1", [chainId])
      ).rows[0]?.registry as string | undefined;
      if (recorded === current) return undefined;
      const cleared = await clearChainState(c, chainId);
      await c.query(
        `INSERT INTO deployments(chain_id,registry) VALUES($1,$2)
         ON CONFLICT(chain_id) DO UPDATE SET registry=$2, adopted_at=now()`,
        [chainId, current],
      );
      return cleared;
    });
  }
  /** Persist before notifying; event IDs are serialized through commit for safe SSE replay. */
  async publish(topic: string, payload: unknown, c?: Connection): Promise<void> {
    if (!c) return this.transaction((tx) => this.publish(topic, payload, tx));
    // Serialize allocation through commit: SSE cannot skip a late committing lower ID.
    await c.query("SELECT pg_advisory_xact_lock(7002)");
    const r = await c.query("INSERT INTO events(topic,payload) VALUES($1,$2) RETURNING id", [
      topic,
      json(payload),
    ]);
    await c.query("SELECT pg_notify('bonded_events',$1)", [r.rows[0].id]);
  }
  /** Record one Sentinel check: never the action or the inputs, only the outcome. */
  async recordSentinelCheck(
    chainId: number,
    agentId: string,
    check: {
      manipulated: number | null;
      blocked: boolean | null;
      latencyMs: number;
      status?: "success" | "error";
      pipelineHash?: string;
      model?: string;
      escalated?: boolean;
      primaryLatencyMs?: number;
      fallbackLatencyMs?: number;
      inputTokens?: number;
      outputTokens?: number;
      llmCostUsd?: number;
    },
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO sentinel_checks(chain_id,agent_id,manipulated,blocked,latency_ms,status,
        pipeline_hash,model,escalated,primary_latency_ms,fallback_latency_ms,input_tokens,output_tokens,llm_cost_usd)
       VALUES($1,$2::numeric,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        chainId,
        agentId,
        check.manipulated,
        check.blocked,
        Math.round(check.latencyMs),
        check.status ?? "success",
        check.pipelineHash,
        check.model,
        check.escalated,
        check.primaryLatencyMs === undefined ? null : Math.round(check.primaryLatencyMs),
        check.fallbackLatencyMs === undefined ? null : Math.round(check.fallbackLatencyMs),
        check.inputTokens,
        check.outputTokens,
        check.llmCostUsd,
      ],
    );
  }
  /** Durable metrics for one deployed pipeline. Unknown legacy or failed-call cost stays unknown. */
  async sentinelMetrics(chainId: number, since: Date, pipelineHash: string) {
    const r = await this.pool.query(
      `SELECT count(*)::int AS checks,
        count(*) FILTER (WHERE status='error')::int AS errors,
        count(*) FILTER (WHERE escalated)::int AS escalations,
        count(escalated)::int AS routed,
        count(llm_cost_usd)::int AS costed,
        sum(llm_cost_usd)::float8 AS cost,
        sum(input_tokens)::float8 AS input_tokens, sum(output_tokens)::float8 AS output_tokens,
        percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50,
        percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95,
        percentile_disc(0.5) WITHIN GROUP (ORDER BY primary_latency_ms) AS primary_p50,
        percentile_disc(0.95) WITHIN GROUP (ORDER BY primary_latency_ms) AS primary_p95,
        percentile_disc(0.5) WITHIN GROUP (ORDER BY fallback_latency_ms) AS fallback_p50,
        percentile_disc(0.95) WITHIN GROUP (ORDER BY fallback_latency_ms) AS fallback_p95
       FROM sentinel_checks WHERE chain_id=$1 AND checked_at >= $2 AND pipeline_hash=$3`,
      [chainId, since, pipelineHash],
    );
    const m = r.rows[0];
    return {
      checks: m.checks as number,
      errors: m.errors as number,
      escalations: m.escalations as number,
      escalationRate: m.routed ? m.escalations / m.routed : null,
      knownCostChecks: m.costed as number,
      llmCostUsd: m.checks && m.costed === m.checks ? m.cost : null,
      llmUsdPer1000: m.checks && m.costed === m.checks ? (m.cost * 1000) / m.checks : null,
      inputTokens: m.input_tokens as number | null,
      outputTokens: m.output_tokens as number | null,
      latencyMs: { p50: m.p50 as number | null, p95: m.p95 as number | null },
      primaryLatencyMs: {
        p50: m.primary_p50 as number | null,
        p95: m.primary_p95 as number | null,
      },
      fallbackLatencyMs: {
        p50: m.fallback_p50 as number | null,
        p95: m.fallback_p95 as number | null,
      },
    };
  }
  /** Sentinel checks since `since`, for one agent or every agent on the chain. */
  async sentinelCheckCounts(
    chainId: number,
    since: Date,
    agentId?: string,
  ): Promise<{ checks: number; blocked: number; lastAt: Date | null }> {
    const r = await this.pool.query(
      `SELECT count(*)::int AS checks, count(*) FILTER (WHERE blocked)::int AS blocked,
        max(checked_at) AS last_at
      FROM sentinel_checks
      WHERE chain_id=$1 AND checked_at >= $2 AND ($3::numeric IS NULL OR agent_id = $3::numeric)`,
      [chainId, since, agentId ?? null],
    );
    const row = r.rows[0];
    return { checks: row.checks, blocked: row.blocked, lastAt: row.last_at };
  }
  /** Delete Sentinel check records from before `before`. */
  async pruneSentinelChecks(before: Date): Promise<number> {
    const r = await this.pool.query("DELETE FROM sentinel_checks WHERE checked_at < $1", [before]);
    return r.rowCount ?? 0;
  }
  /**
   * Delete live events created before `before`, oldest first, in bounded batches so a large
   * backlog never holds one long transaction. Ratings, reports and attestations are kept.
   * An SSE client resuming from a pruned Last-Event-ID continues from the oldest kept event.
   */
  async pruneEvents(before: Date, batchSize = 10_000): Promise<number> {
    // A zero batch would delete nothing and never reach the exit condition.
    if (!Number.isSafeInteger(batchSize) || batchSize < 1)
      throw new RangeError("batchSize must be a positive integer");
    let deleted = 0;
    for (;;) {
      const r = await this.pool.query(
        "DELETE FROM events WHERE id IN (SELECT id FROM events WHERE created_at < $1 ORDER BY id LIMIT $2)",
        [before, batchSize],
      );
      deleted += r.rowCount ?? 0;
      if ((r.rowCount ?? 0) < batchSize) return deleted;
    }
  }
  /** Replace one chain's runnable set without deleting rating or attestation history. */
  async reconcileAgents(chainId: number, agents: { agentId: string; config: unknown }[]) {
    await this.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(7005,$1)", [chainId]);
      const ids = agents.map((agent) => `${chainId}:${agent.agentId}`);
      // The file is the complete set of operator agents; agents registered by their owners
      // (source 'user') are not the file's to remove.
      await c.query(
        "UPDATE agents SET enabled=false WHERE chain_id=$1 AND source='operator' AND NOT (id=ANY($2::text[]))",
        [chainId, ids],
      );
      for (const agent of agents)
        await c.query(
          "INSERT INTO agents(id,chain_id,agent_id,config,enabled) VALUES($1,$2,$3,$4,true) ON CONFLICT(id) DO UPDATE SET config=$4,enabled=true,source='operator',owner=NULL",
          [`${chainId}:${agent.agentId}`, chainId, agent.agentId, json(agent.config)],
        );
      const cancelled = await c.query(
        `UPDATE jobs j SET status='failed',lease_until=NULL
        FROM ratings r JOIN agents a ON a.id=r.agent_id
        WHERE j.id=r.id AND a.chain_id=$1 AND NOT a.enabled AND j.status IN ('queued','running') RETURNING j.id`,
        [chainId],
      );
      for (const row of cancelled.rows) {
        await c.query(
          "UPDATE ratings SET status='failed',error='agent removed from configuration' WHERE id=$1",
          [row.id],
        );
        await this.publish("rating.failed", { runId: row.id }, c);
      }
    });
  }
  /**
   * Store an agent registered by its owner (self-serve). Returns false, changing nothing, if the
   * operator already configures this agent: the operator's config wins.
   */
  async upsertUserAgent(chainId: number, agentId: string, owner: string, config: unknown) {
    const r = await this.pool.query(
      `INSERT INTO agents(id,chain_id,agent_id,config,enabled,source,owner) VALUES($1,$2,$3,$4,true,'user',$5)
       ON CONFLICT(id) DO UPDATE SET config=$4,enabled=true,owner=$5 WHERE agents.source='user'
       RETURNING (xmax = 0) AS inserted`,
      [`${chainId}:${agentId}`, chainId, agentId, json(config), owner.toLowerCase()],
    );
    if (r.rows[0]?.inserted) await this.countFunnel("onboarded");
    return r.rowCount === 1;
  }
  /** An agent's row: where its config came from, its owner and config, and its latest rating. */
  async agentRecord(id: string) {
    const r = await this.pool.query(
      `SELECT a.source,a.owner,a.config,a.enabled,
        (SELECT max(created_at) FROM ratings WHERE agent_id=a.id) AS last_rating_at
       FROM agents a WHERE a.id=$1`,
      [id],
    );
    return r.rows[0] as
      | {
          source: "operator" | "user";
          owner: string | null;
          config: unknown;
          enabled: boolean;
          last_rating_at: Date | null;
        }
      | undefined;
  }
  /**
   * Queue a self-serve rating if both quotas allow it: none for this agent within `perAgentMs`,
   * and fewer than `dailyCap` self-serve ratings on the chain in the last 24 hours. The checks and
   * the insert run in one transaction under a per-chain lock, so parallel requests can't all see
   * the same allowance.
   */
  async enqueueUserRating(
    id: string,
    chainId: number,
    quota: {
      nowMs: number;
      perAgentMs: number;
      dailyCap: number;
      remote?: RemoteQuota;
      /** The code the rating is about, when the caller has settled it (0020). */
      code?: RatedCode;
    },
  ): Promise<
    { runId: string } | { refused: "hourly"; nextAt: Date } | { refused: "daily" } | RemoteRefusal
  > {
    return this.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(7006,$1)", [chainId]);
      const last = (
        await c.query("SELECT max(created_at) AS t FROM ratings WHERE agent_id=$1", [id])
      ).rows[0].t as Date | null;
      if (last && quota.nowMs - last.getTime() < quota.perAgentMs)
        return { refused: "hourly", nextAt: new Date(last.getTime() + quota.perAgentMs) };
      // An operator-run agent has its own lane and caps, so it never uses up the built-in
      // designs' daily allowance (and they never use up its).
      if (quota.remote) {
        const refused = await this.remoteQuotaIn(c, id, quota.remote);
        if (refused) return refused;
        return { runId: await this.enqueueIn(c, id, new Date(quota.nowMs), quota.code) };
      }
      const today = (
        await c.query(
          `SELECT count(*)::int AS n FROM ratings r JOIN agents a ON a.id=r.agent_id
           WHERE a.chain_id=$1 AND a.source='user' AND r.kind<>'remote' AND r.created_at>=$2`,
          [chainId, new Date(quota.nowMs - 86_400_000)],
        )
      ).rows[0].n as number;
      if (today >= quota.dailyCap) return { refused: "daily" };
      // Stamped with the same clock the quotas use, so the next check compares like with like.
      return { runId: await this.enqueueIn(c, id, new Date(quota.nowMs)) };
    });
  }
  /**
   * Store a new runner token's hash for an agent, revoking the one it replaces, in one transaction.
   * Refused when the request was signed no later than the last token request for this agent, so a
   * captured signature can't be replayed.
   */
  async createRunnerToken(
    agentKey: string,
    token: { hash: string; createdBy: string; signedAt: number },
  ): Promise<{ id: string; createdAt: Date } | { refused: "replayed" }> {
    return this.transaction(async (c) => {
      await this.lockSubject(c, agentKey);
      if (await this.runnerRequestSeen(c, agentKey, token.signedAt)) return { refused: "replayed" };
      await c.query(
        "UPDATE runner_tokens SET revoked_at=now(),revoked_signed_at=$2 WHERE agent_id=$1 AND revoked_at IS NULL",
        [agentKey, token.signedAt],
      );
      const r = await c.query(
        `INSERT INTO runner_tokens(id,agent_id,token_hash,created_by,signed_at) VALUES($1,$2,$3,$4,$5)
         RETURNING id,created_at`,
        [randomUUID(), agentKey, token.hash, token.createdBy.toLowerCase(), token.signedAt],
      );
      return { id: r.rows[0].id as string, createdAt: r.rows[0].created_at as Date };
    });
  }
  /** Revoke an agent's live runner token. Refused like `createRunnerToken` for a replay. */
  async revokeRunnerToken(
    agentKey: string,
    signedAt: number,
  ): Promise<{ revoked: number } | { refused: "replayed" }> {
    return this.transaction(async (c) => {
      await this.lockSubject(c, agentKey);
      if (await this.runnerRequestSeen(c, agentKey, signedAt)) return { refused: "replayed" };
      const r = await c.query(
        "UPDATE runner_tokens SET revoked_at=now(),revoked_signed_at=$2 WHERE agent_id=$1 AND revoked_at IS NULL",
        [agentKey, signedAt],
      );
      await c.query(
        "UPDATE runner_presence SET connected=false,disconnected_at=now() WHERE agent_id=$1 AND connected",
        [agentKey],
      );
      return { revoked: r.rowCount ?? 0 };
    });
  }
  /**
   * The latest runner token request time on record for an agent (seconds, as signed), so a
   * request made with a session can be ordered after every signed one.
   */
  async lastRunnerRequestAt(agentKey: string): Promise<number> {
    const r = await this.pool.query(
      `SELECT coalesce(max(greatest(signed_at, coalesce(revoked_signed_at, 0))), 0)::bigint AS t
       FROM runner_tokens WHERE agent_id=$1`,
      [agentKey],
    );
    return Number(r.rows[0].t);
  }
  /** Whether a runner token request for this agent was already signed at or after `signedAt`. */
  private async runnerRequestSeen(c: Connection, agentKey: string, signedAt: number) {
    const r = await c.query(
      `SELECT 1 FROM runner_tokens WHERE agent_id=$1
         AND greatest(signed_at, coalesce(revoked_signed_at, 0)) >= $2 LIMIT 1`,
      [agentKey, signedAt],
    );
    return Boolean(r.rowCount);
  }
  /** The live token with this hash, for an enabled agent; undefined for anything else. */
  async runnerToken(hash: string): Promise<RunnerTokenRecord | undefined> {
    const r = await this.pool.query(
      `SELECT t.id,t.agent_id,t.created_by,a.chain_id,a.agent_id::text AS onchain,a.config FROM runner_tokens t
       JOIN agents a ON a.id=t.agent_id
       WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND a.enabled`,
      [hash],
    );
    const row = r.rows[0];
    if (row)
      return {
        tokenId: row.id,
        agentKey: row.agent_id,
        chainId: row.chain_id,
        agentId: row.onchain,
        config: row.config,
        createdBy: row.created_by,
      };
    // A preview's token: live while the preview is open (PREVIEW_TOKEN_DAYS from its creation).
    const p = (
      await this.pool.query(
        `SELECT t.id,t.agent_id,t.created_by,v.id AS preview,v.chain_id,v.mode,v.owner FROM runner_tokens t
         JOIN previews v ON 'preview:'||v.id::text=t.agent_id
         WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND v.status<>'stopped'
           AND v.created_at > now() - make_interval(days => $2)`,
        [hash, PREVIEW_TOKEN_DAYS],
      )
    ).rows[0];
    return (
      p && {
        tokenId: p.id,
        agentKey: p.agent_id,
        chainId: p.chain_id,
        agentId: p.agent_id,
        config: { kind: "preview", mode: p.mode },
        createdBy: p.created_by,
        preview: { id: p.preview, mode: p.mode, owner: p.owner },
      }
    );
  }
  /**
   * Record that a runner connected for an agent, on the agent's live token, replacing any earlier
   * connection. Returns the connection's id, or undefined, recording nothing, if the agent has no
   * live token (it was revoked since the runner's token was checked).
   */
  async runnerConnected(agentKey: string, hello: RunnerHello): Promise<string | undefined> {
    const connection = randomUUID();
    const r = await this.pool.query(
      `INSERT INTO runner_presence(agent_id,token_id,connection_id,connected,connected_at,last_heartbeat_at,
                                   disconnected_at,runner_version,mode,tee_url,code_hash,code_source,code_detail)
       SELECT agent_id,id,$2,true,now(),now(),NULL,$3,$4,$5,$6,$7,$8 FROM runner_tokens
       WHERE agent_id=$1 AND revoked_at IS NULL
       ON CONFLICT(agent_id) DO UPDATE SET token_id=EXCLUDED.token_id,connection_id=EXCLUDED.connection_id,
         connected=true,connected_at=now(),last_heartbeat_at=now(),disconnected_at=NULL,
         runner_version=EXCLUDED.runner_version,mode=EXCLUDED.mode,tee_url=EXCLUDED.tee_url,
         code_hash=EXCLUDED.code_hash,code_source=EXCLUDED.code_source,code_detail=EXCLUDED.code_detail
       RETURNING agent_id`,
      [
        agentKey,
        connection,
        hello.runnerVersion,
        hello.mode,
        hello.teeUrl ?? null,
        hello.codeHash?.toLowerCase() ?? null,
        hello.codeSource ?? null,
        hello.codeDetail ?? null,
      ],
    );
    return r.rowCount === 1 ? connection : undefined;
  }
  /**
   * A heartbeat on a connection. Returns false when its token was revoked or a newer connection
   * replaced it: the gateway should then drop it.
   */
  async runnerHeartbeat(connectionId: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE runner_presence p SET last_heartbeat_at=now() FROM runner_tokens t
       WHERE p.connection_id=$1 AND t.id=p.token_id AND p.connected AND t.revoked_at IS NULL`,
      [connectionId],
    );
    return r.rowCount === 1;
  }
  /** A connection closed. A newer connection for the same agent is left alone. */
  async runnerDisconnected(connectionId: string): Promise<void> {
    await this.pool.query(
      "UPDATE runner_presence SET connected=false,disconnected_at=now() WHERE connection_id=$1 AND connected",
      [connectionId],
    );
  }
  /** Mark the agent's runner disconnected: its next heartbeat fails, so it must connect again. */
  async dropRunner(agentKey: string): Promise<void> {
    await this.pool.query(
      "UPDATE runner_presence SET connected=false,disconnected_at=now() WHERE agent_id=$1 AND connected",
      [agentKey],
    );
  }
  /** Whether the agent has a connected runner on a live token right now. */
  async runnerIsConnected(agentKey: string): Promise<boolean> {
    if (agentKey.startsWith(PREVIEW_PREFIX)) return this.previewRunnerConnected(agentKey);
    const r = await this.pool.query(
      `SELECT ${RUNNER_CONNECTED} AS ok FROM agents a WHERE a.id=$1`,
      [agentKey],
    );
    return r.rows[0]?.ok === true;
  }
  /** The agent's live token (never the token itself), its runner and the latest skipped rating. */
  async runnerStatus(agentKey: string): Promise<RunnerStatus> {
    const [token, presence, skip] = await Promise.all([
      this.pool.query(
        "SELECT id,created_at FROM runner_tokens WHERE agent_id=$1 AND revoked_at IS NULL",
        [agentKey],
      ),
      this.pool.query(
        `SELECT p.*, (p.connected AND t.revoked_at IS NULL
                      AND p.mode IS NOT DISTINCT FROM coalesce(a.config->>'mode', v.mode)
                      AND p.last_heartbeat_at > now() - make_interval(secs => $2)) AS live
         FROM runner_presence p JOIN runner_tokens t ON t.id=p.token_id
         LEFT JOIN agents a ON a.id=p.agent_id
         LEFT JOIN previews v ON 'preview:'||v.id::text=p.agent_id
         WHERE p.agent_id=$1 AND t.revoked_at IS NULL`,
        [agentKey, RUNNER_FRESH_MS / 1000],
      ),
      this.pool.query(
        "SELECT cause,reason,created_at FROM rating_skips WHERE agent_id=$1 ORDER BY id DESC LIMIT 1",
        [agentKey],
      ),
    ]);
    const t = token.rows[0];
    const p = presence.rows[0];
    const s = skip.rows[0];
    return {
      token: t ? { id: t.id, createdAt: t.created_at } : null,
      runner: p
        ? {
            connected: p.live === true,
            connectedAt: p.connected_at,
            lastHeartbeatAt: p.last_heartbeat_at,
            disconnectedAt: p.disconnected_at,
            runnerVersion: p.runner_version,
            mode: p.mode,
            teeUrl: p.tee_url,
            codeHash: p.code_hash,
            codeSource: p.code_source,
          }
        : null,
      lastSkip: s ? { cause: s.cause, reason: s.reason, at: s.created_at } : null,
    };
  }
  /** Which of these held-out payload hashes an earlier rating already used (migration 0016). */
  async heldOutPayloadsUsed(hashes: readonly string[]): Promise<Set<string>> {
    if (!hashes.length) return new Set();
    const r = await this.pool.query("SELECT hash FROM held_out_payloads WHERE hash=ANY($1)", [
      [...hashes],
    ]);
    return new Set(r.rows.map((row) => row.hash as string));
  }
  /** Record held-out payload hashes as used, so no later rating uses them. */
  async recordHeldOutPayloads(hashes: readonly string[]): Promise<void> {
    if (!hashes.length) return;
    await this.pool.query(
      "INSERT INTO held_out_payloads(hash) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING",
      [[...hashes]],
    );
  }
  /** Record a rating the live loop chose not to queue, and why. */
  async recordRatingSkip(agentKey: string, cause: string, reason: string, c?: Connection) {
    await (c ?? this.pool).query(
      "INSERT INTO rating_skips(agent_id,cause,reason) VALUES($1,$2,$3)",
      [agentKey, cause, reason],
    );
  }
  /**
   * Queue a rating for the live loop unless the agent already has one queued or running, or one
   * was created within `minGapMs`. Returns the run id, or undefined when nothing was queued.
   */
  async enqueueIfIdle(
    agentKey: string,
    minGapMs: number,
    remote?: RemoteQuota,
  ): Promise<string | undefined> {
    return this.transaction(async (c) => {
      await c.query("SELECT 1 FROM agents WHERE id=$1 FOR UPDATE", [agentKey]);
      if (remote && (await this.remoteQuotaIn(c, agentKey, remote))) return undefined;
      const busy = await c.query(
        `SELECT 1 FROM ratings r JOIN jobs j ON j.id=r.id WHERE r.agent_id=$1
           AND (j.status IN ('queued','running') OR r.created_at > now() - make_interval(secs => $2))
         LIMIT 1`,
        [agentKey, minGapMs / 1000],
      );
      if (busy.rowCount) return undefined;
      return this.enqueueIn(c, agentKey);
    });
  }
  /**
   * Bring-your-own agents on a chain whose runner is connected and whose latest posted score
   * expires before `beforeSeconds` (unix seconds): the ones to re-rate before their score lapses.
   */
  async remoteAgentsExpiring(chainId: number, beforeSeconds: number): Promise<string[]> {
    const r = await this.pool.query(
      `SELECT a.id FROM agents a
       WHERE a.chain_id=$1 AND a.enabled AND a.config->>'kind'='remote' AND ${CONNECTION_READY}
         AND (SELECT (s.signed->'attestation'->>'expiresAt')::bigint FROM attestations s
              WHERE s.agent_id=a.id ORDER BY s.created_at DESC LIMIT 1) < $2
       ORDER BY a.id`,
      [chainId, beforeSeconds],
    );
    return r.rows.map((row) => row.id as string);
  }
  /**
   * What observed breach rates are estimated from (`estimateObservedRates` in @bondedhq/shared):
   * every posted score's validity and per-group results, and every production breach on the chain.
   */
  async observedRateInputs(chainId: number): Promise<{
    periods: {
      agentId: string;
      from: number;
      to: number;
      groups: { id: string; episodes: number; breaches: number }[];
    }[];
    breaches: { agentId: string | null; at: Date | null; blocked: boolean | null }[];
  }> {
    const [periods, breaches] = await Promise.all([
      this.pool.query(
        `SELECT a.agent_id::text AS agent, (s.signed->'attestation'->>'issuedAt')::bigint AS issued,
           (s.signed->'attestation'->>'expiresAt')::bigint AS expires,
           r.report->'scoring'->'groups' AS groups
         FROM attestations s JOIN agents a ON a.id=s.agent_id JOIN ratings r ON r.id=s.id
         WHERE a.chain_id=$1`,
        [chainId],
      ),
      this.pool.query(
        "SELECT agent_id::text AS agent,occurred_at,blocked FROM handled_events WHERE chain_id=$1",
        [chainId],
      ),
    ]);
    return {
      periods: periods.rows.map((row) => ({
        agentId: row.agent,
        from: Number(row.issued),
        to: Number(row.expires),
        groups: Array.isArray(row.groups)
          ? (row.groups as { id: string; episodes: number; breaches: number }[])
          : [],
      })),
      breaches: breaches.rows.map((row) => ({
        agentId: row.agent,
        at: row.occurred_at,
        blocked: row.blocked,
      })),
    };
  }
  /**
   * Store a live check only if its observed rating is still current. Custody evidence and failures
   * survive outages within one report, but cannot be inherited by a replacement report.
   */
  async recordTeeCheck(check: {
    agentId: string;
    status: string;
    detail?: string | undefined;
    measurement?: string | undefined;
    ratedMeasurement?: string | undefined;
    ratedReportHash?: string | undefined;
    evmAddress?: string | undefined;
    /** The row version read before consulting the chain; null means no version was on record. */
    observedReportHash?: string | null;
  }) {
    await this.pool.query(
      `INSERT INTO tee_checks(agent_id,status,detail,measurement,rated_measurement,rated_report_hash,
                              evm_address,blocking_status,checked_at,verified_at)
       SELECT $1,$2,$3,$4,$5,$7,CASE WHEN $2='verified' THEN $6 END,
              CASE WHEN $2 IN ('mismatch','invalid') THEN $2 END,now(),
              CASE WHEN $2='verified' THEN now() END
       WHERE NOT $9 OR $8::text IS NULL OR EXISTS (
         SELECT 1 FROM tee_checks WHERE agent_id=$1 AND rated_report_hash IS NOT DISTINCT FROM $8)
       ON CONFLICT(agent_id) DO UPDATE SET status=$2,detail=$3,measurement=$4,
         rated_measurement=$5,rated_report_hash=$7,
         evm_address=CASE WHEN $2='verified' THEN $6
                         WHEN tee_checks.rated_report_hash IS NOT DISTINCT FROM $7
                          AND tee_checks.rated_measurement IS NOT DISTINCT FROM $5
                         THEN tee_checks.evm_address END,
         blocking_status=CASE WHEN $2 IN ('mismatch','invalid') THEN $2
                              WHEN $2 IN ('verified','unrated') THEN NULL
                              WHEN tee_checks.rated_report_hash IS NOT DISTINCT FROM $7
                               AND tee_checks.rated_measurement IS NOT DISTINCT FROM $5
                              THEN tee_checks.blocking_status END,
         checked_at=now(),
         verified_at=CASE WHEN $2='verified' THEN now()
                          WHEN tee_checks.rated_report_hash IS NOT DISTINCT FROM $7
                           AND tee_checks.rated_measurement IS NOT DISTINCT FROM $5
                          THEN tee_checks.verified_at END
       WHERE NOT $9 OR tee_checks.rated_report_hash IS NOT DISTINCT FROM $8`,
      [
        check.agentId,
        check.status,
        check.detail ?? null,
        check.measurement ?? null,
        check.ratedMeasurement ?? null,
        check.evmAddress ?? null,
        check.ratedReportHash ?? null,
        check.observedReportHash ?? null,
        Object.hasOwn(check, "observedReportHash"),
      ],
    );
  }
  /** A posted rating replaces its custody evidence and clears earlier failures. */
  async recordTeeRating(
    rating:
      | { agentId: string; ratedMeasurement: string; ratedReportHash: string; evmAddress: string }
      | { agentId: string },
    c?: Connection,
  ) {
    const q = c ?? this.pool;
    if (!("evmAddress" in rating)) {
      await q.query("DELETE FROM tee_checks WHERE agent_id=$1", [rating.agentId]);
      return;
    }
    await q.query(
      `INSERT INTO tee_checks(agent_id,status,measurement,rated_measurement,rated_report_hash,evm_address,
                              blocking_status,checked_at,verified_at)
       VALUES($1,'verified',$2,$2,$4,$3,NULL,now(),now())
       ON CONFLICT(agent_id) DO UPDATE SET status='verified',detail=NULL,measurement=$2,
         rated_measurement=$2,rated_report_hash=$4,evm_address=$3,blocking_status=NULL,
         checked_at=now(),verified_at=now()`,
      [rating.agentId, rating.ratedMeasurement, rating.evmAddress, rating.ratedReportHash],
    );
  }
  /** How far a rating has got: the episodes its worker has published (see `publish`). */
  async runProgress(runId: string): Promise<RunProgress> {
    // Ratings of agents their operators run (and previews) keep their counts on the rating: their
    // episodes are published only once the rating is over.
    const own = (await this.pool.query("SELECT progress FROM ratings WHERE id=$1", [runId])).rows[0]
      ?.progress as {
      done: number;
      total: number | null;
      startedAt: string;
      lastAt?: string;
      counted?: boolean;
      episodesStartedAt?: string;
    } | null;
    if (own?.counted)
      return {
        done: own.done,
        total: own.total,
        startedAt: new Date(own.startedAt),
        lastAt: own.lastAt ? new Date(own.lastAt) : null,
        episodesStartedAt: own.episodesStartedAt ? new Date(own.episodesStartedAt) : null,
      };
    const r = await this.pool.query(
      `SELECT count(*)::int AS done, max((payload->>'total')::int) AS total,
         min(created_at) AS started, max(created_at) AS last
       FROM events WHERE topic='rating.episode' AND payload->>'runId'=$1`,
      [runId],
    );
    const row = r.rows[0];
    // Episodes published as they run (Bonded's own designs); set-up time from the rating itself.
    return {
      done: row.done,
      total: row.total,
      startedAt: own?.startedAt ? new Date(own.startedAt) : row.started,
      lastAt: row.last,
      episodesStartedAt: row.started,
    };
  }
  /**
   * An agent's ratings, newest first, one numbered page at a time: every attempt, failed and
   * stopped ones included, with the score of the ones that posted.
   */
  async ratingAttempts(
    agentKey: string,
    q: { page?: number; limit?: number } = {},
  ): Promise<Page<RatingAttempt>> {
    const limit = clampLimit(q.limit ?? 10);
    const total = (
      await this.pool.query("SELECT count(*)::int AS n FROM ratings WHERE agent_id=$1", [agentKey])
    ).rows[0].n as number;
    const at = pageOf(q.page, total, limit);
    const r = await this.pool.query(
      `SELECT r.id,r.status,r.error,r.agent_caused,r.agent_report,r.created_at,r.code_hash,r.code_source,
         (s.signed->'attestation'->>'score')::int AS score
       FROM ratings r LEFT JOIN attestations s ON s.id=r.id
       WHERE r.agent_id=$1 ORDER BY r.created_at DESC, r.id LIMIT $2 OFFSET $3`,
      [agentKey, limit, at.offset],
    );
    const items = r.rows.map((row) => ({
      runId: row.id,
      status: row.status,
      error: row.error,
      agentCaused: row.agent_caused,
      agentReport: row.agent_report,
      createdAt: row.created_at,
      score: row.score,
      codeHash: row.code_hash,
      codeSource: row.code_source,
    }));
    return { items, page: at.page, pages: at.pages, total };
  }
  /**
   * The rating that produced a posted score (found by the attestation's report hash): what kind
   * of registration it rated, and whether that registration is still the agent's current one.
   * Undefined for a score this service didn't post.
   */
  async ratingBehindScore(
    agentKey: string,
    reportHash: string,
  ): Promise<{ runId: string; kind: string; current: boolean } | undefined> {
    const row = (
      await this.pool.query(
        `SELECT r.id, r.kind, (r.config IS NOT DISTINCT FROM a.config) AS current
         FROM attestations s JOIN ratings r ON r.id=s.id JOIN agents a ON a.id=r.agent_id
         WHERE s.agent_id=$1 AND lower(s.signed->'attestation'->>'reportHash')=lower($2)
         ORDER BY s.created_at DESC LIMIT 1`,
        [agentKey, reportHash],
      )
    ).rows[0];
    return row ? { runId: row.id, kind: row.kind, current: row.current } : undefined;
  }
  /** An agent's standing after its ratings (see `AgentStanding`). */
  async agentStanding(agentKey: string): Promise<AgentStanding> {
    const row = (
      await this.pool.query("SELECT * FROM agent_standing WHERE agent_id=$1", [agentKey])
    ).rows[0];
    return {
      failuresInRow: row?.failures_in_row ?? 0,
      superseded: row?.superseded_at
        ? { since: row.superseded_at, reason: row.superseded_reason }
        : null,
      cooldownUntil: row?.cooldown_until ?? null,
    };
  }
  /**
   * Whether a remote rating may be queued for this agent now, inside a caller's transaction: no
   * cooldown, and under the per-owner, per-agent and lane-wide daily caps. Every remote rating
   * counts, whoever asked for it (owner, renewal, TEE change). Ratings are counted by what they
   * were when queued (their kind and the owner charged), so registering an agent again, as
   * another kind or under another owner, doesn't take earlier ratings off the count.
   */
  private async remoteQuotaIn(
    c: Connection,
    agentKey: string,
    quota: RemoteQuota,
  ): Promise<RemoteRefusal | undefined> {
    const now = new Date(quota.nowMs);
    const standing = (
      await c.query("SELECT cooldown_until FROM agent_standing WHERE agent_id=$1", [agentKey])
    ).rows[0];
    if (standing?.cooldown_until && standing.cooldown_until > now)
      return { refused: "cooldown", nextAt: standing.cooldown_until };
    const since = new Date(quota.nowMs - 86_400_000);
    const counts = (
      await c.query(
        `SELECT
           count(*) FILTER (WHERE r.agent_id=$1)::int AS agent,
           count(*) FILTER (WHERE r.charged_owner IS NOT DISTINCT FROM (SELECT owner FROM agents WHERE id=$1))::int AS owner,
           count(*)::int AS lane
         FROM ratings r JOIN agents a ON a.id=r.agent_id
         WHERE a.chain_id=(SELECT chain_id FROM agents WHERE id=$1)
           AND r.kind='remote' AND r.created_at>=$2`,
        [agentKey, since],
      )
    ).rows[0];
    if (counts.agent >= quota.perAgentDaily) return { refused: "agent-daily" };
    if (counts.owner >= quota.perOwnerDaily) return { refused: "owner-daily" };
    if (counts.lane >= quota.laneDaily) return { refused: "lane-daily" };
    return undefined;
  }
  /**
   * Revoke every runner token of an agent and drop its runner, without a signed request: used when
   * the agent is registered again (perhaps by a new owner), so no old token outlives it.
   */
  async revokeAllRunnerTokens(agentKey: string, c?: Connection): Promise<number> {
    const q = c ?? this.pool;
    const r = await q.query(
      "UPDATE runner_tokens SET revoked_at=now() WHERE agent_id=$1 AND revoked_at IS NULL",
      [agentKey],
    );
    await q.query(
      "UPDATE runner_presence SET connected=false,disconnected_at=now() WHERE agent_id=$1 AND connected",
      [agentKey],
    );
    return r.rowCount ?? 0;
  }
  /** Remove an agent's TEE row, e.g. when its TEE is no longer configured. */
  async clearTee(agentId: string) {
    await this.pool.query("DELETE FROM tee_checks WHERE agent_id=$1", [agentId]);
  }
  /** The latest live TEE check for `<chain id>:<agent id>`, if there is one. */
  async teeCheck(agentId: string): Promise<TeeCheckRow | undefined> {
    const r = await this.pool.query(
      `SELECT status,detail,measurement,rated_measurement,rated_report_hash,evm_address,blocking_status,checked_at,verified_at
       FROM tee_checks WHERE agent_id=$1`,
      [agentId],
    );
    const row = r.rows[0];
    return (
      row && {
        status: row.status,
        detail: row.detail,
        measurement: row.measurement,
        ratedMeasurement: row.rated_measurement,
        ratedReportHash: row.rated_report_hash,
        evmAddress: row.evm_address,
        blockingStatus: row.blocking_status,
        checkedAt: row.checked_at,
        verifiedAt: row.verified_at,
      }
    );
  }
  /** Queue only enabled agents, locking against concurrent configuration removal. */
  async enqueue(agentId: string) {
    return this.transaction((c) => this.enqueueIn(c, agentId));
  }
  /** Queue a rating inside a caller's transaction. */
  private async enqueueIn(
    c: Connection,
    agentId: string,
    createdAt?: Date,
    code?: RatedCode,
  ): Promise<string> {
    const id = randomUUID();
    const agent = await c.query(
      "SELECT config,owner FROM agents WHERE id=$1 AND enabled FOR SHARE",
      [agentId],
    );
    if (!agent.rowCount) throw new AgentNotConfiguredError("agent not configured");
    // The registration it rates and the owner it is charged to, fixed now (0018).
    const { config, owner } = agent.rows[0] as {
      config: { kind?: unknown; codeHash?: unknown; connection?: unknown };
      owner: string | null;
    };
    // The code it rates (0020): declared at registration, or what the agent's runner or URL
    // reports now, for an operator-run agent that declared none.
    const rated =
      code ??
      (config?.kind !== "remote"
        ? undefined
        : typeof config.codeHash === "string"
          ? { hash: config.codeHash, source: "declared" }
          : await this.reportedCodeIn(c, agentId, await this.connectionOfIn(c, agentId, config)));
    await c.query(
      `INSERT INTO ratings(id,agent_id,created_at,kind,charged_owner,config,code_hash,code_source)
       VALUES($1,$2,coalesce($3,now()),$4,$5,$6,$7,$8)`,
      [
        id,
        agentId,
        createdAt ?? null,
        typeof config?.kind === "string" ? config.kind : "",
        owner,
        json(config),
        rated?.hash.toLowerCase() ?? null,
        rated?.source ?? null,
      ],
    );
    await c.query("INSERT INTO jobs(id) VALUES($1)", [id]);
    await this.publish("rating.queued", { runId: id }, c);
    return id;
  }
  /**
   * Reap exhausted leases and claim one eligible job, fencing stale workers with a new token.
   * `lane` splits the queue: "remote" takes only ratings of agents their operators run (oldest
   * first among the owners who have had the fewest ratings in the last day, so one owner can't
   * crowd out the rest), "builtin" everything else; without it, any job.
   */
  async takeJob(
    chainId?: number,
    lane?: RatingLane,
  ): Promise<{ id: string; token: string } | undefined> {
    return this.transaction(async (c) => {
      const exhausted = await c.query(
        `WITH candidates AS (
        SELECT j.id FROM jobs j JOIN ratings r ON r.id=j.id JOIN agents a ON a.id=r.agent_id
        WHERE ($1::integer IS NULL OR a.chain_id=$1) AND j.attempts>=3
          AND (j.status='queued' OR (j.status='running' AND j.lease_until<now()))
        FOR UPDATE OF j SKIP LOCKED
      ) UPDATE jobs j SET status='failed',lease_until=NULL FROM candidates x WHERE j.id=x.id RETURNING j.id`,
        [chainId ?? null],
      );
      for (const row of exhausted.rows) {
        await c.query(
          "UPDATE ratings SET status='failed',error='rating abandoned after three attempts' WHERE id=$1",
          [row.id],
        );
        await this.publish("rating.failed", { runId: row.id }, c);
      }
      const r = await c.query(
        `UPDATE jobs SET status='running',token=$1,attempts=attempts+1,lease_until=now()+interval '60 seconds'
        WHERE id=(SELECT j.id FROM jobs j JOIN ratings r ON r.id=j.id JOIN agents a ON a.id=r.agent_id
          WHERE ($2::integer IS NULL OR a.chain_id=$2) AND a.enabled AND j.attempts<3
          AND ((j.status='queued' AND j.available_at<=now()) OR (j.status='running' AND j.lease_until<now()))
          AND ($3::text IS NULL OR (r.kind='remote') = ($3='remote'))
          ORDER BY CASE WHEN $3='remote' THEN (
              SELECT count(*) FROM ratings r2
              WHERE r2.charged_owner IS NOT DISTINCT FROM r.charged_owner AND r2.id<>r.id
                AND r2.created_at > now() - interval '1 day') ELSE 0 END,
            j.available_at
          FOR UPDATE OF j SKIP LOCKED LIMIT 1) RETURNING id,token`,
        [randomUUID(), chainId ?? null, lane ?? null],
      );
      return r.rows[0];
    });
  }
  /** Serialize rating writes with cancellation so an old worker cannot overwrite failed status. */
  /**
   * Remove the episodes a rating run has published so far: called when an attempt starts, so a
   * restarted run doesn't show an abandoned attempt's episodes alongside its own.
   */
  async clearRunEpisodes(runId: string, c: pg.Pool | Connection = this.pool): Promise<number> {
    const r = await c.query(
      "DELETE FROM events WHERE topic='rating.episode' AND payload->>'runId' = $1",
      [runId],
    );
    return r.rowCount ?? 0;
  }
  async withLease<T>(
    job: { id: string; token: string },
    fn: (c: Connection) => Promise<T>,
  ): Promise<T> {
    return this.transaction(async (c) => {
      const lease = await c.query(
        "SELECT id FROM jobs WHERE id=$1 AND token=$2 AND status='running' AND lease_until>now() FOR UPDATE",
        [job.id, job.token],
      );
      if (!lease.rowCount) throw new Error("job lease lost");
      return fn(c);
    });
  }
  /** Extend a still-owned lease; a removed agent or expired token cannot renew. */
  async renew(job: { id: string; token: string }) {
    const r = await this.pool.query(
      "UPDATE jobs SET lease_until=now()+interval '60 seconds' WHERE id=$1 AND token=$2 AND status='running' AND lease_until>now()",
      [job.id, job.token],
    );
    if (!r.rowCount) throw new Error("job lease lost");
  }
  /**
   * Fence completion, applying the retry cap and publishing the resulting status atomically. An
   * error is retried unless `final`, which fails the job at once (retrying can't help).
   */
  async finish(
    job: { id: string; token: string },
    error?: string,
    options?: {
      final?: boolean;
      /** The agent caused it: supersede its score and start (or double) its cooldown. */
      agentCaused?: boolean;
      /** What the agent or its runner reported, kept apart from `error`. */
      agentReport?: string;
    },
  ) {
    await this.transaction(async (c) => {
      const r = await c.query(
        `UPDATE jobs SET status=CASE WHEN $3='queued' AND attempts>=3 THEN 'failed' ELSE $3 END, lease_until=NULL, available_at=now()+interval '30 seconds'
        WHERE id=$1 AND token=$2 AND status='running' AND lease_until>now() RETURNING id,status`,
        [job.id, job.token, error ? (options?.final ? "failed" : "queued") : "done"],
      );
      if (!r.rowCount) throw new Error("job lease lost");
      const rating = (
        await c.query(
          "UPDATE ratings SET status=$2,error=$3,agent_caused=$4,agent_report=$5 WHERE id=$1 RETURNING agent_id",
          [
            job.id,
            r.rows[0].status,
            error ?? null,
            Boolean(error && options?.agentCaused),
            options?.agentReport ?? null,
          ],
        )
      ).rows[0];
      if (error && options?.agentCaused) {
        const prior = (
          await c.query("SELECT failures_in_row FROM agent_standing WHERE agent_id=$1 FOR UPDATE", [
            rating.agent_id,
          ])
        ).rows[0];
        const failures = (prior?.failures_in_row ?? 0) + 1;
        await c.query(
          `INSERT INTO agent_standing(agent_id,failures_in_row,superseded_at,superseded_reason,cooldown_until)
           VALUES($1,$2,now(),$3,now()+make_interval(secs => $4))
           ON CONFLICT(agent_id) DO UPDATE SET failures_in_row=$2,superseded_at=now(),
             superseded_reason=$3,cooldown_until=now()+make_interval(secs => $4)`,
          [rating.agent_id, failures, error, remoteCooldownMs(failures) / 1000],
        );
      } else if (!error)
        // A complete rating posted: the new score stands, and the run of failures is over. Also
        // for an agent registered again as a built-in design: its old standing ends only here.
        await c.query("DELETE FROM agent_standing WHERE agent_id=$1", [rating.agent_id]);
      await this.publish(
        `rating.${r.rows[0].status === "queued" ? "retry" : r.rows[0].status}`,
        { runId: job.id },
        c,
      );
    });
  }
  /**
   * Record a revealed bounty for validation. Idempotent: posting the same submission again
   * returns its current status without queueing it twice.
   */
  async submitBounty(b: {
    chainId: number;
    submissionId: string;
    hunter: string;
    specUri: string;
    specYaml: string;
    spec: unknown;
  }): Promise<{ created: boolean; status: string }> {
    return this.transaction(async (c) => {
      const r = await c.query(
        `INSERT INTO bounties(chain_id,submission_id,hunter,spec_uri,spec_yaml,spec)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (chain_id,submission_id) DO NOTHING RETURNING status`,
        [b.chainId, b.submissionId, b.hunter, b.specUri, b.specYaml, json(b.spec)],
      );
      if (r.rowCount) {
        await this.publish(
          "bounty.revealed",
          { chainId: b.chainId, submissionId: b.submissionId },
          c,
        );
        return { created: true, status: r.rows[0].status as string };
      }
      const existing = await c.query(
        "SELECT status FROM bounties WHERE chain_id=$1 AND submission_id=$2",
        [b.chainId, b.submissionId],
      );
      return { created: false, status: existing.rows[0].status as string };
    });
  }
  /** Lease a waiting bounty, including exhausted jobs that still need chain reconciliation. */
  async takeBounty(chainId: number): Promise<BountyJob | undefined> {
    return this.transaction(async (c) => {
      const r = await c.query(
        `UPDATE bounties SET token=$1,attempts=attempts+CASE WHEN broadcast_pending THEN 0 ELSE 1 END,lease_until=now()+interval '60 seconds'
        WHERE (chain_id,submission_id)=(SELECT chain_id,submission_id FROM bounties
          WHERE chain_id=$2 AND status='validating' AND available_at<=now()
            AND (lease_until IS NULL OR lease_until<now())
          ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING submission_id,token,hunter,spec,verdict,attempts,broadcast_pending,pending_tx_hash,pending_nonce`,
        [randomUUID(), chainId],
      );
      const row = r.rows[0];
      return row
        ? {
            chainId,
            submissionId: String(row.submission_id),
            token: row.token as string,
            hunter: row.hunter as string,
            attempts: row.attempts as number,
            broadcastPending: row.broadcast_pending as boolean,
            pendingTxHash: row.pending_tx_hash as string | null,
            pendingNonce: row.pending_nonce === null ? null : Number(row.pending_nonce),
            spec: row.spec,
            verdict: row.verdict,
          }
        : undefined;
    });
  }
  /** Extend a bounty lease this worker still holds. */
  async renewBounty(job: BountyJob) {
    const r = await this.pool.query(
      `UPDATE bounties SET lease_until=now()+interval '60 seconds'
      WHERE chain_id=$1 AND submission_id=$2 AND token=$3 AND status='validating' AND lease_until>now()`,
      [job.chainId, job.submissionId, job.token],
    );
    if (!r.rowCount) throw new Error("bounty lease lost");
  }
  /**
   * Record the verdict before its transaction is sent, so a retry settles the same decision
   * instead of recomputing it against a library that may have changed since.
   */
  async recordBountyVerdict(job: BountyJob, verdict: unknown) {
    const r = await this.pool.query(
      `UPDATE bounties SET verdict=$4 WHERE chain_id=$1 AND submission_id=$2 AND token=$3
        AND status='validating' AND lease_until>now()`,
      [job.chainId, job.submissionId, job.token, json(verdict)],
    );
    if (!r.rowCount) throw new Error("bounty lease lost");
  }
  /** Persist send intent before broadcasting, its hash afterward, or a confirmed revert. */
  async recordBountyBroadcast(
    job: BountyJob,
    pending: boolean,
    hash: string | null = null,
    nonce: number | null = null,
  ) {
    // Clearing the pending state clears its nonce; marking it keeps a nonce already recorded.
    const r = await this.pool.query(
      `UPDATE bounties SET broadcast_pending=$4,pending_tx_hash=$5,
          pending_nonce=CASE WHEN $4 THEN COALESCE($6,pending_nonce) ELSE NULL END
        WHERE chain_id=$1 AND submission_id=$2 AND token=$3 AND status='validating' AND lease_until>now()`,
      [job.chainId, job.submissionId, job.token, pending, hash, nonce],
    );
    if (!r.rowCount) throw new Error("bounty lease lost");
  }
  /**
   * Record the decision, or schedule a retry after an error, if the lease still holds. An
   * acceptance queues a fresh rating of every enabled built-in agent on the chain in the same
   * transaction, so a bounty can't end accepted without its re-rating (docs/SPECIFICATION.md 13.1).
   * An operator-run agent is never rated on bounties (its operator would see them), so a re-rating
   * would test nothing new and only use up its caps: it is skipped with the reason on record.
   */
  async finishBounty(
    job: BountyJob,
    outcome:
      | { status: "accepted" | "rejected"; verdict: unknown; txHash: string }
      | { error: string }
      | { failed: string },
  ) {
    await this.transaction(async (c) => {
      const done = "status" in outcome;
      const r = await c.query(
        `UPDATE bounties SET status=$4,verdict=COALESCE($5::jsonb,verdict),tx_hash=COALESCE($6,tx_hash),
          error=$7,lease_until=NULL,available_at=now()+interval '30 seconds',
          broadcast_pending=CASE WHEN $4='validating' THEN broadcast_pending ELSE false END,
          pending_tx_hash=CASE WHEN $4='validating' THEN pending_tx_hash ELSE NULL END
        WHERE chain_id=$1 AND submission_id=$2 AND token=$3 AND status='validating' AND lease_until>now()
        RETURNING status`,
        [
          job.chainId,
          job.submissionId,
          job.token,
          done ? outcome.status : "failed" in outcome ? "failed" : "validating",
          done ? json(outcome.verdict) : null,
          done ? outcome.txHash : null,
          done ? null : "failed" in outcome ? outcome.failed : outcome.error,
        ],
      );
      if (!r.rowCount) throw new Error("bounty lease lost");
      if (done && outcome.status === "accepted") {
        const agents = await c.query(
          `SELECT a.id, a.config->>'kind'='remote' AS remote
           FROM agents a WHERE a.chain_id=$1 AND a.enabled`,
          [job.chainId],
        );
        for (const row of agents.rows)
          if (row.remote)
            await this.recordRatingSkip(
              row.id as string,
              "bounty",
              `bounty ${job.submissionId} was accepted, but bounty attacks aren't run against operator-run agents, so no re-rating was queued`,
              c,
            );
          else await this.enqueueIn(c, row.id as string);
      }
      await this.publish(
        `bounty.${done ? outcome.status : "failed" in outcome ? "failed" : "retry"}`,
        { chainId: job.chainId, submissionId: job.submissionId },
        c,
      );
    });
  }
  /** The WHERE clause for episode filters, up to and including event `through`. */
  private episodeWhere(f: EpisodeFilters, through: string, values: unknown[], outcome: boolean) {
    const param = (v: unknown) => `$${values.push(v)}`;
    const where = ["e.topic='rating.episode'", `e.id <= ${param(through)}::bigint`];
    if (f.runId) where.push(`e.payload->>'runId' = ${param(f.runId)}`);
    if (f.attackId) where.push(`e.payload->'episode'->>'attackId' = ${param(f.attackId)}`);
    if (f.agentId && f.chainId !== undefined)
      where.push(
        `e.payload->>'runId' IN (SELECT r.id::text FROM ratings r JOIN agents a ON a.id = r.agent_id
          WHERE a.chain_id = ${param(f.chainId)} AND a.agent_id = ${param(f.agentId)}::numeric)`,
      );
    if (f.attackClass) where.push(`e.payload->'episode'->>'attackClass' = ${param(f.attackClass)}`);
    // Only built when filtering by source: an unused parameter makes Postgres reject the query.
    const unpublished = () =>
      f.publishedIds
        ? `NOT (e.payload->'episode'->>'attackId' = ANY(${param([...f.publishedIds])}::text[]))`
        : PRIVATE_ATTACK;
    if (f.source === "held-out")
      where.push(`e.payload->'episode'->>'attackClass' IS NOT NULL AND ${unpublished()}`);
    if (f.source === "library")
      where.push(`e.payload->'episode'->>'attackClass' IS NOT NULL AND NOT (${unpublished()})`);
    if (f.since) where.push(`e.created_at >= now() - ${param(SINCE[f.since])}::interval`);
    if (outcome && f.outcome) where.push(OUTCOME_SQL[f.outcome]);
    return where.join(" AND ");
  }
  /**
   * Episode counts by outcome through event `through`, with every filter but the outcome:
   * the outcome chips show these, and the list's total is the chosen outcome's count.
   */
  async episodeCounts(f: EpisodeFilters, through: string): Promise<EpisodeCounts> {
    const values: unknown[] = [];
    const where = this.episodeWhere(f, through, values, false);
    const r = await this.pool.query(
      `SELECT count(*)::int AS total,
        count(*) FILTER (WHERE ${OUTCOME_SQL.held})::int AS held,
        count(*) FILTER (WHERE ${OUTCOME_SQL.breach})::int AS breach,
        count(*) FILTER (WHERE ${OUTCOME_SQL.control})::int AS control
      FROM events e WHERE ${where}`,
      values,
    );
    return r.rows[0];
  }
  /**
   * One numbered page of Arena episodes, newest first, from a snapshot: only events up to
   * `through`, so page 3 shows the same rows however many episodes arrive meanwhile. `counts`
   * comes from `episodeCounts` with the same filters and snapshot.
   */
  async episodes(
    f: EpisodeFilters,
    q: { through: string; counts: EpisodeCounts; page?: number; limit?: number },
  ): Promise<Page<EpisodeSummary>> {
    const limit = clampLimit(q.limit);
    const total = f.outcome ? q.counts[f.outcome] : q.counts.total;
    const at = pageOf(q.page, total, limit);
    const values: unknown[] = [];
    const where = this.episodeWhere(f, q.through, values, true);
    const r = await this.pool.query(
      `SELECT e.id, e.payload, e.created_at, a.agent_id::text AS onchain FROM events e
        LEFT JOIN ratings r ON r.id::text = e.payload->>'runId'
        LEFT JOIN agents a ON a.id = r.agent_id
      WHERE ${where} ORDER BY e.id DESC LIMIT ${limit} OFFSET ${at.offset}`,
      values,
    );
    const items = r.rows.map((row) => episodeSummary(row));
    return { items, page: at.page, pages: at.pages, total };
  }
  /** One Arena episode with its detail, or undefined if it doesn't exist or was pruned. */
  async episode(eventId: string): Promise<EpisodeRecord | undefined> {
    const r = await this.pool.query(
      `SELECT e.id, e.payload, e.created_at, a.agent_id::text AS onchain FROM events e
        LEFT JOIN ratings r ON r.id::text = e.payload->>'runId'
        LEFT JOIN agents a ON a.id = r.agent_id
      WHERE e.topic='rating.episode' AND e.id = $1::bigint`,
      [eventId],
    );
    const row = r.rows[0];
    if (!row) return undefined;
    const episode = row.payload.episode ?? {};
    return {
      ...episodeSummary(row),
      agent: typeof episode.agent === "string" ? episode.agent : null,
      durationMs: typeof episode.durationMs === "number" ? episode.durationMs : null,
      detail: episode.detail ?? null,
    };
  }
  /**
   * How each attack has done in the Arena episodes still on record (the events table keeps a
   * retention window): episodes, breaches, distinct runs and the latest episode, keyed by
   * attack id, plus when the oldest episode on record ran.
   */
  async attackStats(ids: readonly string[]): Promise<{
    stats: Map<string, AttackStats>;
    since: Date | null;
  }> {
    const r = await this.pool.query(
      `SELECT e.payload->'episode'->>'attackId' AS id, count(*)::int AS episodes,
        count(*) FILTER (WHERE (e.payload->'episode'->'verdict'->>'breached')::boolean IS TRUE)::int AS breaches,
        count(DISTINCT e.payload->>'runId')::int AS runs, max(e.created_at) AS last_at
      FROM events e
      WHERE e.topic='rating.episode' AND e.payload->'episode'->>'attackId' = ANY($1::text[])
      GROUP BY 1`,
      [ids],
    );
    const since = await this.pool.query(
      "SELECT min(created_at) AS since FROM events WHERE topic='rating.episode'",
    );
    return {
      stats: new Map(
        r.rows.map((row) => [
          row.id as string,
          { episodes: row.episodes, breaches: row.breaches, runs: row.runs, lastAt: row.last_at },
        ]),
      ),
      since: since.rows[0].since,
    };
  }
  /**
   * The newest event id. Counts taken through it plus a live stream opened after it miss
   * nothing and count nothing twice (ids are allocated in commit order, see `publish`).
   */
  async latestEventId(): Promise<string> {
    const r = await this.pool.query("SELECT coalesce(max(id),0)::text AS id FROM events");
    return r.rows[0].id;
  }
  /**
   * Bounties on a chain, one numbered page at a time, without payloads. Newest submission
   * first, or the largest reward first; filters by status, class, hunter or submission id.
   */
  async bounties(
    chainId: number,
    q: {
      status?: string;
      attackClass?: string;
      hunter?: string;
      submissionId?: string;
      sort?: "newest" | "reward";
      page?: number;
      limit?: number;
    } = {},
  ): Promise<Page<BountySummary>> {
    const limit = clampLimit(q.limit);
    const values: unknown[] = [chainId];
    const param = (v: unknown) => `$${values.push(v)}`;
    const where = ["chain_id=$1"];
    if (q.status) where.push(`status = ${param(q.status)}`);
    if (q.attackClass) where.push(`spec->>'class' = ${param(q.attackClass)}`);
    if (q.hunter) where.push(`lower(hunter) = lower(${param(q.hunter)})`);
    if (q.submissionId) where.push(`submission_id = ${param(q.submissionId)}::numeric`);
    const total = (
      await this.pool.query(
        `SELECT count(*)::int AS n FROM bounties WHERE ${where.join(" AND ")}`,
        values,
      )
    ).rows[0].n as number;
    const at = pageOf(q.page, total, limit);
    const order =
      q.sort === "reward"
        ? "coalesce((verdict->>'reward')::numeric, 0) DESC, submission_id DESC"
        : "submission_id DESC";
    const r = await this.pool.query(
      `SELECT submission_id,hunter,spec_uri,spec,status,verdict,tx_hash,created_at FROM bounties
      WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ${limit} OFFSET ${at.offset}`,
      values,
    );
    const items = r.rows.map((row) => {
      const spec = row.spec as { id: string; class: string; title: string; surfaces: string[] };
      const verdict = row.verdict as { reward?: string; reason?: string } | null;
      return {
        submissionId: String(row.submission_id),
        hunter: row.hunter,
        specUri: row.spec_uri,
        attackId: spec.id,
        attackClass: spec.class,
        title: spec.title,
        surfaces: spec.surfaces,
        status: row.status,
        reward: verdict?.reward ?? null,
        reason: verdict?.reason ?? null,
        txHash: row.tx_hash,
        createdAt: row.created_at,
      };
    });
    return { items, page: at.page, pages: at.pages, total };
  }
  /** Accepted attacks plus uncertain acceptance broadcasts reserve bounty eligibility. */
  async bountyValidationAttacks(chainId: number, submissionId: string): Promise<unknown[]> {
    const r = await this.pool.query(
      `SELECT spec FROM bounties WHERE chain_id=$1 AND submission_id<>$2 AND
        (status='accepted' OR (status='validating' AND broadcast_pending AND verdict->>'decision'='accept'))`,
      [chainId, submissionId],
    );
    return r.rows.map((row) => row.spec);
  }
  /** Accepted bounty specs, which join the attack library for this chain's ratings. */
  async acceptedAttacks(chainId: number): Promise<unknown[]> {
    const r = await this.pool.query(
      "SELECT spec FROM bounties WHERE chain_id=$1 AND status='accepted' ORDER BY created_at",
      [chainId],
    );
    return r.rows.map((row) => row.spec);
  }
  /**
   * Add or replace held-out attacks for a chain (an upload of a new set). Specs keep their id;
   * uploading the same id again replaces its spec and retirement date.
   */
  async addHeldOutAttacks(
    chainId: number,
    specs: { id: string }[],
    retireAfter: Date,
  ): Promise<number> {
    await this.transaction(async (c) => {
      for (const spec of specs)
        await c.query(
          `INSERT INTO held_out_attacks (chain_id, attack_id, spec, retire_after) VALUES ($1,$2,$3,$4)
          ON CONFLICT (chain_id, attack_id) DO UPDATE SET spec=EXCLUDED.spec, retire_after=EXCLUDED.retire_after`,
          [chainId, spec.id, JSON.stringify(spec), retireAfter],
        );
    });
    return specs.length;
  }
  /** Held-out attacks not yet retired at `now`: these join every rating on the chain. */
  async activeHeldOutAttacks(chainId: number, now = new Date()): Promise<unknown[]> {
    const r = await this.pool.query(
      "SELECT spec FROM held_out_attacks WHERE chain_id=$1 AND retire_after>$2 ORDER BY attack_id",
      [chainId, now],
    );
    return r.rows.map((row) => row.spec);
  }
  /** How many held-out attacks are active, and when the first of them retires. No payloads. */
  async heldOutSummary(
    chainId: number,
    now = new Date(),
  ): Promise<{ active: number; retiresFrom: Date | null }> {
    const r = await this.pool.query(
      "SELECT count(*)::int AS active, min(retire_after) AS retires_from FROM held_out_attacks WHERE chain_id=$1 AND retire_after>$2",
      [chainId, now],
    );
    return { active: r.rows[0].active, retiresFrom: r.rows[0].retires_from };
  }
  /** One bounty's status, for a repeated reveal. */
  async bountyStatus(chainId: number, submissionId: string): Promise<string | undefined> {
    const r = await this.pool.query(
      "SELECT status FROM bounties WHERE chain_id=$1 AND submission_id=$2",
      [chainId, submissionId],
    );
    return r.rows[0]?.status as string | undefined;
  }
  // Bring your own agent, round 2 (migrations 0020 and 0021): sessions, previews, Agent URLs,
  // connection checks and notification settings.

  /**
   * How an operator-run agent is reached: by its Agent URL when registered so or when it has a
   * live one (registering a URL switches it; revoking switches it back), else by its runner.
   */
  async connectionOf(key: string, config: unknown): Promise<ConnectionKind> {
    return this.connectionOfIn(this.pool, key, config);
  }
  private async connectionOfIn(
    c: Connection | pg.Pool,
    key: string,
    config: unknown,
  ): Promise<ConnectionKind> {
    if ((config as { connection?: unknown } | null)?.connection === "url") return "url";
    const live = await c.query(
      "SELECT 1 FROM agent_urls WHERE owner_key=$1 AND revoked_at IS NULL",
      [key],
    );
    return live.rowCount ? "url" : "runner";
  }
  /** Record a signature as used; false when it already was (a replay). */
  async useSignature(hash: string): Promise<boolean> {
    const r = await this.pool.query(
      "INSERT INTO used_signatures(hash) VALUES($1) ON CONFLICT DO NOTHING",
      [hash],
    );
    return (r.rowCount ?? 0) > 0;
  }
  /**
   * Whether `owner` may queue a preview rating now, by the same counts `enqueuePreviewRating`
   * applies, and how many remote ratings and previews are waiting or running on the chain.
   */
  async previewAllowance(
    owner: string,
    chainId: number,
    quota: PreviewQuota,
  ): Promise<{ refusal?: PreviewRefusal; queued: number }> {
    const since = new Date(quota.nowMs - 86_400_000);
    const counts = (
      await this.pool.query(
        `SELECT count(*) FILTER (WHERE r.charged_owner=$2)::int AS wallet,
           min(r.created_at) FILTER (WHERE r.charged_owner=$2) AS wallet_first,
           count(*)::int AS lane, min(r.created_at) AS lane_first
         FROM ratings r JOIN previews v ON v.id=r.preview_id
         WHERE v.chain_id=$1 AND r.kind='preview' AND r.created_at>=$3`,
        [chainId, owner.toLowerCase(), since],
      )
    ).rows[0];
    const queued = await this.remoteQueue(chainId);
    if (counts.wallet >= quota.perWalletDaily)
      return {
        refusal: {
          refused: "wallet-daily",
          nextAt: new Date(
            ((counts.wallet_first as Date | null)?.getTime() ?? quota.nowMs) + 86_400_000,
          ),
        },
        queued,
      };
    if (counts.lane >= quota.daily)
      return {
        refusal: {
          refused: "daily",
          nextAt: new Date(
            ((counts.lane_first as Date | null)?.getTime() ?? quota.nowMs) + 86_400_000,
          ),
        },
        queued,
      };
    return { queued };
  }
  /**
   * Remote ratings and previews waiting or running on the chain; with `runId`, those ahead of it
   * (official ratings always go first, then previews by when they were queued).
   */
  async remoteQueue(chainId: number, runId?: string): Promise<number> {
    const r = await this.pool.query(
      `WITH lane AS (
         SELECT j.id, r.kind, j.available_at, j.status FROM jobs j JOIN ratings r ON r.id=j.id
         LEFT JOIN agents a ON a.id=r.agent_id LEFT JOIN previews v ON v.id=r.preview_id
         WHERE coalesce(a.chain_id, v.chain_id)=$1 AND (r.kind='remote' OR r.kind='preview')
           AND j.status IN ('queued','running') AND j.attempts<3
       ), me AS (SELECT * FROM lane WHERE id=$2::uuid)
       SELECT count(*)::int AS n FROM lane l
       WHERE $2::uuid IS NULL OR (l.id<>$2::uuid AND (l.status='running'
         OR (SELECT kind FROM me)='preview' AND (l.kind='remote' OR l.available_at < (SELECT available_at FROM me))
         OR (SELECT kind FROM me)='remote' AND l.kind='remote' AND l.available_at < (SELECT available_at FROM me)))`,
      [chainId, runId ?? null],
    );
    return r.rows[0].n as number;
  }
  /** Lock an agent's or a preview's row for the rest of the caller's transaction. */
  private async lockSubject(c: Connection, key: string) {
    if (key.startsWith(PREVIEW_PREFIX))
      await c.query("SELECT 1 FROM previews WHERE id::text=$1 FOR UPDATE", [
        key.slice(PREVIEW_PREFIX.length),
      ]);
    else await c.query("SELECT 1 FROM agents WHERE id=$1 FOR UPDATE", [key]);
  }
  /** Whether a preview's runner is connected on its live token, in the preview's mode. */
  private async previewRunnerConnected(key: string): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT EXISTS (SELECT 1 FROM runner_presence p JOIN runner_tokens t ON t.id=p.token_id
         JOIN previews v ON 'preview:'||v.id::text=p.agent_id
         WHERE p.agent_id=$1 AND p.connected AND t.revoked_at IS NULL AND t.created_by=v.owner
           AND p.mode IS NOT DISTINCT FROM v.mode
           AND p.last_heartbeat_at > now() - make_interval(secs => $2)) AS ok`,
      [key, RUNNER_FRESH_MS / 1000],
    );
    return r.rows[0]?.ok === true;
  }
  /** What the agent's (or preview's) connected runner or verified Agent URL reports about its code. */
  private async reportedCodeIn(
    c: Connection | pg.Pool,
    key: string,
    connection: ConnectionKind,
  ): Promise<RatedCode | undefined> {
    if (connection === "url") {
      const u = (
        await c.query(
          "SELECT code_hash FROM agent_urls WHERE owner_key=$1 AND revoked_at IS NULL AND verified_at IS NOT NULL",
          [key],
        )
      ).rows[0];
      return u?.code_hash ? { hash: u.code_hash, source: "url" } : undefined;
    }
    const p = (
      await c.query(
        `SELECT p.code_hash,p.code_source,p.code_detail FROM runner_presence p JOIN runner_tokens t ON t.id=p.token_id
         WHERE p.agent_id=$1 AND p.connected AND t.revoked_at IS NULL
           AND p.last_heartbeat_at > now() - make_interval(secs => $2)`,
        [key, RUNNER_FRESH_MS / 1000],
      )
    ).rows[0];
    return p?.code_hash
      ? {
          hash: p.code_hash,
          source: p.code_source ?? "runner",
          ...(p.code_detail ? { detail: p.code_detail } : {}),
        }
      : undefined;
  }
  /**
   * The connection an agent or preview has now: its live runner token or Agent URL, whether it
   * can be reached (runner connected in the right mode, or URL verified), and the code it reports.
   */
  async currentConnection(key: string, connection: ConnectionKind): Promise<CurrentConnection> {
    if (connection === "url") {
      const u = await this.agentUrl(key);
      return {
        credentialId: u?.id ?? null,
        ready: Boolean(u?.verifiedAt),
        code: u?.verifiedAt && u.codeHash ? { hash: u.codeHash, source: "url" } : undefined,
      };
    }
    const token = (
      await this.pool.query(
        "SELECT id FROM runner_tokens WHERE agent_id=$1 AND revoked_at IS NULL",
        [key],
      )
    ).rows[0];
    const ready = Boolean(token) && (await this.runnerIsConnected(key));
    return {
      credentialId: token?.id ?? null,
      ready,
      code: ready ? await this.reportedCodeIn(this.pool, key, "runner") : undefined,
    };
  }

  /**
   * Open an owner session. Refused when this signature already opened one (a replay) or the
   * wallet opened `perWalletHourly` sessions in the last hour.
   */
  async createSession(
    s: { tokenHash: string; chainId: number; wallet: string; signatureHash: string; ttlMs: number },
    perWalletHourly: number,
  ): Promise<{ expiresAt: Date } | { refused: "replayed" | "too-many" }> {
    const wallet = s.wallet.toLowerCase();
    return this.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(7011, hashtext($1))", [wallet]);
      const seen = await c.query("SELECT 1 FROM owner_sessions WHERE signature_hash=$1", [
        s.signatureHash,
      ]);
      if (seen.rowCount) return { refused: "replayed" as const };
      const n = (
        await c.query(
          "SELECT count(*)::int AS n FROM owner_sessions WHERE wallet=$1 AND created_at > now() - interval '1 hour'",
          [wallet],
        )
      ).rows[0].n as number;
      if (n >= perWalletHourly) return { refused: "too-many" as const };
      const r = await c.query(
        `INSERT INTO owner_sessions(token_hash,chain_id,wallet,signature_hash,expires_at)
         VALUES($1,$2,$3,$4,now()+make_interval(secs => $5)) RETURNING expires_at`,
        [s.tokenHash, s.chainId, wallet, s.signatureHash, s.ttlMs / 1000],
      );
      return { expiresAt: r.rows[0].expires_at as Date };
    });
  }
  /** The wallet of a live session on this chain, or undefined. */
  async session(
    tokenHash: string,
    chainId: number,
  ): Promise<{ wallet: string; expiresAt: Date } | undefined> {
    const row = (
      await this.pool.query(
        `SELECT wallet,expires_at FROM owner_sessions
         WHERE token_hash=$1 AND chain_id=$2 AND revoked_at IS NULL AND expires_at > now()`,
        [tokenHash, chainId],
      )
    ).rows[0];
    return row ? { wallet: row.wallet, expiresAt: row.expires_at } : undefined;
  }
  /**
   * Delete what owner sign-ins leave behind once it can't matter: used signatures after a day
   * (a signature is accepted for 10 minutes) and sessions a day after they expired.
   */
  async pruneOwnerAuth(): Promise<{ signatures: number; sessions: number }> {
    const a = await this.pool.query(
      "DELETE FROM used_signatures WHERE created_at < now() - interval '1 day'",
    );
    const b = await this.pool.query(
      "DELETE FROM owner_sessions WHERE expires_at < now() - interval '1 day'",
    );
    return { signatures: a.rowCount ?? 0, sessions: b.rowCount ?? 0 };
  }
  /** End a session. */
  async revokeSession(tokenHash: string): Promise<boolean> {
    const r = await this.pool.query(
      "UPDATE owner_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL",
      [tokenHash],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /**
   * Create a preview for a wallet, unless it created `perWalletDaily` in the last 24 hours (then
   * `nextAt` is when it may create another).
   */
  async createPreview(
    p: {
      chainId: number;
      owner: string;
      mode: string;
      connection: ConnectionKind;
      codeHash?: string;
    },
    quota: { nowMs: number; perWalletDaily: number },
  ): Promise<PreviewRecord | { refused: "too-many"; nextAt: Date }> {
    const owner = p.owner.toLowerCase();
    return this.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(7012, hashtext($1))", [owner]);
      const since = new Date(quota.nowMs - 86_400_000);
      const made = (
        await c.query(
          "SELECT count(*)::int AS n, min(created_at) AS first FROM previews WHERE owner=$1 AND chain_id=$2 AND created_at>=$3",
          [owner, p.chainId, since],
        )
      ).rows[0];
      if (made.n >= quota.perWalletDaily)
        return {
          refused: "too-many" as const,
          nextAt: new Date((made.first as Date).getTime() + 86_400_000),
        };
      const r = await c.query(
        `INSERT INTO previews(id,chain_id,owner,mode,connection,code_hash,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`,
        [
          randomUUID(),
          p.chainId,
          owner,
          p.mode,
          p.connection,
          p.codeHash?.toLowerCase() ?? null,
          new Date(quota.nowMs),
        ],
      );
      await this.countFunnel("preview_started", c);
      return previewRow(r.rows[0]);
    });
  }
  /** A preview by id. */
  async preview(id: string): Promise<PreviewRecord | undefined> {
    const r = await this.pool.query("SELECT * FROM previews WHERE id=$1", [id]);
    return r.rows[0] ? previewRow(r.rows[0]) : undefined;
  }
  /** A wallet's previews, newest first, a numbered page at a time. */
  async previewsOf(
    owner: string,
    chainId: number,
    q: { page?: number; limit?: number } = {},
  ): Promise<Page<PreviewRecord>> {
    const limit = clampLimit(q.limit ?? 10);
    const total = (
      await this.pool.query(
        "SELECT count(*)::int AS n FROM previews WHERE owner=$1 AND chain_id=$2",
        [owner.toLowerCase(), chainId],
      )
    ).rows[0].n as number;
    const at = pageOf(q.page, total, limit);
    const r = await this.pool.query(
      `SELECT * FROM previews WHERE owner=$1 AND chain_id=$2
       ORDER BY created_at DESC, id LIMIT $3 OFFSET $4`,
      [owner.toLowerCase(), chainId, limit, at.offset],
    );
    return { items: r.rows.map(previewRow), page: at.page, pages: at.pages, total };
  }
  /** Set a preview's status (and its error, cleared when not given). */
  async setPreviewStatus(id: string, status: string, error?: string) {
    await this.pool.query("UPDATE previews SET status=$2,error=$3,updated_at=now() WHERE id=$1", [
      id,
      status,
      error ?? null,
    ]);
  }
  /**
   * Stop a preview: a queued rating is cancelled; a running one can't be (it finishes, or stops
   * at its first failed episode). Its runner token and Agent URL stop working.
   */
  async stopPreview(id: string): Promise<{ stopped: true } | { refused: "running" }> {
    return this.transaction(async (c) => {
      await c.query("SELECT 1 FROM previews WHERE id=$1 FOR UPDATE", [id]);
      const running = await c.query(
        `SELECT 1 FROM jobs j JOIN ratings r ON r.id=j.id
         WHERE r.preview_id=$1 AND j.status='running' AND j.lease_until>now()`,
        [id],
      );
      if (running.rowCount) return { refused: "running" as const };
      const cancelled = await c.query(
        `UPDATE jobs j SET status='failed',lease_until=NULL FROM ratings r
         WHERE j.id=r.id AND r.preview_id=$1 AND j.status IN ('queued','running') RETURNING j.id`,
        [id],
      );
      for (const row of cancelled.rows)
        await c.query(
          "UPDATE ratings SET status='failed',error='stopped by its owner' WHERE id=$1",
          [row.id],
        );
      await c.query("UPDATE previews SET status='stopped',updated_at=now() WHERE id=$1", [id]);
      await c.query(
        "UPDATE runner_tokens SET revoked_at=now() WHERE agent_id=$1 AND revoked_at IS NULL",
        [previewKey(id)],
      );
      await c.query(
        "UPDATE runner_presence SET connected=false,disconnected_at=now() WHERE agent_id=$1 AND connected",
        [previewKey(id)],
      );
      await c.query(
        "UPDATE agent_urls SET revoked_at=now() WHERE owner_key=$1 AND revoked_at IS NULL",
        [previewKey(id)],
      );
      return { stopped: true as const };
    });
  }
  /** Record that an agent was registered from this preview ("Make it official"). */
  async linkPreviewUpgrade(id: string, owner: string, agentKey: string): Promise<boolean> {
    const r = await this.pool.query(
      "UPDATE previews SET upgraded_to=$3,updated_at=now() WHERE id=$1 AND owner=$2",
      [id, owner.toLowerCase(), agentKey],
    );
    return (r.rowCount ?? 0) > 0;
  }
  /** The latest preview an agent was registered from, if any. */
  async previewUpgradedTo(agentKey: string): Promise<PreviewRecord | undefined> {
    const r = await this.pool.query(
      "SELECT * FROM previews WHERE upgraded_to=$1 ORDER BY updated_at DESC LIMIT 1",
      [agentKey],
    );
    return r.rows[0] ? previewRow(r.rows[0]) : undefined;
  }

  /**
   * Queue a preview's rating, within the preview caps: `perWalletDaily` per wallet and `daily` on
   * the chain, over the last 24 hours (`nextAt` is when one is free again). Refused while the
   * preview already has one queued or running. The rating is not published to the public feed.
   */
  async enqueuePreviewRating(
    previewId: string,
    quota: PreviewQuota,
    code?: RatedCode,
  ): Promise<{ runId: string } | PreviewRefusal> {
    return this.transaction(async (c) => {
      const preview = (await c.query("SELECT * FROM previews WHERE id=$1 FOR UPDATE", [previewId]))
        .rows[0];
      if (!preview) throw new AgentNotConfiguredError("preview not found");
      await c.query("SELECT pg_advisory_xact_lock(7014,$1)", [preview.chain_id]);
      const busy = await c.query(
        `SELECT 1 FROM ratings r JOIN jobs j ON j.id=r.id
         WHERE r.preview_id=$1 AND j.status IN ('queued','running')`,
        [previewId],
      );
      if (busy.rowCount) return { refused: "busy" as const };
      const since = new Date(quota.nowMs - 86_400_000);
      const counts = (
        await c.query(
          `SELECT count(*) FILTER (WHERE r.charged_owner=$2)::int AS wallet,
             min(r.created_at) FILTER (WHERE r.charged_owner=$2) AS wallet_first,
             count(*)::int AS lane, min(r.created_at) AS lane_first
           FROM ratings r JOIN previews v ON v.id=r.preview_id
           WHERE v.chain_id=$1 AND r.kind='preview' AND r.created_at>=$3`,
          [preview.chain_id, preview.owner, since],
        )
      ).rows[0];
      if (counts.wallet >= quota.perWalletDaily)
        return {
          refused: "wallet-daily" as const,
          nextAt: new Date((counts.wallet_first as Date).getTime() + 86_400_000),
        };
      if (counts.lane >= quota.daily)
        return {
          refused: "daily" as const,
          nextAt: new Date((counts.lane_first as Date).getTime() + 86_400_000),
        };
      const id = randomUUID();
      const rated: RatedCode | undefined =
        code ?? (preview.code_hash ? { hash: preview.code_hash, source: "declared" } : undefined);
      await c.query(
        `INSERT INTO ratings(id,agent_id,preview_id,created_at,kind,charged_owner,config,code_hash,code_source)
         VALUES($1,NULL,$2,$3,'preview',$4,$5,$6,$7)`,
        [
          id,
          previewId,
          new Date(quota.nowMs),
          preview.owner,
          json({ kind: "preview", mode: preview.mode, connection: preview.connection }),
          rated?.hash.toLowerCase() ?? null,
          rated?.source ?? null,
        ],
      );
      await c.query("INSERT INTO jobs(id) VALUES($1)", [id]);
      await c.query(
        "UPDATE previews SET status='queued',rating_id=$2,error=NULL,updated_at=now() WHERE id=$1",
        [previewId, id],
      );
      return { runId: id };
    });
  }
  /**
   * Claim the next preview rating on the chain, one at a time and only when no rating of an
   * operator-run agent is waiting or running: previews come after official ratings.
   */
  async takePreviewJob(chainId: number): Promise<{ id: string; token: string } | undefined> {
    return this.transaction(async (c) => {
      const exhausted = await c.query(
        `WITH candidates AS (
          SELECT j.id FROM jobs j JOIN ratings r ON r.id=j.id JOIN previews v ON v.id=r.preview_id
          WHERE v.chain_id=$1 AND j.attempts>=3
            AND (j.status='queued' OR (j.status='running' AND j.lease_until<now()))
          FOR UPDATE OF j SKIP LOCKED
        ) UPDATE jobs j SET status='failed',lease_until=NULL FROM candidates x WHERE j.id=x.id RETURNING j.id`,
        [chainId],
      );
      for (const row of exhausted.rows) {
        const r = await c.query(
          "UPDATE ratings SET status='failed',error='rating abandoned after three attempts' WHERE id=$1 RETURNING preview_id",
          [row.id],
        );
        await c.query(
          "UPDATE previews SET status='failed',error='rating abandoned after three attempts',updated_at=now() WHERE id=$1",
          [r.rows[0].preview_id],
        );
      }
      const r = await c.query(
        `UPDATE jobs SET status='running',token=$1,attempts=attempts+1,lease_until=now()+interval '60 seconds'
         WHERE id=(SELECT j.id FROM jobs j JOIN ratings r ON r.id=j.id JOIN previews v ON v.id=r.preview_id
           WHERE v.chain_id=$2 AND j.attempts<3
             AND ((j.status='queued' AND j.available_at<=now()) OR (j.status='running' AND j.lease_until<now()))
             AND NOT EXISTS (SELECT 1 FROM jobs j2 JOIN ratings r2 ON r2.id=j2.id JOIN agents a2 ON a2.id=r2.agent_id
               WHERE a2.chain_id=$2 AND a2.enabled AND r2.kind='remote' AND j2.attempts<3
                 AND ((j2.status='queued' AND j2.available_at<=now()) OR j2.status='running'))
             AND NOT EXISTS (SELECT 1 FROM jobs j3 JOIN ratings r3 ON r3.id=j3.id
               WHERE r3.kind='preview' AND j3.id<>j.id AND j3.status='running' AND j3.lease_until>now())
           ORDER BY j.available_at FOR UPDATE OF j SKIP LOCKED LIMIT 1)
         RETURNING id,token`,
        [randomUUID(), chainId],
      );
      if (r.rows[0])
        await c.query(
          "UPDATE previews SET status='starting',updated_at=now() WHERE id=(SELECT preview_id FROM ratings WHERE id=$1)",
          [r.rows[0].id],
        );
      return r.rows[0];
    });
  }
  /**
   * Fence a preview rating's end: done, refused (its report is kept, not attested) or failed (a
   * failure that isn't `final` is retried, up to three attempts). Returns the rating's status.
   */
  async finishPreview(job: { id: string; token: string }, outcome: PreviewOutcome) {
    return this.transaction(async (c) => {
      const failed = outcome.status !== "done";
      const retry = outcome.status === "failed" && outcome.final === false;
      const r = await c.query(
        `UPDATE jobs SET status=CASE WHEN $3='queued' AND attempts>=3 THEN 'failed' ELSE $3 END,lease_until=NULL,
           available_at=now()+interval '30 seconds'
         WHERE id=$1 AND token=$2 AND status='running' AND lease_until>now() RETURNING status`,
        [job.id, job.token, retry ? "queued" : failed ? "failed" : "done"],
      );
      if (!r.rowCount) throw new Error("job lease lost");
      const status = r.rows[0].status as string;
      const rating = (
        await c.query(
          "UPDATE ratings SET status=$2,error=$3,agent_caused=$4,agent_report=$5 WHERE id=$1 RETURNING preview_id",
          [
            job.id,
            status,
            outcome.error ?? null,
            Boolean(failed && outcome.agentCaused),
            outcome.agentReport ?? null,
          ],
        )
      ).rows[0];
      await c.query("UPDATE previews SET status=$2,error=$3,updated_at=now() WHERE id=$1", [
        rating.preview_id,
        status === "queued" ? "queued" : outcome.status,
        outcome.error ?? null,
      ]);
      if (status === "done") await this.countFunnel("preview_done", c);
      return status;
    });
  }
  /**
   * A rating's worker has taken it and is setting up (the sandbox, the held-out set): status
   * "starting", and its progress starts the clock. Its preview, if it has one, too.
   */
  async markStarting(job: { id: string; token: string }, startedAt = new Date()) {
    await this.withLease(job, async (c) => {
      const r = await c.query(
        "UPDATE ratings SET status='starting',progress=$2 WHERE id=$1 RETURNING preview_id",
        [job.id, json({ done: 0, total: null, startedAt: startedAt.toISOString() })],
      );
      if (r.rows[0]?.preview_id)
        await c.query("UPDATE previews SET status='starting',updated_at=now() WHERE id=$1", [
          r.rows[0].preview_id,
        ]);
    });
  }
  /** Set up: its episodes are running. */
  async markRunning(job: { id: string; token: string }) {
    await this.withLease(job, async (c) => {
      const r = await c.query(
        "UPDATE ratings SET status='running' WHERE id=$1 RETURNING preview_id",
        [job.id],
      );
      if (r.rows[0]?.preview_id)
        await c.query("UPDATE previews SET status='running',updated_at=now() WHERE id=$1", [
          r.rows[0].preview_id,
        ]);
    });
  }
  /** Record a running rating's progress (counts only) under its lease. */
  async setRatingProgress(
    job: { id: string; token: string },
    progress: { done: number; total: number | null; startedAt: Date },
  ) {
    await this.pool.query(
      // The set-up start (markStarting) is kept; the episodes' start is recorded beside it.
      `UPDATE ratings r SET progress=jsonb_build_object('startedAt',
           coalesce(r.progress->>'startedAt', $3::jsonb->>'episodesStartedAt')) || $3::jsonb
       FROM jobs j
       WHERE r.id=$1 AND j.id=r.id AND j.token=$2 AND j.status='running' AND j.lease_until>now()`,
      [
        job.id,
        job.token,
        json({
          done: progress.done,
          total: progress.total,
          episodesStartedAt: progress.startedAt.toISOString(),
          lastAt: new Date().toISOString(),
          counted: true,
        }),
      ],
    );
  }

  /**
   * Store a new Agent URL for an agent or preview, with its encrypted secret, replacing (revoking)
   * the live one in the same transaction.
   */
  async createAgentUrl(
    ownerKey: string,
    u: { url: string; ciphertext: string; createdBy: string; id?: string },
  ): Promise<{ id: string; createdAt: Date }> {
    return this.transaction(async (c) => {
      await this.lockSubject(c, ownerKey);
      await c.query(
        "UPDATE agent_urls SET revoked_at=now() WHERE owner_key=$1 AND revoked_at IS NULL",
        [ownerKey],
      );
      const r = await c.query(
        `INSERT INTO agent_urls(id,owner_key,url,secret_ciphertext,created_by) VALUES($1,$2,$3,$4,$5)
         RETURNING id,created_at`,
        [u.id ?? randomUUID(), ownerKey, u.url, u.ciphertext, u.createdBy.toLowerCase()],
      );
      return { id: r.rows[0].id as string, createdAt: r.rows[0].created_at as Date };
    });
  }
  /** The live Agent URL of an agent or preview. */
  async agentUrl(ownerKey: string): Promise<AgentUrlRecord | undefined> {
    const r = await this.pool.query(
      "SELECT * FROM agent_urls WHERE owner_key=$1 AND revoked_at IS NULL",
      [ownerKey],
    );
    return r.rows[0] ? agentUrlRow(r.rows[0]) : undefined;
  }
  /** Mark a live Agent URL verified, with the version it reported and its code hash. */
  async markAgentUrlVerified(
    id: string,
    reported: { version: string | null; codeHash: string | null },
  ): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE agent_urls SET verified_at=now(),version=$2,code_hash=$3
       WHERE id=$1 AND revoked_at IS NULL`,
      [id, reported.version, reported.codeHash?.toLowerCase() ?? null],
    );
    return (r.rowCount ?? 0) > 0;
  }
  /** Revoke an agent's or preview's Agent URL (and so its secret). */
  async revokeAgentUrls(ownerKey: string, c?: Connection): Promise<number> {
    const r = await (c ?? this.pool).query(
      "UPDATE agent_urls SET revoked_at=now() WHERE owner_key=$1 AND revoked_at IS NULL",
      [ownerKey],
    );
    return r.rowCount ?? 0;
  }

  /**
   * Create a connection check, within its caps: one queued or running per agent or preview,
   * `perWalletHourly` per owner and `hourly` on the chain in the last hour. With `immediate`, the
   * check is stored as already failed with that result (the runner isn't connected, say): it
   * counts, but takes no turn in the lane.
   */
  async createCheck(
    input: {
      subject: string;
      chainId: number;
      owner: string;
      mode: string;
      connection: ConnectionKind;
      credentialId: string | null;
      code?: RatedCode | undefined;
    },
    caps: { perWalletHourly: number; hourly: number },
    immediate?: unknown,
  ): Promise<
    | ConnectionCheckRecord
    | { refused: "busy" }
    | { refused: "wallet-hourly" | "hourly"; nextAt: Date }
  > {
    const owner = input.owner.toLowerCase();
    return this.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(7013,$1)", [input.chainId]);
      const busy = await c.query(
        `SELECT 1 FROM connection_checks WHERE subject=$1
           AND (status='queued' OR (status='running' AND lease_until>now()))`,
        [input.subject],
      );
      if (busy.rowCount) return { refused: "busy" as const };
      const counts = (
        await c.query(
          // The wallet's cap counts every check it asked for; the chain's counts only the checks
          // that took a turn in the lane (one that failed at once ran nothing), so throwaway
          // wallets can't use it up with checks that cost nothing.
          `SELECT count(*) FILTER (WHERE owner=$2)::int AS wallet,
             min(created_at) FILTER (WHERE owner=$2) AS wallet_first,
             count(*) FILTER (WHERE ${LANE_CHECK})::int AS lane,
             min(created_at) FILTER (WHERE ${LANE_CHECK}) AS lane_first
           FROM connection_checks WHERE chain_id=$1 AND created_at > now() - interval '1 hour'`,
          [input.chainId, owner],
        )
      ).rows[0];
      if (counts.wallet >= caps.perWalletHourly)
        return {
          refused: "wallet-hourly" as const,
          nextAt: new Date((counts.wallet_first as Date).getTime() + 3_600_000),
        };
      if (counts.lane >= caps.hourly)
        return {
          refused: "hourly" as const,
          nextAt: new Date((counts.lane_first as Date).getTime() + 3_600_000),
        };
      const r = await c.query(
        `INSERT INTO connection_checks(id,subject,chain_id,owner,mode,connection,credential_id,code_hash,
                                       code_source,status,result,finished_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $10='failed' THEN now() END) RETURNING *`,
        [
          randomUUID(),
          input.subject,
          input.chainId,
          owner,
          input.mode,
          input.connection,
          input.credentialId,
          input.code?.hash.toLowerCase() ?? null,
          input.code?.source ?? null,
          immediate === undefined ? "queued" : "failed",
          immediate === undefined ? null : json(immediate),
        ],
      );
      if (immediate !== undefined)
        await c.query("INSERT INTO connection_check_events(check_id,event) VALUES($1,$2)", [
          r.rows[0].id,
          json({ type: "result", ...(immediate as object) }),
        ]);
      return checkRow(r.rows[0]);
    });
  }
  /** A check by id. */
  async check(id: string): Promise<ConnectionCheckRecord | undefined> {
    const r = await this.pool.query("SELECT * FROM connection_checks WHERE id=$1", [id]);
    return r.rows[0] ? checkRow(r.rows[0]) : undefined;
  }
  /** A check's events after event id `after`, oldest first. */
  async checkEvents(
    id: string,
    after = "0",
    limit = 200,
  ): Promise<{ id: string; event: unknown }[]> {
    const r = await this.pool.query(
      `SELECT id::text AS id,event FROM connection_check_events
       WHERE check_id=$1 AND id>$2::bigint ORDER BY id LIMIT $3`,
      [id, after, limit],
    );
    return r.rows.map((row) => ({ id: row.id as string, event: row.event }));
  }
  /** The latest checks of an agent or preview, newest first. */
  async checksOf(subject: string, limit = 5): Promise<ConnectionCheckRecord[]> {
    const r = await this.pool.query(
      "SELECT * FROM connection_checks WHERE subject=$1 ORDER BY created_at DESC, id LIMIT $2",
      [subject, limit],
    );
    return r.rows.map(checkRow);
  }
  /**
   * The latest passing check of this connection within `withinMs` (default 24 hours): same mode,
   * connection, runner token or URL, and code hash.
   */
  async passingCheck(
    subject: string,
    config: CheckConfig,
    withinMs = 86_400_000,
  ): Promise<ConnectionCheckRecord | undefined> {
    const r = await this.pool.query(
      `SELECT * FROM connection_checks WHERE subject=$1 AND status='passed' AND mode=$2 AND connection=$3
         AND credential_id IS NOT DISTINCT FROM $4::uuid AND code_hash IS NOT DISTINCT FROM $5
         AND finished_at > now() - make_interval(secs => $6)
       ORDER BY finished_at DESC LIMIT 1`,
      [
        subject,
        config.mode,
        config.connection,
        config.credentialId,
        config.codeHash?.toLowerCase() ?? null,
        withinMs / 1000,
      ],
    );
    return r.rows[0] ? checkRow(r.rows[0]) : undefined;
  }
  /**
   * Claim the oldest queued check on the chain (a lease of `leaseMs`). A running check whose
   * lease ran out first is failed as interrupted: a check is cheap to run again, never retried.
   */
  async takeCheck(
    chainId: number,
    leaseMs = 180_000,
  ): Promise<{ id: string; token: string } | undefined> {
    return this.transaction(async (c) => {
      const lost = await c.query(
        `UPDATE connection_checks SET status='failed',result=$2,finished_at=now(),lease_until=NULL
         WHERE chain_id=$1 AND status='running' AND lease_until<now() RETURNING id`,
        [chainId, json(INTERRUPTED_CHECK)],
      );
      for (const row of lost.rows)
        await c.query("INSERT INTO connection_check_events(check_id,event) VALUES($1,$2)", [
          row.id,
          json({ type: "result", ...INTERRUPTED_CHECK }),
        ]);
      const r = await c.query(
        `UPDATE connection_checks SET status='running',token=$1,started_at=now(),
           lease_until=now()+make_interval(secs => $3)
         WHERE id=(SELECT id FROM connection_checks WHERE chain_id=$2 AND status='queued'
                   ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING id,token`,
        [randomUUID(), chainId, leaseMs / 1000],
      );
      return r.rows[0];
    });
  }
  /** Append an event to a running check (dropped once the check's lease is gone). */
  async addCheckEvent(job: { id: string; token: string }, event: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO connection_check_events(check_id,event)
       SELECT $1,$3 FROM connection_checks WHERE id=$1 AND token=$2 AND status='running'`,
      [job.id, job.token, json(event)],
    );
  }
  /**
   * Store a check's result: passed or failed. `code` replaces the code recorded at creation when
   * the check learned it (the runner reported it during the check).
   */
  async finishCheck(
    job: { id: string; token: string },
    result: { passed: boolean } & Record<string, unknown>,
    code?: RatedCode,
  ): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE connection_checks SET status=$3,result=$4,finished_at=now(),lease_until=NULL,
         code_hash=coalesce($5,code_hash),code_source=coalesce($6,code_source)
       WHERE id=$1 AND token=$2 AND status='running' RETURNING id`,
      [
        job.id,
        job.token,
        result.passed ? "passed" : "failed",
        json(result),
        code?.hash.toLowerCase() ?? null,
        code?.source ?? null,
      ],
    );
    const finished = (r.rowCount ?? 0) > 0;
    if (finished && result.passed) await this.countFunnel("check_passed");
    return finished;
  }

  /** An owner's notification settings, if they saved any. */
  async notificationSettings(owner: string): Promise<NotificationSettingsRecord | undefined> {
    const row = (
      await this.pool.query("SELECT * FROM notification_settings WHERE owner=$1", [
        owner.toLowerCase(),
      ])
    ).rows[0];
    return row
      ? {
          owner: row.owner,
          webhookUrl: row.webhook_url,
          webhookSecretCiphertext: row.webhook_secret_ciphertext,
          email: row.email,
          muted: row.muted ?? [],
          updatedAt: row.updated_at,
        }
      : undefined;
  }
  /** Save an owner's notification settings; fields left out are kept. */
  async saveNotificationSettings(
    owner: string,
    patch: {
      webhookUrl?: string | null;
      webhookSecretCiphertext?: string | null;
      email?: string | null;
      muted?: string[];
    },
  ): Promise<NotificationSettingsRecord> {
    const has = (k: keyof typeof patch) => Object.hasOwn(patch, k);
    await this.pool.query(
      `INSERT INTO notification_settings(owner,webhook_url,webhook_secret_ciphertext,email,muted)
       VALUES($1,$2,$3,$4,$9)
       ON CONFLICT(owner) DO UPDATE SET
         webhook_url=CASE WHEN $5 THEN EXCLUDED.webhook_url ELSE notification_settings.webhook_url END,
         webhook_secret_ciphertext=CASE WHEN $6 THEN EXCLUDED.webhook_secret_ciphertext
                                        ELSE notification_settings.webhook_secret_ciphertext END,
         email=CASE WHEN $7 THEN EXCLUDED.email ELSE notification_settings.email END,
         muted=CASE WHEN $8 THEN EXCLUDED.muted ELSE notification_settings.muted END,
         updated_at=now()`,
      [
        owner.toLowerCase(),
        patch.webhookUrl ?? null,
        patch.webhookSecretCiphertext ?? null,
        patch.email ?? null,
        has("webhookUrl"),
        has("webhookSecretCiphertext"),
        has("email"),
        has("muted"),
        patch.muted ?? [],
      ],
    );
    return (await this.notificationSettings(owner))!;
  }
  /** Claim the right to send one notification for a rating's outcome: true only the first time. */
  async claimNotification(ratingId: string, type: string): Promise<boolean> {
    const r = await this.pool.query(
      "INSERT INTO notifications_sent(rating_id,type) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [ratingId, type],
    );
    return (r.rowCount ?? 0) > 0;
  }
  /**
   * Record a notification for an owner's in-app list. Returns its id the first time its
   * `dedupeKey` is seen, undefined after (so it is sent once).
   */
  async addNotification(n: {
    owner: string;
    type: string;
    dedupeKey: string;
    subject?: string | null;
    payload: unknown;
  }): Promise<string | undefined> {
    const r = await this.pool.query(
      `INSERT INTO owner_notifications(owner,type,dedupe_key,subject,payload) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,
      [n.owner.toLowerCase(), n.type, n.dedupeKey, n.subject ?? null, json(n.payload)],
    );
    return r.rows[0]?.id as string | undefined;
  }
  /** Whether a notification with this key was recorded. */
  async notified(dedupeKey: string): Promise<boolean> {
    const r = await this.pool.query("SELECT 1 FROM owner_notifications WHERE dedupe_key=$1", [
      dedupeKey,
    ]);
    return (r.rowCount ?? 0) > 0;
  }
  /** An owner's notifications, newest first, `before` an id for the next page. */
  async inbox(
    owner: string,
    options: { limit?: number; before?: string; unread?: boolean } = {},
  ): Promise<{ items: InboxItem[]; unread: number }> {
    const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
    const [items, unread] = await Promise.all([
      this.pool.query(
        `SELECT * FROM owner_notifications WHERE owner=$1 AND ($2::bigint IS NULL OR id<$2)
           AND (NOT $4 OR read_at IS NULL)
         ORDER BY id DESC LIMIT $3`,
        [owner.toLowerCase(), options.before ?? null, limit, options.unread === true],
      ),
      this.pool.query(
        "SELECT count(*)::int AS n FROM owner_notifications WHERE owner=$1 AND read_at IS NULL",
        [owner.toLowerCase()],
      ),
    ]);
    return {
      items: items.rows.map((row) => ({
        id: String(row.id),
        type: row.type,
        subject: row.subject,
        payload: row.payload,
        createdAt: row.created_at,
        readAt: row.read_at,
      })),
      unread: unread.rows[0].n,
    };
  }
  /** Mark an owner's notifications read: these ids, or all of them up to `through`. */
  async markInboxRead(owner: string, ids: readonly string[] | { through: string }) {
    const r = Array.isArray(ids)
      ? await this.pool.query(
          "UPDATE owner_notifications SET read_at=now() WHERE owner=$1 AND id=ANY($2::bigint[]) AND read_at IS NULL",
          [owner.toLowerCase(), ids],
        )
      : await this.pool.query(
          "UPDATE owner_notifications SET read_at=now() WHERE owner=$1 AND id<=$2 AND read_at IS NULL",
          [owner.toLowerCase(), (ids as { through: string }).through],
        );
    return r.rowCount ?? 0;
  }
  /** Drop notifications older than `before`. */
  async pruneNotifications(before: Date): Promise<number> {
    const r = await this.pool.query("DELETE FROM owner_notifications WHERE created_at<$1", [
      before,
    ]);
    return r.rowCount ?? 0;
  }

  /** Count one funnel step today (UTC). Counters only: nothing about who. */
  async countFunnel(step: FunnelStep, c: pg.Pool | Connection = this.pool, at = new Date()) {
    await c.query(
      `INSERT INTO funnel_daily(day,step,count) VALUES(($1::timestamptz AT TIME ZONE 'UTC')::date,$2,1)
       ON CONFLICT(day,step) DO UPDATE SET count=funnel_daily.count+1`,
      [at, step],
    );
  }
  /** Daily funnel counts for the last `days` days (UTC), oldest first; missing days are zeros. */
  async funnel(days: number, now = new Date()) {
    const r = await this.pool.query(
      `SELECT to_char(d.day,'YYYY-MM-DD') AS day, s.step, coalesce(f.count,0)::int AS count
       FROM generate_series((($2::timestamptz AT TIME ZONE 'UTC')::date - ($1::int - 1)),
                            ($2::timestamptz AT TIME ZONE 'UTC')::date, interval '1 day') AS d(day)
       CROSS JOIN unnest($3::text[]) AS s(step)
       LEFT JOIN funnel_daily f ON f.day=d.day::date AND f.step=s.step
       ORDER BY d.day, s.step`,
      [days, now, [...FUNNEL_STEPS]],
    );
    const byDay = new Map<string, Record<FunnelStep, number>>();
    for (const row of r.rows) {
      const counts =
        byDay.get(row.day) ??
        (Object.fromEntries(FUNNEL_STEPS.map((s) => [s, 0])) as Record<FunnelStep, number>);
      counts[row.step as FunnelStep] = row.count;
      byDay.set(row.day, counts);
    }
    return [...byDay.entries()].map(([day, counts]) => ({ day, ...counts }));
  }

  /** A vault's (or module's) trades through `execute`, from the keeper's index. */
  async vaultActivity(chainId: number, vault: string, now = new Date()): Promise<VaultActivity> {
    const r = await this.pool.query(
      `SELECT min(occurred_at) AS first, max(occurred_at) AS last, count(*)::int AS total,
         count(*) FILTER (WHERE occurred_at > $3::timestamptz - interval '24 hours')::int AS day,
         count(*) FILTER (WHERE occurred_at > $3::timestamptz - interval '7 days')::int AS week,
         (SELECT tx_hash FROM vault_trades WHERE chain_id=$1 AND vault=$2 ORDER BY occurred_at DESC, id DESC LIMIT 1) AS tx,
         (SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY g.gas_used) FROM
            (SELECT gas_used FROM vault_trades WHERE chain_id=$1 AND vault=$2 AND gas_used IS NOT NULL
             ORDER BY occurred_at DESC LIMIT 20) g) AS gas
       FROM vault_trades WHERE chain_id=$1 AND vault=$2`,
      [chainId, vault.toLowerCase(), now],
    );
    const row = r.rows[0];
    return {
      firstTradeAt: row.first,
      lastTradeAt: row.last,
      trades24h: row.day,
      trades7d: row.week,
      total: row.total,
      lastTxHash: row.tx,
      medianGas: row.gas === null || row.gas === undefined ? null : BigInt(row.gas),
    };
  }
  /** The keeper's breaches for a vault (newest first), with their claim state. */
  async vaultBreaches(chainId: number, vault: string, limit = 20) {
    const r = await this.pool.query(
      `SELECT id,breach_id,breach_type,blocked,occurred_at,status,tx_hash,claim_filed_at
       FROM handled_events WHERE chain_id=$1 AND vault=$2 ORDER BY occurred_at DESC NULLS LAST, id DESC LIMIT $3`,
      [chainId, vault.toLowerCase(), limit],
    );
    return r.rows.map((row) => ({
      key: row.id as string,
      breachId: String(row.breach_id),
      breachType: row.breach_type as number | null,
      blocked: row.blocked as boolean | null,
      occurredAt: row.occurred_at as Date | null,
      status: row.status as string,
      claimTxHash: row.tx_hash as string | null,
      claimFiledAt: row.claim_filed_at as Date | null,
    }));
  }

  /** Close idle clients and wait for borrowed clients to return. Drain streams first. */
  async close() {
    await this.pool.end();
  }
}

/**
 * The chain's on-chain state from its old deployment (see Database.adoptDeployment). Agent-keyed
 * rows use "<chainId>:<agentId>"; preview-keyed ones ("preview:<uuid>") are kept. Children
 * before parents, so foreign keys hold at every step.
 */
async function clearChainState(c: Connection, chainId: number): Promise<Record<string, number>> {
  const agent = `${chainId}:%`;
  const ratings = "SELECT id FROM ratings WHERE agent_id LIKE $1";
  const byAgent: [string, string][] = [
    ["notifications_sent", `rating_id IN (${ratings})`],
    ["jobs", `id IN (${ratings})`],
    ["attestations", "agent_id LIKE $1"],
    ["ratings", "agent_id LIKE $1"],
    ["rating_skips", "agent_id LIKE $1"],
    ["agent_standing", "agent_id LIKE $1"],
    ["runner_presence", "agent_id LIKE $1"],
    ["runner_tokens", "agent_id LIKE $1"],
    ["agent_urls", "owner_key LIKE $1"],
    [
      "connection_check_events",
      "check_id IN (SELECT id FROM connection_checks WHERE subject LIKE $1)",
    ],
    ["connection_checks", "subject LIKE $1"],
    ["tee_checks", "agent_id LIKE $1"],
    ["owner_notifications", "subject LIKE $1"],
  ];
  const byChain = [
    "quotes",
    "sentinel_checks",
    "bounties",
    "keeper_cursors",
    "keeper_vaults",
    "keeper_policies",
    "handled_events",
    "vault_trades",
    "agents",
  ];
  const cleared: Record<string, number> = {};
  // A preview made official points at the old agent: it goes back to a plain preview.
  await c.query("UPDATE previews SET upgraded_to=NULL WHERE upgraded_to LIKE $1", [agent]);
  for (const [table, where] of byAgent)
    cleared[table] = (await c.query(`DELETE FROM ${table} WHERE ${where}`, [agent])).rowCount ?? 0;
  for (const table of byChain)
    cleared[table] =
      (await c.query(`DELETE FROM ${table} WHERE chain_id=$1`, [chainId])).rowCount ?? 0;
  return cleared;
}
