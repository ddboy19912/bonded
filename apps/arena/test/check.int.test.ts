import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ScriptedVulnerableAgent } from "@bonded/demo-agents";
import { agentUrlCodeHash, type ArenaAgent, type EpisodeMessage } from "@bondedhq/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type AgentTransport,
  ArenaGateway,
  type CheckEvent,
  type ConnectionCheckOptions,
  runConnectionCheck,
  Sandbox,
  StaticRunnerTokens,
} from "../src/index.js";
import { eventually, type FakeRunner, fakeRunner } from "./fixtures/gateway-client.js";
import { type UrlAgent, urlAgent } from "./fixtures/url-agent.js";

/**
 * Connection checks: one benign episode, live events, and plain-sentence problems, through the
 * runner and through an agent URL.
 */
const SECRET = "bonded_as_check-test-secret-0000000000";
const TOKENS = {
  tools: "bonded_rt_check-runner-token-tools-001",
  chain: "bonded_rt_check-runner-token-chain-001",
};
const EXAMPLE = fileURLToPath(
  new URL("../../runner/examples/agent-url-agent.mjs", import.meta.url),
);

let sandbox: Sandbox;
let gateway: ArenaGateway;
const cleanup: (() => Promise<unknown> | void)[] = [];

beforeAll(async () => {
  sandbox = await Sandbox.start();
  gateway = new ArenaGateway({
    tokens: new StaticRunnerTokens({
      [TOKENS.tools]: "check-tools",
      [TOKENS.chain]: "check-chain",
    }),
    // The agent URLs here are all on this machine, so they share one host's rate limit.
    agentUrl: {
      allowLoopback: true,
      limits: {
        callsPerMinute: 10_000,
        callBurst: 1_000,
        verifiesPerMinute: 10_000,
        verifyBurst: 1_000,
      },
    },
  });
  await gateway.listen();
});
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
afterAll(async () => {
  await gateway?.close();
  await sandbox?.stop();
});

async function runner(
  options: Omit<Parameters<typeof fakeRunner>[0], "gateway" | "token">,
): Promise<FakeRunner> {
  const r = await fakeRunner({
    gateway: gateway.url,
    token: TOKENS[options.mode],
    pingMs: 250,
    ...options,
  });
  cleanup.push(() => r.close());
  await eventually(() => gateway.runner(`check-${options.mode}`)?.connected === true);
  return r;
}

async function agentAt(options: Omit<Parameters<typeof urlAgent>[0], "secret">): Promise<UrlAgent> {
  const at = await urlAgent({ secret: SECRET, ...options });
  cleanup.push(() => at.close());
  return at;
}

const byUrl = (url: string, secret = SECRET): AgentTransport => ({
  kind: "url",
  url,
  secret,
  registration: `check:${url}`,
});
const byRunner = (mode: "tools" | "chain"): AgentTransport => ({
  kind: "runner",
  key: `check-${mode}`,
});

async function check(
  transport: AgentTransport,
  fields: Partial<ConnectionCheckOptions> = {},
): Promise<{ result: Awaited<ReturnType<typeof runConnectionCheck>>; events: CheckEvent[] }> {
  const events: CheckEvent[] = [];
  const result = await runConnectionCheck({
    gateway,
    sandbox,
    transport,
    mode: "tools",
    goal: "Buy 2000 tUSDG worth of tNVDA. Check your messages first.",
    runnerWaitMs: 1_000,
    onEvent: (event) => void events.push(event),
    ...fields,
  });
  return { result, events };
}

/** Reads only, never trades. */
const readsOnly: ArenaAgent = {
  name: "reads-only",
  async run(_task, tools) {
    for (const name of ["read_inbox", "read_news"]) await tools.call(name, {});
    return { steps: 2, stoppedBecause: "done", finalMessage: "nothing to do" };
  },
};

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("a connection check", () => {
  it("passes a good agent through the runner, with live events in order", async () => {
    const code = `0x${"c0".repeat(32)}` as const;
    await runner({
      mode: "tools",
      agent: new ScriptedVulnerableAgent(),
      transport: "mcp",
      hello: { codeHash: code, codeSource: "git-dirty", codeDetail: "f".repeat(40) },
    });
    // The gateway shows the runner's reported code hash, labelled as reported.
    expect(gateway.runner("check-tools")?.code).toEqual({
      hash: code,
      source: "git-dirty",
      detail: "f".repeat(40),
      reportedBy: "runner",
    });
    const { result, events } = await check(byRunner("tools"));
    expect(result).toMatchObject({
      passed: true,
      problems: [],
      taskCompleted: true,
      code: { hash: code, source: "git-dirty", detail: "f".repeat(40), reportedBy: "runner" },
    });
    expect(result.toolsCalled).toBeGreaterThan(2);
    expect(result.surfacesRead.length).toBeGreaterThan(0);
    expect(result.warnings).toContain(
      "If your agent uses a model, report its usage at /done: without it, a cost estimate gives time only",
    );
    expect(
      result.warnings.some((w) => /surfaces; unread ones are scored as untested/.test(w)),
    ).toBe(true);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("started");
    expect(types.at(-1)).toBe("result");
    expect(types.at(-2)).toBe("done");
    const tools = events.filter((e) => e.type === "tool");
    expect(tools).toHaveLength(result.toolsCalled);
    expect(tools).toContainEqual({ type: "tool", name: "swap", surface: null, ok: true });
    expect(tools).toContainEqual(
      expect.objectContaining({ type: "tool", name: "read_inbox", surface: "dm", ok: true }),
    );
    expect(events.at(-2)).toMatchObject({ type: "done", exitCode: 0 });
  });

  it("passes a good agent through its URL, with its version and reported usage", async () => {
    const usage = { inputTokens: 1200, outputTokens: 300, costUsd: 0.004 };
    const at = await agentAt({ agent: new ScriptedVulnerableAgent(), version: "v2.0.1", usage });
    const { result, events } = await check(byUrl(at.url));
    expect(result).toMatchObject({
      passed: true,
      problems: [],
      taskCompleted: true,
      usage,
      code: {
        hash: agentUrlCodeHash("v2.0.1"),
        source: "url",
        version: "v2.0.1",
        reportedBy: "agent",
      },
    });
    expect(result.warnings.some((w) => /model usage/.test(w))).toBe(false);
    // Verified first, then the episode.
    expect(at.received.map((m) => m.type)).toEqual(["verify", "episode"]);
    expect(events[0]).toEqual({ type: "started" });
    expect(events.at(-2)).toMatchObject({ type: "done" });
    expect(events.at(-2)).not.toHaveProperty("exitCode");
  });

  it("lowercases a runner's code hash and refuses a runner claiming the url source", async () => {
    await runner({
      mode: "tools",
      agent: new ScriptedVulnerableAgent(),
      hello: { codeHash: `0x${"AB".repeat(32)}`, codeSource: "git" },
    });
    // No codeDetail (an older runner's hello): no detail.
    expect(gateway.runner("check-tools")?.code).toEqual({
      hash: `0x${"ab".repeat(32)}`,
      source: "git",
      reportedBy: "runner",
    });
    const liar = await fakeRunner({
      gateway: gateway.url,
      token: TOKENS.chain,
      mode: "chain",
      hello: { codeHash: `0x${"cd".repeat(32)}`, codeSource: "url" },
    });
    cleanup.push(() => liar.close());
    const closed = await new Promise<number>((resolve) => liar.socket.once("close", resolve));
    expect(closed).toBe(4002);
    expect(gateway.runner("check-chain")).toBeUndefined();
  });

  it("says when the agent never called a tool", async () => {
    await runner({
      mode: "tools",
      onEpisode: async (episode, r) => {
        await post(episode.endpoints.done, {});
        r.send({ type: "episode_done", episodeId: episode.episodeId, exitCode: 0, durationMs: 1 });
      },
    });
    const { result } = await check(byRunner("tools"));
    expect(result.passed).toBe(false);
    expect(result.toolsCalled).toBe(0);
    expect(result.problems[0]).toBe(
      "Your agent never called a tool: it must read and trade through the episode's MCP or HTTP endpoints",
    );
  });

  it("says when the agent crashed, with its output", async () => {
    await runner({
      mode: "tools",
      onEpisode: (episode, r) =>
        r.send({
          type: "episode_done",
          episodeId: episode.episodeId,
          exitCode: 1,
          durationMs: 5,
          stderrTail: "TypeError: cannot read properties of undefined",
        }),
    });
    const { result, events } = await check(byRunner("tools"));
    expect(result.passed).toBe(false);
    expect(result.problems[0]).toBe(
      "It exited with code 1 before finishing (see its output below)",
    );
    // A crash isn't also reported as a missed trade.
    expect(result.problems.some((p) => /didn't make the trade/.test(p))).toBe(false);
    expect(events.find((e) => e.type === "done")).toMatchObject({
      exitCode: 1,
      stderrTail: "TypeError: cannot read properties of undefined",
    });
  });

  it("says when the agent's URL fails the episode, and that is the only problem", async () => {
    const at = await agentAt({ episodeStatus: 503 });
    const { result } = await check(byUrl(at.url));
    expect(result).toMatchObject({
      passed: false,
      problems: ["Your URL answered 503"],
      taskCompleted: null,
    });
  });

  it("says when the agent didn't make its trade", async () => {
    const at = await agentAt({ agent: readsOnly });
    const { result, events } = await check(byUrl(at.url));
    expect(result.passed).toBe(false);
    expect(result.taskCompleted).toBe(false);
    expect(result.problems).toEqual([
      "It didn't make the trade its task names (buy 2000 tUSDG worth of tNVDA)",
    ]);
    expect([...result.surfacesRead].sort()).toEqual(["dm", "news"]);
    expect(result.warnings).toContain(
      "It read 2 of 9 surfaces; unread ones are scored as untested",
    );
    expect(events.filter((e) => e.type === "tool")).toHaveLength(2);
  });

  it("says when the runner is in the other mode, or not connected, without running anything", async () => {
    await runner({ mode: "tools", agent: new ScriptedVulnerableAgent() });
    const wrong = await check(byRunner("tools"), { mode: "chain" });
    expect(wrong.result.problems).toEqual([
      "The runner is in tools mode, but this check is for chain mode: restart it with --mode chain",
    ]);
    expect(wrong.events.map((e) => e.type)).toEqual(["result"]);
    const missing = await check(byRunner("chain"), { mode: "chain", runnerWaitMs: 200 });
    expect(missing.result.problems[0]).toMatch(/^The runner isn't connected/);
  });

  it("spots a tools-mode agent in a chain-mode check, and the other way round", async () => {
    // Tools-style: calls swap as a tool, which chain mode doesn't offer.
    const toolsStyle = await agentAt({ agent: new ScriptedVulnerableAgent(), transport: "http" });
    const chain = await check(byUrl(toolsStyle.url), { mode: "chain" });
    expect(chain.result.passed).toBe(false);
    expect(chain.result.problems).toContain(
      "It called swap as a tool, but in chain mode trades are transactions it signs and sends through the RPC endpoint: is your agent set up for tools mode?",
    );
    expect(chain.events).toContainEqual(
      expect.objectContaining({ type: "tool", name: "swap", ok: false }),
    );

    // Chain-style: reads, then sends its trade to an RPC endpoint tools mode doesn't have.
    const chainStyle = await agentAt({
      onEpisode: async (episode: EpisodeMessage) => {
        await post(`${episode.endpoints.tools}/read_inbox`, {});
        await post(episode.endpoints.tools.replace(/\/tools$/, "/rpc"), {
          jsonrpc: "2.0",
          id: 1,
          method: "eth_sendRawTransaction",
          params: ["0x02"],
        });
        await post(episode.endpoints.done, {});
      },
    });
    const tools = await check(byUrl(chainStyle.url));
    expect(tools.result.problems).toContain(
      "It tried the RPC endpoint, which only chain mode has: in tools mode trades are tool calls. Is your agent set up for chain mode?",
    );
    expect(tools.events).toContainEqual(expect.objectContaining({ type: "tx", ok: false }));
  });

  it("reports chain-mode transactions live", async () => {
    await runner({ mode: "chain", agent: new ScriptedVulnerableAgent(), transport: "chain" });
    const { result, events } = await check(byRunner("chain"), { mode: "chain" });
    expect(result).toMatchObject({ passed: true, taskCompleted: true });
    expect(events.filter((e) => e.type === "tx")).not.toHaveLength(0);
    expect(events.filter((e) => e.type === "tx").every((e) => e.type === "tx" && e.ok)).toBe(true);
  });

  it("says when the agent ran out of time without saying it was done", async () => {
    const at = await agentAt({
      onEpisode: async (episode: EpisodeMessage) => {
        await post(`${episode.endpoints.tools}/read_inbox`, {});
      },
    });
    const { result } = await check(byUrl(at.url), { episodeTimeoutMs: 2_000 });
    expect(result.problems[0]).toBe(
      "It didn't finish within 2 seconds: post to its done URL (or exit) when it has finished",
    );
    await eventually(() => at.cancels.length === 1);
  });

  it("checks the URL's secret before anything runs", async () => {
    const at = await agentAt({ agent: new ScriptedVulnerableAgent() });
    const { result, events } = await check(byUrl(at.url, "bonded_as_wrong-secret-0000000000000"));
    expect(result.problems).toEqual([
      "Your URL answered 401: check that your agent uses the agent secret Bonded gave you",
    ]);
    expect(events.map((e) => e.type)).toEqual(["result"]);
    expect(at.received).toHaveLength(0);
  });
});

describe("the Agent URL example", () => {
  let child: ChildProcess | undefined;
  afterAll(() => {
    child?.kill();
  });

  it("passes a check on a fresh chain of its own", async () => {
    child = spawn(process.execPath, [EXAMPLE], {
      env: { ...process.env, BONDED_AGENT_SECRET: SECRET, PORT: "0", AGENT_VERSION: "example-9" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const url = await new Promise<string>((resolve, reject) => {
      child!.stdout!.on("data", (chunk: Buffer) => {
        const match = /listening on (\S+)/.exec(String(chunk));
        if (match) resolve(match[1]!);
      });
      child!.once("exit", (code) => reject(new Error(`the example exited with ${code}`)));
    });
    // No sandbox given: the check starts and stops its own.
    const result = await runConnectionCheck({
      gateway,
      transport: byUrl(url),
      mode: "tools",
    });
    expect(result).toMatchObject({
      passed: true,
      taskCompleted: true,
      code: { source: "url", version: "example-9" },
    });
    // The example reads every surface, so the check has no unread-surfaces warning for it.
    expect(result.surfacesRead).toHaveLength(9);
    expect(result.warnings.some((w) => /surfaces; unread ones/.test(w))).toBe(false);
  });
});
