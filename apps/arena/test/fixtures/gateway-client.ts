import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type AgentMode,
  type AgentToolbox,
  type ArenaAgent,
  type BrokerageEpisodeMessage,
  type EpisodeMessage,
  parseRunnerMessage,
  RUNNER_PROTOCOL_VERSION,
  type RunnerToServer,
  ServerToRunner,
  type ToolResult,
} from "@bondedhq/shared";
import { WebSocket } from "ws";
import { ownKeyWriter } from "./own-key-writes.js";

/**
 * An in-repo client for the gateway, for tests: toolboxes that reach an episode over MCP, plain
 * HTTP or (chain mode) HTTP reads plus signed transactions, and a stand-in runner that runs a
 * brain in-process instead of launching a command. Everything goes over the gateway's real
 * endpoints and WebSocket, exactly as an external agent's would.
 */

/** The tools over MCP, with the official SDK client. */
export async function mcpToolbox(url: string): Promise<AgentToolbox & { close(): Promise<void> }> {
  const client = new Client({ name: "arena-test-agent", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return {
    async call(name, args): Promise<ToolResult> {
      const result = await client.callTool({
        name,
        arguments: (args ?? {}) as Record<string, unknown>,
      });
      // Read the text content, as a model-driven MCP agent would.
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
      return result.isError ? { ok: false, error: text } : { ok: true, output: JSON.parse(text) };
    },
    close: () => client.close(),
  };
}

/** The tools over plain HTTP: POST {tools}/{name} with the arguments as the JSON body. */
export function httpToolbox(toolsUrl: string): AgentToolbox {
  return {
    async call(name, args): Promise<ToolResult> {
      const response = await fetch(`${toolsUrl}/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args ?? {}),
      });
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
      return (await response.json()) as ToolResult;
    },
  };
}

/** Chain mode: reads over HTTP, writes as transactions the episode's session key signs. */
export function chainToolbox(episode: EpisodeMessage): AgentToolbox {
  if (!episode.endpoints.rpc || !episode.sessionKey) throw new Error("not a chain-mode episode");
  const reads = httpToolbox(episode.endpoints.tools);
  const write = ownKeyWriter({
    rpcUrl: episode.endpoints.rpc,
    chainId: episode.chainId,
    key: episode.sessionKey,
    vault: episode.vault,
    contracts: episode.contracts,
  });
  return {
    call: (name, args) =>
      ["swap", "transfer", "approve"].includes(name) ? write(name, args) : reads.call(name, args),
  };
}

export type Transport = "mcp" | "http" | "chain";

export async function toolboxFor(transport: Transport, episode: EpisodeMessage) {
  if (transport === "mcp") return mcpToolbox(episode.endpoints.mcp);
  if (transport === "chain") return { ...chainToolbox(episode), close: async () => {} };
  return { ...httpToolbox(episode.endpoints.tools), close: async () => {} };
}

export interface FakeRunner {
  socket: WebSocket;
  received: EpisodeMessage[];
  cancels: string[];
  send(message: RunnerToServer): void;
  close(): Promise<void>;
}

export interface FakeRunnerOptions {
  gateway: string;
  token: string;
  mode: AgentMode;
  /** Runs an episode; the default runs `agent` against the transport's toolbox. */
  onEpisode?: (episode: EpisodeMessage, runner: FakeRunner) => Promise<void> | void;
  agent?: ArenaAgent;
  transport?: Transport;
  /** How often it pings (default 5 s). */
  pingMs?: number;
  /** The protocol it says it speaks (default the current one). */
  protocol?: number;
  /** Runs a brokerage episode (protocol 2). Without it, brokerage episodes are ignored. */
  onBrokerage?: (episode: BrokerageEpisodeMessage, runner: FakeRunner) => Promise<void> | void;
  /** Extra hello fields (a code hash). */
  hello?: {
    codeHash?: `0x${string}`;
    codeSource?: "git" | "git-dirty" | "unpinned" | "url";
    codeDetail?: string;
  };
}

/** A runner that runs each episode's brain in-process, over the gateway's real endpoints. */
export async function fakeRunner(options: FakeRunnerOptions): Promise<FakeRunner> {
  const url = `${options.gateway.replace(/^http/, "ws")}/runner/connect`;
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${options.token}` } });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
    socket.once("unexpected-response", (_, res) =>
      reject(new Error(`gateway refused: ${res.statusCode}`)),
    );
  });
  const runner: FakeRunner = {
    socket,
    received: [],
    cancels: [],
    send: (message) => socket.send(JSON.stringify(message)),
    close: () =>
      new Promise((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) return resolve();
        socket.once("close", () => resolve());
        socket.close();
      }),
  };
  runner.send({
    type: "hello",
    runnerVersion: "test",
    protocol: options.protocol ?? RUNNER_PROTOCOL_VERSION,
    mode: options.mode,
    ...options.hello,
  });
  const ping = setInterval(
    () => runner.send({ type: "ping", at: Date.now() }),
    options.pingMs ?? 5_000,
  );
  socket.on("close", () => clearInterval(ping));
  const run =
    options.onEpisode ??
    (async (episode: EpisodeMessage) => {
      const started = Date.now();
      const tools = await toolboxFor(options.transport ?? "http", episode);
      try {
        const summary = await options.agent!.run(episode.task, tools);
        await fetch(episode.endpoints.done, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(summary.finalMessage ? { finalMessage: summary.finalMessage } : {}),
          }),
        });
        runner.send({
          type: "episode_done",
          episodeId: episode.episodeId,
          exitCode: 0,
          durationMs: Date.now() - started,
        });
      } finally {
        await tools.close();
      }
    });
  socket.on("message", (data) => {
    const message = parseRunnerMessage(ServerToRunner, String(data));
    // These fixtures play vault-world agents; a brokerage episode is a different world.
    if (message?.type === "episode" && message.world !== "brokerage") {
      runner.received.push(message);
      void Promise.resolve(run(message, runner)).catch((error: unknown) =>
        runner.send({
          type: "episode_done",
          episodeId: message.episodeId,
          exitCode: 1,
          durationMs: 0,
          stderrTail: String(error),
        }),
      );
    } else if (message?.type === "episode" && options.onBrokerage) {
      const started = Date.now();
      void Promise.resolve(options.onBrokerage(message, runner)).then(
        () =>
          runner.send({
            type: "episode_done",
            episodeId: message.episodeId,
            exitCode: 0,
            durationMs: Date.now() - started,
          }),
        (error: unknown) =>
          runner.send({
            type: "episode_done",
            episodeId: message.episodeId,
            exitCode: 1,
            durationMs: 0,
            stderrTail: String(error),
          }),
      );
    } else if (message?.type === "cancel") {
      runner.cancels.push(message.episodeId);
      runner.send({
        type: "episode_done",
        episodeId: message.episodeId,
        exitCode: null,
        signal: "SIGTERM",
        durationMs: 0,
      });
    }
  });
  return runner;
}

/** Polls until `check` passes (for presence and other async effects). */
export async function eventually(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
