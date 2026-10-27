import { describe, expect, it } from "vitest";
import {
  agentToolDefinitions,
  chatClientForModel,
  isMetaModel,
  LlmError,
  llmConfigForModel,
  llmConfigFromEnv,
  META_MODEL_API_BASE_URL,
  OPENROUTER_BASE_URL,
  OpenAICompatibleClient,
  RoutingChatClient,
} from "../src/index.js";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const reply = {
  choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
};

/** A fetch that replays responses and records each request. */
function fakeFetch(...responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("llmConfigFromEnv", () => {
  it("defaults to OpenRouter and accepts either key name", () => {
    expect(llmConfigFromEnv({ OPENROUTER_API_KEY: "or-key" })).toEqual({
      baseUrl: OPENROUTER_BASE_URL,
      apiKey: "or-key",
    });
    expect(
      llmConfigFromEnv({ LLM_API_KEY: "k", LLM_BASE_URL: "http://localhost:11434/v1/" }),
    ).toEqual({ baseUrl: "http://localhost:11434/v1", apiKey: "k" });
  });

  it("fails clearly without a key", () => {
    expect(() => llmConfigFromEnv({})).toThrow(/OPENROUTER_API_KEY/);
  });
});

describe("llmConfigForModel", () => {
  it("sends Meta's models to Meta Model API and the rest to the default endpoint", () => {
    const env = { MODEL_API_KEY: "meta-key", OPENROUTER_API_KEY: "or-key" };
    expect(isMetaModel("muse-spark-1.3")).toBe(true);
    // SAM segments images through the Responses API: not a chat model.
    expect(isMetaModel("sam-3.1")).toBe(false);
    expect(isMetaModel("deepseek/deepseek-v4.1-flash")).toBe(false);
    expect(llmConfigForModel("muse-spark-1.3", env)).toEqual({
      baseUrl: META_MODEL_API_BASE_URL,
      apiKey: "meta-key",
      provider: "meta",
    });
    expect(llmConfigForModel("deepseek/deepseek-v4.1-flash", env)).toEqual({
      baseUrl: OPENROUTER_BASE_URL,
      apiKey: "or-key",
    });
  });

  it("fails clearly without MODEL_API_KEY, and needs no OpenRouter key for Meta's models", () => {
    expect(() => llmConfigForModel("muse-spark-1.3", { OPENROUTER_API_KEY: "k" })).toThrow(
      /MODEL_API_KEY/,
    );
    expect(llmConfigForModel("muse-spark-1.3", { MODEL_API_KEY: "m" }).apiKey).toBe("m");
  });
});

describe("chatClientForModel", () => {
  it("fails at once when the model's key is missing", () => {
    expect(() => chatClientForModel("muse-spark-1.3", { OPENROUTER_API_KEY: "k" })).toThrow(
      /MODEL_API_KEY/,
    );
    expect(() => chatClientForModel("deepseek/x", { MODEL_API_KEY: "m" })).toThrow(
      /OPENROUTER_API_KEY/,
    );
    expect(chatClientForModel("muse-spark-1.3", { MODEL_API_KEY: "m" })).toBeInstanceOf(
      RoutingChatClient,
    );
  });
});

describe("RoutingChatClient", () => {
  it("routes each request to its model's endpoint with that endpoint's key", async () => {
    const { impl, calls } = fakeFetch(ok(reply), ok(reply));
    const client = new RoutingChatClient(
      { MODEL_API_KEY: "meta-key", OPENROUTER_API_KEY: "or-key" },
      { fetch: impl },
    );
    const messages = [{ role: "user" as const, content: "x" }];
    await client.complete({ model: "muse-spark-1.3", messages });
    await client.complete({ model: "deepseek/deepseek-v4.1-flash", messages });
    expect(calls.map((c) => c.url)).toEqual([
      `${META_MODEL_API_BASE_URL}/chat/completions`,
      `${OPENROUTER_BASE_URL}/chat/completions`,
    ]);
    const auth = calls.map((c) => (c.init.headers as Record<string, string>).authorization);
    expect(auth).toEqual(["Bearer meta-key", "Bearer or-key"]);
  });
});

describe("RoutingChatClient on a shared gateway", () => {
  it("keeps each route's key and Meta's request format when both point at one URL", async () => {
    const gateway = "https://gateway.example/v1";
    const { impl, calls } = fakeFetch(ok(reply), ok(reply));
    const client = new RoutingChatClient(
      {
        MODEL_API_KEY: "meta-key",
        META_MODEL_API_BASE_URL: gateway,
        LLM_API_KEY: "other-key",
        LLM_BASE_URL: gateway,
      },
      { fetch: impl },
    );
    const request = {
      messages: [{ role: "user" as const, content: "x" }],
      reasoning: { enabled: false },
    };
    await client.complete({ model: "muse-spark-1.3", ...request });
    await client.complete({ model: "deepseek/deepseek-v4.1-flash", ...request });
    const auth = calls.map((c) => (c.init.headers as Record<string, string>).authorization);
    expect(auth).toEqual(["Bearer meta-key", "Bearer other-key"]);
    const bodies = calls.map((c) => JSON.parse(String(c.init.body)));
    expect(bodies[0].reasoning_effort).toBe("minimal");
    expect(bodies[1]).not.toHaveProperty("reasoning_effort");
  });
});

describe("OpenAICompatibleClient", () => {
  it("posts a chat completion with auth, and asks OpenRouter for the cost", async () => {
    const { impl, calls } = fakeFetch(ok(reply));
    const client = new OpenAICompatibleClient(
      { baseUrl: OPENROUTER_BASE_URL, apiKey: "k" },
      { fetch: impl },
    );
    const response = await client.complete({
      model: "m",
      messages: [{ role: "user", content: "x" }],
    });
    expect(response.choices[0]?.message.content).toBe("hi");
    expect(calls[0]?.url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer k");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      model: "m",
      usage: { include: true },
    });
  });

  it("sends a plain request to other endpoints", async () => {
    const { impl, calls } = fakeFetch(ok(reply));
    const client = new OpenAICompatibleClient(
      { baseUrl: "http://localhost:8000/v1", apiKey: "k" },
      { fetch: impl },
    );
    await client.complete({ model: "m", messages: [] });
    expect(JSON.parse(String(calls[0]?.init.body))).not.toHaveProperty("usage");
  });

  it("passes a reasoning setting to OpenRouter and leaves it out for other endpoints", async () => {
    const request = {
      model: "m",
      messages: [{ role: "user" as const, content: "hi" }],
      reasoning: { enabled: false },
    };
    const openRouter = fakeFetch(ok(reply));
    await new OpenAICompatibleClient(
      { baseUrl: OPENROUTER_BASE_URL, apiKey: "k" },
      { fetch: openRouter.impl },
    ).complete(request);
    expect(JSON.parse(String(openRouter.calls[0]!.init.body)).reasoning).toEqual({
      enabled: false,
    });

    const local = fakeFetch(ok(reply));
    await new OpenAICompatibleClient(
      { baseUrl: "http://localhost:11434/v1", apiKey: "k" },
      { fetch: local.impl },
    ).complete(request);
    expect(JSON.parse(String(local.calls[0]!.init.body))).not.toHaveProperty("reasoning");
  });

  it("sends Meta Model API its reasoning_effort, with minimal for reasoning off", async () => {
    const send = async (reasoning?: { enabled?: boolean; effort?: "low" }) => {
      const meta = fakeFetch(ok(reply));
      await new OpenAICompatibleClient(
        { baseUrl: META_MODEL_API_BASE_URL, apiKey: "k" },
        { fetch: meta.impl },
      ).complete({
        model: "muse-spark-1.3",
        messages: [{ role: "user", content: "hi" }],
        reasoning,
      });
      return JSON.parse(String(meta.calls[0]!.init.body));
    };
    const off = await send({ enabled: false });
    expect(off.reasoning_effort).toBe("minimal");
    expect(off).not.toHaveProperty("reasoning");
    expect((await send({ effort: "low" })).reasoning_effort).toBe("low");
    expect(await send()).not.toHaveProperty("reasoning_effort");
  });

  it("retries rate limits, server errors and dropped connections", async () => {
    const { impl, calls } = fakeFetch(
      new Response("slow down", { status: 429 }),
      new Error("socket hang up"),
      ok(reply),
    );
    const client = new OpenAICompatibleClient(
      { baseUrl: OPENROUTER_BASE_URL, apiKey: "k" },
      { fetch: impl, retryDelayMs: 1 },
    );
    await expect(client.complete({ model: "m", messages: [] })).resolves.toMatchObject(reply);
    expect(calls).toHaveLength(3);
  });

  it("retries a response whose body is cut off mid-stream", async () => {
    const cut = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"choices":['));
          controller.error(new TypeError("terminated"));
        },
      }),
      { status: 200 },
    );
    const { impl, calls } = fakeFetch(cut, ok(reply));
    const client = new OpenAICompatibleClient(
      { baseUrl: OPENROUTER_BASE_URL, apiKey: "k" },
      { fetch: impl, retryDelayMs: 1 },
    );
    await expect(client.complete({ model: "m", messages: [] })).resolves.toMatchObject(reply);
    expect(calls).toHaveLength(2);
  });

  it("does not retry client errors, and reports the status and body", async () => {
    const { impl, calls } = fakeFetch(new Response("unknown model", { status: 400 }));
    const client = new OpenAICompatibleClient(
      { baseUrl: OPENROUTER_BASE_URL, apiKey: "k" },
      { fetch: impl, retryDelayMs: 1 },
    );
    const error = await client.complete({ model: "nope", messages: [] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ status: 400, message: expect.stringContaining("unknown model") });
    expect(calls).toHaveLength(1);
  });

  it("stops retrying as soon as the episode is aborted", async () => {
    const controller = new AbortController();
    const { impl, calls } = fakeFetch(new Response("", { status: 503 }), ok(reply));
    const client = new OpenAICompatibleClient(
      { baseUrl: OPENROUTER_BASE_URL, apiKey: "k" },
      { fetch: impl, retryDelayMs: 60_000 },
    );
    const started = Date.now();
    const request = client.complete({ model: "m", messages: [] }, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("episode over")), 20);
    await expect(request).rejects.toThrow("episode over");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(calls).toHaveLength(1);
  });

  it("does not wait to retry when already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already over"));
    const { impl } = fakeFetch(new Response("", { status: 503 }));
    const client = new OpenAICompatibleClient(
      { baseUrl: OPENROUTER_BASE_URL, apiKey: "k" },
      { fetch: impl, retryDelayMs: 60_000 },
    );
    await expect(
      client.complete({ model: "m", messages: [] }, { signal: controller.signal }),
    ).rejects.toThrow("already over");
  });

  it("gives up after the retry budget", async () => {
    const { impl, calls } = fakeFetch(
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
    );
    const client = new OpenAICompatibleClient(
      { baseUrl: OPENROUTER_BASE_URL, apiKey: "k" },
      { fetch: impl, retryDelayMs: 1, maxRetries: 2 },
    );
    await expect(client.complete({ model: "m", messages: [] })).rejects.toMatchObject({
      status: 503,
    });
    expect(calls).toHaveLength(3);
  });
});

describe("agentToolDefinitions", () => {
  it("describes every agent tool as a function with a JSON schema", () => {
    const defs = agentToolDefinitions();
    expect(defs.map((d) => d.function.name)).toContain("transfer");
    for (const def of defs) {
      expect(def.type).toBe("function");
      expect(def.function.parameters).toMatchObject({ type: "object" });
    }
  });
});
