import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  type BondedHandlerOptions,
  createBondedHandler,
  signBondedRequest,
  toNodeHandler,
  verifyBondedSignature,
} from "../src/agent-url.js";
import type { BondedEpisode } from "../src/index.js";
import { agentUrlVerifyProof, checkAgentUrlVerifyProof } from "@bondedhq/shared/agent-url";

/** A verify challenge as the gateway sends it (16 to 128 characters). */
const CHALLENGE = "challenge-0123456789abcdef";
const errorOf = async (r: Response) => ((await r.json()) as { error: string }).error;
const SECRET = "bonded_as_test-secret-not-real-0001";
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

/** A signed request, as Bonded sends it. */
async function signed(
  message: unknown,
  options: { secret?: string; timestamp?: number; headers?: Record<string, string> } = {},
) {
  const body = JSON.stringify(message);
  const headers = await signBondedRequest(
    options.secret ?? SECRET,
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
    secret: SECRET,
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

describe("signatures", () => {
  it("accept Bonded's signature and refuse others", async () => {
    const body = '{"type":"verify","challenge":"challenge-0123456789"}';
    const h = await signBondedRequest(SECRET, body, seconds);
    expect(h["bonded-signature"]).toMatch(/^v1=[0-9a-f]{64}$/);
    const check = (patch: Partial<Parameters<typeof verifyBondedSignature>[0]>) =>
      verifyBondedSignature({
        secret: SECRET,
        body,
        timestamp: h["bonded-timestamp"],
        signature: h["bonded-signature"],
        now: seconds,
        ...patch,
      });
    expect(await check({})).toEqual({ ok: true, timestamp: seconds });
    const mismatch = { ok: false, reason: "the signature doesn't match" };
    const stale = { ok: false, reason: "the timestamp is too old or in the future" };
    expect(await check({ body: body + " " })).toEqual(mismatch);
    expect(await check({ secret: "bonded_as_other" })).toEqual(mismatch);
    expect(await check({ timestamp: String(seconds + 1) })).toEqual(mismatch);
    expect(await check({ now: seconds + 301 })).toEqual(stale);
    expect(await check({ now: seconds - 301 })).toEqual(stale);
    expect(await check({ now: seconds + 300 })).toMatchObject({ ok: true });
    expect(await check({ signature: undefined })).toEqual({
      ok: false,
      reason: "the call is not signed",
    });
    expect(await check({ signature: "v1=zz" })).toEqual({ ok: false, reason: "no v1 signature" });
    expect(await check({ signature: "v0=" + "a".repeat(64) })).toMatchObject({ ok: false });
    expect(await check({ timestamp: "12.5" })).toMatchObject({ ok: false });
    // Several secrets while rotating: any one may match.
    expect(await check({ secret: ["bonded_as_old", SECRET] })).toMatchObject({ ok: true });
    // Signature-only: a body that isn't a Bonded message still has a valid signature.
    const other = "not json";
    const otherHeaders = await signBondedRequest(SECRET, other, seconds);
    expect(
      await check({
        body: other,
        timestamp: otherHeaders["bonded-timestamp"],
        signature: otherHeaders["bonded-signature"],
      }),
    ).toEqual({ ok: true, timestamp: seconds });
    // Any one of several signatures may match (secret rotation).
    expect(
      await check({ signature: `v1=${"0".repeat(64)}, ${h["bonded-signature"]}` }),
    ).toMatchObject({ ok: true });
  });
});

describe("createBondedHandler", () => {
  it("answers a verify challenge with a proof of the secret and the agent's version", async () => {
    const { handler } = setup({ version: "v1.2.3" });
    const res = await handler(await signed({ type: "verify", challenge: CHALLENGE }));
    expect(res.status).toBe(200);
    const answer = (await res.json()) as { challenge: string; proof: string };
    expect(answer).toEqual({
      challenge: CHALLENGE,
      proof: await agentUrlVerifyProof(SECRET, CHALLENGE),
      version: "v1.2.3",
    });
    // The gateway's own check accepts it, and not under another secret.
    expect(await checkAgentUrlVerifyProof(SECRET, CHALLENGE, answer)).toBe(true);
    expect(await checkAgentUrlVerifyProof("bonded_as_someone-else", CHALLENGE, answer)).toBe(false);
    const noVersion = setup().handler;
    expect(
      await (await noVersion(await signed({ type: "verify", challenge: CHALLENGE }))).json(),
    ).toEqual({ challenge: CHALLENGE, proof: await agentUrlVerifyProof(SECRET, CHALLENGE) });
  });

  it("while a secret rotates, proves with the secret that signed the call", async () => {
    const OLD = "bonded_as_test-secret-being-rotated-out";
    const { handler } = setup({ secret: [SECRET, OLD] });
    const res = await handler(
      await signed({ type: "verify", challenge: CHALLENGE }, { secret: OLD }),
    );
    expect(((await res.json()) as { proof: string }).proof).toBe(
      await agentUrlVerifyProof(OLD, CHALLENGE),
    );
  });

  it("refuses bad, stale, missing and replayed signatures before reading the message", async () => {
    let ran = 0;
    const { handler } = setup({ onEpisode: async () => void ran++ });
    const bad = await handler(await signed(episodeMessage(), { secret: "bonded_as_wrong" }));
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
        ...(await signBondedRequest(SECRET, body, timestamp)),
      },
      body,
    });
  };

  it("serves the handler from a Node http server, reading the raw body", async () => {
    const handler = createBondedHandler({ secret: SECRET, version: "abc", onEpisode: () => {} });
    const url = await listen(toNodeHandler(handler));
    const res = await post(url, { type: "verify", challenge: `node-${CHALLENGE}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      challenge: `node-${CHALLENGE}`,
      proof: await agentUrlVerifyProof(SECRET, `node-${CHALLENGE}`),
      version: "abc",
    });
    const bad = await fetch(url, {
      method: "POST",
      body: "{}",
      headers: { "bonded-timestamp": "1", "bonded-signature": "v1=00" },
    });
    expect(bad.status).toBe(401);
  });

  it("accepts a raw body (express.raw) and refuses one already parsed (express.json)", async () => {
    const handler = createBondedHandler({ secret: SECRET, onEpisode: () => {} });
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
      secret: SECRET,
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
});
