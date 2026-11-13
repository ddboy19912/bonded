// The code sandbox's own thread (code-agent.ts starts one per run). It runs an owner's file in
// QuickJS compiled to WebAssembly, and reaches the model and the episode's tools only by asking the
// thread that started it, which makes the real calls and enforces the caps. The worker thread can
// be ended at any moment (a deadline, a cap), whatever the code is doing, and its loops never hold
// the thread that serves the gateway and the API.
//
// Written so Node can run it with its types stripped (tests run it from source): no parameter
// properties, enums or namespaces, and type-only imports marked as such.
import { parentPort, workerData } from "node:worker_threads";
import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import type {
  QuickJSContext,
  QuickJSHandle,
  QuickJSRuntime,
  QuickJSSyncVariant,
  QuickJSWASMModule,
} from "quickjs-emscripten-core";

/** What the thread is started with. */
export interface CodeWorkerInput {
  /** run: one episode; inspect: load the file and check its default export, nothing more. */
  mode: "run" | "inspect";
  /** The file, already JavaScript. */
  js: string;
  /** run: the episode the default export is called with, as JSON. */
  episodeJson?: string;
  limits: {
    memoryBytes: number;
    stackBytes: number;
    sliceMs: number;
    cpuMs: number;
    logLines: number;
    logLineChars: number;
  };
}

/** Messages to the starting thread. */
export type CodeWorkerMessage =
  | { t: "call"; id: number; fn: "chat" | "tool"; body: string }
  | { t: "log"; line: string }
  | { t: "result"; ok: true; finalMessage: string }
  | { t: "result"; ok: false; error: string };

/** Messages from it: the answer to a call. */
export type CodeWorkerReply =
  | { t: "reply"; id: number; ok: true; value: string }
  | { t: "reply"; id: number; ok: false; error: string };

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

const input = workerData as CodeWorkerInput;
const port = parentPort!;
const send = (message: CodeWorkerMessage) => port.postMessage(message);

/** Calls the starting thread (the model, or a tool) and waits for its answer. */
const pending = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>();
let nextId = 0;
port.on("message", (m: CodeWorkerReply) => {
  const waiting = pending.get(m.id);
  if (!waiting) return;
  pending.delete(m.id);
  if (m.ok) waiting.resolve(m.value);
  else waiting.reject(new Error(m.error));
});
function host(fn: "chat" | "tool", body: string): Promise<string> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ t: "call", id, fn, body });
  });
}

/** One run: its runtime, its limits, and the host functions it is given. */
class Sandbox {
  logs = 0;
  runtime: QuickJSRuntime;
  ctx: QuickJSContext;
  limits: CodeWorkerInput["limits"];
  sliceDeadline = 0;
  cpuUsed = 0;
  failure: ((error: Error) => void) | undefined;
  failed: Promise<never>;

  constructor(module: QuickJSWASMModule, limits: CodeWorkerInput["limits"]) {
    this.limits = limits;
    this.failed = new Promise<never>((_, reject) => {
      this.failure = reject;
    });
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
          new Error(`the agent used more than ${this.limits.cpuMs / 1000} s of computing time`),
        );
    }
  }

  /** Runs the engine's pending jobs (promise callbacks) until there are none. */
  pump(): void {
    const result = this.slice(() => this.runtime.executePendingJobs(-1));
    if (result.error) {
      const error = this.describe(result.error);
      result.error.dispose();
      this.fail(new Error(error));
    }
  }

  log(level: string, text: string): void {
    if (this.logs > this.limits.logLines) return;
    if (this.logs++ === this.limits.logLines) {
      send({ t: "log", line: "(more output was cut)" });
      return;
    }
    const line = `${level === "log" || level === "info" ? "" : `${level}: `}${text}`;
    send({
      t: "log",
      line:
        line.length > this.limits.logLineChars
          ? `${line.slice(0, this.limits.logLineChars)}…`
          : line,
    });
  }

  installConsole(): void {
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
          const h = ctx.newString(value);
          deferred.resolve(h);
          h.dispose();
          this.pump();
        },
        (error: unknown) => {
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

/** Loads the file and returns its default export, or throws why it can't be. */
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

async function main(): Promise<string> {
  // The package's types describe its CommonJS build; under ESM its default export is the variant.
  const module = await newQuickJSWASMModuleFromVariant(
    RELEASE_SYNC as unknown as QuickJSSyncVariant,
  );
  const sandbox = new Sandbox(module, input.limits);
  const ctx = sandbox.ctx;
  if (input.mode === "inspect") {
    const refuse = async (): Promise<string> => {
      throw new Error("the model and tools are only available while the agent runs an episode");
    };
    sandbox.hostAsync("__bondedChat", refuse);
    sandbox.hostAsync("__bondedCallTool", refuse);
    (await loadAgent(sandbox, input.js)).dispose();
    return "";
  }
  sandbox.hostAsync("__bondedChat", (body) => host("chat", body));
  sandbox.hostAsync("__bondedCallTool", (body) => host("tool", body));
  const boot = sandbox.slice(() =>
    ctx.evalCode(BOOTSTRAP, "bonded-bootstrap.js", { type: "global" }),
  );
  if (boot.error) throw new Error("the sandbox couldn't start");
  boot.value.dispose();
  const run = await loadAgent(sandbox, input.js);
  const make = ctx.getProp(ctx.global, "__bondedEpisode");
  const jsonH = ctx.newString(input.episodeJson ?? "{}");
  const made = sandbox.slice(() => ctx.callFunction(make, ctx.undefined, jsonH));
  if (made.error) throw new Error("the sandbox couldn't start");
  const called = sandbox.slice(() => ctx.callFunction(run, ctx.undefined, made.value));
  if (called.error) throw new Error(sandbox.describe(called.error));
  const settled = ctx.resolvePromise(called.value);
  sandbox.pump();
  const result = await Promise.race([settled, sandbox.failed]);
  if (result.error) throw new Error(sandbox.describe(result.error));
  return finalMessageOf(ctx.dump(result.value));
}

// The thread ends when the starting thread terminates it, once it has the result. Nothing in the
// engine is freed handle by handle: the whole instance goes with the thread.
main().then(
  (finalMessage) => send({ t: "result", ok: true, finalMessage }),
  (error: unknown) =>
    send({ t: "result", ok: false, error: error instanceof Error ? error.message : String(error) }),
);
