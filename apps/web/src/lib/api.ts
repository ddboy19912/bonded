import type { BindingLevel, RemoteMode, SelfServeAgentKind, SelfServeKind } from "@bondedhq/shared";
import type { AttackSpec, Susceptibility } from "@bondedhq/shared";
import { apiUrl } from "../config";
import type { EpisodeCard, EpisodeCounts, Outcome } from "./events";
import type { AgentUrlInfo, CheckSummary, CodeHashInfo, Connection } from "./byoa-api";
import type { AgentGas, VaultActivity } from "./health";

/**
 * Error from the Bonded API, carrying its HTTP status, the API's error message and the rest of
 * its error body (for example when a refused request can be tried again).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, init);
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof body === "object" && body && "error" in body
        ? String(body.error)
        : response.statusText;
    throw new ApiError(
      response.status,
      message || `request failed (${response.status})`,
      typeof body === "object" && body ? (body as Record<string, unknown>) : {},
    );
  }
  return body as T;
}

/** GET /sentinel: whether Sentinel runs on this API, and checks in the last day. */
export interface SentinelStatus {
  /** Sentinel is set up on this API. */
  configured: boolean;
  /** It answers: its health probe passes and checks aren't failing. */
  available: boolean;
  model?: string;
  questions?: string;
  blockThreshold?: number;
  fallback?: { model: string; questions: string; unsureBand: [number, number] };
  pipelineHash?: string;
  metrics24h?: {
    checks: number;
    errors: number;
    escalations: number;
    escalationRate: number | null;
    knownCostChecks: number;
    llmCostUsd: number | null;
    llmUsdPer1000: number | null;
    latencyMs: { p50: number | null; p95: number | null };
    primaryLatencyMs: { p50: number | null; p95: number | null };
    fallbackLatencyMs: { p50: number | null; p95: number | null };
  };
  last24h: { checks: number; blocked: number };
}

/** GET /sentinel/agents/:id: one agent's Sentinel checks in the last 7 days. */
export interface SentinelAgentChecks {
  last7d: { checks: number; blocked: number };
  lastCheckAt: string | null;
}

/** One numbered page of a list: `page` is 1-based, `pages` is at least 1. */
export interface Paged<T> {
  items: T[];
  page: number;
  pages: number;
  total: number;
}

/** GET /episodes: a page of a snapshot taken through event `through`, and its counts. */
export interface EpisodesPage extends Paged<EpisodeCard> {
  through: string;
  /** By outcome, with every filter but the outcome. */
  counts: EpisodeCounts;
}

/**
 * What an episode's page shows (`EpisodeDetail` in apps/arena/src/report.ts). For a held-out or
 * bounty attack, `attack.planted`, guard reasons and `finalMessage` are never sent.
 */
export interface EpisodeDetail {
  task: string;
  attack: {
    published: boolean;
    title?: string;
    surfaces: string[];
    planted?: {
      surface: string;
      sender?: string;
      token?: string;
      prices?: Record<string, number>;
      text: string;
    }[];
  } | null;
  seen: boolean | null;
  steps: {
    step: number;
    tool: string;
    write: boolean;
    args?: Record<string, string>;
    ok: boolean;
    breaches: { type: string; lossUsd: number; blocked: boolean }[];
  }[];
  guardBlocked: { tool: string; args?: Record<string, string>; reason?: string }[];
  drained: { token: string; amount: string }[];
  stoppedBecause: string;
  finalMessage?: string;
  /** An operator-run agent on a budgeted fork: live-chain requests it caused, and if it ran out. */
  fork?: { fetches: number; budgetExhausted: boolean };
}

/** GET /episodes/:eventId. `detail` is null for episodes from before it was recorded. */
export interface EpisodeRecord extends EpisodeCard {
  agent: string | null;
  durationMs: number | null;
  detail: EpisodeDetail | null;
}

export interface EpisodeFilters {
  runId?: string;
  /** One attack's episodes, by its id. */
  attackId?: string;
  agentId?: string;
  outcome?: Outcome;
  attackClass?: string;
  source?: "held-out" | "library";
  since?: "1h" | "24h" | "7d";
}

export interface EpisodesQuery extends EpisodeFilters {
  through?: string;
  page?: number;
  limit?: number;
}

/** An attack's record in the Arena episodes still on record. */
export interface AttackStats {
  episodes: number;
  breaches: number;
  runs: number;
  lastAt: string | null;
}

/** A published attack in the red team list (no planted text). */
export interface AttackSummary {
  id: string;
  class: string;
  title: string;
  description: string;
  surfaces: string[];
  severity: "low" | "medium" | "high" | "critical";
  tags: string[];
  stats: AttackStats;
}

/** One attack class with its published attacks' combined record. */
export interface ClassRecord {
  class: string;
  attacks: number;
  episodes: number;
  breaches: number;
}

export interface AttacksPage extends Paged<AttackSummary> {
  /** All ten classes, whatever the list's filter. */
  classes: ClassRecord[];
  /** When the oldest episode on record ran: the stats cover episodes since then. */
  statsSince: string | null;
}

export interface AttacksQuery {
  attackClass?: string;
  surface?: string;
  severity?: string;
  sort?: "class" | "breaches" | "rate";
  page?: number;
  limit?: number;
}

/** GET /library. */
export interface LibraryCounts {
  published: number;
  acceptedBounties: number;
  heldOut: { active: number; retiresFrom: string | null };
}

export interface BountiesQuery {
  status?: "validating" | "accepted" | "rejected" | "failed";
  attackClass?: string;
  hunter?: string;
  sort?: "newest" | "reward";
  page?: number;
  limit?: number;
}

/** A query string from the defined values only. */
function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

/**
 * POST endpoints need the operator token (docs/SERVICES.md). The page keeps it in memory only:
 * it is never written to storage or a URL.
 */
function post<T>(path: string, token: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

/** What the API adds to a score or run: binding level, coverage and the held-out seed. */
export interface RatingFacts {
  /** `tee` when the score carries a verified TEE measurement, otherwise `declared`. */
  binding?: BindingLevel;
  /** Which attack surfaces the agent read (reports that record it). */
  coverage?: Coverage | null;
  /** The held-out set made for this rating alone (remote ratings). */
  heldOut?: { seed: string; attacks?: number; source?: string; model?: string } | null;
  /** Control episodes in which the agent did its normal task. */
  liveness?: Liveness | null;
}
/** Control episodes, and how many the agent did its normal task in (rate: completed ÷ controls). */
export interface Liveness {
  controls: number;
  completed: number;
  rate: number | null;
  /** Attack episodes the vault didn't breach, and how many of them the agent did its task in. */
  attacks?: { episodes: number; completed: number; rate: number | null };
  /** The share of attack episodes it must complete, from its control rate. */
  required?: number | null;
  /** Chance the gap between attacks and controls is luck (one-sided test). */
  pValue?: number | null;
}
/** Per surface: episodes that attacked it, and episodes in which the agent read it. */
export interface Coverage {
  surfaces: Record<string, { attacked: number; read: number }>;
  readSurfaces: string[];
}
export interface ScoreRecord extends RatingFacts {
  /** For an operator-run agent: its latest ratings, how many in all, and its standing. */
  attempts?: RatingAttempt[];
  attemptsTotal?: number;
  superseded?: { since: string; reason: string } | null;
  cooldownUntil?: string | null;
  runId: string;
  tx_hash: string;
  signed: { attestation: { reportHash: string; issuedAt: number; expiresAt: number } };
}
/** The keeper's latest live check of a TEE-hosted agent (docs/TEE.md, "Live checks"). */
export interface TeeCheckRecord {
  status: "verified" | "unrated" | "mismatch" | "invalid" | "unreachable";
  /** A definite failure still outstanding. It survives an offline agent (ADR-013). */
  blockingStatus: "mismatch" | "invalid" | null;
  detail: string | null;
  measurement: string | null;
  evmAddress: string | null;
  checkedAt: string;
  verifiedAt: string | null;
}
export interface RunRecord extends RatingFacts {
  /** Episodes published so far, of how many, and a rough estimate of the seconds left. */
  progress?: { done: number; total: number | null; etaSeconds: number | null };
  id: string;
  status: "queued" | "starting" | "running" | "done" | "failed";
  error: string | null;
  created_at: string;
  report: Report | null;
}
export interface Report {
  agent: string;
  modelFamily: string;
  mandateMode: string;
  forked: boolean;
  startedAt: string;
  durationMs: number;
  /** Public security score. Absent from legacy reports. */
  susceptibility?: Susceptibility;
  scoring: {
    score: number;
    tier: string;
    /**
     * Groups of attack classes as priced. `untestedClasses`: classes that ran but never tested an
     * operator-run agent; each one's share of its group is priced as untested (older reports and
     * in-process ratings don't have it).
     */
    groups?: { id: string; name: string; classes: string[]; untestedClasses?: string[] }[];
  };
  episodes: { total: number; attacks: number; controls: number; agentErrors: number };
  controls: { episodes: number; breaches: number };
  /** Accepted bounties and held-out attacks in the rating; older reports don't have it. */
  unpublished?: { attacks: number; episodes: number };
  /** Which attack surfaces the agent read; reports from before bring-your-own agents don't have it. */
  coverage?: Coverage;
  /** Whether the agent did its normal task in the control episodes; older reports don't have it. */
  liveness?: Liveness;
  /** Set when the agent proved it runs in a TEE; reports from before Day 11 don't have it. */
  tee?: {
    measurement: `0x${string}`;
    composeHash: `0x${string}`;
    evmAddress: string;
    /** Absent for a TEE agent that only acts on EVM chains. */
    solanaPublicKey?: string;
    tcbStatus: string;
  } | null;
  /** Sentinel was in front of the agent for this rating; older reports don't have it. */
  sentinel?: {
    model: string;
    repo?: string;
    revision?: string;
    questions: string;
    blockThreshold: number;
    pipelineHash?: string;
    fallback?: { model: string; questions: string; unsureBand: [number, number] };
  } | null;
  classes: {
    class: string;
    name: string;
    episodes: number;
    breaches: number;
    attackSucceeded: number;
    agentErrors: number;
    lossUsd: number;
    /** Attack episodes that tested the agent (breached, or it did its task): remote ratings. */
    exercised?: number;
    /** Attack episodes where the agent acted on the payload, including attempts stopped by containment. */
    manipulated?: number;
  }[];
}
export interface SignedQuoteResponse {
  quote: {
    agentId: string;
    vault: `0x${string}`;
    coverAmount: string;
    premiumRateBps: number;
    score: number;
    modelFamily: string;
    [key: string]: unknown;
  };
  signature: `0x${string}`;
}

/** One leaderboard entry (config/leaderboard.json): class-level results only. */
export interface LeaderboardRecord {
  slug: string;
  name: string;
  kind: "framework" | "reference";
  framework: string;
  template?: string;
  model: string | null;
  ratedAt: string;
  /** The public headline: the susceptibility grade. Legacy entries have no security grade and are unranked. */
  securityGrade?: number;
  /** The attack class the agent was most susceptible to, when a security grade is set. */
  worstClass?: string;
  score: number;
  tier: string;
  expectedLossBps: number;
  premiumRateBps: number;
  insurable: boolean;
  episodes: { attacks: number; controls: number; controlBreaches: number };
  classes: { class: string; name: string; episodes: number; breaches: number }[];
  reportHash: string;
  onchain: { chain: string; agentId: string; tx: string | null } | null;
  disclosure: {
    status: "not-needed" | "pending" | "notified" | "published";
    notifiedAt?: string;
    note?: string;
  };
  /** The registry still holds this rating's score (null: not posted on this chain). */
  verified: boolean | null;
}

/** An agent's self-serve registration, as GET /self/agents/:id reports it. */
export type SelfAgentRecord =
  | { registered: false }
  | {
      registered: true;
      source: "operator" | "user";
      kind: string;
      /** Rated with Sentinel in front of it. */
      sentinel?: boolean;
      owner: string | null;
      lastRatingAt: string | null;
      nextRatingAt: string | null;
      /** The owner's own agent (kind "remote"): what was declared. */
      codeHash?: string;
      mode?: RemoteMode;
      tee?: { url: string; composeHash: string } | null;
      /** Underwriting policy: the most cover it can hold, in tUSDG, by binding. */
      coverCaps?: Record<BindingLevel, number>;
      /** What protects the funds: a Bonded vault, or a module on the owner's smart account. */
      protection?: "vault" | "module";
      /** The vault's or module's address, for agents registered from the web app. */
      vault?: string | null;
      /** What a rating of the owner's own agent will be: its episodes and time budget. */
      /** The most a rating will be: its held-out set can come out smaller. */
      expectedRating?: { maxEpisodes: number; budgetSeconds: number };
      /** After a stop the agent caused: the superseded score and the cooldown. */
      standing?: Standing;
      /** Its trades through the vault from the agent key, from the chain. */
      vaultActivity?: VaultActivity | null;
      /** Active cover, but no trade through the vault in the last 7 days (or ever). */
      coverWithoutVaultTrades?: boolean;
      /** The agent key's gas for its `execute` calls. */
      agentGas?: AgentGas | null;
    };

/** GET /self/agents/:id/runner: the runner token (never the token itself) and the runner. */
export interface RunnerRecord {
  token: { id: string; createdAt: string } | null;
  runner: {
    connected: boolean;
    connectedAt: string;
    lastHeartbeatAt: string;
    disconnectedAt: string | null;
    runnerVersion: string | null;
    mode: string | null;
    teeUrl: string | null;
  } | null;
  /** The latest rating the live loop had to skip, and why. */
  lastSkip: { cause: string; reason: string; at: string } | null;
  /** Why a runner that is there doesn't count (e.g. started in the other mode), or null. */
  problem?: string | null;
  /** Every rating of the agent, newest first, failed ones included. */
  attempts?: RatingAttempt[];
  /** The Arena Gateway's public URL, for the runner command; null when it isn't configured. */
  gatewayUrl: string | null;
  /** How the agent is connected: its runner, or Bonded calling its Agent URL. Runner if absent. */
  connection?: Connection;
  /** The registered Agent URL and its last ownership check, when it has one. */
  agentUrl?: AgentUrlInfo | null;
  /** The latest connection check of the current connection, if any. */
  lastCheck?: CheckSummary | null;
  /** The code hash ratings will record: declared, or reported by the runner or the URL. */
  codeHash?: CodeHashInfo | null;
}

/** One rating of an agent, as its history shows it. */
export interface RatingAttempt {
  runId: string;
  status: "queued" | "starting" | "running" | "done" | "failed";
  /** The system's own reason. */
  error: string | null;
  /** It stopped because of the agent. */
  agentCaused?: boolean;
  /** What the agent or its runner said: the operator's words, shown as such. */
  agentReport?: string | null;
  createdAt: string;
  score: number | null;
}

/** Where an operator-run agent stands after its ratings. */
export interface Standing {
  failuresInRow: number;
  superseded: { since: string; reason: string } | null;
  cooldownUntil: string | null;
}

/** A signed self-serve request with nothing else in it. */
export interface SignedRequest {
  timestamp: number;
  signature: string;
}

/** A community bounty as the API lists it: no payload, which stays private. */
export interface BountyRecord {
  submissionId: string;
  hunter: string;
  specUri: string;
  attackId: string;
  attackClass: string;
  title: string;
  surfaces: string[];
  status: "validating" | "accepted" | "rejected" | "failed";
  /** tUSDG base units. */
  reward: string | null;
  reason: string | null;
  txHash: string | null;
  createdAt: string;
}

export const api = {
  health: () => request<{ ok: boolean; chainId: number }>("/health"),
  leaderboard: () =>
    request<{
      headline: {
        templates: number;
        failingTemplates: number;
        evaluations: number;
        failingEvaluations: number;
      };
      entries: LeaderboardRecord[];
    }>("/leaderboard"),
  score: (agentId: string) => request<ScoreRecord>(`/agents/${agentId}/score`),
  tee: (agentId: string) => request<TeeCheckRecord>(`/agents/${agentId}/tee`),
  /** A run. A preview's is shown only to its owner: pass their session. */
  run: (runId: string, session?: string) =>
    request<RunRecord>(
      `/arena/runs/${runId}`,
      session ? { headers: { Authorization: `Bearer ${session}` } } : undefined,
    ),
  startRun: (token: string, agentId: string) =>
    post<{ runId: string }>("/arena/runs", token, { agentId }),
  /** No operator token needed; without one the API caps cover at 20,000 tUSDG (testnet). */
  quote: (input: { agentId: string; vault: string; coverAmount: string }) =>
    request<SignedQuoteResponse>("/quotes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  /** Whether an agent is registered for self-serve ratings (docs/AGENTS.md). */
  selfAgent: (agentId: string) => request<SelfAgentRecord>(`/self/agents/${agentId}`),
  /** Register an agent for ratings; the owner's wallet signed the request. */
  registerSelfAgent: (input: {
    agentId: string;
    vault: string;
    kind: SelfServeKind | SelfServeAgentKind;
    mandate: unknown;
    sentinel?: boolean;
    protection?: "vault" | "module";
    codeHash?: string;
    mode?: RemoteMode;
    connection?: "runner" | "url";
    previewId?: string;
    tee?: { url: string; composeHash: string };
    timestamp: number;
    signature: string;
  }) =>
    request<{ registered: boolean }>("/self/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  /** Ask for a rating of a self-serve agent; the owner's wallet signed the request. */
  rateSelfAgent: (agentId: string, input: { timestamp: number; signature: string }) =>
    request<{ runId: string }>(`/self/agents/${agentId}/rate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  /** Every rating of an agent, newest first, a page at a time. */
  ratings: (agentId: string, page = 1, limit = 10) =>
    request<Paged<RatingAttempt>>(`/self/agents/${agentId}/ratings${query({ page, limit })}`),
  /** The owner's own agent: its runner token (never the token) and its runner. */
  runner: (agentId: string) => request<RunnerRecord>(`/self/agents/${agentId}/runner`),
  /** A new runner token, shown once; it replaces the agent's current one. */
  createRunnerToken: (agentId: string, input: SignedRequest) =>
    request<{ token: string; tokenId: string; createdAt: string; gatewayUrl: string | null }>(
      `/self/agents/${agentId}/runner-token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    ),
  /** Revoke the agent's runner token; a connected runner is dropped. */
  revokeRunnerToken: (agentId: string, input: SignedRequest) =>
    request<{ revoked: number }>(`/self/agents/${agentId}/runner-token`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  bounties: ({ attackClass, ...q }: BountiesQuery = {}) =>
    request<Paged<BountyRecord>>(`/bounties${query({ ...q, class: attackClass })}`),
  /** Arena episodes, newest first, as numbered pages of a snapshot, filtered in the database. */
  episodes: ({ attackClass, attackId, ...q }: EpisodesQuery = {}) =>
    request<EpisodesPage>(`/episodes${query({ ...q, class: attackClass, attack: attackId })}`),
  /** Whether Sentinel runs on this API, its threshold, and checks in the last day. */
  sentinel: () => request<SentinelStatus>("/sentinel"),
  /** One agent's Sentinel checks in the last 7 days. */
  sentinelAgent: (agentId: string) => request<SentinelAgentChecks>(`/sentinel/agents/${agentId}`),
  /** What ratings run, as counts: published, accepted bounties and the held-out set. */
  library: () => request<LibraryCounts>("/library"),
  /** The published attacks, a numbered page, each with its record in the Arena. */
  attacks: ({ attackClass, ...q }: AttacksQuery = {}) =>
    request<AttacksPage>(`/library/attacks${query({ ...q, class: attackClass })}`),
  /** One published attack in full, planted text included. */
  attack: (id: string) =>
    request<{ attack: AttackSpec; stats: AttackStats; statsSince: string | null }>(
      `/library/attacks/${encodeURIComponent(id)}`,
    ),
  /** One episode with its detail, for its page. */
  episode: (eventId: string) => request<EpisodeRecord>(`/episodes/${eventId}`),
  /** No operator token: the API checks the spec's hash against the revealed specURI. */
  revealBounty: (id: string, yaml: string) =>
    request<{ created: boolean; status: string }>(`/bounties/${id}/reveal`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: yaml,
    }),
};
