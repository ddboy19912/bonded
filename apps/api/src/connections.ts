import {
  hostedAgent,
  runConnectionCheck,
  verifyAgentUrl,
  type AgentTransport,
  type AgentUrlClient,
  type ArenaGateway,
} from "@bonded/arena";
import {
  agentUrlCodeHash,
  type HostedAgentSpec,
  hostedCodeHash,
  problemCode,
  type AgentMode,
  type TradingSummary,
} from "@bondedhq/shared";
import type { ConnectionCheckRecord, HostedAgentRecord, RatedCode } from "@bonded/db";
import type { Hex } from "viem";

/**
 * How the rating service reaches an operator's agent (bring your own agent, round 2), and the
 * seams to the Arena Gateway's side of it: verifying an Agent URL, running a connection check, and
 * reading the code hash a runner reports. Each seam is one small function here, so the API and the
 * workers never depend on how the gateway does it.
 */

/**
 * Through the operator's runner (its key), by calling the agent's own HTTPS endpoint, or (a hosted
 * preview) by running what its owner gave Bonded, here.
 */
export type AgentConnection =
  | { kind: "runner"; key: string }
  | {
      kind: "url";
      url: string;
      secret: string;
      /** What it is registered to ("<chain>:<agent id>" or "preview:<id>"): its own rate limit. */
      registration: string;
    }
  | { kind: "hosted"; spec: HostedAgentSpec; registration: string };

/** What a saved hosted agent runs, as the arena's spec. */
export function hostedSpecOf(saved: HostedAgentRecord): HostedAgentSpec {
  return saved.kind === "instructions"
    ? {
        kind: "instructions",
        model: saved.model as HostedAgentSpec["model"],
        instructions: saved.instructions ?? "",
      }
    : {
        kind: "code",
        model: saved.model as HostedAgentSpec["model"],
        language: saved.language ?? "js",
        code: saved.code ?? "",
      };
}

/** The gateway's transport for a connection: a hosted agent is built here, on Bonded's keys. */
export function transportOf(connection: AgentConnection): AgentTransport {
  return connection.kind === "hosted"
    ? {
        kind: "hosted",
        agent: hostedAgent(connection.spec),
        registration: connection.registration,
      }
    : connection;
}

/** What a connection check streams while it runs (docs/BRING-YOUR-OWN-AGENT.md). */
export type ConnectionCheckEvent =
  | { type: "started" }
  | { type: "tool"; name: string; surface?: string | null; ok: boolean; error?: string }
  | { type: "tx"; ok: boolean; reason?: string }
  | {
      type: "done";
      exitCode?: number | null;
      durationMs: number;
      stdoutTail?: string;
      stderrTail?: string;
    }
  | ({ type: "result" } & ConnectionCheckResult);

/** A check's verdict: never a score. `problems` are plain sentences for the owner. */
export interface ConnectionCheckResult {
  passed: boolean;
  problems: string[];
  /** Advisory: what works but costs score or makes estimates rougher (doesn't fail a check). */
  warnings?: string[];
  /** Null when the episode never ran. */
  taskCompleted: boolean | null;
  toolsCalled: number;
  surfacesRead: string[];
  /** Model usage the agent reported at /done, as it reported it (never trusted for limits). */
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
  /** How long the episode took. */
  durationMs?: number;
  /** The code hash the runner or URL reported during the check, when it did. */
  codeHash?: string;
  codeSource?: string;
  /** Problems and warnings with their troubleshooting codes. */
  issues?: CheckIssue[];
  /** What the agent traded without breaking a rule (for the suggested mandate). */
  trading?: TradingSummary;
}

/** A check's problem or warning with its stable code (`PROBLEMS` in @bondedhq/shared). */
export interface CheckIssue {
  code: string;
  severity: "problem" | "warning";
  message: string;
}

/** The coded problems and warnings of a check result (older results have none stored). */
export function checkIssuesOf(result: Partial<ConnectionCheckResult> | null): CheckIssue[] {
  if (result?.issues) return result.issues;
  return [
    ...(result?.problems ?? []).map((text) => ({
      code: problemCode(text),
      severity: "problem" as const,
      message: text,
    })),
    ...(result?.warnings ?? []).map((text) => ({
      code: problemCode(text),
      severity: "warning" as const,
      message: text,
    })),
  ];
}

/** One check to run: the connection, the mode, its time budget, and where its events go. */
export interface ConnectionCheckRequest {
  connection: AgentConnection;
  mode: AgentMode;
  /** The world to check on (default vault). */
  world?: "vault" | "brokerage";
  /** A brokerage check: whose tool names the agent is offered (default bonded). */
  toolNames?: "bonded" | "alpaca";
  chainId: number;
  timeoutMs: number;
  onEvent: (event: ConnectionCheckEvent) => void;
}

export type ConnectionCheckRunner = (
  request: ConnectionCheckRequest,
) => Promise<ConnectionCheckResult>;

/** The Agent URL's answer to Bonded's verify challenge. */
export type AgentUrlVerification = { ok: true; version?: string } | { ok: false; problem: string };
export type AgentUrlVerifier = (url: string, secret: string) => Promise<AgentUrlVerification>;

/** Why a worker can't run connection checks (no gateway, or no check support in it). */
export const CHECKS_UNAVAILABLE =
  "Connection checks aren't available on this rating service yet: the Arena Gateway isn't running here.";

/**
 * Verify an Agent URL with the gateway's `verifyAgentUrl`: a signed `verify` challenge the agent
 * must answer within 10 s with the challenge and its proof (an HMAC of it with the agent secret,
 * so an echo server can't pass), through `client` (its per-host rate limit and refused hosts are shared
 * with everything else that calls agent URLs from this process).
 */
export function gatewayUrlVerifier(client: AgentUrlClient): AgentUrlVerifier {
  return async (url, secret) => {
    const answer = await verifyAgentUrl(url, secret, { client });
    return answer.ok
      ? { ok: true, ...(answer.version !== undefined ? { version: answer.version } : {}) }
      : { ok: false, problem: answer.problem };
  };
}

/**
 * The gateway's `runConnectionCheck`: one benign episode on a fresh local chain, no attack,
 * never scored, its events streamed as they happen. Only checks get these per-episode events:
 * a rating never streams them (they would show which episodes are attacks).
 */
export function gatewayCheckRunner(gateway: ArenaGateway): ConnectionCheckRunner {
  return async (request) => {
    const result = await runConnectionCheck({
      gateway,
      transport: transportOf(request.connection),
      mode: request.mode,
      ...(request.world ? { world: request.world } : {}),
      ...(request.toolNames ? { toolProfile: request.toolNames } : {}),
      episodeTimeoutMs: Math.min(request.timeoutMs, 90_000),
      onEvent: (event) => request.onEvent(event as ConnectionCheckEvent),
    });
    return {
      passed: result.passed,
      problems: result.problems,
      warnings: result.warnings,
      taskCompleted: result.taskCompleted,
      toolsCalled: result.toolsCalled,
      surfacesRead: [...result.surfacesRead],
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
      ...(result.issues ? { issues: result.issues } : {}),
      ...(result.trading ? { trading: result.trading } : {}),
      ...(result.code
        ? {
            codeHash: result.code.hash,
            codeSource: result.code.source,
          }
        : request.connection.kind === "hosted"
          ? // Bonded ran exactly what was saved: that is its code.
            { codeHash: hostedCodeHash(request.connection.spec), codeSource: "hosted" }
          : {}),
    };
  };
}

/**
 * Seam: the code hash a runner reported in its hello (`codeHash` and `codeSource`), read
 * defensively so a runner that reports none (or something malformed) just reports nothing.
 */
export function reportedCode(
  hello: unknown,
): { codeHash: string; codeSource: string; codeDetail?: string } | undefined {
  if (!hello || typeof hello !== "object") return undefined;
  const h = hello as { codeHash?: unknown; codeSource?: unknown; codeDetail?: unknown };
  if (typeof h.codeHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(h.codeHash)) return undefined;
  const source =
    typeof h.codeSource === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(h.codeSource)
      ? h.codeSource
      : "runner";
  // What it was made from (a commit, an image digest), when the runner says: display only.
  const detail =
    typeof h.codeDetail === "string" && /^[\x20-\x7e]{1,200}$/.test(h.codeDetail)
      ? h.codeDetail
      : undefined;
  return {
    codeHash: h.codeHash.toLowerCase(),
    codeSource: source,
    ...(detail ? { codeDetail: detail } : {}),
  };
}

/** The code hash of an Agent URL that reported `version`: keccak256("url:" + version). */
export function urlCodeHash(version: string): Hex {
  return agentUrlCodeHash(version);
}

/** Why a rating can't be queued without a check. */
export const NEEDS_CHECK =
  "Run a connection check first: a rating needs a passing check of this exact connection (the same runner token or Agent URL, mode and code) in the last 24 hours.";

/** How long a passing check lets a rating be queued. */
const CHECK_VALID_MS = 86_400_000;

/** A code hash, where it came from, and (for an Agent URL) the version it was made from. */
export function codeInfo(code: RatedCode | undefined, version?: string | null) {
  // One name for an Agent URL's reported version, "url" (as @bondedhq/shared's CodeSource); an
  // earlier "url-version" is read as it.
  if (code?.source === "url-version") code = { ...code, source: "url" };
  return code
    ? {
        value: code.hash.toLowerCase(),
        source: code.source,
        detail: code.source === "url" ? (version ?? null) : (code.detail ?? null),
        // Who says so: never verified by Bonded, only declared or reported.
        reportedBy:
          code.source === "declared"
            ? ("owner" as const)
            : code.source === "url"
              ? ("agent" as const)
              : ("runner" as const),
        label:
          code.source === "declared"
            ? "declared by the owner"
            : code.source === "url"
              ? "reported by the agent"
              : "reported by the runner",
      }
    : null;
}

/** A check as the web app lists it: queued counts as running. */
export function checkSummary(k: ConnectionCheckRecord) {
  const result = (k.result ?? null) as Partial<ConnectionCheckResult> | null;
  return {
    id: k.id,
    status: k.status === "queued" ? ("running" as const) : k.status,
    createdAt: k.createdAt.toISOString(),
    connection: k.connection,
    expiresAt:
      k.status === "passed" && k.finishedAt
        ? new Date(k.finishedAt.getTime() + CHECK_VALID_MS).toISOString()
        : null,
    problems: result?.problems ?? [],
    warnings: result?.warnings ?? [],
    issues: checkIssuesOf(result),
  };
}

/** A check as anyone may see it: its outcome and the problems in words, no id, no output. */
export function publicCheckSummary(k: ConnectionCheckRecord) {
  const { id: _id, ...rest } = checkSummary(k);
  void _id;
  return rest;
}
