import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BROKER_SYSTEM_PROMPT, PAYABLES_SYSTEM_PROMPT } from "@bonded/demo-agents";
import {
  type AgentTask,
  type AgentToolbox,
  modelAccountStop,
  type ToolDefinition,
} from "@bondedhq/shared";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAgent, claudeModel, worldSetup } from "../src/claude-code/agent.js";
import {
  claudeArgs,
  claudeEnv,
  ClaudeUsageGate,
  NO_TOOLS_MESSAGE,
  readClaudeStream,
  runClaudeCodeLoop,
  TOOL_SERVER_NAME,
  USAGE_LIMIT_MESSAGE,
} from "../src/claude-code/loop.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));

const PAY: ToolDefinition = {
  type: "function",
  function: {
    name: "pay",
    description: "Pays an invoice.",
    parameters: {
      type: "object",
      properties: { invoice: { type: "string" } },
      required: ["invoice"],
    },
  },
};

const task = (maxSteps = 5): AgentTask => ({
  goal: "Pay INV-1.",
  mandate: "Pay approved invoices only.",
  maxSteps,
});

function toolbox(): AgentToolbox & { calls: [string, unknown][] } {
  const calls: [string, unknown][] = [];
  return {
    calls,
    call: async (name, args) => {
      calls.push([name, args]);
      return { ok: true, output: { paid: (args as { invoice: string }).invoice } };
    },
  };
}

/** Runs the fake claude with node, in `mode`, recording its argv and env to a file. */
function fake(mode: string) {
  const record = join(mkdtempSync(join(tmpdir(), "fake-claude-")), "record.json");
  return {
    record: () =>
      JSON.parse(readFileSync(record, "utf8")) as {
        args: string[];
        env: Record<string, string>;
        cwd: string;
      },
    spawn: (_command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
      spawn(process.execPath, [FAKE, ...args], {
        cwd,
        env: { ...env, FAKE_MODE: mode, FAKE_RECORD: record },
        stdio: ["ignore", "pipe", "pipe"],
      }),
  };
}

describe("the claude -p command line and environment", () => {
  it("drops API keys and a parent session's variables, and keeps what the login needs", () => {
    const env = claudeEnv({
      HOME: "/home/a",
      PATH: "/bin",
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANTHROPIC_BASE_URL: "https://example.test",
      CLAUDECODE: "1",
      CLAUDE_CODE_USER_EMAIL: "someone@example.test",
      OPENROUTER_API_KEY: "or-test",
    });
    expect(env).toEqual({ HOME: "/home/a", PATH: "/bin" });
  });

  it("replaces the system prompt and switches off settings, built-in tools and skills", () => {
    const args = claudeArgs({
      model: "claude-sonnet-5-5",
      system: "SYSTEM",
      prompt: "Task: x",
      mcpConfigFile: "/tmp/mcp.json",
      maxTurns: 31,
    });
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(value("-p")).toBe("Task: x");
    expect(value("--system-prompt")).toBe("SYSTEM");
    expect(value("--tools")).toBe("");
    expect(value("--setting-sources")).toBe("");
    expect(value("--allowedTools")).toBe(`mcp__${TOOL_SERVER_NAME}`);
    expect(value("--max-turns")).toBe("31");
    expect(args).toEqual(
      expect.arrayContaining(["--strict-mcp-config", "--disable-slash-commands"]),
    );
    expect(TOOL_SERVER_NAME).not.toBe("workspace"); // Claude Code reserves that name
  });

  it("takes only Claude model ids", () => {
    expect(claudeModel("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(() => claudeModel(undefined)).toThrow(/needs --model/);
    expect(() => claudeModel("deepseek/deepseek-v4.1-flash")).toThrow(/Claude model id/);
  });
});

describe("reading Claude Code's stream", () => {
  it("adds cached input to the input tokens and reads the final message", () => {
    const run = readClaudeStream([
      JSON.stringify({
        type: "system",
        subtype: "init",
        model: "claude-sonnet-5-5",
        tools: ["mcp__toolbox__pay"],
      }),
      "not json",
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 1,
          output_tokens: 3,
        },
      }),
    ]);
    expect(run).toMatchObject({
      subtype: "success",
      isError: false,
      finalMessage: "done",
      model: "claude-sonnet-5-5",
      usage: { inputTokens: 16, outputTokens: 3 },
      limited: false,
    });
  });

  it("marks a run the plan's limit stopped", () => {
    const seen: unknown[] = [];
    const run = readClaudeStream(
      [
        JSON.stringify({
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected", resetsAt: 5 },
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: true,
          result: "usage limit reached",
        }),
      ],
      (info) => seen.push(info),
    );
    expect(run.limited).toBe(true);
    expect(seen).toEqual([{ status: "rejected", resetsAt: 5 }]);
  });
});

describe("the usage gate", () => {
  const gate = (pauseAt?: number) => {
    const waits: number[] = [];
    const g = new ClaudeUsageGate({
      ...(pauseAt ? { pauseAt } : {}),
      now: () => 1_000_000,
      sleep: async (ms) => {
        waits.push(ms);
      },
      log: () => {},
    });
    return { g, waits };
  };

  it("lets an episode start when nothing is known or the window has room", async () => {
    const { g, waits } = gate();
    expect(await g.beforeEpisode()).toBe("go");
    g.observe({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.5 } } });
    expect(await g.beforeEpisode()).toBe("go");
    expect(waits).toEqual([]);
  });

  it("waits for the 5-hour window to reset once it is nearly full", async () => {
    const { g, waits } = gate();
    g.observe({
      status: "allowed",
      unifiedWindows: { five_hour: { utilization: 0.92, resetsAt: 1_600 } },
    });
    expect(await g.beforeEpisode()).toBe("go");
    // Reset at 1,600 s; now is 1,000 s; plus a minute of slack.
    expect(waits).toEqual([600_000 + 60_000]);
  });

  it("waits when the plan refused a request, until the reset it gave", async () => {
    const { g, waits } = gate();
    g.observe({ status: "rejected", resetsAt: 1_120 });
    expect(await g.beforeEpisode()).toBe("go");
    expect(waits).toEqual([120_000 + 60_000]);
  });

  it("stops the run at the week's ceiling, leaving the plan room for its owner", async () => {
    const { g } = gate();
    g.observe({ status: "allowed", unifiedWindows: { seven_day: { utilization: 0.8 } } });
    expect(await g.beforeEpisode()).toBe("stop");
  });
});

describe("an episode through Claude Code", () => {
  it("serves the episode's tools over MCP and returns what runToolLoop would", async () => {
    const run = fake("pay");
    const tools = toolbox();
    const gate = new ClaudeUsageGate({ log: () => {} });
    const summary = await runClaudeCodeLoop({
      model: "claude-sonnet-5-5",
      system: "SYSTEM",
      task: task(),
      tools,
      toolDefinitions: [PAY],
      gate,
      spawn: run.spawn,
    });
    expect(tools.calls).toEqual([["pay", { invoice: "INV-1" }]]);
    expect(summary.stoppedBecause).toBe("done");
    expect(summary.steps).toBe(1);
    // The tool result is the same JSON text runToolLoop sends, and the message is trimmed.
    expect(summary.finalMessage).toBe(
      `Paid. ${JSON.stringify([{ isError: false, text: '{"paid":"INV-1"}' }])}`,
    );
    // The subscription pays: tokens are kept, nothing counts toward a spending cap.
    expect(summary.usage).toEqual({ inputTokens: 175, outputTokens: 40, costUsd: 0 });
    expect(gate.last?.unifiedWindows?.five_hour?.utilization).toBe(0.25);
    const { args, env, cwd } = run.record();
    expect(args[args.indexOf("-p") + 1]).toBe("Task: Pay INV-1.");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("6");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(cwd).toMatch(/workspace$/);
  });

  it("counts the step cap as runToolLoop does", async () => {
    const tools = toolbox();
    const summary = await runClaudeCodeLoop({
      model: "claude-sonnet-5-5",
      system: "SYSTEM",
      task: task(2),
      tools,
      toolDefinitions: [PAY],
      spawn: fake("loop").spawn,
    });
    expect(tools.calls).toHaveLength(2);
    expect(summary.stoppedBecause).toBe("max_steps");
    expect(summary.finalMessage).toContain(
      JSON.stringify(JSON.stringify({ error: "step limit of 2 reached" })).slice(1, -1),
    );
  });

  it("offers only the tools the episode has", async () => {
    const tools = toolbox();
    const summary = await runClaudeCodeLoop({
      model: "claude-sonnet-5-5",
      system: "SYSTEM",
      task: { ...task(), tools: ["read_inbox"] },
      tools,
      toolDefinitions: [PAY],
      spawn: fake("pay").spawn,
    });
    // pay isn't offered, so the server refuses it and the toolbox never sees it.
    expect(tools.calls).toEqual([]);
    expect(summary.steps).toBe(0);
  });

  it("stops the batch, unscored, when the plan is out of usage", async () => {
    const summary = await runClaudeCodeLoop({
      model: "claude-sonnet-5-5",
      system: "SYSTEM",
      task: task(),
      tools: toolbox(),
      toolDefinitions: [PAY],
      spawn: fake("limited").spawn,
    });
    expect(summary).toMatchObject({ stoppedBecause: "error", finalMessage: USAGE_LIMIT_MESSAGE });
    expect(modelAccountStop(summary.finalMessage)).toBe(402);
  });

  it("stops the batch, unscored, when Claude Code didn't load the tools", async () => {
    const summary = await runClaudeCodeLoop({
      model: "claude-sonnet-5-5",
      system: "SYSTEM",
      task: task(),
      tools: toolbox(),
      toolDefinitions: [PAY],
      spawn: fake("no-tools").spawn,
    });
    expect(summary.stoppedBecause).toBe("error");
    expect(summary.finalMessage).toContain(NO_TOOLS_MESSAGE);
    expect(modelAccountStop(summary.finalMessage)).toBe(403);
  });

  it("starts nothing once the gate says stop", async () => {
    const gate = new ClaudeUsageGate({ log: () => {} });
    gate.observe({ unifiedWindows: { seven_day: { utilization: 0.95 } } });
    const tools = toolbox();
    const summary = await runClaudeCodeLoop({
      model: "claude-sonnet-5-5",
      system: "SYSTEM",
      task: task(),
      tools,
      toolDefinitions: [PAY],
      gate,
      spawn: () => {
        throw new Error("should not start");
      },
    });
    expect(summary.finalMessage).toBe(USAGE_LIMIT_MESSAGE);
    expect(tools.calls).toEqual([]);
  });

  it("reports a crash as the agent's error, with Claude Code's stderr", async () => {
    const summary = await runClaudeCodeLoop({
      model: "claude-sonnet-5-5",
      system: "SYSTEM",
      task: task(),
      tools: toolbox(),
      toolDefinitions: [PAY],
      spawn: fake("crash").spawn,
    });
    expect(summary.stoppedBecause).toBe("error");
    expect(summary.finalMessage).toMatch(/exited \(3\) without a result: boom/);
    expect(modelAccountStop(summary.finalMessage)).toBeUndefined();
  });
});

describe("ClaudeCodeAgent", () => {
  it("uses each world's Index prompt", () => {
    const t = task();
    const tools = toolbox();
    expect(worldSetup("offchain", t, tools).system).toBe(
      `${PAYABLES_SYSTEM_PROMPT}\nYour mandate: ${t.mandate}`,
    );
    expect(worldSetup("brokerage", t, tools).system).toBe(
      `${BROKER_SYSTEM_PROMPT}\nYour mandate: ${t.mandate}`,
    );
    expect(worldSetup("vault", t, tools).system).toContain(`Your mandate: ${t.mandate}`);
    expect(worldSetup("offchain", t, tools).toolDefinitions.map((d) => d.function.name)).toContain(
      "pay_invoice",
    );
  });

  it("is named for its model", () => {
    expect(new ClaudeCodeAgent({ model: "claude-opus-5-5", world: "offchain" }).name).toBe(
      "claude-code/claude-opus-5-5",
    );
  });
});
