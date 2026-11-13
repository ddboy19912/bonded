import * as nodeModule from "node:module";
import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSSyncVariant,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import { type ChatMessage, modelAccountStop, type ToolDefinition } from "@bondedhq/shared";
import { HostedBudgetError, HostedLimitError, type HostedEpisode } from "./episode.js";

/** The most the sandbox may hand out in one model request, and in one tool call's arguments. */
const MAX_CHAT_BODY = 1_000_000;
const MAX_TOOL_ARGS = 64_000;

/**
 * A hosted agent made from one code file: its default export runs one episode. It runs in
 * QuickJS compiled to WebAssembly, a JavaScript engine with nothing of the host's: no network, no
 * files, no processes, no timers. What it can do is what Bonded hands in:
 *
 * - `import OpenAI from "openai"`: a client whose `chat.completions.create` calls the model the
 *   owner picked, through Bonded's key and the episode's caps (the `model` it is given is ignored);
 * - the episode, as the default export's argument: `{ goal, mandate, maxSteps, model, tools,
 *   callTool(name, args) }`, where `tools` is an OpenAI-style function list and `callTool` answers
 *   `{ ok: true, output }` or `{ ok: false, error }`;
 * - `console.log` and friends, kept and shown to the owner when a check runs.
 *
 * Memory, stack and computing time are capped, and the engine is interrupted when a stretch of
 * code runs too long, so a loop can't hold the worker. Model and tool calls are capped by the
 * episode (HostedEpisode). docs/HOSTED-AGENTS.md is the owner-facing guide.
 */

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

/** The file's name in errors and stack traces. */
const FILE = "agent.js";

/** `import OpenAI from "openai"`, inside the sandbox: the picked model, through Bonded. */
const OPENAI_MODULE = `
const chat = globalThis.__bondedChat;
class Completions {
  async create(body) {
    if (body && body.stream) throw new Error("Streaming isn't available here: leave stream unset.");
    return JSON.parse(await chat(JSON.stringify(body ?? {})));
  }
}
export class OpenAI {
  constructor(_options) {
    this.chat = { completions: new Completions() };
  }
}
export default OpenAI;
`;

/** Builds the episode object the default export is called with. */
const BOOTSTRAP = `
globalThis.__bondedEpisode = (json) => {
  const episode = JSON.parse(json);
  const call = globalThis.__bondedCallTool;
  episode.callTool = async (name, args) =>
    JSON.parse(await call(JSON.stringify({ name: String(name), args: args ?? {} })));
  return Object.freeze(episode);
};
`;

/**
 * A fresh engine for every run: its own WebAssembly instance and memory. One run can't leave
 * anything behind for the next, and a run that ends mid-way (out of time, a cap, an abort) is
 * simply dropped with its instance, never torn down handle by handle (QuickJS aborts its whole
 * instance if a runtime is freed with objects still alive, which would end every later run too).
 */
function quickjs(): Promise<QuickJSWASMModule> {
  // The package's types describe its CommonJS build; under ESM its default export is the variant.
  return newQuickJSWASMModuleFromVariant(RELEASE_SYNC as unknown as QuickJSSyncVariant);
}

/** What a code agent's run came to. `logs` is what it printed, kept whatever happened. */
export type CodeAgentOutcome =
  | { ok: true; finalMessage: string; logs: string[] }
  | {
      ok: false;
      error: string;
      logs: string[];
      /** The model account refused (a key or credit problem): Bonded's failure, not the agent's. */
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

/** A sandbox run: one runtime, its limits, and the host functions it is given. */
class Sandbox {
  readonly logs: string[] = [];
  private readonly runtime: QuickJSRuntime;
  readonly ctx: QuickJSContext;
  private sliceDeadline = 0;
  private cpuUsed = 0;
  /** Set when the run must end (a cap, an engine error): the run rejects with it. */
  private failure: ((error: Error) => void) | undefined;
  readonly failed: Promise<never>;
  /** The run is over: late callbacks from the model or tools touch nothing. */
  closed = false;

  constructor(
    module: QuickJSWASMModule,
    private readonly limits: SandboxLimits,
  ) {
    this.failed = new Promise<never>((_, reject) => {
      this.failure = reject;
    });
    // Nobody may be left waiting on it unhandled.
    this.failed.catch(() => {});
    this.runtime = module.newRuntime();
    this.runtime.setMemoryLimit(limits.memoryBytes);
    this.runtime.setMaxStackSize(limits.stackBytes);
    this.runtime.setInterruptHandler(() => Date.now() > this.sliceDeadline);
    this.runtime.setModuleLoader((name) =>
      name === "openai"
        ? OPENAI_MODULE
        : {
            error: new Error(
              `Cannot import "${name}": only "openai" is available here (one file, no packages)`,
            ),
          },
    );
    this.ctx = this.runtime.newContext();
    this.installConsole();
  }

  fail(error: Error): void {
    this.failure?.(error);
  }

  /** Runs `fn` in the engine with the slice and computing-time caps. */
  slice<T>(fn: () => T): T {
    const start = Date.now();
    const left = this.limits.cpuMs - this.cpuUsed;
    this.sliceDeadline = start + Math.max(0, Math.min(this.limits.sliceMs, left));
    try {
      return fn();
    } finally {
      this.cpuUsed += Date.now() - start;
      if (this.cpuUsed >= this.limits.cpuMs)
        this.fail(
          new HostedLimitError(
            `the agent used more than ${this.limits.cpuMs / 1000} s of computing time`,
          ),
        );
    }
  }

  /** Runs the engine's pending jobs (promise callbacks) until there are none. */
  pump(): void {
    if (this.closed) return;
    const result = this.slice(() => this.runtime.executePendingJobs(-1));
    if (result.error) {
      const error = this.describe(result.error);
      result.error.dispose();
      this.fail(new Error(error));
    }
  }

  private log(level: string, text: string): void {
    if (this.logs.length >= this.limits.logLines) return;
    const line = `${level === "log" || level === "info" ? "" : `${level}: `}${text}`;
    this.logs.push(
      line.length > this.limits.logLineChars ? `${line.slice(0, this.limits.logLineChars)}…` : line,
    );
    if (this.logs.length === this.limits.logLines) this.logs.push("(more output was cut)");
  }

  private installConsole(): void {
    const ctx = this.ctx;
    const consoleH = ctx.newObject();
    for (const level of ["log", "info", "warn", "error", "debug"]) {
      const fn = ctx.newFunction(level, (...args) => {
        this.log(level, args.map((a) => show(ctx.dump(a))).join(" "));
      });
      ctx.setProp(consoleH, level, fn);
      fn.dispose();
    }
    ctx.setProp(ctx.global, "console", consoleH);
    consoleH.dispose();
  }

  /** A host function that returns a promise to the engine: `impl` takes and gives JSON text. */
  hostAsync(name: string, impl: (arg: string) => Promise<string>): void {
    const ctx = this.ctx;
    const fn = ctx.newFunction(name, (argH) => {
      const arg = argH && ctx.typeof(argH) === "string" ? ctx.getString(argH) : "";
      const deferred = ctx.newPromise();
      impl(arg).then(
        (value) => {
          if (this.closed) return;
          const h = ctx.newString(value);
          deferred.resolve(h);
          h.dispose();
          this.pump();
        },
        (error: unknown) => {
          if (this.closed) return;
          // A cap, or the model account refusing: the run ends here, whatever the code catches.
          if (
            error instanceof HostedLimitError ||
            error instanceof HostedBudgetError ||
            modelAccountStop(error)
          )
            this.fail(error as Error);
          const h = ctx.newError(error instanceof Error ? error.message : String(error));
          deferred.reject(h);
          h.dispose();
          this.pump();
        },
      );
      return deferred.handle;
    });
    ctx.setProp(ctx.global, name, fn);
    fn.dispose();
  }

  /** An engine error as one line: its name, message and where in the file. */
  describe(errorH: QuickJSHandle): string {
    const e = this.ctx.dump(errorH) as { name?: string; message?: string; stack?: string } | string;
    if (typeof e !== "object" || e === null) return String(e);
    if (e.name === "InternalError" && e.message === "interrupted")
      return `the agent ran for more than ${this.limits.sliceMs} ms without waiting on a tool or the model (an endless loop?)`;
    const where = e.stack
      ?.split("\n")
      .find((l) => l.includes(FILE))
      ?.trim();
    let message = `${e.name ?? "Error"}: ${e.message ?? ""}`;
    if (
      /ReferenceError/.test(message) &&
      /\b(fetch|setTimeout|setInterval|require|process)\b/.test(message)
    )
      message +=
        " (the sandbox has no network, timers or Node APIs: use callTool and the openai client)";
    return where ? `${message} ${where.replace(/^at\s+/, "at ")}` : message;
  }

  /**
   * Ends the run. The engine's instance is the run's own (quickjs()), so nothing is freed handle
   * by handle: callbacks still in flight see `closed` and do nothing, and the whole instance goes
   * to the garbage collector with this sandbox.
   */
  dispose(): void {
    this.closed = true;
    this.fail(new Error("the episode ended"));
  }
}

/** A value from the engine as log text. */
function show(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** What the default export resolved to, as the agent's final message. */
function finalMessageOf(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    typeof (value as { finalMessage?: unknown }).finalMessage === "string"
  )
    return (value as { finalMessage: string }).finalMessage;
  return show(value);
}

/**
 * Loads the file and returns its default export, or throws why it can't be. The module's own
 * top-level code runs here (in the sandbox, under its caps).
 */
async function loadAgent(sandbox: Sandbox, js: string): Promise<QuickJSHandle> {
  const ctx = sandbox.ctx;
  const evaluated = sandbox.slice(() => ctx.evalCode(js, FILE, { type: "module" }));
  if (evaluated.error) {
    const message = sandbox.describe(evaluated.error);
    evaluated.error.dispose();
    throw new Error(message);
  }
  // The exports, or a promise for them (top-level await).
  const settled = ctx.resolvePromise(evaluated.value);
  evaluated.value.dispose();
  sandbox.pump();
  const exports = await Promise.race([settled, sandbox.failed]);
  if (exports.error) {
    const message = sandbox.describe(exports.error);
    exports.error.dispose();
    throw new Error(message);
  }
  const fn = ctx.getProp(exports.value, "default");
  exports.value.dispose();
  if (ctx.typeof(fn) !== "function") {
    fn.dispose();
    throw new Error(
      "the file has no default export to run: add `export default async function run(episode) { ... }`",
    );
  }
  return fn;
}

/**
 * Checks a file before it is saved: it reads as JavaScript (or TypeScript), its top-level code
 * runs, and it has a default export function. Nothing is called: no model, no tools.
 */
export async function inspectCodeAgent(
  code: string,
  language: "js" | "ts",
  limits: Partial<SandboxLimits> = {},
): Promise<{ ok: true } | { ok: false; problem: string }> {
  let js: string;
  try {
    js = javascriptOf(code, language);
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
  const sandbox = new Sandbox(await quickjs(), { ...SANDBOX_LIMITS, cpuMs: 1_000, ...limits });
  try {
    const refuse = async () => {
      throw new Error("the model and tools are only available while the agent runs an episode");
    };
    sandbox.hostAsync("__bondedChat", refuse);
    sandbox.hostAsync("__bondedCallTool", refuse);
    const fn = await loadAgent(sandbox, js);
    fn.dispose();
    return { ok: true };
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) };
  } finally {
    sandbox.dispose();
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
): Promise<CodeAgentOutcome> {
  let js: string;
  try {
    js = javascriptOf(source.code, source.language);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), logs: [] };
  }
  const sandbox = new Sandbox(await quickjs(), { ...SANDBOX_LIMITS, ...limits });
  const ctx = sandbox.ctx;
  const onAbort = () => sandbox.fail(new Error("the episode ended"));
  episode.signal.addEventListener("abort", onAbort, { once: true });
  try {
    sandbox.hostAsync("__bondedChat", async (body) => {
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
    });
    sandbox.hostAsync("__bondedCallTool", async (body) => {
      if (body.length > MAX_TOOL_ARGS)
        throw new Error(`a tool call's arguments may be at most ${MAX_TOOL_ARGS / 1000} KB`);
      const { name, args } = JSON.parse(body) as { name: string; args: unknown };
      return JSON.stringify(await episode.callTool(name, args));
    });
    const boot = sandbox.slice(() =>
      ctx.evalCode(BOOTSTRAP, "bonded-bootstrap.js", { type: "global" }),
    );
    if (boot.error) {
      boot.error.dispose();
      throw new Error("the sandbox couldn't start");
    }
    boot.value.dispose();

    const run = await loadAgent(sandbox, js);
    const { message } = episode;
    const tools = await episode.toolDefinitions();
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
    const make = ctx.getProp(ctx.global, "__bondedEpisode");
    const jsonH = ctx.newString(episodeJson);
    const made = sandbox.slice(() => ctx.callFunction(make, ctx.undefined, jsonH));
    make.dispose();
    jsonH.dispose();
    if (made.error) {
      made.error.dispose();
      run.dispose();
      throw new Error("the sandbox couldn't start");
    }
    const called = sandbox.slice(() => ctx.callFunction(run, ctx.undefined, made.value));
    run.dispose();
    made.value.dispose();
    if (called.error) {
      const error = sandbox.describe(called.error);
      called.error.dispose();
      throw new Error(error);
    }
    const settled = ctx.resolvePromise(called.value);
    called.value.dispose();
    sandbox.pump();
    const result = await Promise.race([settled, sandbox.failed]);
    if (result.error) {
      const error = sandbox.describe(result.error);
      result.error.dispose();
      throw new Error(error);
    }
    const value = ctx.dump(result.value);
    result.value.dispose();
    return { ok: true, finalMessage: finalMessageOf(value), logs: sandbox.logs };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      logs: sandbox.logs,
      ...(modelAccountStop(error) || error instanceof HostedBudgetError ? { bonded: true } : {}),
    };
  } finally {
    episode.signal.removeEventListener("abort", onAbort);
    sandbox.dispose();
  }
}
