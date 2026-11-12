import { PREVIEW_PREFIX, type Database, type RatedCode } from "@bonded/db";
import type { AgentMode } from "@bondedhq/shared";
import {
  CHECKS_UNAVAILABLE,
  checkIssuesOf,
  type AgentConnection,
  type ConnectionCheckEvent,
  type ConnectionCheckResult,
  type ConnectionCheckRunner,
} from "./connections.js";
import { CHECK_BUDGET_MS } from "./remote-policy.js";
import { SECRET_KEY_MISSING, agentUrlContext, type SecretBox } from "./secrets.js";

/**
 * The connection check lane (bring your own agent, round 2): one benign episode per check, never
 * scored, run one at a time per chain under a lock of its own, so checks never wait behind a
 * rating. What the episode does streams to the check's events as it happens; the result (passed,
 * and the problems in plain words) is stored on the check.
 */

export interface CheckWorkerOptions {
  /** The gateway's check runner; without it every check fails with CHECKS_UNAVAILABLE. */
  runCheck?: ConnectionCheckRunner | undefined;
  /** Decrypts Agent URL secrets. */
  secrets?: SecretBox | undefined;
  /** A check's budget (default 120 s). */
  timeoutMs?: number;
  log?: (line: string) => void;
}

const CHECK_LOCK = 7010;
/** The most events one check keeps: a few tool calls, a transaction or two, the exit. */
const MAX_EVENTS = 300;

const failed = (problem: string): ConnectionCheckResult => ({
  passed: false,
  problems: [problem],
  taskCompleted: false,
  toolsCalled: 0,
  surfacesRead: [],
});

const cap = (value: unknown, max: number) =>
  typeof value === "string" ? value.slice(0, max) : undefined;

/** An event as it is stored: free text capped, and only the fields each type has. */
function stored(e: ConnectionCheckEvent): ConnectionCheckEvent | undefined {
  switch (e.type) {
    case "started":
      return { type: "started" };
    case "tool":
      return {
        type: "tool",
        name: cap(e.name, 64) ?? "unknown",
        ...(e.surface !== undefined ? { surface: cap(e.surface, 32) ?? null } : {}),
        ok: e.ok === true,
        ...(e.error ? { error: cap(e.error, 500)! } : {}),
      };
    case "tx":
      return {
        type: "tx",
        ok: e.ok === true,
        ...(e.reason ? { reason: cap(e.reason, 500)! } : {}),
      };
    case "done":
      return {
        type: "done",
        ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
        durationMs: Number(e.durationMs) || 0,
        ...(e.stdoutTail ? { stdoutTail: cap(e.stdoutTail, 4096)! } : {}),
        ...(e.stderrTail ? { stderrTail: cap(e.stderrTail, 4096)! } : {}),
      };
    default:
      // The result is written by the worker itself, once, from what the runner returned.
      return undefined;
  }
}

/** A trading summary as it is stored: numbers and short token symbols only. */
function storedTrading(t: ConnectionCheckResult["trading"]): ConnectionCheckResult["trading"] {
  if (!t || typeof t !== "object") return undefined;
  const n = (v: unknown) => Math.max(0, Number(v) || 0);
  return {
    trades: Math.trunc(n(t.trades)),
    tokens: (Array.isArray(t.tokens) ? t.tokens : [])
      .filter((s): s is string => typeof s === "string" && /^[A-Za-z]{1,8}$/.test(s))
      .slice(0, 20),
    usedRouter: t.usedRouter === true,
    transfers: Math.trunc(n(t.transfers)),
    approvals: Math.trunc(n(t.approvals)),
    largestTradeUsd: n(t.largestTradeUsd),
    totalOutflowUsd: n(t.totalOutflowUsd),
  };
}

/** A check's result as it is stored. */
function storedResult(r: ConnectionCheckResult): ConnectionCheckResult {
  const kept = storedFields(r);
  const trading = storedTrading(r.trading);
  // Codes come from the stored sentences, never from what the runner sent.
  return { ...kept, issues: checkIssuesOf(kept), ...(trading ? { trading } : {}) };
}

function storedFields(r: ConnectionCheckResult): ConnectionCheckResult {
  return {
    passed: r.passed === true,
    problems: (Array.isArray(r.problems) ? r.problems : [])
      .slice(0, 20)
      .map((p) => String(p).slice(0, 500)),
    ...(Array.isArray(r.warnings)
      ? { warnings: r.warnings.slice(0, 20).map((w) => String(w).slice(0, 500)) }
      : {}),
    taskCompleted: r.taskCompleted === null ? null : r.taskCompleted === true,
    toolsCalled: Math.max(0, Math.trunc(Number(r.toolsCalled) || 0)),
    surfacesRead: (Array.isArray(r.surfacesRead) ? r.surfacesRead : [])
      .slice(0, 20)
      .map((s) => String(s).slice(0, 32)),
    ...(r.usage
      ? {
          usage: {
            inputTokens: Math.max(0, Math.trunc(Number(r.usage.inputTokens) || 0)),
            outputTokens: Math.max(0, Math.trunc(Number(r.usage.outputTokens) || 0)),
            ...(typeof r.usage.costUsd === "number" && r.usage.costUsd >= 0
              ? { costUsd: r.usage.costUsd }
              : {}),
          },
        }
      : {}),
    ...(typeof r.durationMs === "number" ? { durationMs: Math.max(0, r.durationMs) } : {}),
    ...(r.codeHash && /^0x[0-9a-fA-F]{64}$/.test(r.codeHash)
      ? { codeHash: r.codeHash.toLowerCase(), codeSource: cap(r.codeSource, 32) ?? "runner" }
      : {}),
  };
}

/** Run the next queued check on the chain, if any. Returns whether one ran. */
export async function workCheckOne(
  db: Database,
  chainId: number,
  options: CheckWorkerOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? CHECK_BUDGET_MS;
  const lock = await db.pool.connect();
  const locked = (
    await lock.query("SELECT pg_try_advisory_lock($2,$1) AS locked", [chainId, CHECK_LOCK])
  ).rows[0].locked;
  if (!locked) {
    lock.release();
    return false;
  }
  try {
    const job = await db.takeCheck(chainId, timeoutMs + 60_000);
    if (!job) return false;
    const check = (await db.check(job.id))!;
    // Events are written in order, one at a time, and at most MAX_EVENTS of them.
    let written = Promise.resolve();
    let count = 0;
    const onEvent = (event: ConnectionCheckEvent) => {
      const e = stored(event);
      if (!e || ++count > MAX_EVENTS) return;
      written = written.then(() => db.addCheckEvent(job, e)).catch(() => undefined);
    };
    let result: ConnectionCheckResult;
    try {
      const connection = await connectionFor(db, check, options.secrets);
      if ("problem" in connection) result = failed(connection.problem);
      else if (!options.runCheck) result = failed(CHECKS_UNAVAILABLE);
      else
        result = storedResult(
          await within(
            options.runCheck({
              connection: connection.reach,
              mode: check.mode as AgentMode,
              world: check.world,
              toolNames: check.toolNames,
              chainId,
              timeoutMs,
              onEvent,
            }),
            timeoutMs + 30_000,
          ),
        );
    } catch {
      options.log?.(`connection check ${check.id} could not run`);
      result = failed(
        "The check couldn't run on Bonded's side, not because of your agent. Run it again.",
      );
    }
    await written;
    await db.addCheckEvent(job, { type: "result", ...result });
    const code: RatedCode | undefined =
      result.codeHash && check.codeSource !== "declared"
        ? { hash: result.codeHash, source: result.codeSource ?? "runner" }
        : undefined;
    await db.finishCheck(job, { ...result }, code);
    // A preview moves on to "ready" once a check passes (back to "created" when one fails).
    if (check.subject.startsWith(PREVIEW_PREFIX))
      await db.pool.query(
        `UPDATE previews SET status=$2,updated_at=now()
         WHERE id::text=$1 AND status IN ('created','checking','ready')`,
        [check.subject.slice(PREVIEW_PREFIX.length), result.passed ? "ready" : "created"],
      );
    return true;
  } finally {
    await lock.query("SELECT pg_advisory_unlock($2,$1)", [chainId, CHECK_LOCK]);
    lock.release();
  }
}

/** How to reach the checked agent now, or the problem in words for its owner. */
async function connectionFor(
  db: Database,
  check: { subject: string; connection: string; credentialId: string | null },
  secrets: SecretBox | undefined,
): Promise<{ reach: AgentConnection } | { problem: string }> {
  if (check.connection === "runner") {
    const now = await db.currentConnection(check.subject, "runner");
    if (now.credentialId !== check.credentialId)
      return {
        problem: "The runner token changed since the check was asked for. Run it again.",
      };
    if (!now.ready)
      return {
        problem:
          "The runner isn't connected. Start it with the command on this page, then check again.",
      };
    return { reach: { kind: "runner", key: check.subject } };
  }
  const live = await db.agentUrl(check.subject);
  if (!live?.verifiedAt || live.id !== check.credentialId)
    return {
      problem:
        "The Agent URL changed (or was removed) since the check was asked for. Run it again.",
    };
  if (!secrets) return { problem: SECRET_KEY_MISSING };
  try {
    return {
      reach: {
        kind: "url",
        url: live.url,
        secret: secrets.decrypt(live.ciphertext, agentUrlContext(live.id)),
        registration: check.subject,
      },
    };
  } catch {
    return { problem: "The Agent URL's secret can't be used. Set the Agent URL again." };
  }
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("check timed out")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
