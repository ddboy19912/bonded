import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicChatClient, claudeCost, type MessagesApi } from "../src/anthropic.js";
import {
  ANTHROPIC_BASE_URL,
  type ChatRequest,
  isClaudeModel,
  isOutOfCredits,
  LlmError,
  llmConfigForModel,
} from "../src/llm.js";

/** A stand-in for the SDK: records each request and answers with the next scripted message. */
function fake(replies: Partial<Anthropic.Message>[]) {
  const sent: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const messages: MessagesApi = {
    async create(params) {
      sent.push(structuredClone(params));
      const reply = replies.shift();
      if (!reply) throw new Error("no reply scripted");
      return {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: params.model,
        stop_reason: "end_turn",
        stop_sequence: null,
        content: [],
        usage: { input_tokens: 10, output_tokens: 5 },
        ...reply,
      } as Anthropic.Message;
    },
  };
  return { client: new AnthropicChatClient({ messages }), sent };
}

const tools: ChatRequest["tools"] = [
  {
    type: "function",
    function: {
      name: "pay_invoice",
      description: "Pay an invoice.",
      parameters: { type: "object", properties: { account: { type: "string" } } },
    },
  },
];

describe("Claude models", () => {
  it("go to Anthropic's API with ANTHROPIC_API_KEY, and fail early without it", () => {
    expect(isClaudeModel("claude-haiku-5-5")).toBe(true);
    expect(isClaudeModel("muse-spark-1.3")).toBe(false);
    expect(llmConfigForModel("claude-sonnet-5-5", { ANTHROPIC_API_KEY: "k" })).toEqual({
      baseUrl: ANTHROPIC_BASE_URL,
      apiKey: "k",
      provider: "anthropic",
    });
    expect(() => llmConfigForModel("claude-sonnet-5-5", { OPENROUTER_API_KEY: "o" })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });
});

describe("AnthropicChatClient", () => {
  it("translates an OpenAI-shaped request: system apart, images as blocks, results first", async () => {
    const { client, sent } = fake([{ content: [{ type: "text", text: "done", citations: null }] }]);
    await client.complete({
      model: "claude-haiku-5-5",
      max_tokens: 4096,
      temperature: 0.2,
      tools,
      messages: [
        { role: "system", content: "You pay invoices." },
        { role: "user", content: "Pay ACM-2291." },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "pay_invoice", arguments: '{"account":"GB33"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: '{"ok":true}' },
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
        },
      ],
    });
    const params = sent[0]!;
    expect(params.system).toBe("You pay invoices.");
    // Current Claude models reject sampling settings, so none is sent.
    expect(params).not.toHaveProperty("temperature");
    expect(params.tools).toEqual([
      {
        name: "pay_invoice",
        description: "Pay an invoice.",
        input_schema: { type: "object", properties: { account: { type: "string" } } },
      },
    ]);
    expect(params.cache_control).toEqual({ type: "ephemeral" });
    expect(params.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Pay ACM-2291." }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_1", name: "pay_invoice", input: { account: "GB33" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: '{"ok":true}' },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      },
    ]);
  });

  it("returns tool calls, and sends each turn's original blocks (its thinking) back unchanged", async () => {
    const turn: Anthropic.ContentBlock[] = [
      { type: "thinking", thinking: "", signature: "sig-1" },
      { type: "text", text: "Paying it.", citations: null },
      { type: "tool_use", id: "toolu_1", name: "pay_invoice", input: { account: "GB33" } },
    ] as Anthropic.ContentBlock[];
    const { client, sent } = fake([
      { content: turn, stop_reason: "tool_use" },
      { content: [{ type: "text", text: "Paid.", citations: null }] },
    ]);
    const first = await client.complete({
      model: "claude-sonnet-5-5",
      tools,
      messages: [{ role: "user", content: "Pay ACM-2291." }],
    });
    const choice = first.choices[0]!;
    expect(choice.finish_reason).toBe("tool_calls");
    expect(choice.message).toEqual({
      role: "assistant",
      content: "Paying it.",
      tool_calls: [
        {
          id: "toolu_1",
          type: "function",
          function: { name: "pay_invoice", arguments: '{"account":"GB33"}' },
        },
      ],
    });
    // The agent loop rebuilds the turn from its text and calls; the thinking comes back anyway.
    await client.complete({
      model: "claude-sonnet-5-5",
      tools,
      messages: [
        { role: "user", content: "Pay ACM-2291." },
        {
          role: "assistant",
          content: choice.message.content,
          tool_calls: choice.message.tool_calls,
        },
        { role: "tool", tool_call_id: "toolu_1", content: '{"ok":true}' },
      ],
    });
    expect(sent[1]!.messages[1]).toEqual({ role: "assistant", content: turn });
  });

  it("maps stop reasons to finish reasons", async () => {
    const { client } = fake([{ stop_reason: "max_tokens" }, { stop_reason: "refusal" }]);
    const request: ChatRequest = {
      model: "claude-haiku-5-5",
      messages: [{ role: "user", content: "hi" }],
    };
    expect((await client.complete(request)).choices[0]!.finish_reason).toBe("length");
    expect((await client.complete(request)).choices[0]!.finish_reason).toBe("content_filter");
  });

  it("prices each response from its tokens, cache writes and reads included", async () => {
    const usage = {
      input_tokens: 1_000,
      cache_creation_input_tokens: 2_000,
      cache_read_input_tokens: 3_000,
      output_tokens: 500,
    } as Anthropic.Usage;
    // Sonnet 5.5: 1,000 × $2 + 2,000 × $2.50 + 3,000 × $0.20 + 500 × $10, per million.
    expect(claudeCost("claude-sonnet-5-5", usage)).toBeCloseTo(0.0126, 10);
    // Haiku 5.5 bills prompts over 100K tokens at its higher rates.
    expect(
      claudeCost("claude-haiku-5-5", {
        input_tokens: 120_000,
        output_tokens: 1_000,
      } as Anthropic.Usage),
    ).toBeCloseTo((120_000 * 0.5 + 1_000 * 2.5) / 1_000_000, 10);
    expect(claudeCost("claude-unknown", usage)).toBeUndefined();
    const { client } = fake([{ usage }]);
    const response = await client.complete({
      model: "claude-sonnet-5-5",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.usage).toEqual({ prompt_tokens: 6_000, completion_tokens: 500, cost: 0.0126 });
  });

  it("reports an empty credit balance as out of credits, so a run stops", async () => {
    const messages: MessagesApi = {
      async create() {
        throw new Anthropic.BadRequestError(
          400,
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "Your credit balance is too low to access the Anthropic API.",
            },
          },
          undefined,
          new Headers(),
        );
      },
    };
    const client = new AnthropicChatClient({ messages });
    const failure = await client
      .complete({ model: "claude-haiku-5-5", messages: [{ role: "user", content: "hi" }] })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(LlmError);
    expect(isOutOfCredits(failure)).toBe(true);
  });
});
