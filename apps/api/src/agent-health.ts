import type { Database } from "@bonded/db";
import {
  RUNNER_OFFLINE_ALERT_MS,
  SCORE_EXPIRY_WARNING_SECONDS,
  codedProblem,
  tierForScore,
} from "@bondedhq/shared";
import type { AgentChainStatus } from "./agent-status.js";
import { RENEW_BEFORE_EXPIRY_SECONDS } from "./live-loop.js";

/**
 * An owner's agent at a glance (`GET /self/agents/:id/health`): its score and when it expires,
 * how Bonded reaches it, its vault's trading, gas and cover, the next rating, and what is wrong,
 * as sentences with a code and what to do. The same rules decide the owner's alerts
 * (owner-alerts.ts), so the panel and the notifications never disagree.
 */

export interface HealthProblem {
  code: string;
  severity: "problem" | "warning";
  text: string;
  fix?: string;
}

/** The latest posted score of a registered agent. */
export async function latestScore(db: Database, agentKey: string) {
  const r = await db.pool.query(
    `SELECT s.id, s.signed->'attestation' AS a, s.tx_hash FROM attestations s
     WHERE s.agent_id=$1 ORDER BY s.created_at DESC LIMIT 1`,
    [agentKey],
  );
  const row = r.rows[0];
  if (!row) return null;
  const a = row.a as { score: number; securityScore?: number; expiresAt: number; issuedAt: number };
  return {
    runId: row.id as string,
    score: Number(a.score),
    securityScore: a.securityScore ?? null,
    tier: tierForScore(Number(a.score)).tier,
    issuedAt: new Date(Number(a.issuedAt) * 1000).toISOString(),
    expiresAt: new Date(Number(a.expiresAt) * 1000).toISOString(),
    expiresAtSeconds: Number(a.expiresAt),
    txHash: row.tx_hash as string,
  };
}

/** A rating of the agent queued or running now, if any. */
export async function pendingRating(db: Database, agentKey: string) {
  const r = await db.pool.query(
    `SELECT r.id, r.status, r.created_at FROM ratings r JOIN jobs j ON j.id=r.id
     WHERE r.agent_id=$1 AND j.status IN ('queued','running') ORDER BY r.created_at DESC LIMIT 1`,
    [agentKey],
  );
  const row = r.rows[0];
  return row
    ? { runId: row.id as string, status: row.status as string, queuedAt: row.created_at as Date }
    : null;
}

export interface HealthInput {
  nowMs: number;
  score: { expiresAtSeconds: number } | null;
  superseded: { reason: string } | null;
  /** How Bonded reaches it; "bonded" for Bonded's own designs, run in the Arena. */
  connection: "runner" | "url" | "bonded";
  /** Runner presence (runner connection), null when it never connected. */
  runner: { connected: boolean; lastHeartbeatAt: Date } | null;
  hasRunnerToken: boolean;
  /** Agent URL connection: whether it is set, and verified. */
  url: { set: boolean; verified: boolean };
  pending: { status: string } | null;
  chain: AgentChainStatus | null;
  /** Breaches the keeper indexed in the last 7 days. */
  recentBreaches: number;
}

const date = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/** Whether a rating or renewal is due: one is queued, or the score renews (or lapsed) by now. */
export function ratingDue(input: Pick<HealthInput, "nowMs" | "score" | "pending">): boolean {
  if (input.pending) return true;
  if (!input.score) return false;
  return input.score.expiresAtSeconds - RENEW_BEFORE_EXPIRY_SECONDS <= input.nowMs / 1000;
}

/** The runner has been away for over 30 minutes (or never came), measured from its last beat. */
export function runnerOffline(input: Pick<HealthInput, "nowMs" | "runner">): boolean {
  if (input.runner?.connected) return false;
  const last = input.runner?.lastHeartbeatAt.getTime();
  return last === undefined || input.nowMs - last > RUNNER_OFFLINE_ALERT_MS;
}

/** What is wrong, worst first. Every sentence has its code (`PROBLEMS` in @bondedhq/shared). */
export function healthProblems(input: HealthInput): HealthProblem[] {
  const out: HealthProblem[] = [];
  const add = (severity: HealthProblem["severity"], text: string, code?: string) =>
    out.push({ severity, ...codedProblem(text, code) });
  const nowS = input.nowMs / 1000;
  if (input.superseded)
    add(
      "problem",
      `This agent's score is superseded: its latest rating was stopped by the agent (${input.superseded.reason}); cover waits for a complete rating.`,
    );
  if (!input.score) add("problem", "The agent has no posted score yet.");
  else if (input.score.expiresAtSeconds <= nowS)
    add("problem", `The agent's score expired on ${date(input.score.expiresAtSeconds * 1000)}.`);
  else if (input.score.expiresAtSeconds - nowS <= SCORE_EXPIRY_WARNING_SECONDS)
    add("warning", `The agent's score expires on ${date(input.score.expiresAtSeconds * 1000)}.`);
  if (input.connection === "runner") {
    const due = ratingDue(input);
    if (!input.hasRunnerToken)
      add("problem", "Create a runner token first, then start the runner.");
    else if (due && runnerOffline(input))
      add(
        "problem",
        input.runner
          ? `The runner has been offline since ${date(input.runner.lastHeartbeatAt.getTime())} while a rating or renewal is due.`
          : "The runner has been offline (it never connected) while a rating or renewal is due.",
      );
    else if (!input.runner?.connected)
      add(
        "warning",
        "The runner isn't connected. Start it with the command on this page, then check again.",
      );
  } else if (input.connection === "bonded") {
    // Nothing to connect: Bonded runs its own designs.
  } else if (!input.url.set) add("problem", "Set your Agent URL first.");
  else if (!input.url.verified)
    add(
      "problem",
      "Verify your Agent URL first: Bonded hasn't had an answer to its challenge yet.",
    );
  const chain = input.chain;
  if (chain) {
    if (chain.frozen) add("problem", "The vault froze the agent after a breach.");
    if (chain.cover?.status === "lapsed")
      add(
        "problem",
        "The cover lapsed: its premium went unpaid past the grace period.",
        "cover-lapsing",
      );
    else if (chain.cover?.active && chain.cover.pastDueSince)
      add(
        "problem",
        `The cover's premium is past due; the cover lapses${chain.cover.lapsesAt ? ` at ${date(Date.parse(chain.cover.lapsesAt))}` : ""} unless it is paid.`,
      );
    if (chain.coverWithoutVaultTrades)
      add(
        "warning",
        chain.vaultActivity.lastTradeAt
          ? "The agent has cover, but hasn't traded through its vault in the last 7 days."
          : "The agent has cover, but hasn't traded through its vault yet.",
      );
    if (chain.agentGas?.low)
      add(
        "warning",
        chain.agentGas.estimatedTradesLeft === null
          ? "The agent key is low on gas."
          : `The agent key is low on gas: about ${chain.agentGas.estimatedTradesLeft} trades left (${chain.agentGas.basis === "measured" ? "from its recent trades" : "assuming a typical trade's gas"}).`,
      );
  }
  if (input.recentBreaches > 0)
    add(
      "warning",
      `The vault recorded a breach ${input.recentBreaches === 1 ? "once" : `${input.recentBreaches} times`} in the last 7 days.`,
    );
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "problem" ? -1 : 1));
}

/** When the agent is rated next, as far as the service can tell. */
export function nextRating(input: HealthInput & { ready: boolean }) {
  if (input.pending) return { status: input.pending.status, at: null, reason: null };
  if (!input.score) return { status: "none", at: null, reason: "Ask for a rating." };
  const renewS = input.score.expiresAtSeconds - RENEW_BEFORE_EXPIRY_SECONDS;
  return input.ready
    ? {
        status: "scheduled",
        at: new Date(Math.max(renewS * 1000, input.nowMs)).toISOString(),
        reason: "Scores renew on their own while the agent can be reached.",
      }
    : {
        status: "waiting",
        at: null,
        reason: "The score renews only while the runner is connected (or the Agent URL verified).",
      };
}
