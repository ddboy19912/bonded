import * as nodeModule from "node:module";
import { Worker } from "node:worker_threads";
import { type ChatMessage, modelAccountStop, type ToolDefinition } from "@bondedhq/shared";
import type { CodeWorkerInput, CodeWorkerMessage, CodeWorkerReply } from "./code-worker.js";
import { HostedBudgetError, HostedLimitError, type HostedEpisode } from "./episode.js";

/**
 * A hosted agent made from one code file: its default export runs one episode. It runs on a
 * thread of its own (code-worker.ts), in QuickJS compiled to WebAssembly, a JavaScript engine
 * with nothing of the host's: no network, no files, no processes, no timers. What it can do is
 * what Bonded hands in:
 *
 * - `import OpenAI from "openai"`: a client whose `chat.completions.create` calls the model the
 *   owner picked, through Bonded's key and the episode's caps (the `model` it is given is ignored);
 * - the episode, as the default export's argument: `{ goal, mandate, maxSteps, model, tools,
 *   callTool(name, args) }`, where `tools` is an OpenAI-style function list and `callTool` answers
 *   `{ ok: true, output }` or `{ ok: false, error }`;
 * - `console.log` and friends, kept and shown to the owner when a check runs.
 *
 * The thread asks this one for every model and tool call, so the caps (HostedEpisode) are
 * enforced here, where the code can't reach. A deadline, a cap or a refused model account ends the
 * thread at once, whatever the code is doing, and its loops never hold the thread that serves the
 * gateway and the API. docs/HOSTED-AGENTS.md is the owner-facing guide.
 */

/**
 * The most the sandbox may hand out in one model request, and in one tool call's arguments. The
 * thread checks them before sending (code-worker.ts); this side checks again, since what arrives
 * from the thread is never trusted. Kept equal (a test compares them).
 */
export const MAX_CHAT_BODY = 1_000_000;
export const MAX_TOOL_ARGS = 64_000;

export interface SandboxLimits {
  memoryBytes: number;
  stackBytes: number;
  /** The longest the engine runs before it must hand control back (a loop is interrupted). */
  sliceMs: number;
  /** Computing time per episode, summed over every stretch the engine runs. */
  cpuMs: number;
  logLines: number;
  logLineChars: number;
}

export const SANDBOX_LIMITS: SandboxLimits = {
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  sliceMs: 250,
  cpuMs: 10_000,
  logLines: 200,
  logLineChars: 500,
};

/** What a code agent's run came to. `logs` is what it printed, kept whatever happened. */
export type CodeAgentOutcome =
  | { ok: true; finalMessage: string; logs: string[] }
  | {
      ok: false;
      error: string;
      logs: string[];
      /** Bonded's own limit or model account stopped it: Bonded's failure, not the agent's. */
      bonded?: boolean;
    };

/**
 * The file as JavaScript: TypeScript has its types removed (Node's own type stripping; types only,
 * so enums and namespaces are refused with a message that says so).
 */
export function javascriptOf(code: string, language: "js" | "ts"): string {
  if (language === "js") return code;
  const strip = (
    nodeModule as {
      stripTypeScriptTypes?: (code: string, options?: { mode?: "strip" | "transform" }) => string;
    }
  ).stripTypeScriptTypes;
  if (!strip)
    throw new Error("TypeScript isn't supported on this server yet: upload the file as JavaScript");
  try {
    return strip(code, { mode: "strip" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `the TypeScript couldn't be read: ${message.split("\n")[0]} (only type annotations are removed, so enums and namespaces aren't supported)`,
      { cause: error },
    );
  }
}

/**
 * The thread's entry: the built file, or (tests running from source) the TypeScript one, which
 * Node runs with its types stripped.
 */
function workerEntry(): { url: URL; execArgv: string[] } {
  const fromSource = import.meta.url.endsWith(".ts");
  return fromSource
    ? {
        url: new URL("./code-worker.ts", import.meta.url),
        execArgv: ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"],
      }
    : { url: new URL("./code-worker.js", import.meta.url), execArgv: [] };
}

/** The thread's own heap: the engine's memory is capped inside it, this is the room around it. */
const THREAD_RESOURCES = { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 };

/**
 * How many sandbox threads may run at once in this process. Each may take up to about 160 MB for
 * up to 10 s, so without a limit, parallel saves of a file that holds memory could run the
 * process out of it. Saving a file (inspection) gets a few slots and is refused at once when they
 * are busy; test runs wait for a slot.
 */
export class ThreadSlots {
  private used = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(readonly max: number) {}

  /** Takes a slot if one is free. */
  tryTake(): boolean {
    if (this.used >= this.max) return false;
    this.used++;
    return true;
  }

  /** Waits for a slot; false if `signal` aborts first. */
  take(signal?: AbortSignal): Promise<boolean> {
    if (this.tryTake()) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const onAbort = () => {
        const i = this.waiting.indexOf(grant);
        if (i >= 0) this.waiting.splice(i, 1);
        resolve(false);
      };
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        this.used++;
        resolve(true);
      };
      this.waiting.push(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Gives a slot back, to the next waiting run if there is one. */
  give(): void {
    this.used = Math.max(0, this.used - 1);
    this.waiting.shift()?.();
  }

  get inUse(): number {
    return this.used;
  }
}

const slotCount = (value: string | undefined, fallback: number) => {
  const n = Number(value ?? fallback);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
/** Files being checked on save (HOSTED_INSPECT_THREADS, 2 by default). */
export const INSPECT_SLOTS = new ThreadSlots(slotCount(process.env.HOSTED_INSPECT_THREADS, 2));
/** Code agents running tests (HOSTED_RUN_THREADS, 8 by default: two previews' worth). */
export const RUN_SLOTS = new ThreadSlots(slotCount(process.env.HOSTED_RUN_THREADS, 8));

/** Told when every inspection slot is busy: nothing is wrong with the file. */
export const INSPECT_BUSY =
  "Bonded is checking other files right now; save it again in a few seconds";

/** Thrown by a call to end the thread with this outcome, whatever the code would do with it. */
class Stop extends Error {
  readonly bonded: boolean;
  constructor(message: string, bonded: boolean) {
    super(message);
    this.bonded = bonded;
  }
}

/** Runs the sandbox thread to its result, answering its model and tool calls with `call`. */
function runThread(
  input: CodeWorkerInput,
  options: {
    call?: (fn: "chat" | "tool", body: string) => Promise<string>;
    signal?: AbortSignal;
    /** Ends the thread if it hasn't answered by then (inspection only). */
    timeoutMs?: number;
  },
): Promise<CodeAgentOutcome> {
  return new Promise((resolve) => {
    const logs: string[] = [];
    let settled = false;
    const entry = workerEntry();
    const worker = new Worker(entry.url, {
      workerData: input,
      execArgv: entry.execArgv,
      resourceLimits: THREAD_RESOURCES,
      stdout: true,
      stderr: true,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => finish({ ok: false, error: "the episode ended", logs });
    function finish(outcome: CodeAgentOutcome) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      resolve(outcome);
    }
    if (options.timeoutMs)
      timer = setTimeout(
        () => finish({ ok: false, error: "the file took too long to load", logs }),
        options.timeoutMs,
      );
    if (options.signal?.aborted) return onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    worker.on("message", (m: CodeWorkerMessage) => {
      if (m.t === "log") {
        if (logs.length <= SANDBOX_LIMITS.logLines) logs.push(m.line);
        return;
      }
      if (m.t === "result") {
        finish(
          m.ok
            ? { ok: true, finalMessage: m.finalMessage, logs }
            : { ok: false, error: m.error, logs },
        );
        return;
      }
      const reply = (r: CodeWorkerReply) => {
        if (!settled) worker.postMessage(r);
      };
      const call = options.call;
      if (!call) return reply({ t: "reply", id: m.id, ok: false, error: "not available" });
      call(m.fn, m.body).then(
        (value) => reply({ t: "reply", id: m.id, ok: true, value }),
        (error: unknown) =>
          error instanceof Stop
            ? finish({
                ok: false,
                error: error.message,
                logs,
                ...(error.bonded ? { bonded: true } : {}),
              })
            : reply({
                t: "reply",
                id: m.id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }),
      );
    });
    worker.on("error", (error: Error & { code?: string }) =>
      finish({
        ok: false,
        error:
          error.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? "the agent used more memory than a test allows"
            : `the sandbox stopped: ${error.message}`,
        logs,
      }),
    );
    worker.on("exit", () =>
      finish({ ok: false, error: "the sandbox ended without an answer", logs }),
    );
  });
}

/**
 * Checks a file before it is saved: it reads as JavaScript (or TypeScript), its top-level code
 * runs, and it has a default export function. Nothing is called: no model, no tools.
 */
export async function inspectCodeAgent(
  code: string,
  language: "js" | "ts",
  limits: Partial<SandboxLimits> = {},
  slots: ThreadSlots = INSPECT_SLOTS,
): Promise<{ ok: true } | { ok: false; problem: string; busy?: true }> {
  let js: string;
  try {
    js = javascriptOf(code, language);
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
  // Busy: refused at once rather than queued, so waiting saves can't pile up either.
  if (!slots.tryTake()) return { ok: false, problem: INSPECT_BUSY, busy: true };
  try {
    const outcome = await runThread(
      { mode: "inspect", js, limits: { ...SANDBOX_LIMITS, cpuMs: 1_000, ...limits } },
      { timeoutMs: 10_000 },
    );
    return outcome.ok ? { ok: true } : { ok: false, problem: outcome.error };
  } finally {
    slots.give();
  }
}

/**
 * Runs one episode with the owner's file: loads it, calls its default export with the episode,
 * and waits for it to finish. Never throws: what went wrong comes back as `{ ok: false, error }`.
 */
export async function runCodeAgent(
  episode: HostedEpisode,
  source: { code: string; language: "js" | "ts" },
  limits: Partial<SandboxLimits> = {},
  slots: ThreadSlots = RUN_SLOTS,
): Promise<CodeAgentOutcome> {
  let js: string;
  let tools: ToolDefinition[];
  try {
    js = javascriptOf(source.code, source.language);
    tools = await episode.toolDefinitions();
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), logs: [] };
  }
  const { message } = episode;
  const offered = message.task.tools
    ? tools.filter((t) => message.task.tools!.includes(t.function.name))
    : tools;
  const episodeJson = JSON.stringify({
    episodeId: message.episodeId,
    goal: message.task.goal,
    mandate: message.task.mandate,
    maxSteps: message.task.maxSteps,
    model: episode.model,
    tools: offered,
  });

  const chat = async (body: string) => {
    if (body.length > MAX_CHAT_BODY)
      throw new Error(`a model request may be at most ${MAX_CHAT_BODY / 1_000_000} MB`);
    const request = JSON.parse(body || "{}") as {
      messages?: unknown;
      tools?: unknown;
      temperature?: unknown;
      max_tokens?: unknown;
      max_completion_tokens?: unknown;
    };
    if (!Array.isArray(request.messages))
      throw new Error("chat.completions.create needs { messages: [...] }");
    const maxTokens = request.max_completion_tokens ?? request.max_tokens;
    const response = await episode.chat({
      messages: request.messages as ChatMessage[],
      ...(Array.isArray(request.tools) ? { tools: request.tools as ToolDefinition[] } : {}),
      ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
      ...(typeof maxTokens === "number" ? { max_tokens: maxTokens } : {}),
    });
    // The shape the OpenAI SDK returns, so code written against it works unchanged.
    return JSON.stringify({
      id: response.id ?? "bonded-chat",
      object: "chat.completion",
      model: episode.model,
      choices: response.choices.map((c, index) => ({
        index,
        message: c.message,
        finish_reason: c.finish_reason,
      })),
      usage: {
        prompt_tokens: response.usage?.prompt_tokens ?? 0,
        completion_tokens: response.usage?.completion_tokens ?? 0,
        total_tokens:
          (response.usage?.prompt_tokens ?? 0) + (response.usage?.completion_tokens ?? 0),
      },
    });
  };
  const tool = async (body: string) => {
    if (body.length > MAX_TOOL_ARGS)
      throw new Error(`a tool call's arguments may be at most ${MAX_TOOL_ARGS / 1000} KB`);
    const { name, args } = JSON.parse(body) as { name: string; args: unknown };
    return JSON.stringify(await episode.callTool(name, args));
  };

  // A slot first: tests wait for one rather than all running at once. The episode's deadline still
  // runs meanwhile, so a long wait ends the test as the episode ending.
  if (!(await slots.take(episode.signal)))
    return { ok: false, error: "the episode ended", logs: [] };
  try {
    return await runThreadWith(js, episodeJson, limits, episode, chat, tool);
  } finally {
    slots.give();
  }
}

/** The run's thread, answering the code's model and tool calls. */
function runThreadWith(
  js: string,
  episodeJson: string,
  limits: Partial<SandboxLimits>,
  episode: HostedEpisode,
  chat: (body: string) => Promise<string>,
  tool: (body: string) => Promise<string>,
): Promise<CodeAgentOutcome> {
  return runThread(
    { mode: "run", js, episodeJson, limits: { ...SANDBOX_LIMITS, ...limits } },
    {
      signal: episode.signal,
      call: async (fn, body) => {
        try {
          return await (fn === "chat" ? chat(body) : tool(body));
        } catch (error) {
          // A cap, Bonded's budget or the model account refusing: the run ends here, whatever
          // the code would do with the error.
          if (error instanceof HostedLimitError) throw new Stop(error.message, false);
          if (error instanceof HostedBudgetError || modelAccountStop(error))
            throw new Stop(error instanceof Error ? error.message : String(error), true);
          throw error;
        }
      },
    },
  );
}
