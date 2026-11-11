import { type ChildProcess, spawn } from "node:child_process";
import {
  type AgentMode,
  type AnyEpisodeMessage,
  type EpisodeMessage,
  type EpisodeWorld,
  episodeEnv,
  episodeWorld,
  parseRunnerMessage,
  RUNNER_CLOSE,
  RUNNER_CONNECT_PATH,
  RUNNER_HEARTBEAT_MS,
  RUNNER_KILL_GRACE_MS,
  RUNNER_MAX_MESSAGE_BYTES,
  runnerProtocolFor,
  RUNNER_TAIL_BYTES,
  type RunnerToServer,
  ServerToRunner,
} from "@bondedhq/shared";
import { WebSocket } from "ws";
import { type CodeIdentity, codeIdentity } from "./code-hash.js";
import { backoffDelay, gatewayUrlProblem, Tail } from "./tail.js";

/**
 * The Bonded runner: lets the Arena rate an agent that runs on its operator's own servers.
 *
 * It connects out to the Arena Gateway (no inbound port needed), says which mode the agent works
 * in, and waits. For each episode the gateway sends, it launches the operator's agent command
 * with the episode's endpoints in its environment (`BONDED_*`, see `episodeEnv`), reports when
 * it started and how it ended (exit code and the last 4 KB of its output), and stops it when the
 * gateway cancels or the deadline passes. One episode at a time.
 *
 * The runner never sees the agent's tool calls or transactions: the agent talks to the gateway
 * directly. The runner token stays with the runner: it is not passed to the agent.
 */
export interface RunnerOptions {
  /** The gateway's base URL, e.g. https://arena.example.com. */
  gateway: string;
  token: string;
  mode: AgentMode;
  /**
   * The world the agent was built for (default vault). The runner says it in hello and takes
   * episodes of this world only: it never starts the agent for another world's episode.
   */
  world?: EpisodeWorld;
  /** The agent's TEE: the runner fetches its evidence for each episode's nonce. */
  teeUrl?: string;
  /** The agent command and its arguments. */
  command: string[];
  /** Where the runner says what it is doing. */
  log?: (line: string) => void;
  /** Copy the agent's output to the runner's own stdout and stderr (default true). */
  echo?: boolean;
  version?: string;
  /**
   * The code version it launches, reported in hello. Default: worked out from the command
   * (`codeIdentity`: BONDED_CODE_HASH, BONDED_IMAGE_DIGEST, the git commit, or unpinned).
   */
  code?: CodeIdentity;
  /** Where the agent command runs. Default: the runner's own working directory. */
  cwd?: string;
  /** Called each time the runner connects to the gateway (after it says hello). */
  onConnect?: () => void;
  heartbeatMs?: number;
  backoff?: { initialMs: number; maxMs: number };
  killGraceMs?: number;
}

/** Why the runner stopped for good. */
export interface RunnerStop {
  /** 0: stopped on request; 2: the gateway refused the runner and retrying won't help. */
  code: 0 | 2;
  reason: string;
}

/** Whether a connection ended for good, and whether it had been up long enough to count. */
interface ConnectionEnd {
  fatal?: string;
  stable: boolean;
}

interface Running {
  episodeId: string;
  child?: ChildProcess;
  cancelled: boolean;
  killTimer?: NodeJS.Timeout;
}

/** Messages the runner keeps while disconnected, to send on reconnect (newest kept). */
const OUTBOX_LIMIT = 16;

export class Runner {
  private socket: WebSocket | undefined;
  private running: Running | undefined;
  private stopped = false;
  private wake: (() => void) | undefined;
  private readonly outbox: RunnerToServer[] = [];
  private readonly log: (line: string) => void;
  /** The code hash it reports, and where it came from. */
  readonly code: CodeIdentity;

  constructor(private readonly options: RunnerOptions) {
    if (options.command.length === 0) throw new Error("no agent command given");
    if ((options.world ?? "vault") !== "vault" && options.mode !== "tools")
      throw new Error(`the ${options.world} world runs in tools mode only`);
    const problem = gatewayUrlProblem(options.gateway);
    if (problem) throw new Error(problem);
    this.log = options.log ?? (() => {});
    this.code = options.code ?? codeIdentity({ command: options.command });
  }

  /** Connects, and keeps reconnecting with backoff, until stopped or refused for good. */
  async start(): Promise<RunnerStop> {
    const backoff = this.options.backoff ?? { initialMs: 1_000, maxMs: 30_000 };
    let attempt = 0;
    while (!this.stopped) {
      const end = await this.connectOnce();
      if (end.fatal) {
        await this.cancelRunning("the runner stopped");
        return { code: 2, reason: end.fatal };
      }
      if (this.stopped) break;
      attempt = end.stable ? 1 : attempt + 1;
      const delay = backoffDelay(attempt, backoff);
      this.log(`disconnected; reconnecting in ${(delay / 1000).toFixed(1)} s`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = undefined;
    }
    return { code: 0, reason: "stopped" };
  }

  /** Stops the agent (if one is running) and disconnects. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.cancelRunning("the runner stopped");
    this.socket?.close(1000, "runner stopping");
  }

  private url(): string {
    const base = this.options.gateway.replace(/\/+$/, "").replace(/^http/, "ws");
    return `${base}${RUNNER_CONNECT_PATH}`;
  }

  private connectOnce(): Promise<ConnectionEnd> {
    return new Promise((resolve) => {
      const socket = new WebSocket(this.url(), {
        headers: {
          authorization: `Bearer ${this.options.token}`,
          "user-agent": `bonded-runner/${this.options.version ?? "dev"}`,
        },
        maxPayload: RUNNER_MAX_MESSAGE_BYTES,
        handshakeTimeout: 15_000,
      });
      this.socket = socket;
      let openedAt = 0;
      let fatal: string | undefined;
      let heartbeat: NodeJS.Timeout | undefined;
      let lastPong = Date.now();
      const heartbeatMs = this.options.heartbeatMs ?? RUNNER_HEARTBEAT_MS;

      socket.on("unexpected-response", (_, res) => {
        if (res.statusCode === 401)
          fatal = "the gateway refused the runner token (wrong or revoked)";
        else this.log(`the gateway answered ${res.statusCode}`);
        socket.terminate();
      });
      socket.on("open", () => {
        openedAt = Date.now();
        lastPong = Date.now();
        this.log(
          `connected to ${this.options.gateway} (${this.options.mode} mode${this.world === "vault" ? "" : `, ${this.world} world`})`,
        );
        this.write({
          type: "hello",
          runnerVersion: this.options.version ?? "dev",
          // The oldest protocol that has this world: a vault-world runner still works with a
          // gateway that hasn't been updated.
          protocol: runnerProtocolFor(this.world),
          mode: this.options.mode,
          ...(this.world === "vault" ? {} : { world: this.world }),
          ...(this.options.teeUrl ? { teeUrl: this.options.teeUrl } : {}),
          codeHash: this.code.codeHash,
          codeSource: this.code.codeSource,
          codeDetail: this.code.detail.slice(0, 200),
        });
        for (const message of this.outbox.splice(0)) this.write(message);
        this.options.onConnect?.();
        heartbeat = setInterval(() => {
          if (Date.now() - lastPong > 3 * heartbeatMs) {
            this.log("no answer from the gateway; reconnecting");
            socket.terminate();
            return;
          }
          this.write({ type: "ping", at: Date.now() });
        }, heartbeatMs);
      });
      socket.on("message", (data, isBinary) => {
        const message = isBinary ? undefined : parseRunnerMessage(ServerToRunner, String(data));
        if (!message) {
          this.log("ignored a message from the gateway that didn't parse");
          return;
        }
        if (message.type === "pong") lastPong = Date.now();
        else if (message.type === "episode") void this.runEpisode(message);
        else if (message.type === "cancel" && this.running?.episodeId === message.episodeId)
          void this.cancelRunning("the gateway cancelled the episode");
      });
      socket.on("error", (error) => this.log(`connection error: ${error.message}`));
      socket.on("close", (code, reason) => {
        clearInterval(heartbeat);
        if (this.socket === socket) this.socket = undefined;
        const why = reason.toString();
        if (code === RUNNER_CLOSE.replaced)
          fatal = "another runner connected with the same token; this one is stopping";
        else if (code === RUNNER_CLOSE.revoked) fatal = "the runner token was revoked";
        else if (code === RUNNER_CLOSE.protocol)
          fatal = `the gateway closed the connection: ${why || "protocol error"} (upgrade the runner?)`;
        // The episode can't be finished without the gateway: stop the agent rather than leave it.
        if (openedAt) void this.cancelRunning("the runner lost its connection");
        resolve({
          ...(fatal ? { fatal } : {}),
          stable: openedAt > 0 && Date.now() - openedAt > 10_000,
        });
      });
    });
  }

  /** Sends now if connected; otherwise keeps the message for the next connection. */
  private write(message: RunnerToServer): void {
    const socket = this.socket;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      return;
    }
    if (message.type === "ping" || message.type === "hello") return;
    this.outbox.push(message);
    if (this.outbox.length > OUTBOX_LIMIT) this.outbox.shift();
  }

  /** The world this runner was started for. */
  private get world(): EpisodeWorld {
    return this.options.world ?? "vault";
  }

  private async runEpisode(episode: AnyEpisodeMessage): Promise<void> {
    const started = Date.now();
    // An agent built for one world is never started for another's episode: outside the world it
    // knows, it could take the episode for production and act with its real tools.
    if (episodeWorld(episode) !== this.world) {
      this.log(
        `episode ${episode.episodeId}: refused, it is a ${episodeWorld(episode)} episode and this runner was started for the ${this.world} world`,
      );
      this.write({
        type: "episode_done",
        episodeId: episode.episodeId,
        exitCode: null,
        durationMs: 0,
        error: `this runner was started for the ${this.world} world, not ${episodeWorld(episode)} (see --world)`,
      });
      return;
    }
    if (this.running) {
      this.write({
        type: "episode_done",
        episodeId: episode.episodeId,
        exitCode: null,
        durationMs: 0,
        error: "the runner is already running an episode",
      });
      return;
    }
    const running: Running = { episodeId: episode.episodeId, cancelled: false };
    this.running = running;
    this.log(`episode ${episode.episodeId}: starting the agent`);
    try {
      if (episode.nonce && episode.world !== "brokerage") await this.sendEvidence(episode);
      if (running.cancelled) {
        this.write({
          type: "episode_done",
          episodeId: episode.episodeId,
          exitCode: null,
          durationMs: Date.now() - started,
          error: "cancelled before the agent started",
        });
        return;
      }
      const result = await this.launch(episode, running);
      this.write({
        type: "episode_done",
        episodeId: episode.episodeId,
        durationMs: Date.now() - started,
        ...result,
      });
      this.log(
        `episode ${episode.episodeId}: agent ${result.exitCode === null ? `stopped (${result.signal ?? result.error})` : `exited with code ${result.exitCode}`}`,
      );
    } finally {
      clearTimeout(running.killTimer);
      if (this.running === running) this.running = undefined;
    }
  }

  /** Runs the agent command to completion (or until it is killed). */
  private launch(
    episode: AnyEpisodeMessage,
    running: Running,
  ): Promise<{
    exitCode: number | null;
    signal?: string | null;
    stdoutTail?: string;
    stderrTail?: string;
    error?: string;
  }> {
    const [command, ...args] = this.options.command;
    const env: NodeJS.ProcessEnv = { ...process.env, ...episodeEnv(episode) };
    // The runner's own credential never reaches the agent, and neither does the production
    // vault's (bondedVaultFromEnv in @bondedhq/sdk): a rated episode can't trade real funds.
    delete env.BONDED_RUNNER_TOKEN;
    delete env.BONDED_AGENT_KEY;
    delete env.BONDED_VAULT_ADDRESS;
    // A brokerage episode has no chain: nothing left over in the runner's own environment may
    // look like one to the agent.
    if (episode.world === "brokerage")
      for (const name of [
        "BONDED_VAULT",
        "BONDED_CHAIN_ID",
        "BONDED_CONTRACTS",
        "BONDED_RPC_URL",
        "BONDED_SESSION_KEY",
        "BONDED_TEE_KEY_ID",
      ])
        delete env[name];
    const stdout = new Tail(RUNNER_TAIL_BYTES);
    const stderr = new Tail(RUNNER_TAIL_BYTES);
    const echo = this.options.echo ?? true;
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(command!, args, {
          env,
          ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
          stdio: ["ignore", "pipe", "pipe"],
          // Its own process group, so stopping it stops anything it started.
          detached: process.platform !== "win32",
        });
      } catch (error) {
        resolve({ exitCode: null, error: `could not start the agent: ${String(error)}` });
        return;
      }
      running.child = child;
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout.push(chunk);
        if (echo) process.stdout.write(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr.push(chunk);
        if (echo) process.stderr.write(chunk);
      });
      let failed: string | undefined;
      child.once("error", (error) => {
        failed = `could not start the agent: ${error.message}`;
      });
      child.once("spawn", () =>
        this.write({ type: "episode_started", episodeId: episode.episodeId }),
      );
      child.once("close", (code, signal) => {
        resolve({
          exitCode: failed ? null : code,
          signal,
          ...(stdout.text() ? { stdoutTail: stdout.text() } : {}),
          ...(stderr.text() ? { stderrTail: stderr.text() } : {}),
          ...(failed ? { error: failed } : {}),
        });
      });
      // The gateway enforces the deadline; this is the runner's own backstop.
      running.killTimer = setTimeout(
        () => void this.cancelRunning("the episode's deadline passed"),
        episode.deadlineMs + (this.options.killGraceMs ?? RUNNER_KILL_GRACE_MS),
      );
      if (running.cancelled) void this.cancelRunning("cancelled");
    });
  }

  /** SIGTERM to the agent's process group, then SIGKILL after the grace period. */
  private async cancelRunning(why: string): Promise<void> {
    const running = this.running;
    if (!running) return;
    running.cancelled = true;
    const child = running.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    this.log(`episode ${running.episodeId}: stopping the agent (${why})`);
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    signal(child, "SIGTERM");
    const grace = this.options.killGraceMs ?? RUNNER_KILL_GRACE_MS;
    const timer = setTimeout(() => signal(child, "SIGKILL"), grace);
    await exited;
    clearTimeout(timer);
  }

  /** Gets the TEE's evidence for the episode's nonce and forwards it as-is. */
  private async sendEvidence(episode: EpisodeMessage): Promise<void> {
    const reply = (fields: { evidence?: unknown; error?: string }) =>
      this.write({ type: "tee_evidence", episodeId: episode.episodeId, ...fields });
    if (!this.options.teeUrl) {
      reply({ error: "this runner has no --tee-url" });
      return;
    }
    try {
      const url = new URL("attestation", `${this.options.teeUrl.replace(/\/+$/, "")}/`);
      url.searchParams.set("nonce", episode.nonce!);
      // In chain mode the TEE attests the rating's Arena key, the one it signs episodes with.
      if (episode.teeKeyId) {
        url.searchParams.set("purpose", "arena");
        url.searchParams.set("key", episode.teeKeyId);
      }
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      const text = await response.text();
      if (!response.ok) throw new Error(`the TEE answered ${response.status}`);
      if (text.length > 512 * 1024) throw new Error("the TEE's evidence is too large");
      reply({ evidence: JSON.parse(text) as unknown });
    } catch (error) {
      reply({ error: error instanceof Error ? error.message : String(error) });
    }
  }
}

function signal(child: ChildProcess, name: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name);
    else child.kill(name);
  } catch {
    // Already gone.
  }
}
