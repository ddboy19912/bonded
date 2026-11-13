import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
  loadAttackLibrary,
  RemoteAgent,
  type RemoteRunSummary,
  runEpisode,
  verifyAgentUrl,
} from "@bonded/arena";
import { createTestSigner } from "@bondedhq/sdk/agent-url";
import { agentUrlCodeHash } from "@bondedhq/shared/agent-url";
import { createServer } from "node:http";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentUrlServer } from "../src/agent-url.js";
import { calls, messageFor, startArena, type TestArena } from "./arena.js";

/**
 * Agent URL mode end to end: Bonded's side is played by signed POSTs (as the gateway sends them),
 * the episode is a real Arena Gateway episode, and the agent is an HTTP server: the TypeScript
 * one built on `createBondedHandler`, and the Python example (skipped without python3 or its
 * `cryptography` package).
 */
/** The wallet the test agents belong to: Bonded signs calls for it, and the agents check that. */
const OWNER = "0x00000000000000000000000000000000000a11ce";
/** Someone else's wallet: calls signed for it are refused. */
const MALLORY = "0x000000000000000000000000000000000000bad0";
const PYTHON_DIR = fileURLToPath(new URL("../../python-agent-url/", import.meta.url));
const hasPython = spawnSync("python3", ["-c", "import cryptography"]).status === 0;

type Sign = (owner: string, body: string) => Promise<Record<string, string>>;

let arena: TestArena;
/** A stand-in for Bonded's key, for the POSTs this file sends itself. */
let testSigner: Awaited<ReturnType<typeof createTestSigner>>;
beforeAll(async () => {
  testSigner = await createTestSigner();
  arena = await startArena();
}, 180_000);
afterAll(async () => {
  await arena?.stop();
});

/** POSTs a message signed for OWNER, with the test signer's key unless `sign` is given. */
async function post(url: string, message: unknown, sign: Sign = (o, b) => testSigner.sign(o, b)) {
  const body = JSON.stringify(message);
  const started = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await sign(OWNER, body)) },
    body,
  });
  return {
    status: response.status,
    body: (await response.json()) as unknown,
    ms: Date.now() - started,
  };
}

const usage = {
  inputTokens: { total: 80, noCache: 80, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

describe("a TypeScript agent on createBondedHandler", () => {
  it("verifies, acknowledges at once, works against the episode, then posts /done with usage", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            { type: "tool-call", toolCallId: "a", toolName: "read_inbox", input: "{}" },
            {
              type: "tool-call",
              toolCallId: "b",
              toolName: "swap",
              input: JSON.stringify({ tokenIn: "tUSDG", tokenOut: "tNVDA", amountIn: "300" }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage,
          warnings: [],
        },
        {
          content: [{ type: "text", text: "bought" }],
          finishReason: { unified: "stop", raw: undefined },
          usage,
          warnings: [],
        },
      ],
    });
    const server = agentUrlServer({
      owner: OWNER,
      keys: testSigner.keys,
      model,
      version: "2026.10.1",
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/bonded`;
    try {
      expect(
        await post(url, { type: "verify", challenge: "challenge-from-a-test-0001" }),
      ).toMatchObject({
        status: 200,
        body: {
          challenge: "challenge-from-a-test-0001",
          owner: OWNER,
          version: "2026.10.1",
        },
      });
      const { episode, toolbox, gatewayEpisode, balance } = await arena.episode();
      const ack = await post(url, messageFor(episode));
      expect(ack).toMatchObject({ status: 202, body: { ok: true, episodeId: episode.episodeId } });
      expect(ack.ms).toBeLessThan(10_000);
      await expect(gatewayEpisode.done).resolves.toEqual({
        finalMessage: "bought",
        usage: { inputTokens: 160, outputTokens: 10 },
      });
      expect(calls(toolbox)).toEqual(["read_inbox:ok", "swap:ok"]);
      expect(await balance("tNVDA")).toBeGreaterThan(0n);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

/** A scripted model that reads three surfaces, then says it is done. */
const readingModel = () =>
  new MockLanguageModelV4({
    doGenerate: [
      {
        content: ["read_inbox", "read_news", "get_prices"].map((toolName, i) => ({
          type: "tool-call" as const,
          toolCallId: `r${i}`,
          toolName,
          input: "{}",
        })),
        finishReason: { unified: "tool-calls", raw: undefined },
        usage,
        warnings: [],
      },
      {
        content: [{ type: "text", text: "read everything; nothing to do" }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      },
    ],
  });

const attack = () => loadAttackLibrary().find((s) => s.id === "A6-operator-impersonation-001")!;

/** An episode the gateway itself delivers: its own signed POST, through its Agent URL client. */
async function deliveredEpisode(url: string) {
  const agent = new RemoteAgent({
    gateway: arena.gateway,
    sandbox: arena.sandbox,
    transport: { kind: "url", url, owner: OWNER, registration: url },
    mode: "tools",
  });
  return runEpisode(arena.sandbox, { agent, attack: attack() });
}

describe("the gateway's own Agent URL calls, to createBondedHandler", () => {
  it("passes the gateway's verify challenge, and its version becomes the code hash", async () => {
    const server = agentUrlServer({
      owner: OWNER,
      keys: arena.signer.keySet().keys,
      model: readingModel(),
      version: "2026.10.2",
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/bonded`;
    try {
      expect(await verifyAgentUrl(url, OWNER, { client: arena.gateway.agentUrls })).toEqual({
        ok: true,
        version: "2026.10.2",
        codeHash: agentUrlCodeHash("2026.10.2"),
      });
      // Saved from another wallet: the gateway signs for that wallet, and the handler refuses.
      const wrong = await verifyAgentUrl(url, MALLORY, { client: arena.gateway.agentUrls });
      expect(wrong.ok).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("refuses an echo server that sends the challenge back without its owner", async () => {
    // What a URL that isn't set up for the owner can do: reflect the body it was sent. The owner
    // isn't in the body, so the answer can't name it.
    const echo = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        const { challenge } = JSON.parse(body) as { challenge: string };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ challenge, version: "echo" }));
      });
    });
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(echo.address() as AddressInfo).port}/`;
      const result = await verifyAgentUrl(url, OWNER, { client: arena.gateway.agentUrls });
      expect(result.ok).toBe(false);
    } finally {
      echo.closeAllConnections();
      await new Promise((resolve) => echo.close(resolve));
    }
  });

  it("accepts the gateway's signed episode delivery, and the episode ends on /done", async () => {
    const server = agentUrlServer({
      owner: OWNER,
      keys: arena.signer.keySet().keys,
      model: readingModel(),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/bonded`;
    try {
      const result = await deliveredEpisode(url);
      expect(result.agentSummary.stoppedBecause).toBe("done");
      expect(result.agentSummary.finalMessage).toBe("read everything; nothing to do");
      const record = (result.agentSummary as RemoteRunSummary).remote;
      expect(record).toMatchObject({ transport: "url" });
      expect(record.urlProblem).toBeUndefined();
      expect(result.trace.map((s) => s.tool)).toEqual(["read_inbox", "read_news", "get_prices"]);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe.skipIf(!hasPython)("the Python example (examples/python-agent-url)", () => {
  it("passes its own self-check", () => {
    const run = spawnSync("python3", ["-B", "selfcheck.py"], {
      cwd: PYTHON_DIR,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(run.stdout).toContain("selfcheck: ok");
    expect(run.status).toBe(0);
  });

  it("is rated against a real gateway episode, checking calls with the gateway's published keys", async () => {
    const gatewaySign: Sign = (owner, body) => arena.signer.sign(owner, body);
    const agent: ChildProcess = spawn("python3", ["-B", "agent.py"], {
      cwd: PYTHON_DIR,
      env: {
        PATH: process.env.PATH,
        BONDED_AGENT_OWNER: OWNER,
        // Where it fetches Bonded's keys: the gateway serves the key it signs with.
        BONDED_API_URL: arena.gateway.url,
        PORT: "0",
        HOST: "127.0.0.1",
        AGENT_VERSION: "py-1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const port = await new Promise<string>((resolve, reject) => {
        let out = "";
        agent.stdout!.on("data", (chunk: Buffer) => {
          out += chunk.toString();
          const match = /listening on :(\d+)/.exec(out);
          if (match) resolve(match[1]!);
        });
        agent.on("exit", (code) => reject(new Error(`agent.py exited with ${code}`)));
      });
      const url = `http://127.0.0.1:${port}/`;
      expect(
        await post(url, { type: "verify", challenge: "challenge-from-a-test-0002" }, gatewaySign),
      ).toMatchObject({
        status: 200,
        body: { challenge: "challenge-from-a-test-0002", owner: OWNER, version: "py-1" },
      });
      // A key the gateway doesn't publish: refused.
      expect(
        (await post(url, { type: "verify", challenge: "challenge-from-a-test-0003" })).status,
      ).toBe(401);

      const { episode, toolbox, gatewayEpisode, balance } = await arena.episode();
      expect((await post(url, messageFor(episode), gatewaySign)).status).toBe(202);
      const done = await gatewayEpisode.done;
      expect(done.finalMessage).toMatch(/swapped/);
      const seen = calls(toolbox);
      expect(seen).toEqual(
        expect.arrayContaining(["read_inbox:ok", "read_news:ok", "get_prices:ok", "swap:ok"]),
      );
      expect(await balance("tNVDA")).toBeGreaterThan(0n);

      // And the gateway's own calls: its verify challenge, and a signed episode it delivers.
      expect(await verifyAgentUrl(url, OWNER, { client: arena.gateway.agentUrls })).toEqual({
        ok: true,
        version: "py-1",
        codeHash: agentUrlCodeHash("py-1"),
      });
      const result = await deliveredEpisode(url);
      expect(result.agentSummary.stoppedBecause).toBe("done");
      expect(result.trace.map((s) => s.tool)).toEqual(
        expect.arrayContaining(["read_inbox", "read_counterparty_messages"]),
      );
    } finally {
      agent.kill();
    }
  });
});
