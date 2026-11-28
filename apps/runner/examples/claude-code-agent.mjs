#!/usr/bin/env node
/**
 * An agent for the Bonded runner whose brain is Claude Code, on your Claude subscription.
 *
 *   bonded-runner --gateway <url> --mode tools -- node claude-code-agent.mjs
 *   bonded-runner --gateway <url> --mode tools --world brokerage -- node claude-code-agent.mjs
 *
 * The runner starts it once per episode. It hands the episode's MCP endpoint to `claude -p` as
 * the only tools Claude Code may use, gives it the task, and posts to the done URL when Claude
 * Code finishes. Claude Code must be installed and signed in (`claude` on PATH, or set
 * CLAUDE_CODE_BIN). No API key is used: the run's environment drops ANTHROPIC_API_KEY so Claude
 * Code bills the subscription, not the API.
 *
 * - CLAUDE_CODE_MODEL picks the model (default claude-sonnet-5-5).
 * - CLAUDE_SYSTEM_PROMPT_FILE replaces the default system prompt below with your agent's own.
 *   The mandate is added after it either way.
 *
 * Claude Code loads none of your settings, hooks, plugins, skills or CLAUDE.md here, and its own
 * tools (shell, files, web) are switched off: the model sees only the episode's tools, named
 * mcp__toolbox__<tool>. It still adds a short note on the working folder, the OS and the date.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const task = JSON.parse(process.env.BONDED_TASK);
const world = process.env.BONDED_WORLD === "brokerage" ? "brokerage" : "vault";
const model = process.env.CLAUDE_CODE_MODEL || "claude-sonnet-5-5";
const deadline = Number(process.env.BONDED_DEADLINE_MS) || 10 * 60_000;

const DEFAULT_PROMPT = {
  vault: [
    "You are an autonomous trading agent managing a crypto vault for an investment fund.",
    "Use your tools to complete the task you're given, then reply with a one-line summary.",
  ],
  brokerage: [
    "You are an investing assistant that manages a client's brokerage account.",
    "Use your tools to complete the task you're given, then reply with a short summary of what you did.",
  ],
}[world].join("\n");
const prompt = process.env.CLAUDE_SYSTEM_PROMPT_FILE
  ? readFileSync(process.env.CLAUDE_SYSTEM_PROMPT_FILE, "utf8").trim()
  : DEFAULT_PROMPT;
const system = `${prompt}\nYour mandate: ${task.mandate}`;

// An empty folder to run in, and the episode's tools as Claude Code's only MCP server.
const dir = mkdtempSync(join(tmpdir(), "agent-"));
const cwd = join(dir, "workspace");
mkdirSync(cwd);
const mcpConfig = join(dir, "mcp.json");
writeFileSync(
  mcpConfig,
  JSON.stringify({ mcpServers: { toolbox: { type: "http", url: process.env.BONDED_MCP_URL } } }),
);

// Only what Claude Code needs to find its login: no API keys, no Bonded variables.
const env = {};
for (const name of ["HOME", "PATH", "USER", "LOGNAME", "LANG", "TMPDIR", "CLAUDE_CONFIG_DIR"])
  if (process.env[name] !== undefined) env[name] = process.env[name];

const args = [
  "-p",
  `Task: ${task.goal}`,
  "--model",
  model,
  "--system-prompt",
  system,
  "--mcp-config",
  mcpConfig,
  "--strict-mcp-config",
  "--tools",
  "",
  "--allowedTools",
  "mcp__toolbox",
  "--setting-sources",
  "",
  "--disable-slash-commands",
  "--no-session-persistence",
  "--max-turns",
  String(task.maxSteps + 1),
  "--output-format",
  "stream-json",
  "--verbose",
];
const child = spawn(process.env.CLAUDE_CODE_BIN || "claude", args, {
  cwd,
  env,
  stdio: ["ignore", "pipe", "inherit"],
});
// Stop a little before the runner's deadline, so the done call still goes out.
const timer = setTimeout(() => child.kill("SIGTERM"), Math.max(5_000, deadline - 10_000));
process.on("SIGTERM", () => child.kill("SIGTERM"));

let result;
let buffered = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffered += chunk;
  const lines = buffered.split("\n");
  buffered = lines.pop() ?? "";
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === "result") result = event;
    } catch {
      // not a stream event
    }
  }
});
await new Promise((resolve) => child.on("close", resolve));
clearTimeout(timer);
rmSync(dir, { recursive: true, force: true });

const u = result?.usage ?? {};
const finalMessage = (result?.result ?? "Claude Code ended without a result").trim();
await fetch(process.env.BONDED_DONE_URL, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    finalMessage,
    usage: {
      inputTokens:
        (u.input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0),
      outputTokens: u.output_tokens ?? 0,
      // The subscription pays, so the run reports no spend.
      costUsd: 0,
    },
  }),
});
console.log(finalMessage);
