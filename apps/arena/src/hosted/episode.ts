import type {
  AnyEpisodeMessage,
  ChatClient,
  ChatMessage,
  ChatResponse,
  ToolDefinition,
} from "@bondedhq/shared";

/**
 * What a hosted agent (one Bonded runs itself, from its owner's instructions or code) can reach in
 * one episode: the episode's tools over the gateway's plain HTTP endpoints, exactly as an agent
 * on its own servers reaches them, and the model its owner picked, through Bonded's key with caps.
 * Nothing else: no other network, no files.
 */

/** Caps on what one hosted episode may spend. */
export interface HostedLimits {
  /** Model calls per episode. */
  modelCalls: number;
  /** The most output tokens one model call may ask for. */
  maxTokensPerCall: number;
  /** Input plus output tokens per episode. */
  tokens: number;
  /** Tool calls per episode (the episode's own step cap still applies on top). */
  toolCalls: number;
  /** The largest tool result handed back, in characters (the rest is cut, and says so). */
  toolResultChars: number;
}

export const HOSTED_LIMITS: HostedLimits = {
  modelCalls: 60,
  // As in Bonded's own agent loop: 4,096 cut answers off mid-tool-call under large prompts.
  maxTokensPerCall: 16_384,
  tokens: 600_000,
  toolCalls: 80,
  toolResultChars: 20_000,
};

/** A hosted agent ran into one of its caps: the episode ends, and this says which. */
export class HostedLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostedLimitError";
  }
}

export interface HostedUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

/** One listed tool, as the episode offers it. */
export interface HostedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A tool call's answer, exactly as the gateway's HTTP API gives it. */
export type HostedToolResult = { ok: true; output: unknown } | { ok: false; error: string };

/**
 * One episode's connection: its tools, the model (capped and metered), and how to say it's done.
 */
export class HostedEpisode {
  readonly usage: HostedUsage = { inputTokens: 0, outputTokens: 0 };
  private modelCalls = 0;
  private toolCalls = 0;
  private costReported = false;
  private finished = false;

  constructor(
    readonly message: AnyEpisodeMessage,
    private readonly options: {
      client: ChatClient;
      model: string;
      signal: AbortSignal;
      limits?: Partial<HostedLimits>;
      fetch?: typeof fetch;
    },
  ) {}

  get limits(): HostedLimits {
    return { ...HOSTED_LIMITS, ...this.options.limits };
  }

  get model(): string {
    return this.options.model;
  }

  get signal(): AbortSignal {
    return this.options.signal;
  }

  private get http(): typeof fetch {
    return this.options.fetch ?? fetch;
  }

  /** The episode's tools: name, description and JSON Schema of the arguments. */
  async tools(): Promise<HostedTool[]> {
    const res = await this.http(this.message.endpoints.tools, { signal: this.signal });
    if (!res.ok) throw new Error(`the episode's tools answered ${res.status}`);
    const body = (await res.json()) as { tools?: HostedTool[] };
    return (body.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  /** The tools as an OpenAI-style function list, for a model. */
  async toolDefinitions(): Promise<ToolDefinition[]> {
    return (await this.tools()).map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }

  /** Calls one tool. A refused call comes back as `{ ok: false, error }`, never thrown. */
  async callTool(name: string, args: unknown): Promise<HostedToolResult> {
    if (++this.toolCalls > this.limits.toolCalls)
      throw new HostedLimitError(
        `the agent made more than ${this.limits.toolCalls} tool calls in one episode`,
      );
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) return { ok: false, error: `no tool named ${name}` };
    const res = await this.http(`${this.message.endpoints.tools}/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args ?? {}),
      signal: this.signal,
    });
    const text = await res.text();
    try {
      return JSON.parse(text) as HostedToolResult;
    } catch {
      return { ok: false, error: `the tool answered ${res.status}` };
    }
  }

  /** A tool result as the text a model is shown, cut to size. */
  resultText(result: HostedToolResult): string {
    const text = JSON.stringify(result);
    const max = this.limits.toolResultChars;
    return text.length > max ? `${text.slice(0, max)}… (cut at ${max} characters)` : text;
  }

  /**
   * One model call on the owner's model, through Bonded's key. Counted against the episode's caps
   * before it is made, and its usage after.
   */
  async chat(request: {
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    temperature?: number;
    max_tokens?: number;
  }): Promise<ChatResponse> {
    const limits = this.limits;
    if (++this.modelCalls > limits.modelCalls)
      throw new HostedLimitError(
        `the agent made more than ${limits.modelCalls} model calls in one episode`,
      );
    if (this.usage.inputTokens + this.usage.outputTokens > limits.tokens)
      throw new HostedLimitError(
        `the agent used more than ${limits.tokens.toLocaleString("en-US")} model tokens in one episode`,
      );
    const response = await this.options.client.complete(
      {
        model: this.options.model,
        messages: request.messages,
        ...(request.tools?.length ? { tools: request.tools } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        max_tokens: Math.min(
          request.max_tokens ?? limits.maxTokensPerCall,
          limits.maxTokensPerCall,
        ),
      },
      { signal: this.signal },
    );
    this.usage.inputTokens += response.usage?.prompt_tokens ?? 0;
    this.usage.outputTokens += response.usage?.completion_tokens ?? 0;
    if (response.usage?.cost !== undefined) {
      this.usage.costUsd = (this.usage.costUsd ?? 0) + response.usage.cost;
      this.costReported = true;
    }
    return response;
  }

  /** Tells the gateway the agent is finished, with its last message and Bonded-measured usage. */
  async done(finalMessage: string | undefined): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const usage = this.costReported
      ? this.usage
      : { inputTokens: this.usage.inputTokens, outputTokens: this.usage.outputTokens };
    await this.http(this.message.endpoints.done, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(finalMessage !== undefined ? { finalMessage: finalMessage.slice(0, 4_000) } : {}),
        usage,
      }),
      signal: this.signal,
    }).catch(() => {});
  }
}
