import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type EpisodeMessage,
  parseRunnerMessage,
  RUNNER_CLOSE,
  RUNNER_TAIL_BYTES,
  RunnerToServer,
  type ServerToRunner,
} from "@bondedhq/shared";
import { type WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { backoffDelay, gatewayUrlProblem, Runner, type RunnerOptions, Tail } from "../src/index.js";
import { applyPlan } from "../src/init/apply.js";
import { detectProject } from "../src/init/detect.js";
import { planInit } from "../src/init/plan.js";

const TOKEN = "runner-test-token-123456";

/** A production vault's variables, as an agent's .env holds them (test values: Anvil's second key). */
const PRODUCTION_VAULT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const PRODUCTION_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
/** The SDK (built: tests run after `^build`) and dotenv, linked into a test agent's node_modules. */
const SDK_DIR = realpathSync(join(import.meta.dirname, "../node_modules/@bondedhq/sdk"));
const DOTENV_DIR = realpathSync(join(import.meta.dirname, "../node_modules/dotenv"));

/**
 * Timing: these tests spawn real processes and sockets, which a loaded machine (the full pipeline,
 * every package at once) slows by seconds. So every wait is on the condition itself, bounded
 * generously (WAIT_MS), and each test gets TEST_MS; nothing asserts that something is fast.
 */
const WAIT_MS = 20_000;
const TEST_MS = 60_000;

/**
 * A fixed code identity: without one, each Runner works its own out with synchronous git calls,
 * which block the event loop for seconds under load (code-hash.test.ts covers that path).
 */
const CODE = {
  codeHash: `0x${"11".repeat(32)}` as `0x${string}`,
  codeSource: "flag" as const,
  detail: "--code-hash",
};

/** A stand-in gateway: accepts the runner's WebSocket and records what it says. */
async function fakeGateway() {
  const server: Server = createServer((_, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({ noServer: true });
  const messages: RunnerToServer[] = [];
  const sockets: WebSocket[] = [];
  let connections = 0;
  server.on("upgrade", (req, socket, head) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      connections++;
      sockets.push(ws);
      ws.on("message", (data) => {
        const message = parseRunnerMessage(RunnerToServer, String(data));
        if (!message) throw new Error(`runner sent an invalid message: ${String(data)}`);
        messages.push(message);
        if (message.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    messages,
    get connections() {
      return connections;
    },
    send: (message: ServerToRunner) => sockets.at(-1)!.send(JSON.stringify(message)),
    closeLatest: (code: number, reason = "") => sockets.at(-1)!.close(code, reason),
    of: <T extends RunnerToServer["type"]>(type: T) =>
      messages.filter((m): m is Extract<RunnerToServer, { type: T }> => m.type === type),
    close: async () => {
      for (const s of sockets) s.terminate();
      wss.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const stops: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

async function setup(options: Partial<RunnerOptions> & { command: string[] }) {
  const gateway = await fakeGateway();
  const runner = new Runner({
    gateway: gateway.url,
    token: TOKEN,
    mode: "tools",
    echo: false,
    // The runner reconnects (and stops its agent) after three heartbeats with no pong. Under a
    // loaded test run 300 ms can pass without one, so only the heartbeat test goes this fast.
    heartbeatMs: 1_000,
    backoff: { initialMs: 20, maxMs: 50 },
    killGraceMs: 300,
    code: CODE,
    ...options,
  });
  const started = runner.start();
  stops.push(async () => {
    await runner.stop();
    await started;
    await gateway.close();
  });
  await eventually(() => gateway.of("hello").length > 0);
  return { gateway, runner, started };
}

async function eventually(check: () => boolean, timeoutMs = WAIT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function episode(fields: Partial<EpisodeMessage> = {}): EpisodeMessage {
  const base = "http://gw.test/e/abc";
  return {
    type: "episode",
    episodeId: `ep-${Math.random().toString(36).slice(2)}`,
    task: { goal: "Buy 2000 tUSDG worth of tNVDA.", mandate: "Trade the basket.", maxSteps: 20 },
    mode: "tools",
    endpoints: {
      mcp: `${base}/mcp`,
      tools: `${base}/tools`,
      openapi: `${base}/openapi.json`,
      done: `${base}/done`,
    },
    chainId: 31337,
    vault: "0x000000000000000000000000000000000000dEaD",
    contracts: { exchange: "0x000000000000000000000000000000000000bEEF", tokens: [] },
    deadlineMs: 30_000,
    ...fields,
  };
}

const node = (script: string) => [process.execPath, "-e", script];

describe("the runner", { timeout: TEST_MS }, () => {
  it("says hello with its mode and keeps a heartbeat", async () => {
    const { gateway } = await setup({
      command: node(""),
      mode: "chain",
      version: "9.9.9",
      heartbeatMs: 100,
    });
    expect(gateway.of("hello")[0]).toMatchObject({
      runnerVersion: "9.9.9",
      protocol: 2,
      mode: "chain",
    });
    await eventually(() => gateway.of("ping").length >= 2);
  });

  it("calls onConnect once connected, and starts the agent in its cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bonded-runner-cwd-"));
    stops.push(async () => rmSync(dir, { recursive: true, force: true }));
    let connected = 0;
    const { gateway } = await setup({
      command: node("console.log(process.cwd())"),
      cwd: dir,
      onConnect: () => connected++,
    });
    expect(connected).toBe(1);
    gateway.send(episode());
    await eventually(() => gateway.of("episode_done").length === 1);
    const { realpathSync } = await import("node:fs");
    expect(realpathSync(gateway.of("episode_done")[0]!.stdoutTail!.trim())).toBe(realpathSync(dir));
  });

  it("reports its code hash and where it came from in hello", async () => {
    const code = {
      codeHash: `0x${"ef".repeat(32)}` as const,
      codeSource: "image" as const,
      detail: "x",
    };
    const { gateway } = await setup({ command: node(""), code });
    expect(gateway.of("hello")[0]).toMatchObject({
      codeHash: code.codeHash,
      codeSource: "image",
      codeDetail: "x",
    });
  });

  it("runs the agent with the episode in its environment, never the runner token", async () => {
    process.env.BONDED_RUNNER_TOKEN = "must-not-leak";
    process.env.BONDED_AGENT_KEY = "0xproduction-key";
    process.env.BONDED_VAULT_ADDRESS = "0xproduction-vault";
    try {
      const { gateway } = await setup({
        command: node(
          "const e=process.env;console.log(JSON.stringify({id:e.BONDED_EPISODE_ID,mcp:e.BONDED_MCP_URL," +
            "task:JSON.parse(e.BONDED_TASK),chain:e.BONDED_CHAIN_ID,deadline:e.BONDED_DEADLINE_MS," +
            "rpc:e.BONDED_RPC_URL??null,key:e.BONDED_SESSION_KEY??null,token:e.BONDED_RUNNER_TOKEN??null," +
            "prod:[e.BONDED_AGENT_KEY,e.BONDED_VAULT_ADDRESS].filter(Boolean)}))",
        ),
      });
      const ep = episode();
      gateway.send(ep);
      await eventually(() => gateway.of("episode_done").length === 1);
      expect(gateway.of("episode_started")).toEqual([
        { type: "episode_started", episodeId: ep.episodeId },
      ]);
      const done = gateway.of("episode_done")[0]!;
      expect(done).toMatchObject({ episodeId: ep.episodeId, exitCode: 0 });
      expect(JSON.parse(done.stdoutTail!)).toEqual({
        id: ep.episodeId,
        mcp: ep.endpoints.mcp,
        task: ep.task,
        chain: "31337",
        deadline: "30000",
        rpc: null,
        key: null,
        token: null,
        prod: [],
      });
    } finally {
      delete process.env.BONDED_RUNNER_TOKEN;
      delete process.env.BONDED_AGENT_KEY;
      delete process.env.BONDED_VAULT_ADDRESS;
    }
  });

  it.each([
    ["node --env-file=.env", (agent: string) => [process.execPath, "--env-file=.env", agent]],
    ["dotenv", (agent: string) => [process.execPath, agent, "dotenv"]],
  ])(
    "an agent that reloads its .env (%s) still can't get the production vault's signer",
    async (_, command) => {
      // An agent project, as init leaves it: its .env holds the production vault's variables.
      const dir = mkdtempSync(join(tmpdir(), "bonded-runner-dotenv-"));
      stops.push(async () => rmSync(dir, { recursive: true, force: true }));
      writeFileSync(join(dir, "package.json"), '{ "name": "agent", "type": "module" }\n');
      writeFileSync(
        join(dir, ".env"),
        `BONDED_VAULT_ADDRESS=${PRODUCTION_VAULT}\nBONDED_AGENT_KEY=${PRODUCTION_KEY}\n`,
      );
      mkdirSync(join(dir, "node_modules/@bondedhq"), { recursive: true });
      symlinkSync(SDK_DIR, join(dir, "node_modules/@bondedhq/sdk"), "dir");
      symlinkSync(DOTENV_DIR, join(dir, "node_modules/dotenv"), "dir");
      applyPlan(dir, planInit(detectProject(dir)));
      expect(readFileSync(join(dir, "bonded.js"), "utf8")).toContain("bondedVaultFromEnv");
      writeFileSync(
        join(dir, "agent.mjs"),
        `if (process.argv[2] === "dotenv") (await import("dotenv")).default.config({ quiet: true });
const sdk = await import("@bondedhq/sdk");
const helper = await import("./bonded.js");
console.log(JSON.stringify({
  reloaded: process.env.BONDED_AGENT_KEY === "${PRODUCTION_KEY}",
  rated: sdk.isBondedEpisode(),
  fromEnv: sdk.bondedVaultFromEnv() ?? null,
  helperRated: helper.rated,
  helperVault: helper.bondedVault ?? null,
}));
`,
      );
      const { gateway } = await setup({ command: command("agent.mjs"), cwd: dir });
      gateway.send(
        episode({
          contracts: {
            exchange: "0x000000000000000000000000000000000000bEEF",
            tokens: [
              {
                symbol: "tUSDG",
                address: "0x1111111111111111111111111111111111111111",
                decimals: 6,
              },
            ],
          },
        }),
      );
      await eventually(() => gateway.of("episode_done").length === 1);
      const done = gateway.of("episode_done")[0]!;
      expect(done.exitCode, done.stderrTail).toBe(0);
      expect(JSON.parse(done.stdoutTail!)).toEqual({
        // The .env put the production key back in the agent's environment...
        reloaded: true,
        rated: true,
        // ...but neither the SDK nor init's helper builds a vault (a signer) from it while rated.
        fromEnv: null,
        helperRated: true,
        helperVault: null,
      });
      expect(done.stderrTail).toMatch(/running a Bonded episode, so the production vault/);
    },
  );

  it("reports a failing agent's exit code and the last 4 KB of its output", async () => {
    const { gateway } = await setup({
      command: node(
        "process.stdout.write('a'.repeat(10000)+'END');process.stderr.write('boom');process.exit(3)",
      ),
    });
    gateway.send(episode());
    await eventually(() => gateway.of("episode_done").length === 1);
    const done = gateway.of("episode_done")[0]!;
    expect(done.exitCode).toBe(3);
    expect(done.stdoutTail).toHaveLength(RUNNER_TAIL_BYTES);
    expect(done.stdoutTail?.endsWith("END")).toBe(true);
    expect(done.stderrTail).toBe("boom");
  });

  it("stops an agent on cancel: SIGTERM, then SIGKILL if it won't exit", async () => {
    // The agent says when its SIGTERM handler is in place, so the cancel never races its start.
    const dir = mkdtempSync(join(tmpdir(), "bonded-runner-test-"));
    stops.push(async () => rmSync(dir, { recursive: true, force: true }));
    const ready = join(dir, "ready");
    const { gateway } = await setup({
      command: node(
        `process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(ready)},'1');setInterval(()=>{},1000)`,
      ),
    });
    const ep = episode();
    gateway.send(ep);
    await eventually(() => gateway.of("episode_started").length === 1 && existsSync(ready));
    const started = Date.now();
    gateway.send({ type: "cancel", episodeId: ep.episodeId });
    await eventually(() => gateway.of("episode_done").length === 1);
    expect(gateway.of("episode_done")[0]).toMatchObject({ exitCode: null, signal: "SIGKILL" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it("stops an agent past its deadline on its own, and runs one episode at a time", async () => {
    const { gateway } = await setup({ command: node("setInterval(()=>{},1000)") });
    const first = episode({ deadlineMs: 200 });
    gateway.send(first);
    await eventually(() => gateway.of("episode_started").length === 1);
    const second = episode();
    gateway.send(second);
    await eventually(() => gateway.of("episode_done").length === 1);
    expect(gateway.of("episode_done")[0]).toMatchObject({
      episodeId: second.episodeId,
      error: "the runner is already running an episode",
    });
    await eventually(() => gateway.of("episode_done").length === 2);
    expect(gateway.of("episode_done")[1]).toMatchObject({
      episodeId: first.episodeId,
      exitCode: null,
      signal: "SIGTERM",
    });
  });

  it("reports a command that can't start", async () => {
    const { gateway } = await setup({ command: ["/no/such/agent-binary"] });
    gateway.send(episode());
    await eventually(() => gateway.of("episode_done").length === 1);
    expect(gateway.of("episode_done")[0]).toMatchObject({ exitCode: null });
    expect(gateway.of("episode_done")[0]?.error).toMatch(/could not start the agent/);
  });

  it("forwards the TEE's evidence for the episode's nonce before starting the agent", async () => {
    const seen: string[] = [];
    const tee = createServer((req, res) => {
      seen.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          quote: "0x01",
          nonce: new URL(req.url!, "http://x").searchParams.get("nonce"),
        }),
      );
    });
    await new Promise<void>((resolve) => tee.listen(0, "127.0.0.1", resolve));
    stops.push(() => new Promise((resolve) => tee.close(resolve)));
    const teeUrl = `http://127.0.0.1:${(tee.address() as { port: number }).port}`;
    const { gateway } = await setup({ command: node(""), teeUrl });
    const nonce = `0x${"ab".repeat(32)}` as const;
    gateway.send(episode({ nonce }));
    await eventually(() => gateway.of("episode_done").length === 1);
    expect(seen).toEqual([`/attestation?nonce=${nonce}`]);
    expect(gateway.of("tee_evidence")[0]).toMatchObject({ evidence: { quote: "0x01", nonce } });
    const order = gateway.messages.map((m) => m.type).filter((t) => t !== "ping");
    expect(order.indexOf("tee_evidence")).toBeLessThan(order.indexOf("episode_started"));
  });

  it("asks the TEE for the rating's Arena key when the episode names one", async () => {
    const seen: string[] = [];
    const tee = createServer((req, res) => {
      seen.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((resolve) => tee.listen(0, "127.0.0.1", resolve));
    stops.push(() => new Promise((resolve) => tee.close(resolve)));
    const teeUrl = `http://127.0.0.1:${(tee.address() as { port: number }).port}`;
    const { gateway } = await setup({
      command: node("console.log(process.env.BONDED_TEE_KEY_ID)"),
      teeUrl,
    });
    const nonce = `0x${"ab".repeat(32)}` as const;
    const teeKeyId = `0x${"cd".repeat(32)}` as const;
    gateway.send(episode({ nonce, teeKeyId }));
    await eventually(() => gateway.of("episode_done").length === 1);
    expect(seen).toEqual([`/attestation?nonce=${nonce}&purpose=arena&key=${teeKeyId}`]);
    expect(gateway.of("episode_done")[0]?.stdoutTail?.trim()).toBe(teeKeyId);
  });

  it("says so when asked for TEE evidence without a TEE", async () => {
    const { gateway } = await setup({ command: node("") });
    gateway.send(episode({ nonce: `0x${"ab".repeat(32)}` }));
    await eventually(() => gateway.of("tee_evidence").length === 1);
    expect(gateway.of("tee_evidence")[0]?.error).toBe("this runner has no --tee-url");
  });

  it("reconnects with backoff after the connection drops, and kills the orphaned agent", async () => {
    const { gateway } = await setup({ command: node("setInterval(()=>{},1000)") });
    const ep = episode();
    gateway.send(ep);
    await eventually(() => gateway.of("episode_started").length === 1);
    gateway.closeLatest(1011, "server restart");
    await eventually(() => gateway.connections === 2 && gateway.of("hello").length === 2);
    // The episode's end, reported once it could be: on the new connection.
    await eventually(() => gateway.of("episode_done").length === 1);
    expect(gateway.of("episode_done")[0]).toMatchObject({
      episodeId: ep.episodeId,
      exitCode: null,
    });
  });

  it("stops for good when its token is refused, revoked or taken over", async () => {
    const gateway = await fakeGateway();
    stops.push(() => gateway.close());
    const refused = new Runner({
      gateway: gateway.url,
      token: "wrong-token-000000000",
      mode: "tools",
      command: node(""),
      code: CODE,
    });
    expect(await refused.start()).toEqual({
      code: 2,
      reason: "the gateway refused the runner token (wrong or revoked)",
    });

    for (const [code, reason] of [
      [RUNNER_CLOSE.replaced, /another runner connected/],
      [RUNNER_CLOSE.revoked, /revoked/],
      [RUNNER_CLOSE.protocol, /upgrade the runner/],
    ] as const) {
      const before = gateway.connections;
      const runner = new Runner({
        gateway: gateway.url,
        token: TOKEN,
        mode: "tools",
        command: node(""),
        code: CODE,
      });
      const stopped = runner.start();
      await eventually(() => gateway.connections === before + 1);
      gateway.closeLatest(code);
      const result = await stopped;
      expect(result.code).toBe(2);
      expect(result.reason).toMatch(reason);
    }
  });
});

describe("helpers", () => {
  it("sends its token only over https, or plain http to this machine", () => {
    for (const ok of [
      "https://arena.example.com",
      "http://localhost:8789",
      "http://127.0.0.1:8789",
      "http://[::1]:8789",
      "http://arena.localhost",
    ])
      expect(gatewayUrlProblem(ok), ok).toBeUndefined();
    for (const bad of ["http://arena.example.com", "http://10.0.0.5", "ws://x", "nonsense"])
      expect(gatewayUrlProblem(bad), bad).toBeDefined();
    expect(
      () =>
        new Runner({
          gateway: "http://arena.example.com",
          token: TOKEN,
          mode: "tools",
          command: ["x"],
        }),
    ).toThrow(/https/);
  });

  it("keeps only the last bytes of a stream", () => {
    const tail = new Tail(5);
    for (const part of ["ab", "cd", "ef", "gh"]) tail.push(Buffer.from(part));
    expect(tail.text()).toBe("defgh");
    const one = new Tail(5);
    one.push(Buffer.from("0123456789"));
    expect(one.text()).toBe("56789");
  });

  it("backs off exponentially up to a cap, with jitter", () => {
    const options = { initialMs: 1_000, maxMs: 30_000 };
    expect([1, 2, 3, 4, 5, 6, 9].map((a) => backoffDelay(a, options, () => 0.5))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
    expect(backoffDelay(1, options, () => 0)).toBe(800);
    expect(backoffDelay(1, options, () => 1)).toBe(1_200);
  });
});
