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
  // A real test takes 15 to 30 model calls and 40,000 to 65,000 tokens: about double that.
  modelCalls: 40,
  // As in Bonded's own agent loop: 4,096 cut answers off mid-tool-call under large prompts.
  maxTokensPerCall: 16_384,
  tokens: 150_000,
  toolCalls: 80,
  toolResultChars: 20_000,
};

/**
 * What every hosted agent in this process may spend on Bonded's model key in a day (UTC), in
 * dollars: HOSTED_DAILY_USD, $10 by default. Per-test caps bound one agent; this bounds all of
 * them together, so many wallets can't run up the bill. Past it, hosted tests stop with a
 * sentence that says it's Bonded's limit, not the agent's failure.
 */
export class HostedBudget {
  private day = "";
  private spent = 0;
  /** What calls in flight may still cost, counted before they're made (see `reserve`). */
  private reserved = 0;
  constructor(readonly dailyUsd: number) {}
  private roll(now: number) {
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.spent = 0;
    }
  }
  /** Throws when the day's spending, with what calls in flight may still cost, has reached it. */
  check(now = Date.now()): void {
    this.roll(now);
    if (this.spent + this.reserved >= this.dailyUsd)
      throw new HostedBudgetError(
        "Bonded's daily budget for running agents is used up; run it again tomorrow",
      );
  }
  /**
   * Admits one call that may cost up to `usd`, counting it at once, so calls made at the same
   * time (several tests, or one file's parallel calls) can't all pass the check before any cost
   * is known. Settle it with `settle` when the call ends.
   */
  reserve(usd: number, now = Date.now()): void {
    this.check(now);
    this.reserved += usd;
  }
  /** A reserved call ended: its reservation goes, and what it cost is spent. */
  settle(reservedUsd: number, spentUsd: number, now = Date.now()): void {
    this.roll(now);
    this.reserved = Math.max(0, this.reserved - reservedUsd);
    this.spent += spentUsd;
  }
  /** Spending with no reservation (a cost found out after the fact). */
  record(usd: number, now = Date.now()): void {
    this.settle(0, usd, now);
  }
  get spentToday(): number {
    return this.spent;
  }
}

/** Bonded's own spending limit stopped a hosted test: not the agent's failure. */
export class HostedBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostedBudgetError";
  }
}

const daily = Number(process.env.HOSTED_DAILY_USD ?? 10);
/** The process-wide budget hosted agents share (HOSTED_DAILY_USD). */
export const HOSTED_BUDGET = new HostedBudget(Number.isFinite(daily) && daily >= 0 ? daily : 10);

/**
 * What a model call costs when the provider doesn't say: a high per-token price for the listed
 * models ($0.5 a million input tokens, $2 a million output), so the budget errs toward stopping.
 */
const costOf = (input: number, output: number) => (input * 0.5 + output * 2) / 1_000_000;

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
  /** Tokens calls still in flight may use (their request and the most they may answer). */
  private reservedTokens = 0;
  private finished = false;

  constructor(
    readonly message: AnyEpisodeMessage,
    private readonly options: {
      client: ChatClient;
      model: string;
      signal: AbortSignal;
      limits?: Partial<HostedLimits>;
      fetch?: typeof fetch;
      /** The shared daily budget (default HOSTED_BUDGET). */
      budget?: HostedBudget;
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
    const budget = this.options.budget ?? HOSTED_BUDGET;
    // The token cap holds before a call is made, counting calls still in flight: the request's
    // own size (about 4 characters a token) and the most it may answer.
    const tooMany = () =>
      new HostedLimitError(
        `the agent used more than ${limits.tokens.toLocaleString("en-US")} model tokens in one episode`,
      );
    const left =
      limits.tokens - this.usage.inputTokens - this.usage.outputTokens - this.reservedTokens;
    const inputEstimate = Math.ceil(
      JSON.stringify({ messages: request.messages, tools: request.tools ?? [] }).length / 4,
    );
    if (inputEstimate >= left) throw tooMany();
    const maxTokens = Math.min(
      request.max_tokens ?? limits.maxTokensPerCall,
      limits.maxTokensPerCall,
      left - inputEstimate,
    );
    const costEstimate = costOf(inputEstimate, maxTokens);
    budget.reserve(costEstimate);
    this.reservedTokens += inputEstimate + maxTokens;
    let response: ChatResponse;
    try {
      response = await this.options.client.complete(
        {
          model: this.options.model,
          messages: request.messages,
          ...(request.tools?.length ? { tools: request.tools } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          max_tokens: maxTokens,
        },
        { signal: this.signal },
      );
    } catch (error) {
      // Sent but never answered (cancelled, timed out): what it may have cost is counted.
      budget.settle(costEstimate, costEstimate);
      throw error;
    } finally {
      this.reservedTokens -= inputEstimate + maxTokens;
    }
    const input = response.usage?.prompt_tokens ?? 0;
    const output = response.usage?.completion_tokens ?? 0;
    this.usage.inputTokens += input;
    this.usage.outputTokens += output;
    budget.settle(costEstimate, response.usage?.cost ?? costOf(input, output));
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
