import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatClient,
  ChatContentPart,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ToolCall,
} from "./llm.js";
import { LlmError } from "./llm.js";

/**
 * Claude through Anthropic's own SDK, behind the same `ChatClient` as every other model (see
 * ADR-006), so an agent runs on Claude without code changes. It translates the OpenAI-shaped chat
 * request into a Messages API request and the response back.
 *
 * Two things the OpenAI shape can't carry are handled here:
 * - Thinking. Current Claude models think before answering, and a turn's thinking blocks must go
 *   back unchanged when the conversation continues. The agent loop rebuilds each assistant turn
 *   from its text and tool calls, so this client keeps every turn's original content blocks,
 *   keyed by its tool-call ids, and sends those back in place of the rebuilt turn.
 * - Cost. Anthropic reports token counts, not dollars; the client prices them (CLAUDE_PRICES), so a
 *   spending cap stays exact instead of estimated.
 *
 * Each model runs as shipped: its default thinking and effort, no sampling settings (current
 * models reject them) and no fallback to another model, which would rate a different model.
 */

interface ClaudePrice {
  inputPerMillion: number;
  outputPerMillion: number;
  /** Reading a cached prompt prefix. */
  cacheReadPerMillion: number;
  /** Prompts longer than this many input tokens are billed at the `long` prices instead. */
  longAbove?: number;
  long?: { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion: number };
}

/**
 * Anthropic's list prices, US dollars per million tokens (claude-api reference, 6 Oct 2026). A
 * cache write costs 1.25× input. Claude Haiku 5.5's cache-read price isn't listed: it's taken as a
 * tenth of input, Anthropic's usual ratio.
 */
export const CLAUDE_PRICES: Record<string, ClaudePrice> = {
  "claude-sonnet-5-5": { inputPerMillion: 2, outputPerMillion: 10, cacheReadPerMillion: 0.2 },
  "claude-haiku-5-5": {
    inputPerMillion: 0.1,
    outputPerMillion: 0.5,
    cacheReadPerMillion: 0.01,
    longAbove: 100_000,
    long: { inputPerMillion: 0.5, outputPerMillion: 2.5, cacheReadPerMillion: 0.05 },
  },
  "claude-opus-5-5": { inputPerMillion: 4, outputPerMillion: 20, cacheReadPerMillion: 0.2 },
};

/** A response's cost in dollars from its token counts, or undefined for an unpriced model. */
export function claudeCost(model: string, usage: Anthropic.Usage): number | undefined {
  const price = CLAUDE_PRICES[model];
  if (!price) return undefined;
  const written = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const prompt = usage.input_tokens + written + read;
  const p = price.long && price.longAbove && prompt > price.longAbove ? price.long : price;
  return (
    (usage.input_tokens * p.inputPerMillion +
      written * p.inputPerMillion * 1.25 +
      read * p.cacheReadPerMillion +
      usage.output_tokens * p.outputPerMillion) /
    1_000_000
  );
}

const FINISH: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  tool_use: "tool_calls",
  max_tokens: "length",
  refusal: "content_filter",
};

/** An image part as a Messages API image block: a data URL becomes base64, any other URL a link. */
function imageBlock(url: string): Anthropic.ImageBlockParam {
  const data = url.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.*)$/);
  return data
    ? {
        type: "image",
        source: { type: "base64", media_type: data[1] as "image/png", data: data[2]! },
      }
    : { type: "image", source: { type: "url", url } };
}

function userBlocks(content: string | ChatContentPart[]): Anthropic.ContentBlockParam[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part) =>
    part.type === "text" ? { type: "text", text: part.text } : imageBlock(part.image_url.url),
  );
}

function parseArguments(args: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(args);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The narrow slice of the SDK the client calls, so tests can stand in for it. */
export interface MessagesApi {
  create(
    params: Anthropic.MessageCreateParamsNonStreaming,
    options?: { signal?: AbortSignal },
  ): Promise<Anthropic.Message>;
}

export interface AnthropicChatClientOptions {
  apiKey?: string;
  /** Retries for rate limits, server errors and dropped connections (default 4). */
  maxRetries?: number;
  /** Stands in for the SDK in tests. */
  messages?: MessagesApi;
}

/** How many assistant turns' original blocks are kept for replay (oldest dropped first). */
const KEPT_TURNS = 5_000;

export class AnthropicChatClient implements ChatClient {
  private readonly messages: MessagesApi;
  /** Each assistant turn's original content blocks, by the id of its first tool call. */
  private readonly turns = new Map<string, Anthropic.ContentBlockParam[]>();

  constructor(options: AnthropicChatClientOptions = {}) {
    this.messages =
      options.messages ??
      new Anthropic({ apiKey: options.apiKey, maxRetries: options.maxRetries ?? 4 }).messages;
  }

  /** The Messages API request for an OpenAI-shaped one. */
  toParams(request: ChatRequest): Anthropic.MessageCreateParamsNonStreaming {
    const system = request.messages
      .filter((m): m is Extract<ChatMessage, { role: "system" }> => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const messages: Anthropic.MessageParam[] = [];
    // Tool results and the user content after them join one user turn, results first.
    const push = (role: "user" | "assistant", blocks: Anthropic.ContentBlockParam[]) => {
      const last = messages[messages.length - 1];
      if (last && last.role === role && role === "user" && Array.isArray(last.content))
        last.content.push(...blocks);
      else messages.push({ role, content: blocks });
    };
    for (const m of request.messages) {
      if (m.role === "system") continue;
      if (m.role === "user") push("user", userBlocks(m.content));
      else if (m.role === "tool")
        push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }]);
      else {
        const kept = m.tool_calls?.[0] && this.turns.get(m.tool_calls[0].id);
        if (kept) {
          push("assistant", kept);
          continue;
        }
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const call of m.tool_calls ?? [])
          blocks.push({
            type: "tool_use",
            id: call.id,
            name: call.function.name,
            input: parseArguments(call.function.arguments),
          });
        if (blocks.length > 0) push("assistant", blocks);
      }
    }
    return {
      model: request.model,
      max_tokens: request.max_tokens ?? 16_000,
      ...(system ? { system } : {}),
      messages,
      ...(request.tools?.length
        ? {
            tools: request.tools.map((t) => ({
              name: t.function.name,
              description: t.function.description,
              input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
            })),
          }
        : {}),
      // Caches the longest stable prefix: each turn of an episode resends the turns before it.
      cache_control: { type: "ephemeral" },
    };
  }

  /** The OpenAI-shaped response for a Messages API one, keeping its blocks for replay. */
  toResponse(model: string, message: Anthropic.Message): ChatResponse {
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const calls: ToolCall[] = message.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input) },
      }));
    if (calls[0]) {
      this.turns.set(calls[0].id, message.content as Anthropic.ContentBlockParam[]);
      if (this.turns.size > KEPT_TURNS) this.turns.delete(this.turns.keys().next().value!);
    }
    const cost = claudeCost(model, message.usage);
    return {
      id: message.id,
      model: message.model,
      choices: [
        {
          message: {
            role: "assistant",
            content: text || null,
            ...(calls.length ? { tool_calls: calls } : {}),
          },
          finish_reason: FINISH[message.stop_reason ?? ""] ?? message.stop_reason,
        },
      ],
      usage: {
        prompt_tokens:
          message.usage.input_tokens +
          (message.usage.cache_creation_input_tokens ?? 0) +
          (message.usage.cache_read_input_tokens ?? 0),
        completion_tokens: message.usage.output_tokens,
        ...(cost !== undefined ? { cost } : {}),
      },
    };
  }

  async complete(
    request: ChatRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<ChatResponse> {
    try {
      const message = await this.messages.create(this.toParams(request), {
        signal: options.signal,
      });
      return this.toResponse(request.model, message);
    } catch (error) {
      if (error instanceof Anthropic.APIError && error.status !== undefined) {
        // An empty balance comes back as a 400; report it as out of credits (402) so a run
        // stops starting new work, as it does for other providers.
        const credits = /credit balance/i.test(error.message);
        throw new LlmError(
          credits ? 402 : error.status,
          `Anthropic (${credits ? 402 : error.status}): ${error.message}`,
        );
      }
      throw error;
    }
  }
}
