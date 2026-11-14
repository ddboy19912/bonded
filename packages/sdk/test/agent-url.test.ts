import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_URL_KEYS_PATH,
  BONDED_AGENT_KEYS,
  BONDED_AGENT_KEYS_URL,
  type BondedHandlerOptions,
  createBondedHandler,
  createTestSigner,
  toNodeHandler,
} from "../src/agent-url.js";
import type { BondedEpisode } from "../src/index.js";
import { AgentUrlKeySet, checkAgentUrlVerifyAnswer } from "@bondedhq/shared/agent-url";

/** A verify challenge as the gateway sends it (16 to 128 characters). */
const CHALLENGE = "challenge-0123456789abcdef";
const errorOf = async (r: Response) => ((await r.json()) as { error: string }).error;
const OWNER = "0x00000000000000000000000000000000000a11ce";
const MALLORY = "0x000000000000000000000000000000000000bad0";
const bonded = await createTestSigner();
const KEYS = bonded.keys;
const NOW = 1_800_000_000_000; // ms
const now = () => NOW;
const seconds = Math.floor(NOW / 1000);

const episodeMessage = (id = "ep-1", deadlineMs = 60_000) => ({
  type: "episode",
  episodeId: id,
  task: { goal: "Buy 300 tUSDG worth of tNVDA.", mandate: "You manage a vault.", maxSteps: 12 },
  mode: "tools",
  endpoints: {
    mcp: "https://gw.example/e/tok/mcp",
    tools: "https://gw.example/e/tok/tools",
    openapi: "https://gw.example/e/tok/openapi.json",
    done: "https://gw.example/e/tok/done",
  },
  chainId: 46630,
  vault: "0x00000000000000000000000000000000000000aa",
  contracts: {
    exchange: "0x4444444444444444444444444444444444444444",
    tokens: [
      { symbol: "tUSDG", address: "0x1111111111111111111111111111111111111111", decimals: 6 },
    ],
  },
  deadlineMs,
});

/** A signed request, as Bonded sends it (for OWNER unless told otherwise). */
async function signed(
  message: unknown,
  options: {
    owner?: string;
    signer?: typeof bonded;
    timestamp?: number;
    headers?: Record<string, string>;
  } = {},
) {
  const body = JSON.stringify(message);
  const headers = await (options.signer ?? bonded).sign(
    options.owner ?? OWNER,
    body,
    options.timestamp ?? seconds,
  );
  return new Request("https://agent.example/bonded", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers, ...options.headers },
    body,
  });
}

/** A handler whose /done posts are recorded, and whose background work tests can await. */
function setup(overrides: Partial<BondedHandlerOptions> = {}) {
  const done: { url: string; body: unknown }[] = [];
  const work: Promise<unknown>[] = [];
  const handler = createBondedHandler({
    owner: OWNER,
    keys: KEYS,
    now,
    fetch: (async (url: string, init: RequestInit) => {
      done.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
    waitUntil: (p) => work.push(p),
    onEpisode: async () => ({ finalMessage: "ok" }),
    onError: () => {},
    ...overrides,
  });
  return { handler, done, settled: () => Promise.all(work) };
}

describe("createBondedHandler", () => {
  it("needs the owner's wallet", () => {
    const base = { keys: KEYS, onEpisode: () => {} };
    expect(() => createBondedHandler({ ...base, owner: "" })).toThrow(/owner: your wallet/);
    expect(() => createBondedHandler({ ...base, owner: "alice" })).toThrow(/owner/);
    expect(() => createBondedHandler({ ...base, owner: [] })).toThrow(/owner/);
    expect(() => createBondedHandler({ ...base, owner: [OWNER, MALLORY] })).not.toThrow();
  });

  it("answers a verify challenge with its owner and version", async () => {
    const { handler } = setup({ version: "v1.2.3" });
    const res = await handler(await signed({ type: "verify", challenge: CHALLENGE }));
    expect(res.status).toBe(200);
    const answer = (await res.json()) as { challenge: string; owner: string };
    expect(answer).toEqual({ challenge: CHALLENGE, owner: OWNER, version: "v1.2.3" });
    // The gateway's own check accepts it, and not for another owner.
    expect(checkAgentUrlVerifyAnswer(OWNER, CHALLENGE, answer)).toBe(true);
    expect(checkAgentUrlVerifyAnswer(MALLORY, CHALLENGE, answer)).toBe(false);
    const noVersion = setup().handler;
    expect(
      await (await noVersion(await signed({ type: "verify", challenge: CHALLENGE }))).json(),
    ).toEqual({ challenge: CHALLENGE, owner: OWNER });
  });

  it("refuses calls Bonded signed for someone else: nobody can claim this URL", async () => {
    let ran = 0;
    const { handler } = setup({ onEpisode: async () => void ran++ });
    const theirs = await handler(
      await signed({ type: "verify", challenge: CHALLENGE }, { owner: MALLORY }),
    );
    expect(theirs.status).toBe(401);
    // It says so with a code Bonded reads, and never names its own wallet.
    const refusal = await theirs.text();
    expect(JSON.parse(refusal)).toEqual({
      error: "this agent is set up for another wallet, not the one this call is for",
      code: "wrong-owner",
    });
    expect(refusal.toLowerCase()).not.toContain(OWNER.toLowerCase());
    expect((await handler(await signed(episodeMessage(), { owner: MALLORY }))).status).toBe(401);
    expect(ran).toBe(0);
    // A team: either wallet's calls pass.
    const team = setup({ owner: [MALLORY, OWNER] }).handler;
    expect(
      await (
        await team(await signed({ type: "verify", challenge: CHALLENGE }, { owner: MALLORY }))
      ).json(),
    ).toMatchObject({ owner: MALLORY });
  });

  it("fetches Bonded's keys from the API (once), and answers 503 when it can't", async () => {
    let fetched: string[] = [];
    let up = true;
    const handler = createBondedHandler({
      owner: OWNER,
      apiUrl: "https://api.example/",
      now,
      fetch: (async (url: string) => {
        fetched.push(url);
        return up
          ? new Response(JSON.stringify({ keys: KEYS }))
          : new Response("down", { status: 503 });
      }) as typeof fetch,
      onEpisode: () => {},
    });
    const verify = async () =>
      handler(await signed({ type: "verify", challenge: `${CHALLENGE}-${Math.random()}` }));
    expect((await verify()).status).toBe(200);
    expect((await verify()).status).toBe(200);
    expect(fetched).toEqual([`https://api.example${AGENT_URL_KEYS_PATH}`]);
    // A call from another Bonded key: fetches again (there may be a new key), then refuses.
    const other = await createTestSigner();
    fetched = [];
    up = false;
    const unknown = await handler(
      await signed({ type: "verify", challenge: CHALLENGE }, { signer: other }),
    );
    expect(unknown.status).toBe(401);
    expect(await errorOf(unknown)).toMatch(/key this agent doesn't know/);
    // Nothing cached and the API down: 503, so Bonded's verify says to try again.
    // With no apiUrl the keys come from Bonded's own domain, not the API's host name: that
    // address is built into every deployed handler, so it must outlive a move of the API.
    fetched = [];
    const cold = createBondedHandler({
      owner: OWNER,
      fetch: (async (url: string) => {
        fetched.push(url);
        return new Response("down", { status: 503 });
      }) as typeof fetch,
      onEpisode: () => {},
    });
    const original = console.error;
    console.error = () => {};
    try {
      expect((await cold(await signed({ type: "verify", challenge: CHALLENGE }))).status).toBe(503);
      expect(fetched).toEqual(["https://www.bondedhq.xyz/.well-known/bonded-agent-keys.json"]);
      expect(BONDED_AGENT_KEYS_URL).toBe(fetched[0]);
    } finally {
      console.error = original;
    }
  });

  it("builds in Bonded's production key: a valid Ed25519 key whose id matches it", async () => {
    expect(BONDED_AGENT_KEYS.length).toBeGreaterThan(0);
    AgentUrlKeySet.parse({ keys: BONDED_AGENT_KEYS });
    for (const { kid, x } of BONDED_AGENT_KEYS) {
      const raw = Buffer.from(x, "base64url");
      await globalThis.crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
      const digest = await globalThis.crypto.subtle.digest("SHA-256", raw);
      expect(Buffer.from(digest).toString("base64url").slice(0, 12)).toBe(kid);
    }
  });

  it("refuses bad, stale, missing and replayed signatures before reading the message", async () => {
    let ran = 0;
    const { handler } = setup({ onEpisode: async () => void ran++ });
    const forged = await signed(episodeMessage(), {
      headers: { "bonded-signature": `v2=${KEYS[0]!.kid}:${"A".repeat(86)}` },
    });
    const bad = await handler(forged);
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: "the signature doesn't match" });
    const stale = await handler(await signed(episodeMessage(), { timestamp: seconds - 600 }));
    expect(stale.status).toBe(401);
    expect(await errorOf(stale)).toMatch(/too old or in the future/);
    const unsigned = await handler(
      new Request("https://agent.example/", {
        method: "POST",
        body: JSON.stringify(episodeMessage()),
      }),
    );
    expect(unsigned.status).toBe(401);

    const request = await signed(episodeMessage());
    const replay = request.clone();
    expect((await handler(request)).status).toBe(202);
    const again = await handler(replay);
    expect(again.status).toBe(401);
    expect(await errorOf(again)).toMatch(/replay/);
    expect(ran).toBe(1);
  });

  it("acknowledges an episode at once, then works, then posts /done with the usage", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const seen: BondedEpisode[] = [];
    const { handler, done, settled } = setup({
      onEpisode: async (episode) => {
        seen.push(episode);
        await gate;
        return {
          finalMessage: "bought",
          usage: { inputTokens: 900, outputTokens: 40, costUsd: 0.01 },
        };
      },
    });
    const res = await handler(await signed(episodeMessage("ep-ack")));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, episodeId: "ep-ack" });
    // Acknowledged while the agent is still working.
    expect(done).toEqual([]);
    expect(seen[0]).toMatchObject({ episodeId: "ep-ack", mode: "tools", deadlineMs: 60_000 });
    expect(seen[0]).not.toHaveProperty("type");

    // A second delivery of the same episode (a retry, freshly signed) doesn't start it twice.
    const dup = await handler(await signed(episodeMessage("ep-ack"), { timestamp: seconds + 1 }));
    expect(await dup.json()).toMatchObject({ alreadyRunning: true });

    release();
    await settled();
    expect(done).toEqual([
      {
        url: "https://gw.example/e/tok/done",
        body: {
          finalMessage: "bought",
          usage: { inputTokens: 900, outputTokens: 40, costUsd: 0.01 },
        },
      },
    ]);
    expect(seen).toHaveLength(1);
  });

  it("aborts the episode's signal on cancel, and doesn't post /done for it", async () => {
    let aborted: unknown;
    const { handler, done, settled } = setup({
      onEpisode: (_episode, { signal }) =>
        new Promise((resolve) =>
          signal.addEventListener("abort", () => {
            aborted = signal.reason;
            resolve({ finalMessage: "stopped" });
          }),
        ),
    });
    expect((await handler(await signed(episodeMessage("ep-c")))).status).toBe(202);
    const cancel = await handler(
      await signed({ type: "cancel", episodeId: "ep-c" }, { timestamp: seconds + 1 }),
    );
    expect(await cancel.json()).toEqual({ ok: true, cancelled: true });
    await settled();
    expect(String(aborted)).toMatch(/cancelled/);
    expect(done).toEqual([]);
    const unknown = await handler(
      await signed({ type: "cancel", episodeId: "nope" }, { timestamp: seconds + 2 }),
    );
    expect(await unknown.json()).toEqual({ ok: true, cancelled: false });
  });

  it("aborts at the episode's deadline", async () => {
    let reason: unknown;
    const { handler, done, settled } = setup({
      onEpisode: (_e, { signal }) =>
        new Promise((resolve) =>
          signal.addEventListener("abort", () => resolve(void (reason = signal.reason))),
        ),
    });
    await handler(await signed(episodeMessage("ep-d", 50)));
    await settled();
    expect(String(reason)).toMatch(/deadline/);
    expect(done).toEqual([]);
  });

  it("still posts /done when the agent throws, saying it failed", async () => {
    const errors: unknown[] = [];
    const { handler, done, settled } = setup({
      onEpisode: async () => {
        throw new Error("model unavailable");
      },
      onError: (error) => errors.push(error),
    });
    await handler(await signed(episodeMessage("ep-e")));
    await settled();
    expect(errors).toHaveLength(1);
    expect(done[0]!.body).toEqual({ finalMessage: "the agent failed: model unavailable" });
  });

  it("refuses what isn't a well-formed signed POST", async () => {
    const { handler } = setup({
      maxBodyBytes: 2_000,
      maxConcurrent: 1,
      onEpisode: () => new Promise(() => {}),
    });
    expect((await handler(new Request("https://agent.example/"))).status).toBe(405);
    const big = await handler(await signed({ type: "verify", challenge: "x".repeat(3_000) }));
    expect(big.status).toBe(413);
    const invalid = await handler(
      await signed({ type: "episode", episodeId: "x" }, { timestamp: seconds + 3 }),
    );
    expect(invalid.status).toBe(400);
    expect(await errorOf(invalid)).toMatch(/not a Bonded message/);
    const unknown = await handler(await signed({ type: "party" }, { timestamp: seconds + 4 }));
    expect(unknown.status).toBe(400);
    const noChallenge = await handler(await signed({ type: "verify" }, { timestamp: seconds + 5 }));
    expect(noChallenge.status).toBe(400);
    // One episode at a time here: a second, different one is refused.
    expect(
      (await handler(await signed(episodeMessage("a"), { timestamp: seconds + 6 }))).status,
    ).toBe(202);
    expect(
      (await handler(await signed(episodeMessage("b"), { timestamp: seconds + 7 }))).status,
    ).toBe(429);
  });
});

describe("toNodeHandler", () => {
  let server: Server | undefined;
  afterEach(
    () => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())),
  );

  async function listen(listener: Parameters<typeof createServer>[1]) {
    server = createServer(listener);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/bonded`;
  }
  const post = async (url: string, message: unknown, timestamp = Math.floor(Date.now() / 1000)) => {
    const body = JSON.stringify(message);
    return fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(await bonded.sign(OWNER, body, timestamp)),
      },
      body,
    });
  };

  it("serves the handler from a Node http server, reading the raw body", async () => {
    const handler = createBondedHandler({
      owner: OWNER,
      keys: KEYS,
      version: "abc",
      onEpisode: () => {},
    });
    const url = await listen(toNodeHandler(handler));
    const res = await post(url, { type: "verify", challenge: `node-${CHALLENGE}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      challenge: `node-${CHALLENGE}`,
      owner: OWNER,
      version: "abc",
    });
    const bad = await fetch(url, {
      method: "POST",
      body: "{}",
      headers: { "bonded-timestamp": "1", "bonded-owner": OWNER, "bonded-signature": "v2=00" },
    });
    expect(bad.status).toBe(401);
  });

  it("accepts a raw body (express.raw) and refuses one already parsed (express.json)", async () => {
    const handler = createBondedHandler({ owner: OWNER, keys: KEYS, onEpisode: () => {} });
    const node = toNodeHandler(handler);
    let parse: "raw" | "json" = "raw";
    const url = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks);
        (req as typeof req & { body: unknown }).body =
          parse === "raw" ? raw : JSON.parse(raw.toString());
        void node(req, res);
      });
    });
    expect((await post(url, { type: "verify", challenge: `raw-${CHALLENGE}` })).status).toBe(200);
    parse = "json";
    const parsed = await post(url, { type: "verify", challenge: `json-${CHALLENGE}` });
    expect(parsed.status).toBe(500);
    expect(await errorOf(parsed)).toMatch(/before express.json/);
  });
});

describe("platform waitUntil", () => {
  it("keeps the work alive with the context's waitUntil, called as a method", async () => {
    const handler = createBondedHandler({
      owner: OWNER,
      keys: KEYS,
      now,
      fetch: (async () => new Response("{}")) as unknown as typeof fetch,
      onEpisode: async () => ({ finalMessage: "ok" }),
    });
    // Like Cloudflare's ExecutionContext: waitUntil uses `this`.
    const ctx = {
      kept: [] as Promise<unknown>[],
      waitUntil(work: Promise<unknown>) {
        this.kept.push(work);
      },
    };
    expect((await handler(await signed(episodeMessage("ep-w")), ctx)).status).toBe(202);
    expect(ctx.kept).toHaveLength(1);
    await ctx.kept[0];
  });
});

describe("brokerage episodes", () => {
  const brokerageMessage = (id = "ep-b1") => ({
    type: "episode",
    world: "brokerage",
    episodeId: id,
    task: { goal: "Do this week's run.", mandate: "You manage Dana's account.", maxSteps: 40 },
    mode: "tools",
    endpoints: {
      mcp: "https://gw.example/e/tok/mcp",
      tools: "https://gw.example/e/tok/tools",
      openapi: "https://gw.example/e/tok/openapi.json",
      done: "https://gw.example/e/tok/done",
    },
    deadlineMs: 60_000,
  });

  it("refuses them when the agent has no brokerage handler", async () => {
    let ran = false;
    const { handler } = setup({
      onEpisode: () => {
        ran = true;
      },
    });
    const response = await handler(await signed(brokerageMessage()));
    expect(response.status).toBe(422);
    expect(await errorOf(response)).toMatch(/brokerage/);
    expect(ran).toBe(false);
  });

  it("runs them with onBrokerageEpisode and posts /done", async () => {
    const seen: unknown[] = [];
    let vaultRan = false;
    const { handler, done, settled } = setup({
      onEpisode: () => {
        vaultRan = true;
      },
      onBrokerageEpisode: (episode) => {
        seen.push(episode);
        return { finalMessage: "sold 10 AAPL" };
      },
    });
    expect((await handler(await signed(brokerageMessage()))).status).toBe(202);
    await settled();
    expect(vaultRan).toBe(false);
    expect(seen).toEqual([
      {
        world: "brokerage",
        episodeId: "ep-b1",
        task: brokerageMessage().task,
        mode: "tools",
        endpoints: brokerageMessage().endpoints,
        deadlineMs: 60_000,
      },
    ]);
    expect(done).toEqual([
      { url: "https://gw.example/e/tok/done", body: { finalMessage: "sold 10 AAPL" } },
    ]);
  });

  it("still posts /done when the agent fails and its error reporter throws too", async () => {
    const logged: unknown[][] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      const { handler, done, settled } = setup({
        onBrokerageEpisode: () => {
          throw new Error("the broker API is down");
        },
        onBrokerageError: () => {
          throw new Error("the reporter is down too");
        },
      });
      expect((await handler(await signed(brokerageMessage("ep-b2")))).status).toBe(202);
      await settled();
      expect(done).toEqual([
        {
          url: "https://gw.example/e/tok/done",
          body: { finalMessage: "the agent failed: the broker API is down" },
        },
      ]);
      expect(String(logged[0]?.[0])).toMatch(/error reporter threw/);
    } finally {
      console.error = error;
    }
  });
});
