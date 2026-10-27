/**
 * Provider-neutral access to language models. See ADR-006.
 *
 * Everything in Bonded that needs an LLM (demo agents, the attacker, the grey-area judge)
 * talks to it through `ChatClient`, using the OpenAI-compatible chat-completions format that
 * OpenRouter, OpenAI, DeepSeek, Gemini's compatible endpoint and local servers (Ollama, vLLM)
 * all speak. The model is a setting, never a code change. OpenRouter is the default endpoint
 * because one key reaches hundreds of models, including Claude.
 */

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** Meta Model API: Muse Spark, Muse Wonder and the other hosted Meta models. */
export const META_MODEL_API_BASE_URL = "https://api.meta.ai/v1";

/**
 * Whether a model id names a chat model served by Meta Model API (`muse-spark-1.3`,
 * `muse-wonder-1.0`, ...). SAM 3.1 isn't one: it segments images through the Responses API.
 */
export function isMetaModel(model: string): boolean {
  return /^muse-/.test(model);
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Part of a user message: text, or an image as a data URL (for models that can see images). */
export type ChatContentPart =
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ChatContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  max_tokens?: number;
  temperature?: number;
  /**
   * OpenRouter's reasoning control for models that think before answering. Hidden reasoning
   * counts against max_tokens, so short structured outputs can come back empty without
   * `{ enabled: false }`. Sent to OpenRouter only; other endpoints get the request without it.
   */
  reasoning?: { enabled?: boolean; effort?: "low" | "medium" | "high" };
}

export interface ChatResponse {
  id?: string;
  model?: string;
  choices: {
    message: { role: "assistant"; content: string | null; tool_calls?: ToolCall[] };
    /** "stop", "tool_calls", "length", "content_filter", ... (providers vary). */
    finish_reason: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

export interface ChatClient {
  complete(request: ChatRequest, options?: { signal?: AbortSignal }): Promise<ChatResponse>;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  /**
   * The endpoint is Meta Model API, which takes `reasoning_effort`. Set by `llmConfigForModel`,
   * so a META_MODEL_API_BASE_URL proxy keeps Meta's request format; inferred from the URL if unset.
   */
  provider?: "meta";
}

/**
 * Reads the endpoint and key from the environment:
 * - LLM_BASE_URL: any OpenAI-compatible endpoint (default: OpenRouter)
 * - LLM_API_KEY, or OPENROUTER_API_KEY
 */
export function llmConfigFromEnv(env: Record<string, string | undefined> = process.env): LlmConfig {
  const apiKey = env.LLM_API_KEY ?? env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("no LLM API key: set OPENROUTER_API_KEY (or LLM_API_KEY with LLM_BASE_URL)");
  }
  return { baseUrl: (env.LLM_BASE_URL ?? OPENROUTER_BASE_URL).replace(/\/+$/, ""), apiKey };
}

/**
 * The endpoint and key for one model. Meta's models go to Meta Model API with MODEL_API_KEY
 * (META_MODEL_API_BASE_URL overrides the URL); every other model uses `llmConfigFromEnv`.
 */
export function llmConfigForModel(
  model: string,
  env: Record<string, string | undefined> = process.env,
): LlmConfig {
  if (!isMetaModel(model)) return llmConfigFromEnv(env);
  const apiKey = env.MODEL_API_KEY;
  if (!apiKey) throw new Error(`no Meta Model API key for ${model}: set MODEL_API_KEY`);
  const baseUrl = env.META_MODEL_API_BASE_URL ?? META_MODEL_API_BASE_URL;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, provider: "meta" };
}

/**
 * A `ChatClient` that sends each request to its model's endpoint (`llmConfigForModel`), so an
 * agent on Muse Spark and an attacker on OpenRouter can share one client. Endpoints are resolved
 * on first use: a run that only calls Meta's models needs no OpenRouter key.
 */
export class RoutingChatClient implements ChatClient {
  private readonly clients = new Map<string, OpenAICompatibleClient>();

  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly options: OpenAICompatibleClientOptions = {},
  ) {}

  complete(request: ChatRequest, options?: { signal?: AbortSignal }): Promise<ChatResponse> {
    const config = llmConfigForModel(request.model, this.env);
    // Two routes can share a URL (a gateway) with different keys and request formats.
    const key = JSON.stringify([config.baseUrl, config.apiKey, config.provider ?? null]);
    let client = this.clients.get(key);
    if (!client) {
      client = new OpenAICompatibleClient(config, this.options);
      this.clients.set(key, client);
    }
    return client.complete(request, options);
  }
}

/**
 * The routing client for an agent on `model`, checking now that the model's key is set: a
 * missing key fails when the agent is built, before a rating starts its sandbox, rather than on
 * every episode's first request.
 */
export function chatClientForModel(
  model: string,
  env: Record<string, string | undefined> = process.env,
): ChatClient {
  llmConfigForModel(model, env);
  return new RoutingChatClient(env);
}

/** The default `ChatClient`: routes each model to its endpoint, configured from the environment. */
export function chatClientFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: OpenAICompatibleClientOptions = {},
): ChatClient {
  return new RoutingChatClient(env, options);
}

/** An HTTP error from the endpoint, with its status and (truncated) body. */
export class LlmError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

export interface OpenAICompatibleClientOptions {
  /** Retries for rate limits, server errors and dropped connections (default 2). */
  maxRetries?: number;
  /** Base delay between retries in ms, doubled each time (default 1000). */
  retryDelayMs?: number;
  fetch?: typeof fetch;
}

/** A `ChatClient` for any OpenAI-compatible chat-completions endpoint. */
export class OpenAICompatibleClient implements ChatClient {
  private readonly isOpenRouter: boolean;
  private readonly isMeta: boolean;
  private readonly fetch: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly config: LlmConfig,
    options: OpenAICompatibleClientOptions = {},
  ) {
    this.isOpenRouter = new URL(config.baseUrl).hostname.endsWith("openrouter.ai");
    this.isMeta =
      config.provider === "meta" ||
      new URL(config.baseUrl).hostname === new URL(META_MODEL_API_BASE_URL).hostname;
    this.fetch = options.fetch ?? fetch;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
  }

  /**
   * Sends one chat-completion request and returns the response. Retries rate limits, server
   * errors and dropped connections; throws `LlmError` for other HTTP errors.
   */
  async complete(
    request: ChatRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<ChatResponse> {
    // OpenRouter reports each request's cost when asked; other endpoints may reject the field.
    // Meta Model API takes reasoning as `reasoning_effort` and has no "off": "minimal" is lowest.
    const { reasoning, ...plain } = request;
    const metaEffort = reasoning?.enabled === false ? "minimal" : reasoning?.effort;
    const body = this.isOpenRouter
      ? { ...plain, ...(reasoning ? { reasoning } : {}), usage: { include: true } }
      : this.isMeta && metaEffort
        ? { ...plain, reasoning_effort: metaEffort }
        : plain;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetch(`${this.config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            "content-type": "application/json",
            ...(this.isOpenRouter ? { "x-title": "Bonded Arena" } : {}),
          },
          body: JSON.stringify(body),
          signal: options.signal,
        });
      } catch (error) {
        if (options.signal?.aborted || attempt >= this.maxRetries) throw error;
        await this.wait(attempt, options.signal);
        continue;
      }
      if (response.ok) {
        // The connection can still drop while the body streams in ("terminated"): retry that
        // like a dropped connection.
        try {
          return (await response.json()) as ChatResponse;
        } catch (error) {
          if (options.signal?.aborted || attempt >= this.maxRetries) throw error;
          await this.wait(attempt, options.signal);
          continue;
        }
      }
      const text = (await response.text()).slice(0, 500);
      if (!RETRYABLE.has(response.status) || attempt >= this.maxRetries) {
        throw new LlmError(response.status, `LLM request failed (${response.status}): ${text}`);
      }
      await this.wait(attempt, options.signal);
    }
  }

  /** Waits before a retry; rejects at once if the episode is (or becomes) aborted. */
  private wait(attempt: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(
        () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        this.retryDelayMs * 2 ** attempt,
      );
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
