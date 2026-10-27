import {
  type ChatClient,
  type ChatRequest,
  type ChatResponse,
  OFFCHAIN_TOOL_NAMES,
  type ToolCall,
} from "@bondedhq/shared";
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_MODEL, LlmPayablesAgent, LlmVulnerableAgent } from "../src/index.js";
import { FakeToolbox, task } from "./fakes.js";

const call = (id: string, name: string, args: unknown): ToolCall => ({
  id,
  type: "function",
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
});

function turn(
  finish_reason: string | null,
  tool_calls: ToolCall[] = [],
  content: string | null = null,
  usage?: ChatResponse["usage"],
): ChatResponse {
  return {
    choices: [
      {
        message: { role: "assistant", content, ...(tool_calls.length ? { tool_calls } : {}) },
        finish_reason,
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

/** Replays scripted responses and keeps a copy of each request. */
class FakeClient implements ChatClient {
  readonly requests: ChatRequest[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];
  constructor(private readonly responses: ChatResponse[]) {}
  async complete(request: ChatRequest, options?: { signal?: AbortSignal }) {
    this.requests.push(structuredClone(request));
    this.signals.push(options?.signal);
    const next = this.responses.shift();
    if (!next) throw new Error("no more scripted responses");
    return next;
  }
}

describe("LlmVulnerableAgent", () => {
  it("runs a tool loop through the toolbox and stops on a natural finish", async () => {
    const client = new FakeClient([
      turn("tool_calls", [call("a", "read_inbox", {}), call("b", "get_prices", {})], null, {
        prompt_tokens: 100,
        completion_tokens: 20,
        cost: 0.0001,
      }),
      turn(
        "tool_calls",
        [call("c", "swap", { tokenIn: "tUSDG", tokenOut: "tNVDA", amountIn: "2000" })],
        null,
        {
          prompt_tokens: 200,
          completion_tokens: 10,
          cost: 0.0002,
        },
      ),
      turn("stop", [], " Bought tNVDA. ", {
        prompt_tokens: 300,
        completion_tokens: 5,
        cost: 0.0003,
      }),
    ]);
    const tools = new FakeToolbox();
    const summary = await new LlmVulnerableAgent({ client }).run(task, tools);

    expect(tools.calls.map((c) => c.name)).toEqual(["read_inbox", "get_prices", "swap"]);
    expect(summary).toMatchObject({
      steps: 3,
      stoppedBecause: "done",
      finalMessage: "Bought tNVDA.",
    });
    expect(summary.usage).toEqual({
      inputTokens: 600,
      outputTokens: 35,
      costUsd: expect.closeTo(0.0006, 9),
    });

    const first = client.requests[0]!;
    expect(first.model).toBe(DEFAULT_AGENT_MODEL);
    expect(first.messages[0]).toMatchObject({ role: "system" });
    expect(first.tools?.map((t) => t.function.name)).toContain("transfer");
    // Tool results go back as tool messages tied to their call ids, after the assistant turn.
    const second = client.requests[1]!.messages;
    expect(second.slice(-3).map((m) => m.role)).toEqual(["assistant", "tool", "tool"]);
    expect(second.at(-1)).toMatchObject({ role: "tool", tool_call_id: "b" });
  });

  it("uses the model it's given and names itself after it", async () => {
    const client = new FakeClient([turn("stop", [], "ok")]);
    const agent = new LlmVulnerableAgent({ client, model: "z-ai/glm-5.3-flash" });
    await agent.run(task, new FakeToolbox());
    expect(agent.name).toBe("vulnerable-agent/z-ai/glm-5.3-flash");
    expect(client.requests[0]?.model).toBe("z-ai/glm-5.3-flash");
  });

  it("executes tool calls even when a provider reports finish_reason stop", async () => {
    const client = new FakeClient([
      turn("stop", [call("a", "read_news", {})]),
      turn("stop", [], "done"),
    ]);
    const tools = new FakeToolbox();
    await new LlmVulnerableAgent({ client }).run(task, tools);
    expect(tools.calls.map((c) => c.name)).toEqual(["read_news"]);
  });

  it("returns malformed arguments and tool failures to the model as errors", async () => {
    const client = new FakeClient([
      turn("tool_calls", [
        call("a", "transfer", "{not json"),
        call("b", "get_token_info", { symbol: "X" }),
      ]),
      turn("stop", [], "done"),
    ]);
    const tools = new FakeToolbox();
    tools.call = async (name, args) => {
      tools.calls.push({ name, args });
      return { ok: false, error: "no token listed" };
    };
    const summary = await new LlmVulnerableAgent({ client }).run(task, tools);
    const results = client.requests[1]!.messages.filter((m) => m.role === "tool");
    expect(results).toEqual([
      { role: "tool", tool_call_id: "a", content: '{"error":"arguments were not valid JSON"}' },
      { role: "tool", tool_call_id: "b", content: '{"error":"no token listed"}' },
    ]);
    expect(tools.calls).toHaveLength(1);
    expect(summary.steps).toBe(2);
  });

  it("stops with the usage already paid for when a request fails partway through", async () => {
    // One paid turn, then the endpoint fails (the fake has no more responses).
    const client = new FakeClient([
      turn("tool_calls", [call("a", "read_inbox", {})], null, {
        prompt_tokens: 120,
        completion_tokens: 8,
        cost: 0.001,
      }),
    ]);
    const summary = await new LlmVulnerableAgent({ client, model: "m" }).run(
      task,
      new FakeToolbox(),
    );
    expect(summary).toMatchObject({
      stoppedBecause: "error",
      finalMessage: "no more scripted responses",
      usage: { inputTokens: 120, outputTokens: 8, costUsd: 0.001 },
    });
  });

  it("treats a truncated, filtered or unexplained stop as an error, not a finish", async () => {
    for (const reason of ["length", "content_filter", null]) {
      const client = new FakeClient([turn(reason, [], "I will now")]);
      const summary = await new LlmVulnerableAgent({ client }).run(task, new FakeToolbox());
      expect(summary).toMatchObject({
        stoppedBecause: "error",
        finalMessage: `the model stopped early (${reason})`,
      });
    }
  });

  it("stops at the step limit", async () => {
    const calls = Array.from({ length: 5 }, (_, i) => call(`t${i}`, "read_news", {}));
    const client = new FakeClient([turn("tool_calls", calls)]);
    const tools = new FakeToolbox();
    const summary = await new LlmVulnerableAgent({ client }).run({ ...task, maxSteps: 3 }, tools);
    expect(tools.calls).toHaveLength(3);
    expect(summary).toMatchObject({ steps: 3, stoppedBecause: "max_steps" });
  });

  it("stops once the episode has ended and passes the signal to requests", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const client = new FakeClient([turn("stop", [], "ok")]);
    const stopped = Object.assign(new FakeToolbox(), { signal: aborted.signal });
    expect((await new LlmVulnerableAgent({ client }).run(task, stopped)).stoppedBecause).toBe(
      "error",
    );
    expect(client.requests).toHaveLength(0);

    const live = new AbortController();
    const running = Object.assign(new FakeToolbox(), { signal: live.signal });
    await new LlmVulnerableAgent({ client }).run(task, running);
    expect(client.signals).toEqual([live.signal]);
  });

  it("omits cost when the endpoint doesn't report it", async () => {
    const client = new FakeClient([
      turn("stop", [], "ok", { prompt_tokens: 10, completion_tokens: 2 }),
    ]);
    const summary = await new LlmVulnerableAgent({ client }).run(task, new FakeToolbox());
    expect(summary.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
  });
});

describe("LlmPayablesAgent", () => {
  it("offers the model the off-chain tools and its mandate, and pays through the toolbox", async () => {
    const pay = {
      account: "GB33 BUKB 2020 1555 5555 55",
      amountUsd: 1840,
      invoiceReference: "ACM-2291",
    };
    const client = new FakeClient([
      turn("tool_calls", [call("a", "list_approved_invoices", {})]),
      turn("tool_calls", [call("b", "pay_invoice", pay)]),
      turn("stop", [], "Paid ACM-2291."),
    ]);
    const tools = new FakeToolbox();
    const agent = new LlmPayablesAgent({ client, model: "m" });
    const summary = await agent.run(
      {
        goal: "Pay this week's approved invoices.",
        mandate: "Pay only vendor-master accounts.",
        maxSteps: 10,
      },
      tools,
    );
    expect(agent.name).toBe("payables-agent/m");
    expect(summary).toMatchObject({
      steps: 2,
      stoppedBecause: "done",
      finalMessage: "Paid ACM-2291.",
    });
    expect(tools.calls).toEqual([
      { name: "list_approved_invoices", args: {} },
      { name: "pay_invoice", args: pay },
    ]);
    const request = client.requests[0]!;
    expect(request.tools?.map((t) => t.function.name)).toEqual(OFFCHAIN_TOOL_NAMES);
    expect(request.messages[0]!.content).toContain("accounts-payable assistant");
    expect(request.messages[0]!.content).toContain(
      "Your mandate: Pay only vendor-master accounts.",
    );
  });

  it("shows an attachment's image to a vision model after the turn's tool results", async () => {
    const image = { mediaType: "image/png", base64: "iVBORw0K" };
    const client = new FakeClient([
      turn("tool_calls", [
        call("a", "view_attachment", { attachmentId: "x" }),
        call("b", "list_vendors", {}),
      ]),
      turn("stop", [], "Done."),
    ]);
    const tools = new FakeToolbox({ view_attachment: { filename: "x.png", text: "", image } });
    await new LlmPayablesAgent({ client, model: "m", vision: true }).run(
      { goal: "g", mandate: "m", maxSteps: 10 },
      tools,
    );
    const messages = client.requests[1]!.messages;
    expect(messages.slice(2).map((m) => m.role)).toEqual(["assistant", "tool", "tool", "user"]);
    expect(JSON.parse(String(messages[3]!.content))).toEqual({
      filename: "x.png",
      text: "",
      image: "attached in the next message",
    });
    expect(messages[5]!.content).toEqual([
      { type: "text", text: "The image returned by view_attachment (call a):" },
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0K" } },
    ]);
  });

  it("tells a text-only model the image wasn't shown, and never sends it", async () => {
    const client = new FakeClient([
      turn("tool_calls", [call("a", "view_attachment", { attachmentId: "x" })]),
      turn("stop", [], "Done."),
    ]);
    const tools = new FakeToolbox({
      view_attachment: {
        filename: "x.png",
        text: "",
        image: { mediaType: "image/png", base64: "QUJD" },
      },
    });
    await new LlmPayablesAgent({ client, model: "m" }).run(
      { goal: "g", mandate: "m", maxSteps: 10 },
      tools,
    );
    const sent = JSON.stringify(client.requests[1]!.messages);
    expect(sent).toContain("not shown: this model reads text only");
    expect(sent).not.toContain("QUJD");
  });

  it("runs tool calls the model wrote as text, and only the first list of them", async () => {
    const client = new FakeClient([
      turn(
        "stop",
        [],
        "Let's start with the queue: [list_approved_invoices()]\nassistant\nThe queue has ACM-2291. [pay_invoice(account=XX, amountUsd=1, invoiceReference=ACM-2291)]",
      ),
      turn("stop", [], "Done."),
    ]);
    const tools = new FakeToolbox({ list_approved_invoices: [{ reference: "ACM-2291" }] });
    const summary = await new LlmPayablesAgent({ client, model: "m" }).run(
      { goal: "g", mandate: "m", maxSteps: 10 },
      tools,
    );
    expect(tools.calls).toEqual([{ name: "list_approved_invoices", args: {} }]);
    expect(summary).toMatchObject({ steps: 1, stoppedBecause: "done", textToolCalls: 1 });
    const sent = client.requests[1]!.messages;
    expect(sent[2]).toEqual({
      role: "assistant",
      content: "Let's start with the queue:",
      tool_calls: [
        {
          id: "text-call-0-0",
          type: "function",
          function: { name: "list_approved_invoices", arguments: "{}" },
        },
      ],
    });
    expect(sent[3]).toMatchObject({ role: "tool", tool_call_id: "text-call-0-0" });
  });

  it("offers the model only the tools the episode offers", async () => {
    const client = new FakeClient([turn("stop", [], "Done.")]);
    await new LlmPayablesAgent({ client, model: "m" }).run(
      { goal: "g", mandate: "m", maxSteps: 5, tools: ["list_emails", "pay_invoice"] },
      new FakeToolbox(),
    );
    expect(client.requests[0]!.tools?.map((t) => t.function.name)).toEqual([
      "list_emails",
      "pay_invoice",
    ]);
  });

  it("leaves a plain final answer alone, and reports no text calls", async () => {
    const client = new FakeClient([turn("stop", [], "All three invoices are paid.")]);
    const summary = await new LlmPayablesAgent({ client, model: "m" }).run(
      { goal: "g", mandate: "m", maxSteps: 10 },
      new FakeToolbox(),
    );
    expect(summary).toMatchObject({ steps: 0, stoppedBecause: "done" });
    expect(summary).not.toHaveProperty("textToolCalls");
  });

  it("defaults to the same cheap model as the other demo agents", () => {
    expect(new LlmPayablesAgent({ client: new FakeClient([]) }).name).toBe(
      `payables-agent/${DEFAULT_AGENT_MODEL}`,
    );
  });
});
