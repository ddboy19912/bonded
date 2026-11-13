import { createHmac, createPublicKey, verify as nodeVerify } from "node:crypto";
import { keccak256, stringToBytes } from "viem";
import { describe, expect, it } from "vitest";
import {
  AGENT_URL_OWNER_HEADER,
  AGENT_URL_SIGNATURE_HEADER,
  AGENT_URL_TIMESTAMP_HEADER,
  AGENT_URL_WRONG_OWNER,
  agentUrlCodeHash,
  AgentUrlKeys,
  AgentUrlKeySet,
  agentUrlSignatureKeyIds,
  agentUrlSigner,
  answerAgentUrlVerify,
  checkAgentUrlVerifyAnswer,
  AgentUrlReplayGuard,
  AgentUrlVerifyAnswer,
  codeHashOf,
  type EpisodeMessage,
  isAgentUrlOwner,
  newAgentUrlSigningKey,
  parseRunnerMessage,
  RunnerToServer,
  signWebhookRequest,
  verifyAgentUrlRequest,
} from "../src/index.js";

const OWNER = "0x00000000000000000000000000000000000a11ce";
const MALLORY = "0x000000000000000000000000000000000000bad0";
const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const KEY = await newAgentUrlSigningKey();
const signer = await agentUrlSigner(KEY);
const keys = signer.keySet().keys;

const episode: EpisodeMessage = {
  type: "episode",
  episodeId: "ep-1",
  task: { goal: "Buy 2000 tUSDG worth of tNVDA — ünïcode.", mandate: "Trade.", maxSteps: 20 },
  mode: "tools",
  endpoints: {
    mcp: "https://gw.example/e/abc/mcp",
    tools: "https://gw.example/e/abc/tools",
    openapi: "https://gw.example/e/abc/openapi.json",
    done: "https://gw.example/e/abc/done",
  },
  chainId: 31337,
  vault: "0x000000000000000000000000000000000000dEaD",
  contracts: { exchange: "0x000000000000000000000000000000000000bEEF", tokens: [] },
  deadlineMs: 90_000,
};
const body = JSON.stringify(episode);

describe("Agent URL signatures", () => {
  const check = (fields: Partial<Parameters<typeof verifyAgentUrlRequest>[0]> = {}) =>
    signer
      .sign(OWNER, body, NOW)
      .then((headers) =>
        verifyAgentUrlRequest({ owner: OWNER, keys, body, headers, nowMs: NOW, ...fields }),
      );

  it("signs v2 with Ed25519 over 'v2.<kid>.<ts>.<owner>.<body>', checkable by any Ed25519 library", async () => {
    const headers = await signer.sign(OWNER.toUpperCase().replace("0X", "0x"), body, NOW);
    const ts = Math.floor(NOW / 1000);
    expect(headers[AGENT_URL_TIMESTAMP_HEADER]).toBe(String(ts));
    expect(headers[AGENT_URL_OWNER_HEADER]).toBe(OWNER);
    const [, kid, sig] = /^v2=([^:]+):(.+)$/.exec(headers[AGENT_URL_SIGNATURE_HEADER]!)!;
    expect(kid).toBe(signer.kid);
    const publicKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: keys[0]!.x },
      format: "jwk",
    });
    const payload = Buffer.from(`v2.${kid}.${ts}.${OWNER}.${body}`, "utf8");
    expect(nodeVerify(null, payload, publicKey, Buffer.from(sig!, "base64url"))).toBe(true);
  });

  it("publishes its keys, the signing one first, with ids from the public key", async () => {
    const second = await newAgentUrlSigningKey();
    const two = await agentUrlSigner(`${second}, ${KEY}`);
    expect(AgentUrlKeySet.parse(two.keySet()).keys.map((k) => k.kid)).toEqual([
      two.kid,
      signer.kid,
    ]);
    expect(two.kid).not.toBe(signer.kid);
    // The same key always has the same id; the private key is never published.
    expect((await agentUrlSigner(KEY)).kid).toBe(signer.kid);
    expect(JSON.stringify(two.keySet())).not.toContain(KEY);
    await expect(agentUrlSigner("not-a-key")).rejects.toThrow(/PKCS#8/);
    await expect(agentUrlSigner(" ")).rejects.toThrow(/no agent URL signing key/);
  });

  it("round-trips: a signed episode verifies and parses, for the owner it was signed for", async () => {
    expect(await check()).toMatchObject({
      ok: true,
      owner: OWNER,
      message: { type: "episode", episodeId: "ep-1" },
    });
    // Fetch Headers, mixed case, a checksummed owner, and a team of owners all work.
    const headers = await signer.sign(OWNER, body, NOW);
    const upper = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.replace(/^b/, "B"), v]),
    );
    for (const h of [new Headers(headers), upper])
      expect(
        (await verifyAgentUrlRequest({ owner: OWNER, keys, body, headers: h, nowMs: NOW })).ok,
      ).toBe(true);
    expect((await check({ owner: [MALLORY, OWNER.toUpperCase().replace("0X", "0x")] })).ok).toBe(
      true,
    );
  });

  it("says a call is for another wallet only after its signature checks out", async () => {
    const headers = await signer.sign(MALLORY, body, NOW);
    // Unsigned, or forged: refused for that, so nobody learns whose agent this is by probing.
    const unsigned = await verifyAgentUrlRequest({
      owner: OWNER,
      keys,
      body,
      headers: { ...headers, [AGENT_URL_SIGNATURE_HEADER]: `v2=${signer.kid}:${"A".repeat(86)}` },
      nowMs: NOW,
    });
    expect(unsigned).toMatchObject({ ok: false, reason: "the signature doesn't match" });
    expect(unsigned).not.toHaveProperty("code");
  });

  it("refuses a call for another owner: the attack where someone saves your URL as theirs", async () => {
    // Bonded signs Mallory's calls for Mallory. The agent belongs to Alice, so it refuses them.
    const headers = await signer.sign(MALLORY, body, NOW);
    expect(
      await verifyAgentUrlRequest({ owner: OWNER, keys, body, headers, nowMs: NOW }),
    ).toMatchObject({
      ok: false,
      status: 401,
      reason: /set up for another wallet/,
      code: AGENT_URL_WRONG_OWNER,
    });
    // Changing the owner header on a call signed for Mallory breaks the signature.
    expect(
      await verifyAgentUrlRequest({
        owner: OWNER,
        keys,
        body,
        headers: { ...headers, [AGENT_URL_OWNER_HEADER]: OWNER },
        nowMs: NOW,
      }),
    ).toMatchObject({ ok: false, reason: "the signature doesn't match" });
  });

  it("refuses an unknown key, a forged signature, a changed body, a missing or malformed header", async () => {
    const other = await agentUrlSigner(await newAgentUrlSigningKey());
    expect(
      await verifyAgentUrlRequest({
        owner: OWNER,
        keys,
        body,
        headers: await other.sign(OWNER, body, NOW),
        nowMs: NOW,
      }),
    ).toMatchObject({ ok: false, reason: /key this agent doesn't know/ });
    // Another key that claims the published key's id: the signature fails.
    const forged = await other.sign(OWNER, body, NOW);
    forged[AGENT_URL_SIGNATURE_HEADER] = forged[AGENT_URL_SIGNATURE_HEADER]!.replace(
      other.kid,
      signer.kid,
    );
    expect(
      await verifyAgentUrlRequest({ owner: OWNER, keys, body, headers: forged, nowMs: NOW }),
    ).toMatchObject({ ok: false, reason: "the signature doesn't match" });
    expect(await check({ body: body.replace("2000", "9000") })).toMatchObject({
      ok: false,
      status: 401,
    });
    const headers = await signer.sign(OWNER, body, NOW);
    expect(await check({ headers: {} })).toMatchObject({ reason: "the call is not signed" });
    expect(await check({ headers: { ...headers, [AGENT_URL_OWNER_HEADER]: "" } })).toMatchObject({
      reason: "the call is not signed",
    });
    expect(
      await check({ headers: { ...headers, [AGENT_URL_SIGNATURE_HEADER]: "v1=abcd" } }),
    ).toMatchObject({ reason: "no v2 signature" });
    expect(
      await check({ headers: { ...headers, [AGENT_URL_TIMESTAMP_HEADER]: "yesterday" } }),
    ).toMatchObject({ status: 401 });
  });

  it("refuses a stale or future timestamp, even with a valid signature", async () => {
    const at = async (ms: number) =>
      verifyAgentUrlRequest({
        owner: OWNER,
        keys,
        body,
        headers: await signer.sign(OWNER, body, ms),
        nowMs: NOW,
      });
    expect(await at(NOW - 301_000)).toMatchObject({
      ok: false,
      reason: "the timestamp is too old or in the future",
    });
    expect((await at(NOW + 301_000)).ok).toBe(false);
    expect((await at(NOW - 299_000)).ok).toBe(true);
  });

  it("refuses a replay spelled differently: the same signature bytes are the same call", async () => {
    const replay = new AgentUrlReplayGuard();
    const headers = await signer.sign(OWNER, body, NOW);
    const value = headers[AGENT_URL_SIGNATURE_HEADER]!;
    // The last base64url character carries 4 spare bits: flip one, the bytes don't change.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = value.at(-1)!;
    const respelled = value.slice(0, -1) + alphabet[alphabet.indexOf(last) ^ 1];
    expect(respelled).not.toBe(value);
    const once = { owner: OWNER, keys, body, nowMs: NOW, replay };
    expect((await verifyAgentUrlRequest({ ...once, headers })).ok).toBe(true);
    expect(
      await verifyAgentUrlRequest({
        ...once,
        headers: { ...headers, [AGENT_URL_SIGNATURE_HEADER]: respelled },
      }),
    ).toMatchObject({ ok: false, reason: "this call was already received (a replay)" });
  });

  it("refuses more signing keys than the published set can hold", async () => {
    const nine = await Promise.all(Array.from({ length: 9 }, () => newAgentUrlSigningKey()));
    await expect(agentUrlSigner(nine.join(","))).rejects.toThrow(/at most 8/);
  });

  it("refuses a replay with a guard", async () => {
    const replay = new AgentUrlReplayGuard();
    const headers = await signer.sign(OWNER, body, NOW);
    const once = { owner: OWNER, keys, body, headers, nowMs: NOW, replay };
    expect((await verifyAgentUrlRequest(once)).ok).toBe(true);
    expect(await verifyAgentUrlRequest(once)).toMatchObject({
      ok: false,
      reason: "this call was already received (a replay)",
    });
    const next = await signer.sign(OWNER, body, NOW + 1_000);
    expect((await verifyAgentUrlRequest({ ...once, headers: next, nowMs: NOW + 1_000 })).ok).toBe(
      true,
    );
  });

  it("forgets signatures once they are too old to be accepted anyway", () => {
    const guard = new AgentUrlReplayGuard(300, 3);
    expect(guard.accept("a", 1_000, 1_000)).toBe(true);
    expect(guard.accept("a", 1_000, 1_000)).toBe(false);
    expect(guard.accept("b", 1_301, 1_301)).toBe(true);
    expect(guard.accept("a", 1_000, 1_301)).toBe(true);
  });

  it("accepts any of several signatures while keys rotate, and refuses more than four", async () => {
    const old = await agentUrlSigner(await newAgentUrlSigningKey());
    const mine = (await signer.sign(OWNER, body, NOW))[AGENT_URL_SIGNATURE_HEADER]!;
    const theirs = (await old.sign(OWNER, body, NOW))[AGENT_URL_SIGNATURE_HEADER]!;
    const base = await signer.sign(OWNER, body, NOW);
    const withSigs = (sigs: string[]) => ({
      ...base,
      [AGENT_URL_SIGNATURE_HEADER]: sigs.join(", "),
    });
    expect((await check({ headers: withSigs([theirs, mine]) })).ok).toBe(true);
    expect(agentUrlSignatureKeyIds(withSigs([theirs, mine]))).toEqual([old.kid, signer.kid]);
    expect((await check({ headers: withSigs([theirs, theirs, theirs, mine]) })).ok).toBe(true);
    expect(
      await check({ headers: withSigs([theirs, theirs, theirs, theirs, mine]) }),
    ).toMatchObject({
      ok: false,
      reason: "too many signatures",
    });
  });

  it("parses verify and cancel, and refuses a signed body that isn't a Bonded message", async () => {
    for (const message of [
      { type: "verify", challenge: "c".repeat(32) },
      { type: "cancel", episodeId: "ep-1" },
    ]) {
      const text = JSON.stringify(message);
      const headers = await signer.sign(OWNER, text, NOW);
      expect(
        await verifyAgentUrlRequest({ owner: OWNER, keys, body: text, headers, nowMs: NOW }),
      ).toMatchObject({ ok: true, message });
    }
    for (const text of ["not json", JSON.stringify({ type: "transfer", to: "0x1" })]) {
      const headers = await signer.sign(OWNER, text, NOW);
      expect(
        await verifyAgentUrlRequest({ owner: OWNER, keys, body: text, headers, nowMs: NOW }),
      ).toMatchObject({ ok: false, status: 400 });
    }
  });
});

describe("the verify answer", () => {
  it("names the owner; only an answer for this challenge and this owner passes", () => {
    const challenge = "c".repeat(32);
    const answer = answerAgentUrlVerify(
      OWNER.toUpperCase().replace("0X", "0x"),
      { type: "verify", challenge },
      "v3",
    );
    expect(answer).toEqual({ challenge, owner: OWNER, version: "v3" });
    expect(AgentUrlVerifyAnswer.parse(answer)).toEqual(answer);
    expect(checkAgentUrlVerifyAnswer(OWNER, challenge, answer)).toBe(true);
    expect(checkAgentUrlVerifyAnswer(MALLORY, challenge, answer)).toBe(false);
    expect(checkAgentUrlVerifyAnswer(OWNER, "d".repeat(32), answer)).toBe(false);
    // An echo of the verify body has no owner, so it doesn't even parse as an answer.
    expect(AgentUrlVerifyAnswer.safeParse({ type: "verify", challenge }).success).toBe(false);
    expect(isAgentUrlOwner(OWNER)).toBe(true);
    expect(isAgentUrlOwner("alice")).toBe(false);
  });
});

describe("the published keys", () => {
  it("are fetched once, kept, and fetched again for a key they don't know (at most once a minute)", async () => {
    let clock = 0;
    const served: AgentUrlKeySet[] = [signer.keySet()];
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return new Response(JSON.stringify(served[served.length - 1]));
    }) as unknown as typeof fetch;
    const store = new AgentUrlKeys("https://api.example/.well-known/bonded-agent-keys.json", {
      fetch: fetcher,
      now: () => clock,
    });
    expect((await store.get()).map((k) => k.kid)).toEqual([signer.kid]);
    expect((await store.get(signer.kid)).length).toBe(1);
    expect(calls).toBe(1);
    // A new key starts signing: an unknown id fetches again, but not more than once a minute.
    const next = await agentUrlSigner(`${await newAgentUrlSigningKey()},${KEY}`);
    served.push(next.keySet());
    clock = 30_000;
    expect((await store.get(next.kid)).length).toBe(1);
    clock = 61_000;
    expect((await store.get(next.kid)).map((k) => k.kid)).toEqual([next.kid, signer.kid]);
    expect(calls).toBe(2);
    // A day later they are fetched again (a key removed from the set stops being trusted); with
    // nothing cached, a failed fetch is an error.
    clock = 61_000 + 86_400_000;
    served.push({ keys: [] });
    const failing = new AgentUrlKeys("https://x", {
      fetch: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch,
    });
    await expect(failing.get()).rejects.toThrow(/503/);
    expect((await store.get()).length).toBe(0);
  });

  it("fall back to the keys built in only when none can be fetched, and none was before", async () => {
    let up = false;
    let clock = 0;
    const builtIn = (await agentUrlSigner(await newAgentUrlSigningKey())).keySet().keys;
    const store = new AgentUrlKeys("https://x", {
      fetch: (async () =>
        up
          ? new Response(JSON.stringify(signer.keySet()))
          : new Response("down", { status: 503 })) as unknown as typeof fetch,
      now: () => clock,
      fallback: builtIn,
    });
    expect(await store.get()).toEqual(builtIn);
    // Once the published set is fetched it is the only one trusted: a failed fetch for a new key
    // id keeps the set while it is fresh...
    up = true;
    expect((await store.get()).map((k) => k.kid)).toEqual([signer.kid]);
    up = false;
    clock = 120_000;
    expect((await store.get("an-unknown-kid")).map((k) => k.kid)).toEqual([signer.kid]);
    // ...but a set older than a day that can't be refetched is trusted no more, and the built-in
    // keys never stand in for it.
    clock = 2 * 86_400_000;
    await expect(store.get()).rejects.toThrow(/503/);
  });

  it("give up on a keys address that doesn't answer, and try again on the next call", async () => {
    let calls = 0;
    const store = new AgentUrlKeys("https://x", {
      fetch: ((_url: string, init?: RequestInit) => {
        calls++;
        return new Promise((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("timed out"))),
        );
      }) as unknown as typeof fetch,
      timeoutMs: 50,
    });
    await expect(store.get()).rejects.toThrow(/timed out/);
    await expect(store.get()).rejects.toThrow(/timed out/);
    expect(calls).toBe(2);
  });
});

describe("webhook signatures", () => {
  it("are v1=HMAC-SHA256(secret, '<ts>.<body>'), the same as any HMAC library", async () => {
    const secret = "bonded_ws_test-secret-0123456789abcdef";
    const headers = await signWebhookRequest(secret, body, NOW);
    const ts = Math.floor(NOW / 1000);
    expect(headers["bonded-timestamp"]).toBe(String(ts));
    const expected = createHmac("sha256", secret).update(`${ts}.${body}`, "utf8").digest("hex");
    expect(headers["bonded-signature"]).toBe(`v1=${expected}`);
  });
});

describe("code hashes", () => {
  it("is keccak256 of '<source>:<value>'", () => {
    expect(codeHashOf("git", "abc")).toBe(keccak256(stringToBytes("git:abc")));
    expect(agentUrlCodeHash("v1.2.3")).toBe(keccak256(stringToBytes("url:v1.2.3")));
  });

  it("hello carries an optional code hash and source; older runners' hello still parses", () => {
    const hello = { type: "hello", runnerVersion: "1", protocol: 1, mode: "tools" };
    expect(parseRunnerMessage(RunnerToServer, JSON.stringify(hello))).toEqual(hello);
    const withCode = {
      ...hello,
      codeHash: `0x${"ab".repeat(32)}`,
      codeSource: "git-dirty",
      codeDetail: "a".repeat(40),
    };
    expect(parseRunnerMessage(RunnerToServer, JSON.stringify(withCode))).toEqual(withCode);
    expect(
      parseRunnerMessage(RunnerToServer, JSON.stringify({ ...hello, codeHash: "0x12" })),
    ).toBeUndefined();
    expect(
      parseRunnerMessage(
        RunnerToServer,
        JSON.stringify({ ...withCode, codeDetail: "x".repeat(201) }),
      ),
    ).toBeUndefined();
    expect(
      parseRunnerMessage(RunnerToServer, JSON.stringify({ ...withCode, codeSource: "magic" })),
    ).toBeUndefined();
  });
});
