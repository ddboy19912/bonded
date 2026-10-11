import { randomBytes } from "node:crypto";
import {
  type AgentMode,
  AttackSurface,
  type DoneRequest,
  problemCode,
  type TradingSummary,
} from "@bondedhq/shared";
import { BENIGN_GOALS, benignTrade, type EpisodeResult, runEpisode } from "./episode.js";
import {
  type AgentTransport,
  RemoteAgent,
  type RemoteEpisodeEvent,
} from "./gateway/remote-agent.js";
import type { ArenaGateway } from "./gateway/server.js";
import { Sandbox } from "./sandbox.js";
import { tradingSummary } from "./trades.js";
import type { AgentVaultOptions } from "./vault.js";

/**
 * The connection check: one control-style episode (a benign task in a benign world, no attack),
 * never scored, run through the same gateway and transport a rating would use, with live events
 * and plain-sentence diagnostics. It tells an operator in a minute or two whether a rating would
 * work, before they wait for one. A passing check means: the agent was reached, called tools,
 * finished on its own, did the trade its task names, and broke no rule doing it.
 */

/** Seconds a check's episode has (the hosted preview's episode deadline). */
export const CHECK_EPISODE_TIMEOUT_MS = 90_000;
/** How long a check waits for the runner to be connected. */
export const CHECK_RUNNER_WAIT_MS = 5_000;

/** One live event of a check, in order: started, tool and tx events, done, then result. */
export type CheckEvent =
  | { type: "started" }
  | {
      type: "tool";
      name: string;
      /** The attack surface it reads (null for a write or a lookup). */
      surface: AttackSurface | null;
      ok: boolean;
      error?: string;
    }
  | { type: "tx"; ok: boolean; reason?: string }
  | {
      type: "done";
      /** Runner only: the agent's exit code (null when it was stopped or never started). */
      exitCode?: number | null;
      durationMs: number;
      stdoutTail?: string;
      stderrTail?: string;
    }
  | ({ type: "result" } & CheckResult);

export interface CheckResult {
  /** True when there are no problems (warnings don't fail a check). */
  passed: boolean;
  /** What stops a rating from working, as plain sentences. */
  problems: string[];
  /** What works, but will cost the agent score or make estimates rougher. */
  warnings: string[];
  /**
   * The problems and warnings again, each with its stable code for the troubleshooting page
   * (`PROBLEMS` in @bondedhq/shared).
   */
  issues?: { code: string; severity: "problem" | "warning"; message: string }[];
  /** What the agent traded without breaking a rule: what a suggested mandate is built from. */
  trading?: TradingSummary;
  /** Whether it did the trade its task names (null when the episode never ran). */
  taskCompleted: boolean | null;
  /** Tool calls the gateway saw. */
  toolsCalled: number;
  /** Attack surfaces it read successfully (a rating plants attacks on all of them). */
  surfacesRead: AttackSurface[];
  /** Model usage the agent reported at /done, if it did. */
  usage?: DoneRequest["usage"];
  /** How long the episode took, from handing it over to its end. */
  durationMs?: number;
  /**
   * The code version, when the transport reported one: the runner's computed code hash, or
   * keccak256("url:" + version) from an agent URL's verify answer.
   */
  code?: {
    hash: `0x${string}`;
    source: string;
    version?: string;
    /** The runner's commit, digest or label (hello `codeDetail`). */
    detail?: string;
    /** Who said so: the runner or the agent URL. Never verified; show it as reported. */
    reportedBy: "runner" | "agent";
  };
}

export interface ConnectionCheckOptions {
  gateway: ArenaGateway;
  transport: AgentTransport;
  mode: AgentMode;
  /** Where to run it (default: a fresh local chain, started for the check and stopped after). */
  sandbox?: Sandbox;
  /** Called with each event as it happens (for SSE). Errors it throws are ignored. */
  onEvent?: (event: CheckEvent) => void | Promise<void>;
  /** The episode's deadline (default CHECK_EPISODE_TIMEOUT_MS). */
  episodeTimeoutMs?: number;
  /** How long to wait for the runner (default CHECK_RUNNER_WAIT_MS). */
  runnerWaitMs?: number;
  /** The benign task (default: one of the rating's benign goals, at random). */
  goal?: string;
  vault?: AgentVaultOptions;
}

const SURFACES = AttackSurface.options;

/** Runs one connection check. Never throws for anything the agent does; the result says. */
export async function runConnectionCheck(options: ConnectionCheckOptions): Promise<CheckResult> {
  const emit = async (event: CheckEvent) => {
    try {
      await options.onEvent?.(event);
    } catch {
      // The listener's problem (a closed stream), not the check's.
    }
  };
  const finish = async (plain: CheckResult): Promise<CheckResult> => {
    const result: CheckResult = { ...plain, issues: checkIssues(plain) };
    await emit({ type: "result", ...result });
    return result;
  };
  const early = (problem: string, code?: CheckResult["code"]) =>
    finish({
      passed: false,
      problems: [problem],
      warnings: [],
      taskCompleted: null,
      toolsCalled: 0,
      surfacesRead: [],
      ...(code ? { code } : {}),
    });

  const { gateway, transport, mode } = options;
  let code: CheckResult["code"];
  // Cheap checks first: nothing starts until the agent is reachable.
  if (transport.kind === "runner") {
    const waitMs = options.runnerWaitMs ?? CHECK_RUNNER_WAIT_MS;
    const deadline = Date.now() + waitMs;
    while (!gateway.runner(transport.key) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    const runner = gateway.runner(transport.key);
    if (!runner)
      return early(
        "The runner isn't connected: start it with your runner token, then run the check again",
      );
    if (runner.hello?.mode !== mode)
      return early(
        `The runner is in ${runner.hello?.mode} mode, but this check is for ${mode} mode: restart it with --mode ${mode}`,
      );
    if (runner.episodeId !== null)
      return early("The runner is busy with another episode; try again when it's finished");
    if (runner.code) code = runner.code;
  } else {
    const verified = await gateway.agentUrls.verify(transport.url, transport.secret);
    if (!verified.ok) return early(verified.problem);
    if (verified.codeHash && verified.version)
      code = {
        hash: verified.codeHash,
        source: "url",
        version: verified.version,
        reportedBy: "agent",
      };
  }

  const tally = {
    tools: 0,
    failedTools: [] as { name: string; error: string }[],
    chainWrites: [] as string[],
    rpcInToolsMode: false,
    txs: 0,
    failedTxs: [] as string[],
  };
  let done: Extract<RemoteEpisodeEvent, { type: "done" }> | undefined;
  const forward = (event: RemoteEpisodeEvent) => {
    if (event.type === "started") return void emit({ type: "started" });
    if (event.type === "done") {
      done = event;
      return void emit(event);
    }
    if (event.type === "tool") {
      tally.tools++;
      if (!event.ok) {
        if (mode === "chain" && /in chain mode, writes are transactions/.test(event.error ?? ""))
          tally.chainWrites.push(event.name);
        else tally.failedTools.push({ name: event.name, error: event.error ?? "failed" });
      }
    } else if (/tools mode, which has no RPC endpoint/.test(event.reason ?? "")) {
      tally.rpcInToolsMode = true;
    } else {
      tally.txs++;
      if (!event.ok) tally.failedTxs.push(event.reason ?? "refused");
    }
    void emit(event);
  };

  const timeoutMs = options.episodeTimeoutMs ?? CHECK_EPISODE_TIMEOUT_MS;
  const sandbox = options.sandbox ?? (await Sandbox.start());
  let result: EpisodeResult;
  let agent: RemoteAgent;
  try {
    agent = new RemoteAgent({
      gateway,
      sandbox,
      transport,
      mode,
      name: "connection-check",
      episodeTimeoutMs: timeoutMs,
      runnerWaitMs: options.runnerWaitMs ?? CHECK_RUNNER_WAIT_MS,
      onEvent: forward,
    });
    result = await runEpisode(sandbox, {
      agent,
      attack: null,
      goal: options.goal ?? BENIGN_GOALS[Math.floor(Math.random() * BENIGN_GOALS.length)]!,
      worldSeed: randomBytes(16).toString("hex"),
      timeoutMs: timeoutMs + 30_000,
      ...(options.vault ? { vault: options.vault } : {}),
    });
  } finally {
    if (!options.sandbox) await sandbox.stop();
  }

  const record = agent.episodes.at(-1);
  const summary = result.agentSummary;
  const problems: string[] = [];
  const warnings: string[] = [];
  const seconds = Math.round(timeoutMs / 1000);

  // How it ended. A URL that refused the episode (or that Bonded couldn't call) is the only
  // problem: nothing else ran.
  const notRun = record?.urlProblem ?? record?.bondedProblem;
  if (notRun)
    return finish({
      passed: false,
      problems: [notRun],
      warnings: [],
      taskCompleted: null,
      toolsCalled: tally.tools,
      surfacesRead: [],
      ...(code ? { code } : {}),
    });
  if (summary.stoppedBecause === "error") {
    const message = summary.finalMessage ?? "";
    if (record?.runnerError && /could not start/.test(record.runnerError))
      problems.push(`The runner couldn't start your agent: ${record.runnerError}`);
    else if (/^timed out after/.test(message))
      problems.push(
        `It didn't finish within ${seconds} seconds: post to its done URL (or exit) when it has finished`,
      );
    else if (/runner disconnected/.test(message))
      problems.push("The runner disconnected during the episode");
    else if (/no runner is connected/.test(message)) problems.push("The runner isn't connected");
    else if (record && record.exitCode !== null && record.exitCode !== 0)
      problems.push(
        `It exited with code ${record.exitCode} before finishing (see its output below)`,
      );
    else if (record?.signal)
      problems.push(`It was stopped by ${record.signal} before finishing (see its output below)`);
    else problems.push(`The episode failed: ${message || "no reason given"}`);
  }

  const ranToEnd = problems.length === 0;

  // What it did.
  const surfacesRead = SURFACES.filter((surface) => (record?.reads[surface] ?? 0) > 0);
  if (tally.tools === 0 && tally.txs === 0)
    problems.push(
      "Your agent never called a tool: it must read and trade through the episode's MCP or HTTP endpoints",
    );
  const taskCompleted = result.taskCompleted ?? null;
  const modeHint =
    tally.chainWrites.length > 0
      ? `It called ${[...new Set(tally.chainWrites)].join(", ")} as a tool, but in chain mode trades are transactions it signs and sends through the RPC endpoint: is your agent set up for tools mode?`
      : tally.rpcInToolsMode
        ? "It tried the RPC endpoint, which only chain mode has: in tools mode trades are tool calls. Is your agent set up for chain mode?"
        : undefined;
  if (taskCompleted === false && ranToEnd) {
    const trade = benignTrade(result.task.goal);
    problems.push(
      trade
        ? `It didn't make the trade its task names (buy ${trade.amountUsd} ${trade.tokenIn} worth of ${trade.tokenOut})`
        : "It didn't make the trade its task names",
    );
    if (modeHint) problems.push(modeHint);
  } else if (modeHint) (taskCompleted === false ? problems : warnings).push(modeHint);
  if (result.verdict.breached)
    problems.push(
      `Its actions broke the mandate in a benign episode (${result.verdict.breaches.map((b) => b.type).join(", ")}): a rating would count that against it`,
    );

  // What will cost it score, or make estimates rough.
  if (surfacesRead.length < SURFACES.length && tally.tools > 0)
    warnings.push(
      `It read ${surfacesRead.length} of ${SURFACES.length} surfaces; unread ones are scored as untested`,
    );
  if (tally.failedTools.length > 0) {
    const first = tally.failedTools[0]!;
    warnings.push(
      `${tally.failedTools.length} tool call${tally.failedTools.length === 1 ? "" : "s"} failed; the first: ${first.name}: ${first.error}`,
    );
  }
  if (tally.failedTxs.length > 0)
    warnings.push(
      `${tally.failedTxs.length} transaction${tally.failedTxs.length === 1 ? " was" : "s were"} refused; the first: ${tally.failedTxs[0]}`,
    );
  // A note, not a fix: an agent with no model has no usage to report (NOTE_CODES).
  if (!record?.reportedUsage && problems.length === 0)
    warnings.push(
      "If your agent uses a model, report its usage at /done: without it, a cost estimate gives time only",
    );

  return finish({
    passed: problems.length === 0,
    problems,
    warnings,
    taskCompleted,
    toolsCalled: tally.tools,
    surfacesRead,
    ...(record?.reportedUsage ? { usage: record.reportedUsage } : {}),
    ...(done ? { durationMs: done.durationMs } : {}),
    ...(code ? { code } : {}),
    trading: tradingSummary(result.trades ?? []),
  });
}

/** A check's problems and warnings with their codes. */
export function checkIssues(
  result: Pick<CheckResult, "problems" | "warnings">,
): NonNullable<CheckResult["issues"]> {
  return [
    ...result.problems.map((text) => ({
      code: problemCode(text),
      severity: "problem" as const,
      message: text,
    })),
    ...result.warnings.map((text) => ({
      code: problemCode(text),
      severity: "warning" as const,
      message: text,
    })),
  ];
}
