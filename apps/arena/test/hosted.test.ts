import type { ChatClient, ChatRequest, ChatResponse } from "@bondedhq/shared";
import { LlmError } from "@bondedhq/shared";
import { afterEach, describe, expect, it } from "vitest";
import { didNotFinish, runBrokerEpisode } from "../src/brokerage/episode.js";
import { runBrokeragePreview } from "../src/brokerage/preview.js";
import { controlScenario } from "../src/brokerage/scenarios.js";
import { runConnectionCheck } from "../src/check.js";
import {
  ArenaGateway,
  RemoteAgent,
  type RemoteEpisodeEvent,
  StaticRunnerTokens,
} from "../src/gateway/index.js";
import {
  HostedBudget,
  hostedAgent,
  type HostedAgentOptions,
  inspectCodeAgent,
} from "../src/hosted/index.js";

/**
 * Hosted agents ("Run it on Bonded"): Bonded runs the owner's instructions or code itself, through
 * the same gateway episode an outside agent gets, and the broker ledger judges it the same way.
 */

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function gateway() {
  const g = new ArenaGateway({ tokens: new StaticRunnerTokens() });
  await g.listen({ port: 0 });
  cleanups.push(() => g.close());
  return g;
}

/** A model that answers from a script, recording what it was asked. */
function scripted(...turns: ((request: ChatRequest) => ChatResponse)[]) {
  const requests: ChatRequest[] = [];
  const client: ChatClient = {
    async complete(request) {
      requests.push(request);
      const next = turns.shift();
      if (!next) throw new Error("the script ran out");
      return next(request);
    },
  };
  return { client, requests };
}

const say = (content: string): ChatResponse => ({
  choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
});
const call = (name: string, args: unknown, id = `call-${name}`): ChatResponse => ({
  choices: [
    {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
});

/** Does the control's job with plain tool calls: no model at all. */
const DO_THE_JOB = `
export default async function run(episode) {
  console.log("goal:", episode.goal.slice(0, 20));
  console.log("tools:", episode.tools.length);
  const plan = await episode.callTool("get_instructions", {});
  if (!plan.ok) throw new Error(plan.error);
  for (const [symbol, side, size] of [["VOO", "buy", { amountUsd: 2000 }], ["JPM", "buy", { amountUsd: 3000 }], ["AAPL", "sell", { quantity: 10 }]]) {
    const placed = await episode.callTool("place_order", { symbol, side, ...size });
    console.log(symbol, placed.ok ? "filled" : placed.error);
  }
  return "Bought VOO and JPM, sold 10 AAPL.";
}
`;

function hostedRemote(
  g: ArenaGateway,
  spec: Parameters<typeof hostedAgent>[0],
  options: HostedAgentOptions = {},
  onEvent?: (e: RemoteEpisodeEvent) => void,
) {
  return new RemoteAgent({
    gateway: g,
    transport: {
      kind: "hosted",
      agent: hostedAgent(spec, { client: scripted().client, ...options }),
      registration: "preview:test",
    },
    mode: "tools",
    world: "brokerage",
    ...(onEvent ? { onEvent } : {}),
  });
}

describe("a hosted code agent", () => {
  it("runs one file in the sandbox, through the gateway, judged by the ledger", async () => {
    const g = await gateway();
    const events: RemoteEpisodeEvent[] = [];
    const agent = hostedRemote(
      g,
      { kind: "code", model: "deepseek/deepseek-v4.1-flash", language: "js", code: DO_THE_JOB },
      {},
      (e) => events.push(e),
    );
    const result = await runBrokerEpisode(agent, controlScenario());
    expect(result.missed).toEqual([]);
    expect(result.verdict.breached).toBe(false);
    expect(result.agentSummary.finalMessage).toBe("Bought VOO and JPM, sold 10 AAPL.");
    // What it printed comes back with the episode, for the owner's check.
    const done = events.find((e) => e.type === "done") as { stdoutTail?: string };
    expect(done.stdoutTail).toContain("VOO filled");
    expect(done.stdoutTail).toContain("goal:");
  });

  it('calls the picked model through `import OpenAI from "openai"`, whatever model the code names', async () => {
    const g = await gateway();
    const model = scripted(
      (req) => {
        expect(req.model).toBe("qwen/qwen3.7-flash");
        expect(req.tools?.map((t) => t.function.name)).toContain("place_order");
        return call("get_instructions", {});
      },
      () => say("Nothing needed doing."),
    );
    const code = `
import OpenAI from "openai";
const openai = new OpenAI({ apiKey: "ignored" });
export default async function run({ goal, tools, callTool }) {
  const messages = [{ role: "system", content: "You run a brokerage account." }, { role: "user", content: goal }];
  for (;;) {
    const res = await openai.chat.completions.create({ model: "gpt-4o", messages, tools });
    const msg = res.choices[0].message;
    messages.push(msg);
    if (!msg.tool_calls?.length) return msg.content;
    for (const c of msg.tool_calls) {
      const out = await callTool(c.function.name, JSON.parse(c.function.arguments));
      messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(out) });
    }
  }
}`;
    const agent = hostedRemote(
      g,
      { kind: "code", model: "qwen/qwen3.7-flash", language: "js", code },
      { client: model.client },
    );
    const result = await runBrokerEpisode(agent, controlScenario());
    expect(result.agentSummary.finalMessage).toBe("Nothing needed doing.");
    expect(model.requests).toHaveLength(2);
    // The tool result went back to the model as the tool's JSON answer.
    const second = model.requests[1]!.messages.at(-1)!;
    expect(second).toMatchObject({ role: "tool", tool_call_id: "call-get_instructions" });
    expect(JSON.parse(second.content as string)).toMatchObject({ ok: true });
    // Bonded measured the usage and reported it at /done.
    const remote = (result.agentSummary as { remote?: { reportedUsage?: unknown } }).remote;
    expect(remote?.reportedUsage).toEqual({ inputTokens: 200, outputTokens: 40 });
  });

  it("runs TypeScript, with its types removed", async () => {
    const g = await gateway();
    const code = `
type Episode = { goal: string; callTool(name: string, args: object): Promise<{ ok: boolean }> };
export default async function run(episode: Episode): Promise<string> {
  const r = await episode.callTool("get_account", {});
  return r.ok ? "read the account" : "failed";
}`;
    const agent = hostedRemote(g, {
      kind: "code",
      model: "deepseek/deepseek-v4.1-flash",
      language: "ts",
      code,
    });
    const result = await runBrokerEpisode(agent, controlScenario());
    expect(result.agentSummary.finalMessage).toBe("read the account");
  });

  it("has no network, no timers and no Node, and says what to use instead", async () => {
    const g = await gateway();
    const agent = hostedRemote(g, {
      kind: "code",
      model: "deepseek/deepseek-v4.1-flash",
      language: "js",
      code: `export default async function run() { await fetch("https://example.com"); }`,
    });
    const result = await runBrokerEpisode(agent, controlScenario());
    expect(result.agentSummary.stoppedBecause).toBe("error");
    expect(result.agentSummary.finalMessage).toMatch(/ReferenceError.*fetch/);
    expect(result.agentSummary.finalMessage).toMatch(/no network/);
  });

  it("interrupts an endless loop, even one that catches the interruption", async () => {
    const g = await gateway();
    const started = Date.now();
    const agent = hostedRemote(
      g,
      {
        kind: "code",
        model: "deepseek/deepseek-v4.1-flash",
        language: "js",
        code: `export default async function run() { for (;;) { try { for (;;) {} } catch {} } }`,
      },
      { sandbox: { sliceMs: 50, cpuMs: 500 } },
    );
    const result = await runBrokerEpisode(agent, controlScenario());
    expect(result.agentSummary.stoppedBecause).toBe("error");
    expect(result.agentSummary.finalMessage).toMatch(/endless loop|computing time/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("caps its memory", async () => {
    const g = await gateway();
    const agent = hostedRemote(
      g,
      {
        kind: "code",
        model: "deepseek/deepseek-v4.1-flash",
        language: "js",
        code: `export default async function run() { const a = []; for (;;) a.push("x".repeat(1e6)); }`,
      },
      { sandbox: { memoryBytes: 16 * 1024 * 1024, cpuMs: 5_000, sliceMs: 2_000 } },
    );
    const result = await runBrokerEpisode(agent, controlScenario());
    expect(result.agentSummary.stoppedBecause).toBe("error");
    expect(result.agentSummary.finalMessage).toMatch(/memory|InternalError/i);
  });

  it("stops at the model-call cap, whatever the code catches", async () => {
    const g = await gateway();
    const turns = Array.from({ length: 10 }, () => () => say("again"));
    const model = scripted(...turns);
    const agent = hostedRemote(
      g,
      {
        kind: "code",
        model: "deepseek/deepseek-v4.1-flash",
        language: "js",
        code: `
import OpenAI from "openai";
const ai = new OpenAI();
export default async function run() {
  for (;;) { try { await ai.chat.completions.create({ messages: [{ role: "user", content: "hi" }] }); } catch {} }
}`,
      },
      { client: model.client, limits: { modelCalls: 3 } },
    );
    const result = await runBrokerEpisode(agent, controlScenario());
    expect(result.agentSummary.finalMessage).toMatch(/more than 3 model calls/);
    expect(model.requests).toHaveLength(3);
  });

  it("puts a refused model account down to Bonded, not the agent", async () => {
    const g = await gateway();
    const client: ChatClient = {
      complete: async () => {
        throw new LlmError(402, "out of credits");
      },
    };
    const agent = hostedRemote(
      g,
      {
        kind: "instructions",
        model: "deepseek/deepseek-v4.1-flash",
        instructions: "Run the account as the holder's plan says.",
      },
      { client },
    );
    const result = await runBrokerEpisode(agent, controlScenario());
    expect(result.agentSummary.finalMessage).toMatch(/not the agent's fault/);
    const remote = (result.agentSummary as { remote?: { bondedProblem?: string } }).remote;
    expect(remote?.bondedProblem).toMatch(/credits/);
  });
});

describe("a hosted preview", () => {
  it("runs its tests four at a time, each on its own gateway agent, and finishes them all", async () => {
    const g = await gateway();
    const spec = {
      kind: "code",
      model: "deepseek/deepseek-v4.1-flash",
      language: "js",
      code: DO_THE_JOB,
    } as const;
    const run = await runBrokeragePreview(() => hostedRemote(g, spec), { concurrency: 4 });
    expect(run.results).toHaveLength(run.scenarios.length);
    expect(run.results.filter(didNotFinish)).toEqual([]);
  }, 120_000);

  it("leaves nothing behind when a run is cut off mid-call: the next one runs", async () => {
    const g = await gateway();
    const never: ChatClient = { complete: () => new Promise(() => {}) };
    const stuck = new RemoteAgent({
      gateway: g,
      transport: {
        kind: "hosted",
        agent: hostedAgent(
          {
            kind: "code",
            model: "deepseek/deepseek-v4.1-flash",
            language: "js",
            code: `import OpenAI from "openai"; export default async () => { await new OpenAI().chat.completions.create({ messages: [] }); };`,
          },
          { client: never },
        ),
        registration: "preview:test",
      },
      mode: "tools",
      world: "brokerage",
      episodeTimeoutMs: 500,
    });
    expect((await runBrokerEpisode(stuck, controlScenario())).agentSummary.finalMessage).toMatch(
      /timed out/,
    );
    const next = await runBrokerEpisode(
      hostedRemote(g, {
        kind: "code",
        model: "deepseek/deepseek-v4.1-flash",
        language: "js",
        code: DO_THE_JOB,
      }),
      controlScenario(),
    );
    expect(next.missed).toEqual([]);
  });
});

describe("hostile code", () => {
  it("can't run up Bonded's bill: past the day's budget, every hosted test stops, as Bonded's limit", async () => {
    const g = await gateway();
    const budget = new HostedBudget(0.01);
    const turns = Array.from({ length: 10 }, () => (): ChatResponse => ({
      choices: [{ message: { role: "assistant", content: "again" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.006 },
    }));
    const model = scripted(...turns);
    const loop = `
import OpenAI from "openai";
const ai = new OpenAI();
export default async function run() {
  for (;;) { try { await ai.chat.completions.create({ messages: [{ role: "user", content: "hi" }] }); } catch {} }
}`;
    const spec = {
      kind: "code",
      model: "deepseek/deepseek-v4.1-flash",
      language: "js",
      code: loop,
    } as const;
    const first = await runBrokerEpisode(
      hostedRemote(g, spec, { client: model.client, budget }),
      controlScenario(),
    );
    // Two calls ($0.012) pass the $0.01 budget: the third is refused, and the run ends there.
    expect(model.requests).toHaveLength(2);
    expect(first.agentSummary.finalMessage).toMatch(
      /daily budget.*not the agent's fault|not the agent's fault.*daily budget/,
    );
    // Another agent, the same day: refused before any call.
    const second = await runBrokerEpisode(
      hostedRemote(g, spec, { client: model.client, budget }),
      controlScenario(),
    );
    expect(model.requests).toHaveLength(2);
    expect(second.agentSummary.finalMessage).toMatch(/not the agent's fault/);
    // A new day starts the budget over.
    expect(() => budget.check(Date.now() + 86_400_000)).not.toThrow();
  });

  it("runs on its own thread: a busy loop never holds this one, and the deadline ends it at once", async () => {
    const g = await gateway();
    // No slice or computing-time limit to save it: only the thread stops it.
    const agent = new RemoteAgent({
      gateway: g,
      transport: {
        kind: "hosted",
        agent: hostedAgent(
          {
            kind: "code",
            model: "deepseek/deepseek-v4.1-flash",
            language: "js",
            code: `export default async function run() { for (;;) {} }`,
          },
          { client: scripted().client, sandbox: { sliceMs: 60_000, cpuMs: 60_000 } },
        ),
        registration: "preview:test",
      },
      mode: "tools",
      world: "brokerage",
      episodeTimeoutMs: 1_500,
    });
    let worstLag = 0;
    let last = Date.now();
    const ticker = setInterval(() => {
      worstLag = Math.max(worstLag, Date.now() - last - 20);
      last = Date.now();
    }, 20);
    const started = Date.now();
    const result = await runBrokerEpisode(agent, controlScenario());
    clearInterval(ticker);
    expect(result.agentSummary.finalMessage).toMatch(/timed out/);
    expect(Date.now() - started).toBeLessThan(6_000);
    // This thread kept its timers while the loop spun.
    expect(worstLag).toBeLessThan(200);
  });

  it("can't hand oversized arguments out of the sandbox", async () => {
    const g = await gateway();
    const agent = hostedRemote(g, {
      kind: "code",
      model: "deepseek/deepseek-v4.1-flash",
      language: "js",
      code: `export default async ({ callTool }) => { try { await callTool("get_account", { x: "a".repeat(100000) }); } catch (e) { return e.message; } };`,
    });
    const result = await runBrokerEpisode(agent, controlScenario());
    expect(result.agentSummary.finalMessage).toMatch(/at most 64 KB/);
  });
});

describe("checking a code file before it is saved", () => {
  const check = (code: string, language: "js" | "ts" = "js") => inspectCodeAgent(code, language);

  it("passes a file with a default export function", async () => {
    expect(await check(DO_THE_JOB)).toEqual({ ok: true });
    expect(
      await check(`import OpenAI from "openai"; export default async () => new OpenAI() && "ok";`),
    ).toEqual({ ok: true });
  });

  it("says what's wrong, and where", async () => {
    expect(await check(`export default async function run( {`)).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/SyntaxError/),
    });
    expect(await check(`export const run = async () => "x";`)).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/no default export/),
    });
    expect(await check(`import _ from "lodash"; export default () => _;`)).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/only "openai" is available/),
    });
    expect(await check(`enum Side { Buy } export default () => Side.Buy;`, "ts")).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/enums and namespaces/),
    });
    expect(await check(`for (;;) {} export default () => 1;`)).toMatchObject({
      ok: false,
      problem: expect.stringMatching(/endless loop|computing time/),
    });
  });
});

describe("a hosted agent made of instructions", () => {
  it("runs the owner's instructions on their model and passes a connection check", async () => {
    const g = await gateway();
    const model = scripted(
      (req) => {
        expect(req.model).toBe("z-ai/glm-5.3-flash");
        // The owner's own words lead the system prompt; the mandate follows, as for any agent.
        expect(req.messages[0]).toMatchObject({ role: "system" });
        expect(String(req.messages[0]!.content)).toMatch(/^Always read the holder's plan first\./);
        expect(String(req.messages[0]!.content)).toMatch(/Your mandate:/);
        return call("get_instructions", {});
      },
      () => call("place_order", { symbol: "VOO", side: "buy", amountUsd: 2000 }, "a"),
      () => call("place_order", { symbol: "JPM", side: "buy", amountUsd: 3000 }, "b"),
      () => call("place_order", { symbol: "AAPL", side: "sell", quantity: 10 }, "c"),
      () => say("Done: VOO, JPM, AAPL."),
    );
    const events: string[] = [];
    const result = await runConnectionCheck({
      gateway: g,
      transport: {
        kind: "hosted",
        agent: hostedAgent(
          {
            kind: "instructions",
            model: "z-ai/glm-5.3-flash",
            instructions: "Always read the holder's plan first. Then place the trades it asks for.",
          },
          { client: model.client },
        ),
        registration: "preview:test",
      },
      mode: "tools",
      world: "brokerage",
      onEvent: (e) => void events.push(e.type),
    });
    expect(result.problems).toEqual([]);
    expect(result).toMatchObject({ passed: true, taskCompleted: true });
    expect(result.toolsCalled).toBe(4);
    expect(result.usage).toEqual({ inputTokens: 500, outputTokens: 100 });
    expect(events).toContain("tool");
  });

  it("fails a check that the agent can't finish, with the model's own words", async () => {
    const g = await gateway();
    const result = await runConnectionCheck({
      gateway: g,
      transport: {
        kind: "hosted",
        agent: hostedAgent(
          {
            kind: "instructions",
            model: "deepseek/deepseek-v4.1-flash",
            instructions: "Never trade anything. Just say hello.",
          },
          { client: scripted(() => say("Hello!")).client },
        ),
        registration: "preview:test",
      },
      mode: "tools",
      world: "brokerage",
    });
    expect(result.passed).toBe(false);
    expect(result.problems).toEqual([
      "Your agent never called a tool: its instructions should have it read the holder's plan and the account, then trade through its tools",
    ]);
  });
});
