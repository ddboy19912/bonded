import { type ChildProcess, spawn as spawnProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  type AgentRunSummary,
  type AgentTask,
  type AgentToolbox,
  agentToolDefinitions,
  splitToolImage,
  type ToolDefinition,
} from "@bondedhq/shared";

/**
 * Claude Code as an agent's brain: the same episode runToolLoop (demo-agents/llm-loop.ts) gives
 * an API model, run through `claude -p` on the user's Claude subscription instead.
 *
 * What the model gets is kept as close to runToolLoop as Claude Code allows:
 * - the system prompt replaces Claude Code's own (`--system-prompt`);
 * - the first user message is `Task: <goal>`;
 * - its only tools are the episode's, served by a local MCP server on 127.0.0.1 with the same
 *   descriptions and schemas; Claude Code's own tools (shell, files, web) are switched off;
 * - a tool result is the same JSON text runToolLoop sends, and the step cap is counted the same way;
 * - no user or project settings, hooks, plugins, skills, CLAUDE.md or memory are loaded, it runs
 *   in an empty folder, and its environment holds only what it needs to find its login.
 *
 * What it can't match: Claude Code adds a short environment note to the context (the working
 * folder, the OS, today's date and the model's name), and tool names reach the model with Claude
 * Code's MCP prefix (`mcp__toolbox__pay_invoice`).
 */

/** The name the episode's tool server has in Claude Code: tools show as `mcp__<name>__<tool>`. */
export const TOOL_SERVER_NAME = "toolbox";

/**
 * Environment variables a `claude -p` run keeps. Everything else is dropped: an API key would
 * bill the API instead of the subscription, and a parent Claude Code session's variables would
 * pass its account and session details on to the model.
 */
const KEPT_ENV = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "CLAUDE_CONFIG_DIR",
];

export function claudeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const name of KEPT_ENV) if (env[name] !== undefined) kept[name] = env[name];
  return kept;
}

export interface ClaudeArgs {
  model: string;
  system: string;
  prompt: string;
  mcpConfigFile: string;
  maxTurns: number;
}

/** The command line for one episode. */
export function claudeArgs(options: ClaudeArgs): string[] {
  return [
    "-p",
    options.prompt,
    "--model",
    options.model,
    "--system-prompt",
    options.system,
    "--mcp-config",
    options.mcpConfigFile,
    "--strict-mcp-config",
    // No built-in tools; the episode's MCP tools are allowed without asking.
    "--tools",
    "",
    "--allowedTools",
    `mcp__${TOOL_SERVER_NAME}`,
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--max-turns",
    String(options.maxTurns),
    "--output-format",
    "stream-json",
    "--verbose",
  ];
}

/** One usage window on the subscription, as Claude Code reports it. */
export interface UsageWindow {
  /** Share of the window used, 0 to 1. */
  utilization?: number;
  /** When the window resets, in Unix seconds. */
  resetsAt?: number;
}

/** Claude Code's `rate_limit_event`: the subscription's state after a request. */
export interface RateLimitInfo {
  status?: string;
  resetsAt?: number;
  unifiedWindows?: { five_hour?: UsageWindow; seven_day?: UsageWindow };
}

export interface UsageGateOptions {
  /** Wait for the 5-hour window to reset once it is this full (default 0.9). */
  pauseAt?: number;
  /**
   * Stop starting episodes once the 7-day window is this full (default 0.8), so a rating leaves
   * room on the plan for the owner's own work.
   */
  stopAtWeekly?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * Shared by every episode of a run: it remembers the last usage Claude Code reported, waits for
 * the 5-hour window to reset before an episode when it is nearly full, and stops the run when the
 * week's usage reaches its ceiling. Episodes never start into a limit they can see coming.
 */
export class ClaudeUsageGate {
  private latest: RateLimitInfo | undefined;
  private readonly pauseAt: number;
  private readonly stopAtWeekly: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;

  constructor(options: UsageGateOptions = {}) {
    this.pauseAt = options.pauseAt ?? 0.9;
    this.stopAtWeekly = options.stopAtWeekly ?? 0.8;
    if (
      !(this.pauseAt > 0 && this.pauseAt <= 1) ||
      !(this.stopAtWeekly > 0 && this.stopAtWeekly <= 1)
    )
      throw new RangeError("usage thresholds must be above 0 and at most 1");
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = options.log ?? ((line) => console.error(line));
  }

  observe(info: RateLimitInfo): void {
    this.latest = info;
  }

  get last(): RateLimitInfo | undefined {
    return this.latest;
  }

  /** Waits if the 5-hour window needs to reset; "stop" if the week's ceiling is reached. */
  async beforeEpisode(): Promise<"go" | "stop"> {
    for (;;) {
      const info = this.latest;
      if (!info) return "go";
      const week = info.unifiedWindows?.seven_day;
      if ((week?.utilization ?? 0) >= this.stopAtWeekly) {
        this.log(
          `claude-code: the 7-day window is ${pct(week?.utilization)} used (ceiling ${pct(this.stopAtWeekly)}): no more episodes`,
        );
        return "stop";
      }
      const hours = info.unifiedWindows?.five_hour;
      const rejected = info.status === "rejected";
      if (!rejected && (hours?.utilization ?? 0) < this.pauseAt) return "go";
      const resetsAt = (rejected ? info.resetsAt : hours?.resetsAt) ?? info.resetsAt;
      const waitMs = resetsAt ? resetsAt * 1000 - this.now() + 60_000 : 30 * 60_000;
      if (waitMs <= 0) {
        this.latest = undefined;
        return "go";
      }
      this.log(
        `claude-code: the 5-hour window is ${rejected ? "at its limit" : `${pct(hours?.utilization)} used`}; waiting ${Math.ceil(waitMs / 60_000)} min for it to reset`,
      );
      await this.sleep(waitMs);
      this.latest = undefined;
    }
  }
}

const pct = (x: number | undefined) => `${Math.round((x ?? 0) * 100)}%`;

/** The parts of `claude -p --output-format stream-json` a run reads. */
export interface ClaudeRunResult {
  /** The final `result` event's subtype: success, error_max_turns, error_during_execution... */
  subtype?: string;
  isError: boolean;
  finalMessage?: string;
  numTurns?: number;
  usage: { inputTokens: number; outputTokens: number };
  /** The model Claude Code reported in its init event. */
  model?: string;
  /** The subscription was out of usage during the run. */
  limited: boolean;
  /** The tools Claude Code offered the model, from its init event. */
  tools?: string[];
  /** MCP servers Claude Code refused to load, from its init event (a reserved name, say). */
  mcpErrors?: string[];
}

/** Reads the stream-json lines of one run; `onRateLimit` gets each usage report. */
export function readClaudeStream(
  lines: readonly string[],
  onRateLimit?: (info: RateLimitInfo) => void,
): ClaudeRunResult {
  const result: ClaudeRunResult = {
    isError: true,
    usage: { inputTokens: 0, outputTokens: 0 },
    limited: false,
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "system" && event.subtype === "init") {
      if (typeof event.model === "string") result.model = event.model;
      if (Array.isArray(event.tools)) result.tools = event.tools.map(String);
      if (Array.isArray(event.mcp_server_errors) && event.mcp_server_errors.length > 0)
        result.mcpErrors = event.mcp_server_errors.map((e: { message?: unknown }) =>
          String(e?.message ?? JSON.stringify(e)),
        );
    } else if (event.type === "rate_limit_event") {
      const info = (event.rate_limit_info ?? {}) as RateLimitInfo;
      if (info.status === "rejected") result.limited = true;
      onRateLimit?.(info);
    } else if (event.type === "result") {
      result.subtype = typeof event.subtype === "string" ? event.subtype : undefined;
      result.isError = event.is_error === true || result.subtype !== "success";
      if (typeof event.result === "string") result.finalMessage = event.result;
      if (typeof event.num_turns === "number") result.numTurns = event.num_turns;
      const u = (event.usage ?? {}) as Record<string, unknown>;
      const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
      result.usage = {
        inputTokens:
          n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens"),
        outputTokens: n("output_tokens"),
      };
      if (
        result.isError &&
        /usage limit|limit reached|rate.?limit/i.test(result.finalMessage ?? "")
      )
        result.limited = true;
    }
  }
  return result;
}

export interface ClaudeCodeLoopOptions {
  /** A Claude model id, e.g. claude-sonnet-5-5. */
  model: string;
  system: string;
  task: AgentTask;
  tools: AgentToolbox;
  /** The tools offered to the model. Defaults to the on-chain rail's (AGENT_TOOLS). */
  toolDefinitions?: ToolDefinition[];
  /** Show tool images (invoice scans) to the model. Off by default, as for runToolLoop. */
  vision?: boolean;
  gate?: ClaudeUsageGate;
  /** The Claude Code executable (default `claude`, or CLAUDE_CODE_BIN). */
  claudeBin?: string;
  /** Ends the run if Claude Code is still going (default 20 minutes). */
  timeoutMs?: number;
  /** For tests: starts the process. */
  spawn?: (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => ChildProcess;
}

/** What an episode reports when the plan has no usage left: the batch stops, not the agent. */
export const USAGE_LIMIT_MESSAGE = "the Claude subscription's usage limit was reached (402)";

/** What an episode reports when Claude Code didn't load its tools: the batch stops, unscored. */
export const NO_TOOLS_MESSAGE = "Claude Code did not load the episode's tools (403)";

/**
 * Runs one episode through Claude Code. Never throws: failures come back as stoppedBecause
 * "error". Two of them aren't the agent's (USAGE_LIMIT_MESSAGE, NO_TOOLS_MESSAGE) and carry a
 * status a batch reads as an account stop, so the episode is skipped rather than scored.
 */
export async function runClaudeCodeLoop(options: ClaudeCodeLoopOptions): Promise<AgentRunSummary> {
  const { task, tools } = options;
  const definitions = (options.toolDefinitions ?? agentToolDefinitions()).filter(
    (d) => !task.tools || task.tools.includes(d.function.name),
  );
  let steps = 0;
  const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const summary = (
    stoppedBecause: AgentRunSummary["stoppedBecause"],
    finalMessage?: string,
  ): AgentRunSummary => ({
    steps,
    stoppedBecause,
    ...(finalMessage === undefined ? {} : { finalMessage }),
    // The subscription pays: nothing here counts toward a run's spending cap.
    usage,
  });

  if (options.gate && (await options.gate.beforeEpisode()) === "stop")
    return summary("error", USAGE_LIMIT_MESSAGE);
  if (tools.signal?.aborted) return summary("error", "the episode ended");

  const callTool = async (name: string, args: unknown): Promise<CallToolResult> => {
    if (steps >= task.maxSteps)
      return textResult({ error: `step limit of ${task.maxSteps} reached` }, true);
    steps++;
    const result = await tools.call(name, args ?? {});
    if (!result.ok) return textResult({ error: result.error }, true);
    const { rest, image } = splitToolImage(result.output);
    if (!image) return textResult(result.output, false);
    const text = JSON.stringify({
      ...(rest as Record<string, unknown>),
      image: options.vision ? "attached" : "not shown: this model reads text only",
    });
    return {
      content: [
        { type: "text", text },
        ...(options.vision
          ? [{ type: "image" as const, data: image.base64, mimeType: image.mediaType }]
          : []),
      ],
    };
  };

  const server = await serveTools(definitions, callTool);
  const dir = mkdtempSync(join(tmpdir(), "agent-"));
  const workdir = join(dir, "workspace");
  const lines: string[] = [];
  let stderr = "";
  try {
    mkdirSync(workdir);
    const mcpConfigFile = join(dir, "mcp.json");
    writeFileSync(
      mcpConfigFile,
      JSON.stringify({ mcpServers: { [TOOL_SERVER_NAME]: { type: "http", url: server.url } } }),
    );
    const args = claudeArgs({
      model: options.model,
      system: options.system,
      prompt: `Task: ${task.goal}`,
      mcpConfigFile,
      maxTurns: task.maxSteps + 1,
    });
    const command = options.claudeBin ?? process.env.CLAUDE_CODE_BIN ?? "claude";
    const env = claudeEnv(process.env);
    const child = options.spawn
      ? options.spawn(command, args, workdir, env)
      : spawnProcess(command, args, { cwd: workdir, env, stdio: ["ignore", "pipe", "pipe"] });
    const exit = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
      let buffered = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        buffered += chunk;
        const parts = buffered.split("\n");
        buffered = parts.pop() ?? "";
        lines.push(...parts);
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-4000);
      });
      const stop = () => child.kill("SIGTERM");
      tools.signal?.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(stop, options.timeoutMs ?? 20 * 60_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ code: null, error });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        tools.signal?.removeEventListener("abort", stop);
        if (buffered) lines.push(buffered);
        resolve({ code });
      });
    });
    const run = readClaudeStream(lines, (info) => options.gate?.observe(info));
    usage.inputTokens = run.usage.inputTokens;
    usage.outputTokens = run.usage.outputTokens;
    if (exit.error) return summary("error", `could not start Claude Code: ${exit.error.message}`);
    if (run.limited) return summary("error", USAGE_LIMIT_MESSAGE);
    // The model never saw the episode's tools: the harness failed, not the agent. The status in
    // the message makes a batch skip the episode and stop, as for a refused key (modelAccountStop).
    if (run.mcpErrors?.length)
      return summary("error", `${NO_TOOLS_MESSAGE}: ${run.mcpErrors.join("; ")}`);
    if (
      definitions.length > 0 &&
      run.tools &&
      !run.tools.some((t) => t.startsWith(`mcp__${TOOL_SERVER_NAME}__`))
    )
      return summary("error", NO_TOOLS_MESSAGE);
    if (tools.signal?.aborted) return summary("error", "the episode ended");
    if (run.subtype === undefined)
      return summary(
        "error",
        `Claude Code exited (${exit.code}) without a result: ${stderr.trim().slice(-500)}`,
      );
    if (run.subtype === "error_max_turns" || steps >= task.maxSteps)
      return summary("max_steps", run.finalMessage?.trim());
    if (run.isError)
      return summary("error", run.finalMessage?.trim() || `Claude Code: ${run.subtype}`);
    return summary("done", (run.finalMessage ?? "").trim());
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function textResult(payload: unknown, isError: boolean): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) ?? "null" }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * The episode's tools over MCP (streamable HTTP, stateless) on 127.0.0.1, at a path with a
 * random token so nothing else on the machine can call them.
 */
export async function serveTools(
  definitions: readonly ToolDefinition[],
  call: (name: string, args: unknown) => Promise<CallToolResult>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const path = `/${randomBytes(16).toString("hex")}/mcp`;
  const names = new Set(definitions.map((d) => d.function.name));
  const http: HttpServer = createServer((req: IncomingMessage, res) => {
    if (req.url !== path) {
      res.writeHead(404).end();
      return;
    }
    const server = new Server(
      { name: TOOL_SERVER_NAME, version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: definitions.map((d) => ({
        name: d.function.name,
        description: d.function.description,
        inputSchema: d.function.parameters as { type: "object"; [key: string]: unknown },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) =>
      names.has(request.params.name)
        ? call(request.params.name, request.params.arguments ?? {})
        : textResult({ error: `unknown tool ${request.params.name}` }, true),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    void server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${path}`,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
