import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import {
  AGENT_TOOLS,
  type AgentMode,
  type AttackSurface,
  DoneRequest,
  type AgentToolbox,
  BROKERAGE_PROTOCOL_VERSION,
  type EpisodeEndpoints,
  type BrokerToolProfile,
  type EpisodeWorld,
  type HelloMessage,
  isAgentToolName,
  isWellFormedRunnerToken,
  parseRunnerMessage,
  RUNNER_CLOSE,
  RUNNER_CONNECT_PATH,
  RUNNER_HEARTBEAT_MS,
  RUNNER_MAX_MESSAGE_BYTES,
  RUNNER_MIN_PROTOCOL_VERSION,
  RUNNER_PROTOCOL_VERSION,
  RunnerToServer,
  type ServerToRunner,
  type ToolResult,
} from "@bondedhq/shared";
import { type WebSocket, WebSocketServer } from "ws";
import { publicAddress } from "../safe-fetch.js";
import { ArenaToolbox } from "../toolbox.js";
import { addressGroup } from "./address.js";
import { AgentUrlClient, type AgentUrlClientOptions } from "./agent-url.js";

export { addressGroup };
import { serveMcp } from "./mcp.js";
import { handleRpc, type RpcBinding, RpcBudget } from "./rpc.js";
import {
  hashToken,
  newCapabilityToken,
  type RunnerIdentity,
  type RunnerTokenValidator,
} from "./tokens.js";
import { CHAIN_MODE_WRITE, openApiDocument, toolList, WORLDS } from "./tools.js";

/**
 * The Arena Gateway: serves one definition of the world (the agent tools, the world simulator
 * behind them, and the toolbox that sends writes through the vault) to agents running on their
 * operators' own servers. See docs/SPECIFICATION.md Section 8.4.
 *
 * - Runners connect out to `GET /runner/connect` (a WebSocket) with their runner token, and wait
 *   for episodes.
 * - Each episode gets an unguessable capability token `t`, and its agent calls
 *   `/e/{t}/mcp` (MCP), `/e/{t}/tools[/{name}]` (plain HTTP, described at `/e/{t}/openapi.json`),
 *   `/e/{t}/rpc` (chain mode) and `/e/{t}/done`. The token reaches exactly one episode's toolbox,
 *   and stops working the moment the episode ends.
 * - Every tool call is logged with the attack surface it reads, for coverage.
 *
 * The agent under test is untrusted: request bodies, batches, concurrent requests and upstream
 * calls are all capped, and the RPC endpoint passes only an allowlist (gateway/rpc.ts).
 */

export interface GatewayLimits {
  /** Largest request body for tools, MCP and done. */
  bodyBytes: number;
  /** Largest request body for the RPC endpoint. */
  rpcBodyBytes: number;
  /** Most requests in one JSON-RPC batch. */
  rpcBatch: number;
  /** Most requests one episode may have in flight at once. */
  concurrentPerEpisode: number;
  /**
   * HTTP requests one episode may make per second, with a burst: past that a request is refused
   * before its body is read, so a client spinning on refusals costs the gateway almost nothing.
   */
  requestsPerSecond: number;
  requestBurst: number;
  /** Per call to the sandbox node. */
  upstreamTimeoutMs: number;
  /** Largest single sandbox node answer passed on. */
  upstreamResponseBytes: number;
  /** Largest total of answers for one RPC request, a batch included. */
  rpcRequestResponseBytes: number;
  /** Gas cap for eth_call, eth_estimateGas, eth_createAccessList and each simulated call. */
  rpcCallGas: bigint;
  /** The gas such a call gets when it names none. */
  rpcDefaultCallGas: bigint;
  /** Gas one episode's calls may use per second, with a burst (each charged the gas it may use). */
  rpcGasPerSecond: number;
  rpcGasBurst: number;
  /** Blocks and calls one eth_simulateV1 may simulate. */
  rpcSimulateBlocks: number;
  rpcSimulateCalls: number;
  /** Calls to the sandbox node one episode may make in all, and per second (with a burst). */
  rpcCallsPerEpisode: number;
  rpcCallsPerSecond: number;
  rpcCallBurst: number;
  /** How long a request waits for a gated episode to open (a TEE-bound agent's evidence). */
  readyTimeoutMs: number;
  /** How long a new runner has to say hello. */
  helloTimeoutMs: number;
  /**
   * The runner heartbeat: a runner silent (no ping) for three of these is dropped, and every
   * connected runner's token is checked again once per interval, whatever it sends.
   */
  heartbeatMs: number;
  /** Messages a runner may send per second, on average, with this many in a burst. */
  runnerMessagesPerSecond: number;
  runnerMessageBurst: number;
  /**
   * Failed token checks one client address may cause per minute; past that, its upgrades are
   * refused before any check. Only well-formed tokens are checked, so only they count.
   */
  upgradesPerMinute: number;
  /** Upgrades one token (by hash) may make per minute: a valid runner reconnecting has its own. */
  upgradesPerToken: number;
  /** Upgrades with no or a malformed token, per minute, across all addresses (never checked). */
  malformedUpgradesPerMinute: number;
  /**
   * Failed token checks per minute across all addresses: past it, tokens that haven't passed a
   * check recently are refused before one (tokens that have keep their own budget).
   */
  failedChecksPerMinute: number;
  /** Token checks for upgrades in flight at once, across all addresses. */
  pendingUpgrades: number;
}

export const DEFAULT_GATEWAY_LIMITS: GatewayLimits = {
  bodyBytes: 64 * 1024,
  rpcBodyBytes: 256 * 1024,
  rpcBatch: 50,
  concurrentPerEpisode: 8,
  requestsPerSecond: 50,
  requestBurst: 100,
  upstreamTimeoutMs: 15_000,
  upstreamResponseBytes: 1024 * 1024,
  rpcRequestResponseBytes: 2 * 1024 * 1024,
  rpcCallGas: 10_000_000n,
  rpcDefaultCallGas: 5_000_000n,
  rpcGasPerSecond: 100_000_000,
  rpcGasBurst: 300_000_000,
  rpcSimulateBlocks: 4,
  rpcSimulateCalls: 16,
  rpcCallsPerEpisode: 5_000,
  rpcCallsPerSecond: 50,
  rpcCallBurst: 200,
  readyTimeoutMs: 30_000,
  helloTimeoutMs: 10_000,
  heartbeatMs: RUNNER_HEARTBEAT_MS,
  runnerMessagesPerSecond: 20,
  runnerMessageBurst: 100,
  upgradesPerMinute: 30,
  upgradesPerToken: 20,
  malformedUpgradesPerMinute: 600,
  failedChecksPerMinute: 300,
  pendingUpgrades: 64,
};

/** A runner came, is still there, or left. The rating service records these as runner presence. */
export interface RunnerPresenceEvent {
  type: "connected" | "heartbeat" | "disconnected";
  key: string;
  at: number;
  /** What the runner said when it connected. */
  hello?: HelloMessage;
  /** Why it left (for "disconnected"). */
  reason?: string;
}

export interface GatewayOptions {
  /** Checks runner tokens (StaticRunnerTokens, or the rating service's database). */
  tokens: RunnerTokenValidator;
  /**
   * The base URL runners and agents reach the gateway at, e.g. https://arena.example.com. Episode
   * endpoints are built from it. Default: the address `listen` binds.
   */
  publicUrl?: string;
  onRunnerPresence?: (event: RunnerPresenceEvent) => void;
  /**
   * Proxies in front of the gateway whose X-Forwarded-For entries are trusted (Railway: 1). The
   * client address used for rate limits is then the entry that many places from the right; with 0
   * (the default) it is the socket's peer, which behind a proxy is the proxy itself.
   */
  trustProxy?: number;
  /**
   * What chain-mode RPC answers to web3_clientVersion when the sandbox isn't a fork (a fork
   * answers with its live chain's own version). Default: the sandbox node's own answer.
   */
  clientVersion?: string;
  log?: (message: string) => void;
  limits?: Partial<GatewayLimits>;
  /**
   * Agent URL mode: how the gateway calls agents' own endpoints (gateway/agent-url.ts). The
   * gateway's own URL is always refused as an agent URL.
   */
  agentUrl?: AgentUrlClientOptions;
}

/** One tool call as the gateway saw it. */
export interface ToolRead {
  tool: string;
  /** The attack surface the tool shows, if it is a read of the world. */
  surface?: AttackSurface;
  ok: boolean;
  at: number;
}

/**
 * What an episode's agent did, as it happens: each tool call, and in chain mode each transaction
 * it sent (or tried to). For a connection check's live view; a rating never shows these while it
 * runs.
 */
export type EpisodeActivity =
  | {
      type: "tool";
      name: string;
      /** The attack surface the tool reads, or null for a write or a lookup. */
      surface: AttackSurface | null;
      ok: boolean;
      error?: string;
    }
  | { type: "tx"; ok: boolean; reason?: string };

type RunnerMessageListener = (message: RunnerToServer) => void;

/** A connected runner. */
export class RunnerSession {
  readonly connectedAt = Date.now();
  lastSeen = Date.now();
  hello: HelloMessage | undefined;
  /** The episode it is running, if any: one at a time. */
  episodeId: string | null = null;
  private readonly listeners = new Set<RunnerMessageListener>();
  private readonly closeListeners = new Set<(reason: string) => void>();
  private closedReason: string | undefined;

  constructor(
    readonly identity: RunnerIdentity,
    private readonly socket: WebSocket,
  ) {}

  get key(): string {
    return this.identity.key;
  }

  get connected(): boolean {
    return this.closedReason === undefined && this.hello !== undefined;
  }

  get closed(): string | undefined {
    return this.closedReason;
  }

  /** The world the runner was started for (`--world`; vault when it didn't say). */
  get world(): EpisodeWorld {
    return this.hello?.world ?? "vault";
  }

  /**
   * Whether the runner takes brokerage episodes: it speaks a protocol that has them (2 or later)
   * and was started for the brokerage world.
   */
  get canRunBrokerage(): boolean {
    return (this.hello?.protocol ?? 0) >= BROKERAGE_PROTOCOL_VERSION && this.world === "brokerage";
  }

  /** The code hash the runner worked out and its source, when it reported one in hello. */
  /**
   * The code hash the runner worked out and its source, when it reported one in hello. Reported
   * by the runner, never verified: show it as reported.
   */
  get code():
    | {
        hash: `0x${string}`;
        source: NonNullable<HelloMessage["codeSource"]>;
        /** The commit, digest or label the runner gave (hello `codeDetail`). */
        detail?: string;
        reportedBy: "runner";
      }
    | undefined {
    const hello = this.hello;
    return hello?.codeHash
      ? {
          hash: hello.codeHash.toLowerCase() as `0x${string}`,
          source: hello.codeSource ?? "unpinned",
          ...(hello.codeDetail ? { detail: hello.codeDetail } : {}),
          reportedBy: "runner",
        }
      : undefined;
  }

  send(message: ServerToRunner): boolean {
    if (this.closedReason !== undefined) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  onMessage(listener: RunnerMessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(code: number, reason: string): void {
    this.socket.close(code, reason);
    this.closedWith(reason);
  }

  /** @internal */
  emit(message: RunnerToServer): void {
    for (const listener of [...this.listeners]) listener(message);
  }

  /** @internal */
  closedWith(reason: string): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    for (const listener of [...this.closeListeners]) listener(reason);
  }
}

/** What an episode needs from the gateway. */
export interface EpisodeSpec {
  episodeId: string;
  /** The vault world's ArenaToolbox, or another world's (the brokerage BrokerToolbox). */
  toolbox: AgentToolbox;
  mode: AgentMode;
  /** The world whose tools the episode serves (default vault). Only the vault world has chain mode. */
  world?: EpisodeWorld;
  /** Whose tool names a brokerage episode's tools are listed under (default the world's own). */
  toolProfile?: BrokerToolProfile;
  /** Chain mode: where the RPC endpoint forwards, and whose transactions it accepts. */
  chain?: Omit<RpcBinding, "toolbox">;
  /** Hold every request until `open()` is called (a TEE-bound episode waits for its evidence). */
  gated?: boolean;
}

/** One episode served by the gateway, behind its capability token. */
export class GatewayEpisode {
  readonly reads: ToolRead[] = [];
  readonly done: Promise<DoneRequest>;
  /** What the agent posted to /done, once it has. */
  finished: DoneRequest | undefined;
  inFlight = 0;
  private closed = false;
  private readonly ended = new AbortController();
  private budget: RpcBudget | undefined;
  private gas: RpcBudget | undefined;
  private requests: RpcBudget | undefined;
  private finish!: (body: DoneRequest) => void;
  private readonly activityListeners = new Set<(activity: EpisodeActivity) => void>();
  private openGate!: () => void;
  private readonly gate: Promise<void>;

  constructor(
    readonly spec: EpisodeSpec,
    readonly token: string,
    readonly endpoints: EpisodeEndpoints,
    private readonly detach: () => void,
  ) {
    this.done = new Promise((resolve) => (this.finish = resolve));
    this.gate = new Promise((resolve) => (this.openGate = resolve));
    if (!spec.gated) this.openGate();
  }

  get mode(): AgentMode {
    return this.spec.mode;
  }

  get world(): EpisodeWorld {
    return this.spec.world ?? "vault";
  }

  get toolProfile(): BrokerToolProfile | undefined {
    return this.spec.toolProfile;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Lets requests through to a gated episode. */
  open(): void {
    this.openGate();
  }

  /** @internal Resolves when the episode is open; rejects after `timeoutMs`. */
  ready(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      this.gate,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error("the episode is not open yet")), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /** The agent said it is done. Later calls are refused. */
  markDone(body: DoneRequest): void {
    if (this.finished) return;
    this.finished = body;
    this.finish(body);
  }

  /** Ends the episode at the gateway: the token stops working at once, and RPC forwarding stops. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ended.abort();
    this.detach();
  }

  /** Aborted when the episode ends. */
  get signal(): AbortSignal {
    return this.ended.signal;
  }

  /** @internal The episode's HTTP request rate. */
  requestBudget(limits: GatewayLimits): RpcBudget {
    this.requests ??= new RpcBudget(
      Number.POSITIVE_INFINITY,
      limits.requestsPerSecond,
      limits.requestBurst,
    );
    return this.requests;
  }

  /** @internal The episode's gas budget for calls, estimates and simulations. */
  gasBudget(limits: GatewayLimits): RpcBudget {
    this.gas ??= new RpcBudget(
      Number.POSITIVE_INFINITY,
      limits.rpcGasPerSecond,
      limits.rpcGasBurst,
    );
    return this.gas;
  }

  /** @internal The episode's budget of calls to the sandbox node. */
  rpcBudget(limits: GatewayLimits): RpcBudget {
    this.budget ??= new RpcBudget(
      limits.rpcCallsPerEpisode,
      limits.rpcCallsPerSecond,
      limits.rpcCallBurst,
    );
    return this.budget;
  }

  /** Listens to the episode's tool calls and transactions as they happen. */
  onActivity(listener: (activity: EpisodeActivity) => void): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  /** @internal */
  emitActivity(activity: EpisodeActivity): void {
    for (const listener of [...this.activityListeners]) {
      try {
        listener(activity);
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  /** A tool call from MCP or HTTP: logged with its surface, then run by the toolbox. */
  async callTool(name: string, args: unknown): Promise<ToolResult> {
    if (this.closed || this.finished) return { ok: false, error: "the episode is over" };
    // Attack surfaces are the vault world's; another world's reads are logged without one.
    const surface = WORLDS[this.world].surface(name) ?? null;
    if (this.mode === "chain" && isAgentToolName(name) && AGENT_TOOLS[name].writes) {
      this.emitActivity({ type: "tool", name, surface, ok: false, error: CHAIN_MODE_WRITE });
      return { ok: false, error: CHAIN_MODE_WRITE };
    }
    const result = await this.spec.toolbox.call(name, args);
    this.reads.push({
      tool: name,
      ...(surface ? { surface } : {}),
      ok: result.ok,
      at: Date.now(),
    });
    this.emitActivity({
      type: "tool",
      name,
      surface,
      ok: result.ok,
      ...(result.ok ? {} : { error: result.error.slice(0, 500) }),
    });
    return result;
  }
}

interface UpgradeWindow {
  start: number;
  counts: Map<string, number>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class ArenaGateway {
  private readonly limits: GatewayLimits;
  private readonly episodes = new Map<string, GatewayEpisode>();
  private readonly runners = new Map<string, RunnerSession>();
  private readonly sockets = new Set<RunnerSession>();
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: RUNNER_MAX_MESSAGE_BYTES,
  });
  private server: Server | undefined;
  private base: string | undefined;
  private upgradesInFlight = 0;
  private readonly malformed: UpgradeWindow = { start: 0, counts: new Map() };
  private readonly failures: UpgradeWindow = { start: 0, counts: new Map() };
  private readonly perToken: UpgradeWindow = { start: 0, counts: new Map() };
  /** Token hashes that passed a check, with when (oldest first, bounded). */
  private readonly validTokens = new Map<string, number>();
  private readonly log: (message: string) => void;
  /** Calls agents' own URLs (Agent URL mode), with one rate limit per host for everyone. */
  readonly agentUrls: AgentUrlClient;

  constructor(private readonly options: GatewayOptions) {
    this.limits = { ...DEFAULT_GATEWAY_LIMITS, ...options.limits };
    this.log = options.log ?? (() => {});
    this.base = options.publicUrl?.replace(/\/+$/, "");
    this.agentUrls = new AgentUrlClient({ log: this.log, ...options.agentUrl });
    if (this.base) this.refuseOwnUrl(this.base);
  }

  /** The gateway's own URL is never an agent URL: the whole host, unless it is this machine. */
  private refuseOwnUrl(base: string): void {
    const url = new URL(base);
    const bare = url.hostname.replace(/^\[|\]$/g, "");
    const local = url.hostname === "localhost" || (isIP(bare) !== 0 && !publicAddress(bare));
    if (local) this.agentUrls.refuseOrigin(url.origin);
    else this.agentUrls.refuseHost(url.hostname);
  }

  /** Starts listening. Returns the base URL (the public URL when one was given). */
  async listen(options: { port?: number; host?: string } = {}): Promise<string> {
    if (this.server) throw new Error("the gateway is already listening");
    const server = createServer((req, res) => void this.handle(req, res));
    server.requestTimeout = 60_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    server.on("upgrade", (req, socket, head) => void this.handleUpgrade(req, socket, head));
    const host = options.host ?? "127.0.0.1";
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, host, () => resolve());
    });
    this.server = server;
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : options.port;
    this.base ??= `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
    this.refuseOwnUrl(this.base);
    return this.base;
  }

  /** The configured web3_clientVersion for fresh (non-fork) sandboxes. */
  get clientVersion(): string | undefined {
    return this.options.clientVersion;
  }

  /** The base URL episode endpoints are built from. */
  get url(): string {
    if (!this.base) throw new Error("the gateway has no URL yet: listen() or set publicUrl");
    return this.base;
  }

  async close(): Promise<void> {
    for (const session of this.sockets) session.close(1001, "the gateway is shutting down");
    for (const episode of this.episodes.values()) episode.close();
    this.wss.close();
    const server = this.server;
    this.server = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /** The connected runner for a key, if there is one. */
  runner(key: string): RunnerSession | undefined {
    const session = this.runners.get(key);
    return session?.connected ? session : undefined;
  }

  /**
   * Waits until the runner for `key` is connected and idle, then reserves it for an episode.
   * Release it with `releaseRunner` once the episode's process is gone.
   */
  async acquireRunner(key: string, episodeId: string, timeoutMs: number): Promise<RunnerSession> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const session = this.runner(key);
      if (session && session.episodeId === null) {
        session.episodeId = episodeId;
        return session;
      }
      if (Date.now() >= deadline)
        throw new Error(
          session
            ? `the agent's runner is still busy with episode ${session.episodeId}`
            : "no runner is connected for this agent",
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  releaseRunner(session: RunnerSession, episodeId: string): void {
    if (session.episodeId === episodeId) session.episodeId = null;
  }

  /** Serves an episode behind a fresh capability token. Close it when the episode ends. */
  openEpisode(spec: EpisodeSpec): GatewayEpisode {
    if (spec.mode === "chain" && !spec.chain) throw new Error("a chain-mode episode needs a chain");
    const world = spec.world ?? "vault";
    if (!WORLDS[world].chain && (spec.mode === "chain" || spec.chain))
      throw new Error(`the ${world} world has no chain mode`);
    if (world !== "vault" && spec.toolbox instanceof ArenaToolbox)
      throw new Error(`the ${world} world can't be served from the vault world's toolbox`);
    if (world !== "brokerage" && spec.toolProfile && spec.toolProfile !== "bonded")
      throw new Error(`only the brokerage world is offered under a broker's tool names`);
    const token = newCapabilityToken();
    const key = hashToken(token);
    const base = `${this.url}/e/${token}`;
    const endpoints: EpisodeEndpoints = {
      mcp: `${base}/mcp`,
      tools: `${base}/tools`,
      openapi: `${base}/openapi.json`,
      ...(spec.mode === "chain" ? { rpc: `${base}/rpc` } : {}),
      done: `${base}/done`,
    };
    const episode = new GatewayEpisode(spec, token, endpoints, () => this.episodes.delete(key));
    this.episodes.set(key, episode);
    return episode;
  }

  /** The HTTP handler, for mounting the gateway in another server. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.route(req, res);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) this.log(`gateway error: ${(error as Error)?.message ?? error}`);
      if (!res.headersSent)
        reply(res, status, { error: status === 500 ? "internal error" : (error as Error).message });
      else res.end();
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://gateway").pathname;
    if (path === "/healthz" && req.method === "GET") return reply(res, 200, { ok: true });
    const match = /^\/e\/([A-Za-z0-9_-]{43})\/(.+)$/.exec(path);
    if (!match) throw new HttpError(404, "not found");
    const episode = this.episodes.get(hashToken(match[1]!));
    if (!episode) throw new HttpError(404, "no such episode, or it is over");
    if (episode.inFlight >= this.limits.concurrentPerEpisode)
      throw new HttpError(429, "too many requests in flight for this episode");
    if (!episode.requestBudget(this.limits).take()) {
      req.resume();
      throw new HttpError(429, "too many requests for this episode; slow down");
    }
    episode.inFlight++;
    try {
      await episode.ready(this.limits.readyTimeoutMs).catch(() => {
        throw new HttpError(503, "the episode is not open yet");
      });
      await this.serveEpisode(episode, match[2]!, req, res);
    } finally {
      episode.inFlight--;
    }
  }

  private async serveEpisode(
    episode: GatewayEpisode,
    route: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const method = req.method ?? "GET";
    const base = `${this.url}/e/${episode.token}`;
    if (route === "tools" && method === "GET")
      return reply(res, 200, { tools: toolList(episode.mode, episode.world, episode.toolProfile) });
    if (route === "openapi.json" && method === "GET")
      return reply(
        res,
        200,
        openApiDocument(base, episode.mode, episode.world, episode.toolProfile),
      );
    if (route === "mcp") {
      if (method !== "POST") {
        res.setHeader("allow", "POST");
        throw new HttpError(405, "MCP here is stateless: POST only");
      }
      const body = await readJson(req, this.limits.bodyBytes);
      if (episode.isClosed) throw new HttpError(404, "no such episode, or it is over");
      return serveMcp(req, res, body, episode);
    }
    const tool = /^tools\/([a-z_]{1,64})$/.exec(route);
    if (tool && method === "POST") {
      const args = await readJson(req, this.limits.bodyBytes, {});
      return reply(res, 200, await episode.callTool(tool[1]!, args));
    }
    const vaultTools = episode.spec.toolbox;
    if (
      route === "rpc" &&
      method === "POST" &&
      episode.spec.chain &&
      vaultTools instanceof ArenaToolbox
    ) {
      const body = await readJson(req, this.limits.rpcBodyBytes);
      if (episode.finished || episode.isClosed)
        return reply(res, 200, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: "the episode is over" },
        });
      const response = await handleRpc(
        body,
        {
          ...episode.spec.chain,
          toolbox: vaultTools,
          budget: episode.rpcBudget(this.limits),
          gas: episode.gasBudget(this.limits),
          signal: episode.signal,
          onTransaction: (outcome) => episode.emitActivity({ type: "tx", ...outcome }),
        },
        {
          batch: this.limits.rpcBatch,
          timeoutMs: this.limits.upstreamTimeoutMs,
          responseBytes: this.limits.upstreamResponseBytes,
          requestResponseBytes: this.limits.rpcRequestResponseBytes,
          callGas: this.limits.rpcCallGas,
          defaultCallGas: this.limits.rpcDefaultCallGas,
          simulateBlocks: this.limits.rpcSimulateBlocks,
          simulateCalls: this.limits.rpcSimulateCalls,
        },
      );
      return reply(res, 200, response);
    }
    if (route === "rpc" && !episode.spec.chain)
      // An agent set up for chain mode in a tool-mode episode: say so to a live view.
      episode.emitActivity({
        type: "tx",
        ok: false,
        reason: "this episode is in tools mode, which has no RPC endpoint: trades are tool calls",
      });
    if (route === "done" && method === "POST") {
      const parsed = DoneRequest.safeParse(await readJson(req, this.limits.bodyBytes, {}));
      if (!parsed.success) throw new HttpError(400, "body must be { finalMessage?, usage? }");
      episode.markDone(parsed.data);
      return reply(res, 200, { ok: true });
    }
    throw new HttpError(404, "not found");
  }

  /** The WebSocket upgrade handler, for mounting the gateway in another server (with `handle`). */
  async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const path = new URL(req.url ?? "/", "http://gateway").pathname;
    if (path !== RUNNER_CONNECT_PATH) return refuse(socket, 404, "Not Found");
    const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    // Anything that isn't shaped like a runner token is refused without a check, against one
    // global budget, so anonymous traffic can't use up any address's or token's allowance.
    if (!token || !isWellFormedRunnerToken(token))
      return refuse(
        socket,
        this.windowed(this.malformed, "all", this.limits.malformedUpgradesPerMinute) ? 401 : 429,
        "Unauthorized",
      );
    // Well-formed tokens. A token that has passed a check recently keeps only its own budget, so
    // a legitimate runner can reconnect whatever others send. Any other token is refused before a
    // check when its address (IPv6 by /64, so rotating addresses in one block doesn't help) or the
    // whole gateway has seen too many failed checks. Checks in flight are capped overall.
    const address = this.clientAddress(req);
    const tokenHash = hashToken(token);
    const known = this.recentlyValid(tokenHash);
    if (!known) {
      if (this.counted(this.failures, address) >= this.limits.upgradesPerMinute)
        return refuse(socket, 429, "Too Many Requests");
      if (this.counted(this.failures, "*") >= this.limits.failedChecksPerMinute)
        return refuse(socket, 429, "Too Many Requests");
    }
    if (!this.windowed(this.perToken, tokenHash, this.limits.upgradesPerToken))
      return refuse(socket, 429, "Too Many Requests");
    if (this.upgradesInFlight >= this.limits.pendingUpgrades)
      return refuse(socket, 503, "Service Unavailable");
    let identity: RunnerIdentity | null;
    this.upgradesInFlight++;
    try {
      identity = await this.options.tokens.validate(token);
    } catch (error) {
      this.log(`runner token check failed: ${(error as Error)?.message ?? error}`);
      return refuse(socket, 503, "Service Unavailable");
    } finally {
      this.upgradesInFlight--;
    }
    if (!identity) {
      this.windowed(this.failures, address, Number.POSITIVE_INFINITY);
      this.windowed(this.failures, "*", Number.POSITIVE_INFINITY);
      this.validTokens.delete(tokenHash);
      return refuse(socket, 401, "Unauthorized");
    }
    this.validTokens.delete(tokenHash);
    this.validTokens.set(tokenHash, Date.now());
    if (this.validTokens.size > 10_000) {
      const oldest = this.validTokens.keys().next().value;
      if (oldest !== undefined) this.validTokens.delete(oldest);
    }
    const found = identity;
    this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, found, token));
  }

  /**
   * Counts one event for `key` in a fixed one-minute window; false once the window holds `limit`
   * (the event is then not counted).
   */
  private windowed(window: UpgradeWindow, key: string, limit: number): boolean {
    const count = this.counted(window, key);
    if (count >= limit) return false;
    window.counts.set(key, count + 1);
    return true;
  }

  /** How many events `key` has in the current window (starting a new window when it's over). */
  private counted(window: UpgradeWindow, key: string): number {
    const now = Date.now();
    if (now - window.start > 60_000) {
      window.start = now;
      window.counts.clear();
    }
    return window.counts.get(key) ?? 0;
  }

  /** Whether this token passed a check in the last day (and hasn't failed one since). */
  private recentlyValid(tokenHash: string): boolean {
    const at = this.validTokens.get(tokenHash);
    return at !== undefined && Date.now() - at < 24 * 3_600_000;
  }

  /**
   * The client's address, for rate limits: the socket's peer, or the trusted proxies'
   * X-Forwarded-For entry; an IPv6 address counts as its /64, the block one client controls.
   */
  private clientAddress(req: IncomingMessage): string {
    return addressGroup(this.clientIp(req));
  }

  private clientIp(req: IncomingMessage): string {
    const hops = this.options.trustProxy ?? 0;
    const peer = req.socket.remoteAddress ?? "unknown";
    if (hops <= 0) return peer;
    const header = req.headers["x-forwarded-for"];
    const list = (Array.isArray(header) ? header.join(",") : (header ?? ""))
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    return list[list.length - hops] ?? peer;
  }

  private attach(ws: WebSocket, identity: RunnerIdentity, token: string): void {
    const session = new RunnerSession(identity, ws);
    this.sockets.add(session);
    const presence = (event: Omit<RunnerPresenceEvent, "key" | "at">) =>
      this.options.onRunnerPresence?.({ ...event, key: identity.key, at: Date.now() });

    const heartbeatMs = this.limits.heartbeatMs;
    const helloTimer = setTimeout(
      () => session.close(RUNNER_CLOSE.protocol, "no hello"),
      this.limits.helloTimeoutMs,
    );
    // Once per heartbeat, whatever the runner sends: drop it if it hasn't pinged for three
    // intervals, and check its token again (one check at a time), so a revoked token disconnects
    // within one interval even if the runner never pings. Presence is reported from here too, at
    // most once per interval, however often the runner pings.
    let checking = false;
    let pingedSinceReport = false;
    const heartbeat = setInterval(() => {
      if (Date.now() - session.lastSeen > 3 * heartbeatMs) {
        session.close(RUNNER_CLOSE.heartbeat, "no heartbeat");
        return;
      }
      if (checking || !session.hello) return;
      checking = true;
      void this.options.tokens
        .validate(token)
        .then(
          (still) => {
            if (!still) session.close(RUNNER_CLOSE.revoked, "the runner token was revoked");
            else if (pingedSinceReport) {
              pingedSinceReport = false;
              presence({ type: "heartbeat" });
            }
          },
          () => {},
        )
        .finally(() => (checking = false));
    }, heartbeatMs);

    // A token bucket per socket: a runner needs a few messages a minute.
    let allowance = this.limits.runnerMessageBurst;
    let refilled = Date.now();
    const withinRate = () => {
      const now = Date.now();
      allowance = Math.min(
        this.limits.runnerMessageBurst,
        allowance + ((now - refilled) / 1000) * this.limits.runnerMessagesPerSecond,
      );
      refilled = now;
      if (allowance < 1) return false;
      allowance -= 1;
      return true;
    };

    ws.on("message", (data, isBinary) => {
      if (session.closed !== undefined) return;
      if (!withinRate()) return session.close(RUNNER_CLOSE.rateLimited, "too many messages");
      const message = isBinary
        ? undefined
        : parseRunnerMessage(RunnerToServer, rawText(data as Buffer | Buffer[] | ArrayBuffer));
      if (!message) return session.close(RUNNER_CLOSE.protocol, "malformed message");
      if (!session.hello) {
        if (message.type !== "hello") return session.close(RUNNER_CLOSE.protocol, "hello first");
        if (
          message.protocol < RUNNER_MIN_PROTOCOL_VERSION ||
          message.protocol > RUNNER_PROTOCOL_VERSION
        )
          return session.close(RUNNER_CLOSE.protocol, "unsupported protocol version");
        // "url" labels a version an agent URL reported; a runner can't claim it.
        if (message.codeSource === "url")
          return session.close(RUNNER_CLOSE.protocol, "a runner can't report codeSource url");
        clearTimeout(helloTimer);
        session.hello = message;
        session.lastSeen = Date.now();
        const previous = this.runners.get(identity.key);
        if (previous && previous !== session)
          previous.close(RUNNER_CLOSE.replaced, "another runner connected with this token");
        this.runners.set(identity.key, session);
        this.log(`runner connected for ${identity.key} (${message.mode} mode)`);
        presence({ type: "connected", hello: message });
        return;
      }
      if (message.type === "hello") return;
      if (message.type === "ping") {
        // Only a ping keeps a runner alive.
        session.lastSeen = Date.now();
        pingedSinceReport = true;
        session.send({ type: "pong", at: Date.now() });
        return;
      }
      session.emit(message);
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      clearInterval(heartbeat);
      this.sockets.delete(session);
      session.closedWith("disconnected");
      if (this.runners.get(identity.key) === session) {
        this.runners.delete(identity.key);
        presence({ type: "disconnected", reason: session.closed ?? "disconnected" });
      }
    });
    ws.on("error", () => ws.terminate());
  }
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** Reads a JSON body up to `limit` bytes. An empty body is `empty` when given, else an error. */
async function readJson(req: IncomingMessage, limit: number, empty?: unknown): Promise<unknown> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit)
    throw new HttpError(413, `request body over ${limit} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      req.destroy();
      throw new HttpError(413, `request body over ${limit} bytes`);
    }
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") {
    if (empty !== undefined) return empty;
    throw new HttpError(400, "empty body");
  }
  const type = req.headers["content-type"] ?? "";
  if (!/^application\/json\b/i.test(type))
    throw new HttpError(415, "send the body as application/json");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "the body is not valid JSON");
  }
}

function refuse(socket: Duplex, status: number, text: string): void {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function rawText(data: Buffer | Buffer[] | ArrayBuffer): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}
