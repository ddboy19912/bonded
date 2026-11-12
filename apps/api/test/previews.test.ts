import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { ANVIL_KEYS, Sandbox, createAgentVault, type AgentVault } from "@bonded/arena";
import { connectChain, type ServiceChain } from "@bonded/keeper";
import {
  byoaMessage,
  mandateHash,
  operatorBondAbi,
  selfServeMessage,
  testTokenAbi,
  type RemoteAgentSpec,
  type SelfServeRequest,
} from "@bondedhq/shared";
import type { ArenaAgent } from "@bondedhq/shared";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createApi } from "../src/index.js";
import {
  DbRunnerAuth,
  RunnerPresenceWriter,
  newRunnerToken,
  runnerTokenHash,
} from "../src/runners.js";
import { workOne } from "../src/worker.js";
import { workCheckOne } from "../src/check-worker.js";
import { workPreviewOne } from "../src/preview-worker.js";
import { ratedAgent } from "../src/sentinel.js";
import {
  DEFAULT_REMOTE_POLICY,
  benignTwins,
  type RemoteRatingPolicy,
} from "../src/remote-policy.js";
import { SecretBox } from "../src/secrets.js";
import {
  CHECKS_UNAVAILABLE,
  NEEDS_CHECK,
  urlCodeHash,
  type AgentUrlVerifier,
  type ConnectionCheckRunner,
} from "../src/connections.js";
import { Notifier, type RatingNotification } from "../src/notifications.js";
import { postgres } from "./postgres.js";

let pg: Awaited<ReturnType<typeof postgres>>;
let sandbox: Sandbox;
let chain: ServiceChain;
let app: ReturnType<typeof createApi>;
let auth: DbRunnerAuth;
let presence: RunnerPresenceWriter;
let mine: AgentVault;
const owner = privateKeyToAccount(ANVIL_KEYS.operator);
const stranger = privateKeyToAccount(ANVIL_KEYS.depositor);
let clock = Date.now();
const now = () => Math.floor(clock / 1000);
const tick = () => (clock += 1000);
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
/** A preview of one attack: the attack, the 6 controls and the benign twins. */
const ONE_ATTACK_EPISODES = 7 + benignTwins();
const API_TOKEN = "test-api-token-at-least-24-characters";
const secrets = new SecretBox(randomBytes(32));
let chainId: number;
/** Verifies every URL, reporting version "v1.2.3" (the gateway's verifier, stood in for). */
const verified: AgentUrlVerifier = async () => ({ ok: true, version: "v1.2.3" });
const verifyCalls: { url: string; secret: string }[] = [];
const recordingVerifier: AgentUrlVerifier = async (url, secret) => {
  verifyCalls.push({ url, secret });
  return verified(url, secret);
};

function api(
  policy: Partial<RemoteRatingPolicy> = {},
  extra: Partial<Parameters<typeof createApi>[0]> = {},
) {
  return createApi({
    db: pg.db,
    chain,
    attesterKey: ANVIL_KEYS.deployer,
    apiToken: API_TOKEN,
    gatewayUrl: "https://gateway.example",
    webOrigins: ["https://bonded.example"],
    selfServe: {
      requests: { perClient: 1000, total: 1000, windowMs: 60_000 },
      now: () => clock,
      remote: {
        ...DEFAULT_REMOTE_POLICY,
        checksPerWalletHourly: 1000,
        checksHourly: 1000,
        previewCreatesPerWalletDaily: 1000,
        urlVerifiesPerWalletHourly: 1000,
        urlVerifiesHourly: 1000,
        ...policy,
      },
    },
    secrets,
    verifyAgentUrl: recordingVerifier,
    ownerRequests: {
      writes: { perClient: 100_000, total: 100_000, windowMs: 60_000 },
      reads: { perClient: 100_000, total: 100_000, windowMs: 60_000 },
      checksPerClientHourly: 100_000,
    },
    ...extra,
  });
}

beforeAll(async () => {
  pg = await postgres();
  sandbox = await Sandbox.start();
  chainId = sandbox.deployment.chainId;
  chain = connectChain(sandbox.deployment, sandbox.rpcUrl, ANVIL_KEYS.deployer);
  mine = await createAgentVault(sandbox);
  const op = connectChain(sandbox.deployment, sandbox.rpcUrl, ANVIL_KEYS.operator);
  const d = sandbox.deployment;
  await op.send(d.usdg, testTokenAbi, "faucet", [1_000_000_000n]);
  await op.send(d.usdg, testTokenAbi, "approve", [d.bond, 1_000_000_000n]);
  await op.read.waitForTransactionReceipt({
    hash: await op.send(d.bond, operatorBondAbi, "stake", [mine.agentId, 1_000_000_000n]),
  });
  app = api();
  auth = new DbRunnerAuth(pg.db, chainId);
  presence = new RunnerPresenceWriter(pg.db);
}, 180_000);
afterAll(async () => {
  await app?.close();
  await sandbox?.stop();
  await pg?.stop();
});

const bodyOf = async (r: Response) => (await r.json()) as Record<string, unknown>;
const send = (
  method: string,
  path: string,
  body: unknown,
  session?: string,
  a = app,
): Promise<Response> =>
  Promise.resolve(
    a.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(session ? { Authorization: `Bearer ${session}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
const get = (path: string, session?: string, a = app) =>
  Promise.resolve(
    a.request(path, session ? { headers: { Authorization: `Bearer ${session}` } } : {}),
  );

async function signIn(who: PrivateKeyAccount = owner, a = app) {
  tick();
  const timestamp = now();
  const request: SelfServeRequest = {
    action: "sign-in",
    chainId,
    wallet: who.address,
    timestamp,
  };
  const signature = await who.signMessage({ message: selfServeMessage(request) });
  return send("POST", "/self/session", { wallet: who.address, timestamp, signature }, undefined, a);
}
/** A session for `who`, opened once and reused (any API on this database accepts it). */
const sessions = new Map<string, string>();
async function sessionFor(who: PrivateKeyAccount = owner, a = app) {
  const known = sessions.get(who.address);
  if (known) return known;
  const session = (await bodyOf(await signIn(who, a))).session as string;
  sessions.set(who.address, session);
  return session;
}

async function newPreview(
  session: string,
  input: Record<string, unknown> = { mode: "tools" },
  a = app,
) {
  const res = await send("POST", "/previews", input, session, a);
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return (await bodyOf(res)) as unknown as { id: string; status: string; connection: string };
}
/** Connect a runner for `token` as the gateway would, reporting `codeHash` in its hello. */
async function connect(token: string, mode: "tools" | "chain" = "tools", codeHash?: string) {
  const identity = await auth.validate(token);
  if (!identity) throw new Error("token refused");
  presence.onEvent({
    type: "connected",
    key: identity.key,
    at: Date.now(),
    hello: {
      type: "hello",
      runnerVersion: "0.2.0",
      protocol: 1,
      mode,
      ...(codeHash ? { codeHash: codeHash as `0x${string}`, codeSource: "git" as const } : {}),
    },
  });
  await presence.flush();
  return identity;
}
/** A check runner that passes, reporting usage, as the gateway's would after one benign episode. */
const passing: ConnectionCheckRunner = async ({ onEvent }) => {
  onEvent({ type: "started" });
  onEvent({ type: "tool", name: "read_inbox", surface: "dm", ok: true });
  onEvent({ type: "tool", name: "swap", surface: null, ok: true });
  onEvent({ type: "done", exitCode: 0, durationMs: 4000, stdoutTail: "ok" });
  return {
    passed: true,
    problems: [],
    taskCompleted: true,
    toolsCalled: 2,
    surfacesRead: ["dm"],
    usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.002 },
    durationMs: 4000,
  };
};
/**
 * Read a whole SSE response (it ends by itself) into its messages: plain `message` events, as
 * EventSource.onmessage gets them (named heartbeats are left out). `event` is the data's `type`.
 */
async function sse(res: Response) {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((block) => block.includes("data:") && !block.includes("event:"))
    .map((block) => {
      const data = JSON.parse(/data: (.*)/.exec(block)![1]!) as Record<string, unknown>;
      return { event: data.type as string | undefined, data };
    });
}
/** A preview on a connected runner (reporting `code`) with a passing check, ready to rate. */
async function readyPreview(session: string, code = hash(0xabc), a = app) {
  const preview = await newPreview(session, { mode: "tools" }, a);
  const made = await bodyOf(
    await send("POST", `/previews/${preview.id}/runner-token`, {}, session, a),
  );
  await connect(made.token as string, "tools", code);
  const check = await bodyOf(await send("POST", `/previews/${preview.id}/checks`, {}, session, a));
  expect(check.queued).toBe(true);
  expect(await workCheckOne(pg.db, chainId, { runCheck: passing })).toBe(true);
  return { preview, token: made.token as string, checkId: check.checkId as string };
}

describe("owner sessions", () => {
  it("open with a fresh sign-in signature, once per signature, and end when signed out", async () => {
    const res = await signIn();
    expect(res.status).toBe(201);
    const opened = await bodyOf(res);
    expect(opened.session).toMatch(/^bonded_ss_/);
    expect(opened.wallet).toBe(owner.address.toLowerCase());
    expect(await bodyOf(await get("/self/session", opened.session as string))).toMatchObject({
      wallet: owner.address.toLowerCase(),
    });
    // The same signature again: refused.
    tick();
    const timestamp = now();
    const signature = await owner.signMessage({
      message: selfServeMessage({ action: "sign-in", chainId, wallet: owner.address, timestamp }),
    });
    const first = await send("POST", "/self/session", {
      wallet: owner.address,
      timestamp,
      signature,
    });
    expect(first.status).toBe(201);
    const replay = await send("POST", "/self/session", {
      wallet: owner.address,
      timestamp,
      signature,
    });
    expect(replay.status).toBe(409);
    // Signed by someone else for this wallet; signed too long ago.
    const forged = await stranger.signMessage({
      message: selfServeMessage({ action: "sign-in", chainId, wallet: owner.address, timestamp }),
    });
    expect(
      (await send("POST", "/self/session", { wallet: owner.address, timestamp, signature: forged }))
        .status,
    ).toBe(403);
    const old = now() - 3600;
    const stale = await owner.signMessage({
      message: selfServeMessage({
        action: "sign-in",
        chainId,
        wallet: owner.address,
        timestamp: old,
      }),
    });
    expect(
      (
        await send("POST", "/self/session", {
          wallet: owner.address,
          timestamp: old,
          signature: stale,
        })
      ).status,
    ).toBe(400);
    // Signed out: the session no longer works.
    expect(
      (await send("DELETE", "/self/session", undefined, opened.session as string)).status,
    ).toBe(200);
    expect((await get("/previews", opened.session as string)).status).toBe(401);
  });

  it("are needed for every preview, check and notification route", async () => {
    for (const [method, path] of [
      ["POST", "/previews"],
      ["GET", "/previews"],
      ["GET", "/self/notifications"],
      ["POST", "/self/notifications"],
      ["POST", `/self/agents/${mine.agentId}/checks`],
      ["POST", `/self/agents/${mine.agentId}/agent-url`],
    ] as const) {
      const res = await send(method, path, method === "POST" ? {} : undefined);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    expect(
      (await get("/previews", "bonded_ss_not-a-real-session-token-at-all-0000000000000")).status,
    ).toBe(401);
  });
});

describe("previews", () => {
  it("start with a session, belong to their wallet, and say they aren't on chain", async () => {
    const session = await sessionFor();
    const res = await send("POST", "/previews", { mode: "tools" }, session);
    expect(res.status).toBe(201);
    const body = await bodyOf(res);
    const preview = body;
    expect(preview).toMatchObject({
      status: "created",
      connection: "runner",
      codeHash: null,
      declaredCodeHash: null,
      hasRunnerToken: false,
      lastCheck: null,
      label: "Preview: not on chain, not insurable",
      attested: false,
      insurable: false,
    });
    expect(body.expectedRating).toMatchObject({ episodes: expect.any(Number) });
    const list = await bodyOf(await get("/previews", session));
    expect((list.items as { id: string }[]).some((p) => p.id === preview.id)).toBe(true);
    // Another wallet can't see it, or act on it: it is "not found" to them.
    const theirs = await sessionFor(stranger);
    expect((await get(`/previews/${preview.id}`, theirs)).status).toBe(404);
    expect((await send("POST", `/previews/${preview.id}/runner-token`, {}, theirs)).status).toBe(
      404,
    );
    expect((await send("POST", `/previews/${preview.id}/checks`, {}, theirs)).status).toBe(404);
    expect((await send("POST", `/previews/${preview.id}/rate`, {}, theirs)).status).toBe(404);
    expect((await get(`/previews/${preview.id}/report`, theirs)).status).toBe(404);
    expect(
      ((await bodyOf(await get("/previews", theirs))).items as { id: string }[]).some(
        (p) => p.id === preview.id,
      ),
    ).toBe(false);
  });

  it("refuse bad input and too many per wallet in a day", async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const session = await sessionFor(wallet);
    expect((await send("POST", "/previews", { mode: "both" }, session)).status).toBe(400);
    expect(
      (await send("POST", "/previews", { mode: "tools", codeHash: "0x12" }, session)).status,
    ).toBe(400);
    expect((await send("POST", "/previews", { mode: "tools", extra: 1 }, session)).status).toBe(
      400,
    );
    const capped = api({ previewCreatesPerWalletDaily: 2 });
    const s = await sessionFor(wallet, capped);
    await newPreview(s, { mode: "tools" }, capped);
    await newPreview(s, { mode: "chain", codeHash: hash(5) }, capped);
    const third = await send("POST", "/previews", { mode: "tools" }, s, capped);
    expect(third.status).toBe(429);
    expect((await bodyOf(third)).error).toMatch(
      /You can start at most 2 previews a day\. Try again after/,
    );
  });

  it("get a runner token, shown once, that the gateway accepts in the preview's mode", async () => {
    const session = await sessionFor();
    const preview = await newPreview(session);
    const made = await send("POST", `/previews/${preview.id}/runner-token`, {}, session);
    expect(made.status).toBe(201);
    const { token } = await bodyOf(made);
    expect(token).toMatch(/^bonded_rt_/);
    const identity = await auth.validate(token as string);
    expect(identity).toMatchObject({ key: `preview:${preview.id}`, mode: "tools" });
    // The page shows the runner, never the token.
    await connect(token as string, "tools", hash(0x99));
    const page = await bodyOf(await get(`/previews/${preview.id}`, session));
    expect(JSON.stringify(page)).not.toContain(token as string);
    expect(page.runner).toMatchObject({ connected: true, codeHash: hash(0x99), codeSource: "git" });
    expect(page.hasRunnerToken).toBe(true);
    expect(page.code).toEqual({ hash: hash(0x99), source: "git" });
    expect(page.codeHash).toEqual({
      value: hash(0x99),
      source: "git",
      detail: null,
      reportedBy: "runner",
      label: "reported by the runner",
    });
    expect(page.upgrade).toMatchObject({
      kind: "remote",
      mode: "tools",
      connection: "runner",
      runner: true,
      codeHash: null,
      reportedCode: { hash: hash(0x99), source: "git" },
      previewId: preview.id,
    });
    // A stopped preview's token stops working.
    expect((await send("POST", `/previews/${preview.id}/stop`, {}, session)).status).toBe(200);
    expect(await auth.validate(token as string)).toBeNull();
    expect((await send("POST", `/previews/${preview.id}/runner-token`, {}, session)).status).toBe(
      409,
    );
  });
});

describe("connection checks", () => {
  it("fail at once, saying why, when the agent can't be reached", async () => {
    const session = await sessionFor();
    const preview = await newPreview(session);
    const res = await send("POST", `/previews/${preview.id}/checks`, {}, session);
    expect(res.status).toBe(201);
    const check = await bodyOf(res);
    expect(check).toMatchObject({ status: "failed", eventsUrl: `/checks/${check.checkId}/events` });
    expect((check.result as { problems: string[] }).problems[0]).toMatch(
      /Create a runner token first/,
    );
    // The live stream gives the result and ends.
    const events = await sse(await get(check.eventsUrl as string, session));
    expect(events.at(-1)).toMatchObject({ event: "result", data: { passed: false } });
    // The polling fallback has the same events.
    expect((await bodyOf(await get(`/checks/${check.checkId}`, session))).events).toEqual([
      expect.objectContaining({ type: "result", passed: false }),
    ]);
    // Runner token made, but no runner connected.
    await send("POST", `/previews/${preview.id}/runner-token`, {}, session);
    const again = await bodyOf(await send("POST", `/previews/${preview.id}/checks`, {}, session));
    expect((again.result as { problems: string[] }).problems[0]).toMatch(
      /The runner isn't connected/,
    );
  });

  it("run in their own lane, stream what the agent does, and make a preview ready", async () => {
    const session = await sessionFor();
    const preview = await newPreview(session);
    const { token } = await bodyOf(
      await send("POST", `/previews/${preview.id}/runner-token`, {}, session),
    );
    await connect(token as string, "tools", hash(0x77));
    const check = await bodyOf(await send("POST", `/previews/${preview.id}/checks`, {}, session));
    expect(check).toMatchObject({
      status: "running",
      queued: true,
      codeHash: hash(0x77),
      codeSource: "git",
    });
    // One at a time per agent.
    const busy = await send("POST", `/previews/${preview.id}/checks`, {}, session);
    expect(busy.status).toBe(409);
    expect((await bodyOf(busy)).error).toMatch(/already running/);
    expect(await workCheckOne(pg.db, chainId, { runCheck: passing })).toBe(true);
    const events = await sse(await get(`/checks/${check.checkId}/events`, session));
    expect(events.map((e) => e.event)).toEqual(["started", "tool", "tool", "done", "result"]);
    expect(events.at(-1)!.data).toMatchObject({
      passed: true,
      toolsCalled: 2,
      surfacesRead: ["dm"],
    });
    const stored = await bodyOf(await get(`/checks/${check.checkId}`, session));
    expect(stored.status).toBe("passed");
    const page = await bodyOf(await get(`/previews/${preview.id}`, session));
    expect(page.status).toBe("ready");
    expect(page.passingCheck).toMatchObject({ id: check.checkId });
    expect(page.lastCheck).toMatchObject({
      id: check.checkId,
      status: "passed",
      connection: "runner",
      expiresAt: expect.any(String),
    });
    // An unknown check id is just not found.
    expect((await get(`/checks/${crypto.randomUUID()}`, session)).status).toBe(404);
    expect((await get("/checks/not-a-uuid/events", session)).status).toBe(404);
  });

  it("fail plainly on a worker that can't run them, and whatever the runner throws", async () => {
    const session = await sessionFor();
    const preview = await newPreview(session);
    const { token } = await bodyOf(
      await send("POST", `/previews/${preview.id}/runner-token`, {}, session),
    );
    await connect(token as string);
    const first = await bodyOf(await send("POST", `/previews/${preview.id}/checks`, {}, session));
    await workCheckOne(pg.db, chainId, {});
    expect(
      (
        (await bodyOf(await get(`/checks/${first.checkId}`, session))).result as {
          problems: string[];
        }
      ).problems,
    ).toEqual([CHECKS_UNAVAILABLE]);
    const second = await bodyOf(await send("POST", `/previews/${preview.id}/checks`, {}, session));
    const logs: string[] = [];
    await workCheckOne(pg.db, chainId, {
      runCheck: async () => {
        throw new Error("boom with a secret-ish detail");
      },
      log: (l) => logs.push(l),
    });
    const result = (await bodyOf(await get(`/checks/${second.checkId}`, session))).result as {
      problems: string[];
    };
    expect(result.problems[0]).toMatch(/couldn't run on Bonded's side/);
    expect(logs.join()).not.toContain("secret-ish");
  });

  it("are capped per wallet per hour and on the chain, so they can't be spammed", async () => {
    // The chain's cap counts checks that took a turn in the lane, not ones that failed at once.
    const earlier = (
      await pg.db.pool.query(
        `SELECT count(*)::int AS n FROM connection_checks WHERE created_at > now() - interval '1 hour'
           AND (status IN ('queued','running') OR started_at IS NOT NULL)`,
      )
    ).rows[0].n as number;
    const capped = api({ checksPerWalletHourly: 2, checksHourly: earlier + 1 });
    // Throwaway wallets firing checks that fail at once (nothing connected): each wallet is
    // capped, and none of it uses up the chain's cap.
    for (let w = 0; w < 3; w++) {
      const s = await sessionFor(privateKeyToAccount(generatePrivateKey()), capped);
      const p = await newPreview(s, undefined, capped);
      expect((await send("POST", `/previews/${p.id}/checks`, {}, s, capped)).status).toBe(201);
      expect((await send("POST", `/previews/${p.id}/checks`, {}, s, capped)).status).toBe(201);
      const third = await send("POST", `/previews/${p.id}/checks`, {}, s, capped);
      expect(third.status).toBe(429);
      expect((await bodyOf(third)).error).toMatch(
        /You can run at most 2 checks an hour\. Try again after/,
      );
    }
    // A real check still gets its turn; the next one on the chain is refused.
    const runnerCheck = async () => {
      const s = await sessionFor(privateKeyToAccount(generatePrivateKey()), capped);
      const p = await newPreview(s, undefined, capped);
      const { token } = await bodyOf(
        await send("POST", `/previews/${p.id}/runner-token`, {}, s, capped),
      );
      await connect(token as string);
      return send("POST", `/previews/${p.id}/checks`, {}, s, capped);
    };
    const first = await runnerCheck();
    expect(first.status).toBe(201);
    const overall = await runnerCheck();
    expect(overall.status).toBe(429);
    expect((await bodyOf(overall)).error).toMatch(/Connection checks are busy right now/);
    // Not this test's to run: the later tests take their own checks off the queue.
    await pg.db.pool.query("UPDATE connection_checks SET status='failed' WHERE id=$1", [
      (await bodyOf(first)).checkId,
    ]);
  });

  it("are capped per client address, whichever wallets it signs in with", async () => {
    const capped = api({}, { ownerRequests: { checksPerClientHourly: 2 } });
    const statuses: number[] = [];
    for (let w = 0; w < 3; w++) {
      const s = await sessionFor(privateKeyToAccount(generatePrivateKey()), capped);
      const p = await newPreview(s, undefined, capped);
      statuses.push((await send("POST", `/previews/${p.id}/checks`, {}, s, capped)).status);
    }
    expect(statuses).toEqual([201, 201, 429]);
  });
});

describe("queuing a preview rating", () => {
  it("needs a passing check of exactly this connection in the last 24 hours", async () => {
    const session = await sessionFor(privateKeyToAccount(generatePrivateKey()));
    const preview = await newPreview(session);
    const { token } = await bodyOf(
      await send("POST", `/previews/${preview.id}/runner-token`, {}, session),
    );
    await connect(token as string, "tools", hash(1));
    const refused = await send("POST", `/previews/${preview.id}/rate`, {}, session);
    expect(refused.status).toBe(409);
    expect((await bodyOf(refused)).error).toBe(NEEDS_CHECK);
    await send("POST", `/previews/${preview.id}/checks`, {}, session);
    await workCheckOne(pg.db, chainId, { runCheck: passing });
    // The runner restarts with other code: the check was of the old code.
    await connect(token as string, "tools", hash(2));
    expect((await send("POST", `/previews/${preview.id}/rate`, {}, session)).status).toBe(409);
    // A new token is a new connection too.
    await connect(token as string, "tools", hash(1));
    const fresh = await bodyOf(
      await send("POST", `/previews/${preview.id}/runner-token`, {}, session),
    );
    await connect(fresh.token as string, "tools", hash(1));
    expect((await send("POST", `/previews/${preview.id}/rate`, {}, session)).status).toBe(409);
    await send("POST", `/previews/${preview.id}/checks`, {}, session);
    await workCheckOne(pg.db, chainId, { runCheck: passing });
    // A check older than a day doesn't count.
    await pg.db.pool.query(
      "UPDATE connection_checks SET finished_at=now()-interval '25 hours' WHERE subject=$1",
      [`preview:${preview.id}`],
    );
    expect((await send("POST", `/previews/${preview.id}/rate`, {}, session)).status).toBe(409);
    await pg.db.pool.query("UPDATE connection_checks SET finished_at=now() WHERE subject=$1", [
      `preview:${preview.id}`,
    ]);
    const queued = await send("POST", `/previews/${preview.id}/rate`, {}, session);
    expect(queued.status).toBe(202);
    const { runId } = await bodyOf(queued);
    const rating = (await pg.db.pool.query("SELECT * FROM ratings WHERE id=$1", [runId])).rows[0];
    expect(rating).toMatchObject({
      kind: "preview",
      agent_id: null,
      preview_id: preview.id,
      code_hash: hash(1),
      code_source: "git",
    });
    // Its owner's alone: not on the public feed; the run endpoint serves it to its owner only.
    expect((await app.request(`/arena/runs/${runId}`)).status).toBe(404);
    expect((await bodyOf(await get(`/arena/runs/${runId}`, session))).preview).toBe(true);
    const published = await pg.db.pool.query("SELECT 1 FROM events WHERE payload->>'runId'=$1", [
      runId,
    ]);
    expect(published.rowCount).toBe(0);
    // One at a time per preview.
    expect((await send("POST", `/previews/${preview.id}/rate`, {}, session)).status).toBe(409);
    // Clean up: this test's job shouldn't be taken by the next ones.
    await pg.db.pool.query("UPDATE jobs SET status='failed' WHERE id=$1", [runId]);
  });

  it("is capped per wallet and on the chain, even across many wallets", async () => {
    const earlier = (
      await pg.db.pool.query(
        "SELECT count(*)::int AS n FROM ratings WHERE kind='preview' AND created_at > now() - interval '1 day'",
      )
    ).rows[0].n as number;
    const capped = api({ previewPerWalletDaily: 1, previewDaily: earlier + 2 });
    const wallets = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()));
    const runs: string[] = [];
    for (const [i, w] of wallets.entries()) {
      const s = await sessionFor(w, capped);
      const { preview } = await readyPreview(s, hash(100 + i), capped);
      const res = await send("POST", `/previews/${preview.id}/rate`, {}, s, capped);
      if (i < 2) {
        expect(res.status).toBe(202);
        runs.push((await bodyOf(res)).runId as string);
        // The same wallet again (another preview): one a day.
        const { preview: second } = await readyPreview(s, hash(200 + i), capped);
        const again = await send("POST", `/previews/${second.id}/rate`, {}, s, capped);
        expect(again.status).toBe(429);
        expect((await bodyOf(again)).error).toMatch(
          /You can run at most 1 preview rating a day\. Try again after/,
        );
      } else {
        // The third wallet hits the chain's daily cap.
        expect(res.status).toBe(429);
        expect((await bodyOf(res)).error).toMatch(
          /Today's preview ratings are used up\. Try again after/,
        );
      }
    }
    await pg.db.pool.query("UPDATE jobs SET status='failed' WHERE id=ANY($1)", [runs]);
  });
});

describe("the preview worker", () => {
  // Only this block's previews are waiting.
  beforeAll(async () => {
    await pg.db.pool.query(
      "UPDATE jobs j SET status='failed' FROM ratings r WHERE j.id=r.id AND r.kind='preview' AND j.status='queued'",
    );
  });
  it("rates after official ratings, never attests, keeps the labelled report and tells the owner", async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const session = await sessionFor(wallet);
    const { preview } = await readyPreview(session, hash(0x5150));
    const { runId } = await bodyOf(await send("POST", `/previews/${preview.id}/rate`, {}, session));
    // An official remote rating waiting: the preview waits behind it.
    const official = (
      await pg.db.pool.query(
        `INSERT INTO agents(id,chain_id,agent_id,config,enabled,source,owner)
         VALUES($1,$2,999,'{"kind":"remote","mode":"tools"}',true,'user','0xabc') RETURNING id`,
        [`${chainId}:999`, chainId],
      )
    ).rows[0].id;
    const waiting = await pg.db.enqueue(official);
    expect(await pg.db.takePreviewJob(chainId)).toBeUndefined();
    await pg.db.pool.query("UPDATE jobs SET status='failed' WHERE id=$1", [waiting]);
    await pg.db.pool.query("UPDATE agents SET enabled=false WHERE id=$1", [official]);

    const sent: RatingNotification[] = [];
    const notifier = new Notifier(pg.db);
    vi.spyOn(notifier, "notify").mockImplementation(
      (_owner, n) => void sent.push(n as RatingNotification),
    );
    const errors: unknown[] = [];
    // The gateway's agent, stood in for by a built-in design: what matters here is the lane.
    const ran = await workPreviewOne(pg.db, chain, sandbox.rpcUrl, {
      remote: () => ratedAgent("hardened"),
      heldOut: { perClass: 0 },
      selectAttacks: (attacks) => attacks.filter((a) => a.id === "A6-operator-impersonation-001"),
      notifier,
      onError: (e) => errors.push(e),
    });
    expect(ran).toBe(true);
    expect(errors).toEqual([]);
    const page = await bodyOf(await get(`/previews/${preview.id}`, session));
    const rating = page.rating as Record<string, unknown>;
    expect(["done", "failed"]).toContain(rating.status);
    expect(rating.progress).toMatchObject({
      done: ONE_ATTACK_EPISODES,
      total: ONE_ATTACK_EPISODES,
    });
    expect(rating.codeHash).toBe(hash(0x5150));
    const report = await bodyOf(await get(`/previews/${preview.id}/report`, session));
    expect(report).toMatchObject({
      label: "Preview: not on chain, not insurable",
      attested: false,
    });
    expect((report.report as { preview: unknown }).preview).toMatchObject({
      attested: false,
      codeHash: hash(0x5150),
    });
    // Never attested or posted.
    expect(
      (await pg.db.pool.query("SELECT 1 FROM attestations WHERE id=$1", [runId])).rowCount,
    ).toBe(0);
    expect(
      (await pg.db.pool.query("SELECT attestation FROM ratings WHERE id=$1", [runId])).rows[0]
        .attestation,
    ).toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      ratingId: runId,
      previewId: preview.id,
      label: "Preview: not on chain, not insurable",
    });
    // Progress: counts and an ETA, and the end.
    const progress = await sse(await get(`/ratings/${runId}/progress`, session));
    expect(progress).toHaveLength(1);
    expect(progress[0]!.data).toMatchObject({
      done: ONE_ATTACK_EPISODES,
      total: ONE_ATTACK_EPISODES,
      etaSeconds: null,
    });
    expect(["done", "failed"]).toContain(progress[0]!.data.status);
  }, 240_000);

  it("fails at once, saying why, on a worker without the gateway", async () => {
    const session = await sessionFor(privateKeyToAccount(generatePrivateKey()));
    const { preview } = await readyPreview(session, hash(0x5151));
    await send("POST", `/previews/${preview.id}/rate`, {}, session);
    await workPreviewOne(pg.db, chain, sandbox.rpcUrl, {});
    const page = await bodyOf(await get(`/previews/${preview.id}`, session));
    expect(page).toMatchObject({ status: "failed" });
    expect(page.reason).toMatch(/gateway not available/);
  }, 120_000);
});

describe("Agent URLs", () => {
  it("store the secret encrypted, return it once, verify the URL and use its version as the code", async () => {
    const logs: string[] = [];
    const spies = (["log", "info", "warn", "error"] as const).map((m) =>
      vi
        .spyOn(console, m)
        .mockImplementation((...args: unknown[]) => void logs.push(args.join(" "))),
    );
    try {
      const session = await sessionFor();
      const preview = await newPreview(session, { mode: "tools", connection: "url" });
      expect(preview.connection).toBe("url");
      // A runner token isn't for a URL-mode preview.
      expect((await send("POST", `/previews/${preview.id}/runner-token`, {}, session)).status).toBe(
        409,
      );
      const made = await send(
        "POST",
        `/previews/${preview.id}/agent-url`,
        { url: "https://agent.example/bonded" },
        session,
      );
      expect(made.status).toBe(201);
      const body = await bodyOf(made);
      const secret = body.secret as string;
      expect(secret).toMatch(/^bonded_as_/);
      expect(made.headers.get("cache-control")).toBe("no-store");
      // Saved, not yet challenged: the agent needs its secret first.
      expect(body).toMatchObject({
        url: "https://agent.example/bonded",
        verified: false,
        verifiedAt: null,
        codeHash: null,
      });
      expect(verifyCalls.find((v) => v.secret === secret)).toBeUndefined();
      // An unverified URL can't be checked or rated.
      const early = await bodyOf(await send("POST", `/previews/${preview.id}/checks`, {}, session));
      expect((early.result as { problems: string[] }).problems[0]).toMatch(/Verify your Agent URL/);
      // Not in the clear in the database, and never in any later response.
      const row = (
        await pg.db.pool.query("SELECT * FROM agent_urls WHERE id=$1", [body.agentUrlId])
      ).rows[0];
      expect(JSON.stringify(row)).not.toContain(secret);
      expect(row.secret_ciphertext).toMatch(/^v1\./);
      const verify = await send("POST", `/previews/${preview.id}/agent-url/verify`, {}, session);
      expect(await bodyOf(verify)).toMatchObject({
        verified: true,
        url: "https://agent.example/bonded",
        verifiedAt: expect.any(String),
        version: "v1.2.3",
        codeHash: {
          value: urlCodeHash("v1.2.3"),
          source: "url",
          detail: "v1.2.3",
          reportedBy: "agent",
          label: "reported by the agent",
        },
      });
      // The verifier got the real secret, to sign its challenge with.
      expect(verifyCalls.at(-1)).toEqual({ url: "https://agent.example/bonded", secret });
      for (const path of [
        `/previews/${preview.id}`,
        `/previews/${preview.id}/agent-url`,
        `/previews/${preview.id}/checks`,
      ]) {
        const text = await (await get(path, session)).text();
        expect(text, path).not.toContain(secret);
      }
      const page = await bodyOf(await get(`/previews/${preview.id}`, session));
      expect(page.agentUrl).toMatchObject({
        url: "https://agent.example/bonded",
        verified: true,
        version: "v1.2.3",
      });
      expect(page.code).toEqual({ hash: urlCodeHash("v1.2.3"), source: "url" });
      // Its checks reach the agent by URL, with the secret, never the runner.
      let reached: unknown;
      const check = await bodyOf(await send("POST", `/previews/${preview.id}/checks`, {}, session));
      await workCheckOne(pg.db, chainId, {
        secrets,
        runCheck: async (request) => {
          reached = request.connection;
          return passing(request);
        },
      });
      expect(reached).toEqual({
        kind: "url",
        url: "https://agent.example/bonded",
        secret,
        registration: `preview:${preview.id}`,
      });
      expect((await bodyOf(await get(`/checks/${check.checkId}`, session))).status).toBe("passed");
      const events = await (await get(`/checks/${check.checkId}/events`, session)).text();
      expect(events).not.toContain(secret);
      // Rotating: a new secret, the old URL row revoked; the check was of the old one.
      const rotated = await bodyOf(
        await send(
          "POST",
          `/previews/${preview.id}/agent-url`,
          { url: "https://agent.example/bonded" },
          session,
        ),
      );
      expect(rotated.secret).not.toBe(secret);
      expect(
        (await bodyOf(await get(`/previews/${preview.id}/agent-url`, session))).agentUrl,
      ).toMatchObject({ verified: false, agentUrlId: rotated.agentUrlId });
      expect((await send("POST", `/previews/${preview.id}/rate`, {}, session)).status).toBe(409);
      // Revoking.
      expect(
        await bodyOf(await send("DELETE", `/previews/${preview.id}/agent-url`, undefined, session)),
      ).toEqual({ revoked: 1 });
      expect(
        (await bodyOf(await get(`/previews/${preview.id}/agent-url`, session))).agentUrl,
      ).toBeNull();
      expect(logs.join("\n")).not.toContain(secret);
      expect(logs.join("\n")).not.toContain(rotated.secret as string);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("refuse unsafe URLs, Bonded's own hosts, and every URL when the secret key isn't set", async () => {
    const session = await sessionFor();
    const preview = await newPreview(session, { mode: "tools", connection: "url" });
    for (const [url, why] of [
      ["http://agent.example/x", /https/],
      ["https://user:pw@agent.example/x", /user name or password/],
      ["https://agent.example/x#frag", /fragment/],
      ["https://localhost/x", /public internet/],
      ["https://gateway.example/agent", /Bonded's own/],
      ["https://app.bonded.example/agent", /Bonded's own/],
      ["not a url", /isn't a URL/],
    ] as const) {
      const res = await send("POST", `/previews/${preview.id}/agent-url`, { url }, session);
      expect(res.status, url).toBe(400);
      expect((await bodyOf(res)).error, url).toMatch(why);
    }
    const tooBig = await send(
      "POST",
      `/previews/${preview.id}/agent-url`,
      { url: `https://a.example/${"x".repeat(20_000)}` },
      session,
    );
    expect(tooBig.status).toBe(413);
    const off = api({}, { secrets: undefined });
    const s = await sessionFor(owner, off);
    const refused = await send("POST", "/previews", { mode: "tools", connection: "url" }, s, off);
    expect(refused.status).toBe(409);
    expect((await bodyOf(refused)).error).toMatch(/AGENT_URL_SECRET_KEY isn't set/);
    expect(
      (
        await send(
          "POST",
          `/previews/${preview.id}/agent-url`,
          { url: "https://agent.example/x" },
          s,
          off,
        )
      ).status,
    ).toBe(409);
  });

  it("say why verification failed (422, the URL kept unverified), and limit verifications of one host", async () => {
    const failing = api(
      {},
      { verifyAgentUrl: async () => ({ ok: false, problem: "your URL answered 404" }) },
    );
    const session = await sessionFor(owner, failing);
    const preview = await newPreview(session, { mode: "tools", connection: "url" }, failing);
    const saved = await send(
      "POST",
      `/previews/${preview.id}/agent-url`,
      { url: "https://busy.example/a" },
      session,
      failing,
    );
    expect(saved.status).toBe(201);
    const verify = () =>
      send("POST", `/previews/${preview.id}/agent-url/verify`, {}, session, failing);
    const res = await verify();
    expect(res.status).toBe(422);
    // The gateway's reason, as a full sentence.
    expect((await bodyOf(res)).error).toBe("Your URL answered 404.");
    expect((await pg.db.agentUrl(`preview:${preview.id}`))?.verifiedAt).toBeNull();
    for (let i = 1; i < 10; i++) await verify();
    const limited = await verify();
    expect(limited.status).toBe(429);
    expect((await bodyOf(limited)).retryAt).toEqual(expect.any(String));
  });

  it("reach the agent through the gateway's URL transport in a rating, never with a TEE", async () => {
    const { gatewayAgents } = await import("../src/remote-agent.js");
    const factory = gatewayAgents({} as never);
    const request = {
      agentKey: "preview:x",
      chainId,
      agentId: "preview:x",
      mode: "tools" as const,
      codeHash: hash(1),
      connection: {
        kind: "url" as const,
        url: "https://a.example",
        secret: "s",
        registration: "preview:x",
      },
    };
    const agent = factory(request, sandbox) as unknown as { transport: unknown };
    expect(agent.transport).toEqual(request.connection);
    expect(() =>
      factory(
        {
          ...request,
          tee: { keyId: hash(2), evmAddress: owner.address, verify: async () => ({}) as never },
        },
        sandbox,
      ),
    ).toThrow(/through its runner/);
  });
});

describe("registered agents", () => {
  const remote: RemoteAgentSpec = { mode: "tools" };
  async function register(spec: RemoteAgentSpec, extra: Record<string, unknown> = {}) {
    tick();
    const timestamp = now();
    const agentId = mine.agentId.toString();
    const signature = await owner.signMessage({
      message: selfServeMessage({
        action: "register",
        chainId,
        agentId,
        vault: mine.address,
        kind: "remote",
        mandateHash: mandateHash(mine.mandate),
        remote: spec,
        timestamp,
      }),
    });
    return send("POST", "/self/agents", {
      agentId,
      vault: mine.address,
      kind: "remote",
      mandate: mine.mandate,
      ...spec,
      ...extra,
      timestamp,
      signature,
    });
  }
  async function rate() {
    tick();
    const timestamp = now();
    const agentId = mine.agentId.toString();
    const signature = await owner.signMessage({
      message: selfServeMessage({ action: "rate", chainId, agentId, timestamp }),
    });
    return send("POST", `/self/agents/${agentId}/rate`, { timestamp, signature });
  }

  it("register with no code hash (the runner's is used) and need a passing check to be rated", async () => {
    const session = await sessionFor();
    const preview = await newPreview(session);
    const res = await register(remote, { previewId: preview.id });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    expect(await bodyOf(res)).toMatchObject({ connection: "runner", codeSource: "auto" });
    // "Make it official": the preview is linked from the agent.
    const page = await bodyOf(await app.request(`/self/agents/${mine.agentId}`));
    expect(page).toMatchObject({
      codeHash: null,
      codeSource: "auto",
      connection: "runner",
      // Public: only that it came from a preview, not which (or its rating).
      fromPreview: true,
    });
    // A TEE needs a declared code hash.
    const tee = { url: "https://tee.example", composeHash: hash(9) };
    expect((await register({ mode: "chain", tee })).status).toBe(400);
    tick();
    const agentId = mine.agentId.toString();
    const timestamp = now();
    const token = (
      await bodyOf(
        await send("POST", `/self/agents/${agentId}/runner-token`, {
          timestamp,
          signature: await owner.signMessage({
            message: selfServeMessage({ action: "runner-token", chainId, agentId, timestamp }),
          }),
        }),
      )
    ).token as string;
    // A runner that reports no code: nothing to rate.
    await connect(token, "tools");
    expect((await bodyOf(await rate())).error).toMatch(/reported no code hash/i);
    await connect(token, "tools", hash(0xbeef));
    const unchecked = await rate();
    expect(unchecked.status).toBe(409);
    expect((await bodyOf(unchecked)).error).toBe(NEEDS_CHECK);
    // Only the registry's owner may check it.
    const theirs = await sessionFor(stranger);
    expect((await send("POST", `/self/agents/${agentId}/checks`, {}, theirs)).status).toBe(403);
    const check = await bodyOf(await send("POST", `/self/agents/${agentId}/checks`, {}, session));
    expect(check).toMatchObject({ queued: true, codeHash: hash(0xbeef) });
    await workCheckOne(pg.db, chainId, { runCheck: passing });
    const queued = await rate();
    expect(queued.status, JSON.stringify(await queued.clone().json())).toBe(202);
    const { runId } = await bodyOf(queued);
    const run = await bodyOf(await app.request(`/arena/runs/${runId}`));
    expect(run).toMatchObject({ codeHash: hash(0xbeef), codeSource: "git", progress: { done: 0 } });
    // The cost estimate comes from the check, labelled as one.
    // The estimate is the owner's: 401 without a session, "not found" for another wallet.
    expect((await get(`/self/agents/${agentId}/estimate`)).status).toBe(401);
    expect((await get(`/self/agents/${agentId}/estimate`, theirs)).status).toBe(404);
    const estimate = await bodyOf(await get(`/self/agents/${agentId}/estimate`, session));
    expect(estimate).toMatchObject({
      estimate: true,
      perEpisode: { toolCalls: 2, seconds: 4, costUsd: 0.002 },
      basis: `connection check ${check.checkId}`,
      usageReported: true,
    });
    expect((estimate.total as { costUsd: number }).costUsd).toBeCloseTo(
      0.002 * (estimate.episodes as number),
      4,
    );
    await pg.db.pool.query("UPDATE jobs SET status='failed' WHERE id=$1", [runId]);
    await pg.db.pool.query("UPDATE ratings SET status='failed' WHERE id=$1", [runId]);
  });

  it("can be reached by Agent URL instead of a runner", async () => {
    const res = await register({ mode: "tools", connection: "url" });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const session = await sessionFor();
    const agentId = mine.agentId.toString();
    tick();
    const timestamp = now();
    const token = await send("POST", `/self/agents/${agentId}/runner-token`, {
      timestamp,
      signature: await owner.signMessage({
        message: selfServeMessage({ action: "runner-token", chainId, agentId, timestamp }),
      }),
    });
    expect(token.status).toBe(409);
    expect(
      (
        await send(
          "POST",
          `/self/agents/${agentId}/agent-url`,
          { url: "https://mine.example/agent" },
          stranger.address,
        )
      ).status,
    ).toBe(401);
    const made = await bodyOf(
      await send(
        "POST",
        `/self/agents/${agentId}/agent-url`,
        { url: "https://mine.example/agent" },
        session,
      ),
    );
    expect(made.secret).toMatch(/^bonded_as_/);
    expect(
      (await bodyOf(await send("POST", `/self/agents/${agentId}/agent-url/verify`, {}, session)))
        .verified,
    ).toBe(true);
    const page = await bodyOf(await app.request(`/self/agents/${agentId}`));
    expect(page).toMatchObject({ connection: "url", connectionReady: true });
    // The public page never shows the URL, let alone the secret.
    expect(JSON.stringify(page)).not.toContain("mine.example");
    // Registering again revokes its URL.
    expect((await register(remote)).status).toBe(201);
    expect(await pg.db.agentUrl(`${chainId}:${agentId}`)).toBeUndefined();
  });

  it("an estimate without reported usage says so and gives time only", async () => {
    const session = await sessionFor(privateKeyToAccount(generatePrivateKey()));
    const preview = await newPreview(session);
    const { token } = await bodyOf(
      await send("POST", `/previews/${preview.id}/runner-token`, {}, session),
    );
    await connect(token as string, "tools", hash(3));
    expect((await get(`/previews/${preview.id}/estimate`, session)).status).toBe(409);
    expect((await get(`/previews/${preview.id}/estimate`)).status).toBe(401);
    const other = await sessionFor(stranger);
    expect((await get(`/previews/${preview.id}/estimate`, other)).status).toBe(404);
    expect((await get(`/previews/${preview.id}/notifications`)).status).toBe(401);
    expect((await get(`/previews/${preview.id}/notifications`, other)).status).toBe(404);
    expect((await get(`/previews/${preview.id}/notifications`, session)).status).toBe(200);
    await send("POST", `/previews/${preview.id}/checks`, {}, session);
    await workCheckOne(pg.db, chainId, {
      runCheck: async (r) => {
        const result = await passing(r);
        delete result.usage;
        return result;
      },
    });
    const estimate = await bodyOf(await get(`/previews/${preview.id}/estimate`, session));
    expect(estimate.usageReported).toBe(false);
    expect(estimate.perEpisode).not.toHaveProperty("costUsd");
    expect(estimate.total).not.toHaveProperty("costUsd");
    expect(estimate.note).toMatch(/didn't report its model usage/);
    // The runner now runs other code: the check was of the old code, so there is no estimate.
    await connect(token as string, "tools", hash(4));
    expect((await get(`/previews/${preview.id}/estimate`, session)).status).toBe(409);
  });
});

describe("request limits", () => {
  it("limit writes per client address", async () => {
    const limited = api(
      {},
      { ownerRequests: { writes: { perClient: 2, total: 100, windowMs: 60_000 } } },
    );
    const session = await sessionFor(owner, limited);
    expect((await send("POST", "/previews", { mode: "tools" }, session, limited)).status).toBe(201);
    expect((await send("POST", "/previews", { mode: "tools" }, session, limited)).status).toBe(201);
    const third = await send("POST", "/previews", { mode: "tools" }, session, limited);
    expect(third.status).toBe(429);
  });
});

describe("round 2, as the web app calls it", () => {
  it("says whether a wallet may start a preview, and when it can again", async () => {
    const capped = api({ previewPerWalletDaily: 1 });
    const wallet = privateKeyToAccount(generatePrivateKey());
    const before = await bodyOf(
      await get(`/previews/allowance?wallet=${wallet.address}`, undefined, capped),
    );
    expect(before).toMatchObject({
      allowed: true,
      reason: null,
      retryAt: null,
      plan: { episodes: expect.any(Number) },
    });
    expect(before.queued).toEqual(expect.any(Number));
    const session = await sessionFor(wallet, capped);
    const { preview } = await readyPreview(session, hash(0x7001), capped);
    const queued = await send("POST", `/previews/${preview.id}/rate`, {}, session, capped);
    expect(queued.status).toBe(202);
    const { runId, queue } = await bodyOf(queued);
    expect(queue).toMatchObject({ position: expect.any(Number) });
    const after = await bodyOf(
      await get(`/previews/allowance?wallet=${wallet.address}`, undefined, capped),
    );
    expect(after).toMatchObject({ allowed: false, retryAt: expect.any(String) });
    expect(after.reason).toMatch(/at most 1 preview rating a day/);
    expect((await get("/previews/allowance?wallet=nope", undefined, capped)).status).toBe(400);
    await pg.db.pool.query("UPDATE jobs SET status='failed' WHERE id=$1", [runId]);
  });

  it("signs a registered agent's Agent URL, check and notifications with byoaMessage, each signature once", async () => {
    const agentId = mine.agentId.toString();
    // The agent from the tests above is registered for its runner; registering a URL switches it.
    const signedBody = async (
      action: "agent-url" | "check" | "notifications",
      body: Record<string, unknown>,
      fields: Record<string, string> = {},
      who = owner,
    ) => {
      tick();
      const timestamp = now();
      const signature = await who.signMessage({
        message: byoaMessage({ action, chainId, agentId, fields, timestamp }),
      });
      return { ...body, timestamp, signature };
    };
    const url = "https://signed.example/agent";
    const req = await signedBody("agent-url", { url }, { url });
    const made = await send("POST", `/self/agents/${agentId}/agent-url`, req);
    expect(made.status, JSON.stringify(await made.clone().json())).toBe(201);
    expect((await bodyOf(made)).secret).toMatch(/^bonded_as_/);
    // The same signature again: refused, nothing rotated.
    const replay = await send("POST", `/self/agents/${agentId}/agent-url`, req);
    expect(replay.status).toBe(409);
    // The agent has its secret now: Bonded challenges it (signed too, a fresh signature).
    const verified = await send(
      "POST",
      `/self/agents/${agentId}/agent-url/verify`,
      await signedBody("agent-url", {}, { url }),
    );
    expect(verified.status, JSON.stringify(await verified.clone().json())).toBe(200);
    // Signed for another URL than sent; signed by someone else.
    expect(
      (
        await send(
          "POST",
          `/self/agents/${agentId}/agent-url`,
          await signedBody("agent-url", { url: "https://other.example/x" }, { url }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await send(
          "POST",
          `/self/agents/${agentId}/agent-url`,
          await signedBody("agent-url", { url }, { url }, stranger),
        )
      ).status,
    ).toBe(403);
    const runner = await bodyOf(await app.request(`/self/agents/${agentId}/runner`));
    expect(runner).toMatchObject({
      connection: "url",
      // Public: no URL, no check id.
      agentUrl: { configured: true, version: "v1.2.3", verifiedAt: expect.any(String) },
      codeHash: { source: "url", reportedBy: "agent" },
    });
    expect(JSON.stringify(runner)).not.toContain("bonded_as_");
    const check = await send(
      "POST",
      `/self/agents/${agentId}/checks`,
      await signedBody("check", {}),
    );
    expect(check.status).toBe(201);
    expect((await bodyOf(check)).checkId).toEqual(expect.any(String));
    await workCheckOne(pg.db, chainId, { secrets, runCheck: passing });
    expect(
      (await bodyOf(await app.request(`/self/agents/${agentId}/runner`))).lastCheck,
    ).toMatchObject({
      status: "passed",
      connection: "url",
    });
    // Notifications: PUT signed, GET masked.
    const put = await app.request(`/self/agents/${agentId}/notifications`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        await signedBody(
          "notifications",
          { webhookUrl: "https://hooks.example/t/secret-path", email: null },
          { webhook: "https://hooks.example/t/secret-path", email: "none" },
        ),
      ),
    });
    expect(put.status, JSON.stringify(await put.clone().json())).toBe(200);
    expect((await bodyOf(put)).webhookSecret).toMatch(/^bonded_ws_/);
    // Reading them needs the owner's session: 401 without, "not found" for anyone else.
    expect((await app.request(`/self/agents/${agentId}/notifications`)).status).toBe(401);
    const theirs = await sessionFor(stranger);
    expect((await get(`/self/agents/${agentId}/notifications`, theirs)).status).toBe(404);
    const shown = await bodyOf(
      await get(`/self/agents/${agentId}/notifications`, await sessionFor()),
    );
    expect(shown).toEqual({
      webhook: { url: "https://hooks.example/…" },
      email: null,
      emailAvailable: false,
      webhookAvailable: true,
      muted: [],
      types: expect.arrayContaining(["low_gas"]),
    });
    // Revoking the URL puts the agent back on its runner.
    const session = await sessionFor();
    await send("DELETE", `/self/agents/${agentId}/agent-url`, undefined, session);
    expect((await bodyOf(await app.request(`/self/agents/${agentId}/runner`))).connection).toBe(
      "runner",
    );
  });

  it("caps Agent URL verifications per wallet and in all, so a spammer across wallets is stopped", async () => {
    const capped = api({ urlVerifiesPerWalletHourly: 2, urlVerifiesHourly: 3 });
    const verify = async (who: PrivateKeyAccount) => {
      const s = await sessionFor(who, capped);
      const p = await newPreview(s, { mode: "tools", connection: "url" }, capped);
      const saved = await send(
        "POST",
        `/previews/${p.id}/agent-url`,
        { url: `https://spam${Math.random()}.example/a` },
        s,
        capped,
      );
      expect(saved.status).toBe(201);
      return send("POST", `/previews/${p.id}/agent-url/verify`, {}, s, capped);
    };
    const a = privateKeyToAccount(generatePrivateKey());
    const b = privateKeyToAccount(generatePrivateKey());
    expect((await verify(a)).status).toBe(200);
    expect((await verify(a)).status).toBe(200);
    const third = await verify(a);
    expect(third.status).toBe(429);
    expect((await bodyOf(third)).retryAt).toEqual(expect.any(String));
    expect((await verify(b)).status).toBe(200);
    // Three in all this hour: a fourth wallet is refused too.
    expect((await verify(privateKeyToAccount(generatePrivateKey()))).status).toBe(429);
  });

  it("compares code hashes in any case, and never charges the agent for a URL Bonded couldn't call", async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const session = await sessionFor(wallet);
    const declared = `0x${"AB".repeat(32)}`;
    const p = await newPreview(session, { mode: "tools", codeHash: declared });
    const { token } = await bodyOf(
      await send("POST", `/previews/${p.id}/runner-token`, {}, session),
    );
    await connect(token as string);
    await send("POST", `/previews/${p.id}/checks`, {}, session);
    await workCheckOne(pg.db, chainId, { runCheck: passing });
    const queued = await send("POST", `/previews/${p.id}/rate`, {}, session);
    expect(queued.status).toBe(202);
    await pg.db.pool.query("UPDATE jobs SET status='failed' WHERE id=$1", [
      (await bodyOf(queued)).runId,
    ]);
    const { bondedUrlFailure, ratingFailure } = await import("../src/remote-agent.js");
    const { AgentUrlUnavailableError } = await import("@bonded/arena");
    // The gateway's own flag decides; what the agent's URL said never does.
    expect(bondedUrlFailure({ agentSummary: { remote: { bondedProblem: "rate limit" } } })).toBe(
      true,
    );
    expect(
      bondedUrlFailure({ agentSummary: { finalMessage: "the agent's URL failed: 500" } }),
    ).toBe(false);
    expect(
      bondedUrlFailure({ agentSummary: { finalMessage: "the agent's URL wasn't called" } }),
    ).toBe(false);
    // rateAgent stops such a rating with AgentUrlUnavailableError: retried, not charged.
    expect(ratingFailure(new AgentUrlUnavailableError("stopped: Bonded couldn't call it"))).toEqual(
      {
        reason: "stopped: Bonded couldn't call it",
        final: false,
      },
    );
  });
});

describe("review fixes (each a regression test for a finding)", () => {
  it("a signature written another way (v as 0/1, not 27/28) is the same request: one session, one use", async () => {
    tick();
    const timestamp = now();
    const sig = await owner.signMessage({
      message: selfServeMessage({ action: "sign-in", chainId, wallet: owner.address, timestamp }),
    });
    const v = parseInt(sig.slice(130), 16);
    const alt = sig.slice(0, 130) + (v - 27).toString(16).padStart(2, "0");
    expect(
      (
        await send("POST", "/previews/session", {
          wallet: owner.address,
          timestamp,
          signature: sig,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await send("POST", "/previews/session", {
          wallet: owner.address,
          timestamp,
          signature: alt,
        })
      ).status,
    ).toBe(409);
    // The same for a registered agent's signed actions.
    tick();
    const agentId = mine.agentId.toString();
    const t2 = now();
    const s2 = await owner.signMessage({
      message: byoaMessage({ action: "check", chainId, agentId, timestamp: t2 }),
    });
    const alt2 =
      s2.slice(0, 130) + (parseInt(s2.slice(130), 16) - 27).toString(16).padStart(2, "0");
    const first = await send("POST", `/self/agents/${agentId}/checks`, {
      timestamp: t2,
      signature: s2,
    });
    expect([201, 409]).toContain(first.status);
    const again = await send("POST", `/self/agents/${agentId}/checks`, {
      timestamp: t2,
      signature: alt2,
    });
    expect(again.status).toBe(409);
    expect((await bodyOf(again)).error).toMatch(/already used/);
    await pg.db.pool.query("UPDATE connection_checks SET status='failed' WHERE status='queued'");
  });

  it("the public runner page shows no Agent URL and no check id, and a check is its owner's alone", async () => {
    const session = await sessionFor();
    const agentId = mine.agentId.toString();
    await send(
      "POST",
      `/self/agents/${agentId}/agent-url`,
      { url: "https://secret-host.example/hook?k=abc" },
      session,
    );
    await send("POST", `/self/agents/${agentId}/agent-url/verify`, {}, session);
    const leaky: ConnectionCheckRunner = async (r) => {
      r.onEvent({
        type: "done",
        exitCode: 0,
        durationMs: 10,
        stdoutTail: "OPENAI_API_KEY=sk-live-123",
      });
      return passing(r);
    };
    const made = await bodyOf(await send("POST", `/self/agents/${agentId}/checks`, {}, session));
    await workCheckOne(pg.db, chainId, { runCheck: leaky, secrets });
    const pub = await (await app.request(`/self/agents/${agentId}/runner`)).text();
    expect(pub).not.toContain("secret-host.example");
    expect(pub).not.toContain(made.checkId as string);
    expect(pub).not.toContain("sk-live-123");
    // The check and its stream: 401 without a session, "not found" to anyone else.
    expect((await app.request(`/checks/${made.checkId}`)).status).toBe(401);
    expect((await app.request(`/checks/${made.checkId}/events`)).status).toBe(401);
    const theirs = await sessionFor(stranger);
    expect((await get(`/checks/${made.checkId}`, theirs)).status).toBe(404);
    expect((await get(`/checks/${made.checkId}/events`, theirs)).status).toBe(404);
    // The owner sees its output.
    expect(
      JSON.stringify((await bodyOf(await get(`/checks/${made.checkId}`, session))).events),
    ).toContain("sk-live-123");
    // An EventSource gets a one-use ticket for its own check only.
    const ticket = (
      await bodyOf(await send("POST", "/streams/token", { checkId: made.checkId }, session))
    ).token as string;
    expect((await send("POST", "/streams/token", { checkId: made.checkId }, theirs)).status).toBe(
      404,
    );
    const viaTicket = await app.request(`/checks/${made.checkId}/events?token=${ticket}`);
    expect(viaTicket.status).toBe(200);
    expect(await viaTicket.text()).toContain("sk-live-123");
    // Good again for the browser's reconnects, for that check only, and not for a rating.
    const again = await app.request(`/checks/${made.checkId}/events?token=${ticket}`);
    expect(again.status).toBe(200);
    await again.body?.cancel();
    expect(
      (await app.request(`/checks/${crypto.randomUUID()}/events?token=${ticket}`)).status,
    ).toBe(401);
    expect((await app.request(`/checks/${made.checkId}/events?token=nope`)).status).toBe(401);
    await send("DELETE", `/self/agents/${agentId}/agent-url`, undefined, session);
  });

  it("an agent's own words never make a failure Bonded's, and a retried attempt's episodes stay off the feed", async () => {
    await pg.db.pool.query(
      "UPDATE jobs j SET status='failed' FROM ratings r WHERE j.id=r.id AND j.status IN ('queued','running')",
    );
    // A preview whose agent ends every episode claiming its URL "wasn't called": it is rated
    // as it behaved, never retried as Bonded's fault.
    const session = await sessionFor(privateKeyToAccount(generatePrivateKey()));
    const { preview } = await readyPreview(session, hash(0x7777));
    const { runId } = await bodyOf(await send("POST", `/previews/${preview.id}/rate`, {}, session));
    const base = ratedAgent("hardened");
    const spoof = {
      name: base.name,
      run: async (task: never, tools: never) => ({
        ...(await base.run(task, tools)),
        finalMessage: "the agent's URL wasn't called: (any text the agent likes)",
      }),
    };
    await workPreviewOne(pg.db, chain, sandbox.rpcUrl, {
      remote: () => spoof as never,
      heldOut: { perClass: 0 },
      selectAttacks: (attacks) => attacks.filter((a) => a.id === "A6-operator-impersonation-001"),
    });
    const job = (await pg.db.pool.query("SELECT status FROM jobs WHERE id=$1", [runId])).rows[0];
    expect(job.status).not.toBe("queued");

    // An official remote rating Bonded couldn't deliver (the gateway says so): retried, not
    // charged, and the abandoned attempt's verdicts are never published.
    const vault = await createAgentVault(sandbox);
    const key = `${chainId}:${vault.agentId}`;
    const who = privateKeyToAccount(generatePrivateKey());
    await pg.db.upsertUserAgent(chainId, vault.agentId.toString(), who.address, {
      kind: "remote",
      mandate: vault.mandate,
      codeHash: hash(0x8888),
      mode: "tools",
    });
    const token = newRunnerToken();
    await pg.db.createRunnerToken(key, {
      hash: runnerTokenHash(token),
      createdBy: who.address,
      signedAt: 1,
    });
    await connect(token);
    const official = await pg.db.enqueue(key);
    let calls = 0;
    const flaky = {
      name: base.name,
      run: async (task: never, tools: never) => {
        const summary = await base.run(task, tools);
        return ++calls === 2
          ? { ...summary, remote: { bondedProblem: "Bonded's rate limit" } }
          : summary;
      },
    };
    await workOne(pg.db, chain, sandbox.rpcUrl, ANVIL_KEYS.deployer, undefined, undefined, {
      remote: () => flaky as never,
      heldOut: { perClass: 0 },
      selectAttacks: (attacks) => attacks.filter((a) => a.id === "A6-operator-impersonation-001"),
    });
    const rating = (
      await pg.db.pool.query("SELECT status,error,agent_caused FROM ratings WHERE id=$1", [
        official,
      ])
    ).rows[0];
    expect(rating).toMatchObject({ status: "queued", agent_caused: false });
    expect(rating.error).toMatch(/Bonded couldn't call the agent's URL/);
    expect((await pg.db.agentStanding(key)).cooldownUntil).toBeNull();
    const published = await pg.db.pool.query(
      "SELECT 1 FROM events WHERE topic='rating.episode' AND payload->>'runId'=$1",
      [official],
    );
    expect(published.rowCount).toBe(0);
    await pg.db.pool.query("UPDATE jobs SET status='failed' WHERE id=$1", [official]);
  }, 240_000);

  it("progress streams are the owner's, capped per client and per rating", async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const session = await sessionFor(wallet);
    const { preview } = await readyPreview(session, hash(0x9999));
    const { runId } = await bodyOf(await send("POST", `/previews/${preview.id}/rate`, {}, session));
    expect((await app.request(`/ratings/${runId}/progress`)).status).toBe(401);
    expect((await get(`/ratings/${runId}/progress`, await sessionFor(stranger))).status).toBe(404);
    // A preview's run and report: "not found" without its owner's session.
    expect((await app.request(`/arena/runs/${runId}`)).status).toBe(404);
    expect((await app.request(`/arena/runs/${runId}/report`)).status).toBe(404);
    expect((await get(`/arena/runs/${runId}`, session)).status).toBe(200);
    const held: Response[] = [];
    for (let i = 0; i < 3; i++) held.push(await get(`/ratings/${runId}/progress`, session));
    expect(held.map((r) => r.status)).toEqual([200, 200, 200]);
    // A fourth on the same rating: refused, and the slots stay free for everyone else.
    expect((await get(`/ratings/${runId}/progress`, session)).status).toBe(429);
    for (const r of held) await r.body?.cancel();
    await pg.db.pool.query("UPDATE jobs SET status='failed' WHERE id=$1", [runId]);
  });

  it("forgets used signatures and long-expired sessions after a day", async () => {
    await pg.db.pool.query(
      "INSERT INTO used_signatures(hash,created_at) VALUES('old-sig', now()-interval '2 days')",
    );
    await pg.db.pool.query(
      `INSERT INTO owner_sessions(token_hash,chain_id,wallet,signature_hash,expires_at)
       VALUES('old-session',1,'0xa','old-session-sig',now()-interval '2 days')`,
    );
    const pruned = await pg.db.pruneOwnerAuth();
    expect(pruned.signatures).toBeGreaterThanOrEqual(1);
    expect(pruned.sessions).toBeGreaterThanOrEqual(1);
    expect(
      (await pg.db.pool.query("SELECT 1 FROM used_signatures WHERE hash='old-sig'")).rowCount,
    ).toBe(0);
  });
});

describe("one sign-in for the agent page, local Agent URLs, and code details", () => {
  it("lets the owner's session ask for a runner token and a rating of an owned agent", async () => {
    const agentId = mine.agentId.toString();
    const session = await sessionFor();
    // Someone else's session: the registry says they don't own it.
    const theirs = await sessionFor(stranger);
    const refused = await send("POST", `/self/agents/${agentId}/runner-token`, {}, theirs);
    expect(refused.status).toBe(403);
    const made = await send("POST", `/self/agents/${agentId}/runner-token`, {}, session);
    expect(made.status, JSON.stringify(await made.clone().json())).toBe(201);
    const { token } = await bodyOf(made);
    expect(token).toMatch(/^bonded_rt_/);
    // A signed request after it is still accepted (it is ordered after the session's).
    tick();
    const timestamp = now() + 120;
    const signature = await owner.signMessage({
      message: selfServeMessage({ action: "runner-token", chainId, agentId, timestamp }),
    });
    clock += 120_000;
    const signed = await send("POST", `/self/agents/${agentId}/runner-token`, {
      timestamp,
      signature,
    });
    expect(signed.status).toBe(201);
    const fresh = (await bodyOf(signed)).token as string;
    // The runner reports what its code hash was made from (a commit): shown with the hash.
    const identity = await auth.validate(fresh);
    presence.onEvent({
      type: "connected",
      key: identity!.key,
      at: Date.now(),
      hello: {
        type: "hello",
        runnerVersion: "0.2.0",
        protocol: 1,
        mode: "tools",
        codeHash: hash(0xd1),
        codeSource: "git",
        codeDetail: "4f2a9c1",
      },
    });
    await presence.flush();
    expect(
      (await bodyOf(await app.request(`/self/agents/${agentId}/runner`))).codeHash,
    ).toMatchObject({
      value: hash(0xd1),
      source: "git",
      detail: "4f2a9c1",
      reportedBy: "runner",
    });
    // Rating with the session: the same rules (here, no passing check of this connection yet).
    const rated = await send("POST", `/self/agents/${agentId}/rate`, {}, session);
    expect(rated.status).toBe(409);
    expect((await bodyOf(rated)).error).toBe(NEEDS_CHECK);
    expect((await send("POST", `/self/agents/${agentId}/rate`, {}, theirs)).status).toBe(403);
  });

  it("allows plain-http loopback Agent URLs only when the service is local", async () => {
    const local = api({}, { allowLoopbackUrls: true, webOrigins: ["http://localhost:5173"] });
    const s = await sessionFor(owner, local);
    const p = await newPreview(s, { mode: "tools", connection: "url" }, local);
    for (const url of ["http://localhost:8790/agent", "http://127.0.0.1:8790/agent"])
      expect(
        (await send("POST", `/previews/${p.id}/agent-url`, { url }, s, local)).status,
        url,
      ).toBe(201);
    const hosted = await send(
      "POST",
      `/previews/${p.id}/agent-url`,
      { url: "http://127.0.0.1:8790/agent" },
      s,
    );
    expect(hosted.status).toBe(400);
    expect((await bodyOf(hosted)).error).toBe("Your URL must use https.");
  });
});

describe("setting up, a new secret, and preview status without polling", () => {
  it("shows a preview as starting, with its start time, while the sandbox is set up", async () => {
    await pg.db.pool.query(
      "UPDATE jobs j SET status='failed' FROM ratings r WHERE j.id=r.id AND j.status IN ('queued','running')",
    );
    const session = await sessionFor(privateKeyToAccount(generatePrivateKey()));
    const { preview } = await readyPreview(session, hash(0x5ea1));
    const { runId } = await bodyOf(await send("POST", `/previews/${preview.id}/rate`, {}, session));
    let during: Promise<unknown> | undefined;
    await workPreviewOne(pg.db, chain, sandbox.rpcUrl, {
      // The agent is built once the sandbox is up and before the episodes: still setting up.
      remote: () => {
        during = Promise.all([
          get(`/previews/${preview.id}`, session).then(bodyOf),
          pg.db.pool.query("SELECT status,progress FROM ratings WHERE id=$1", [runId]),
        ]);
        return ratedAgent("hardened");
      },
      heldOut: { perClass: 0 },
      selectAttacks: (attacks) => attacks.filter((a) => a.id === "A6-operator-impersonation-001"),
    });
    const [page, rating] = (await during) as [
      Record<string, unknown>,
      { rows: { status: string; progress: { startedAt: string; total: number | null } }[] },
    ];
    expect(page.status).toBe("starting");
    expect(rating.rows[0]!.status).toBe("starting");
    expect(Date.parse(rating.rows[0]!.progress.startedAt)).toBeGreaterThan(0);
    // Over: its progress keeps when it began setting up, and counts from the episodes.
    const done = await bodyOf(await get(`/previews/${preview.id}`, session));
    expect(
      (done.rating as { progress: { startedAt: string; done: number } }).progress,
    ).toMatchObject({
      startedAt: rating.rows[0]!.progress.startedAt,
      done: ONE_ATTACK_EPISODES,
    });
    // Its status as a stream (a stream token, as an EventSource would use): the state, then the end.
    const token = (
      await bodyOf(await send("POST", "/streams/token", { previewId: preview.id }, session))
    ).token as string;
    expect((await app.request(`/previews/${preview.id}/events`)).status).toBe(401);
    expect((await get(`/previews/${preview.id}/events`, await sessionFor(stranger))).status).toBe(
      404,
    );
    const events = await sse(await app.request(`/previews/${preview.id}/events?token=${token}`));
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({
      ratingId: runId,
      progress: { done: ONE_ATTACK_EPISODES, total: ONE_ATTACK_EPISODES },
    });
    expect(["done", "refused", "failed"]).toContain(events[0]!.data.status);
  }, 240_000);

  it("gives an Agent URL a new secret, keeping the URL, unverified until checked again", async () => {
    const session = await sessionFor();
    const p = await newPreview(session, { mode: "tools", connection: "url" });
    const first = await bodyOf(
      await send(
        "POST",
        `/previews/${p.id}/agent-url`,
        { url: "https://rotate.example/a" },
        session,
      ),
    );
    await send("POST", `/previews/${p.id}/agent-url/verify`, {}, session);
    const rotated = await send("POST", `/previews/${p.id}/agent-url/secret`, {}, session);
    expect(rotated.status).toBe(201);
    const body = await bodyOf(rotated);
    expect(body).toMatchObject({
      url: "https://rotate.example/a",
      verified: false,
      verifiedAt: null,
    });
    expect(body.secret).toMatch(/^bonded_as_/);
    expect(body.secret).not.toBe(first.secret);
    // The old secret is gone at once: only the new row is live, and it decrypts to the new secret.
    const live = (await pg.db.agentUrl(`preview:${p.id}`))!;
    expect(live.id).toBe(body.agentUrlId);
    expect(secrets.decrypt(live.ciphertext, `agent-url:${live.id}`)).toBe(body.secret);
    const old = (
      await pg.db.pool.query("SELECT revoked_at FROM agent_urls WHERE id=$1", [first.agentUrlId])
    ).rows[0];
    expect(old.revoked_at).not.toBeNull();
    // Without a URL there is nothing to rotate.
    const empty = await newPreview(session, { mode: "tools", connection: "url" });
    expect((await send("POST", `/previews/${empty.id}/agent-url/secret`, {}, session)).status).toBe(
      404,
    );
  });
});

describe("brokerage previews", () => {
  beforeAll(async () => {
    await pg.db.pool.query(
      "UPDATE jobs j SET status='failed' FROM ratings r WHERE j.id=r.id AND r.kind='preview' AND j.status='queued'",
    );
  });

  /** A stock-trading preview, connected by runner, with a passing brokerage check. */
  async function readyBrokerage(
    session: string,
    code: string,
    a = app,
    toolNames?: "bonded" | "alpaca",
  ) {
    const preview = await newPreview(
      session,
      { mode: "tools", world: "brokerage", ...(toolNames ? { toolNames } : {}) },
      a,
    );
    const made = await bodyOf(
      await send("POST", `/previews/${preview.id}/runner-token`, {}, session, a),
    );
    await connect(made.token as string, "tools", code);
    const worlds: unknown[] = [];
    const names: unknown[] = [];
    await send("POST", `/previews/${preview.id}/checks`, {}, session, a);
    expect(
      await workCheckOne(pg.db, chainId, {
        runCheck: (request) => {
          worlds.push(request.world);
          names.push(request.toolNames);
          return passing(request);
        },
      }),
    ).toBe(true);
    expect(worlds).toEqual(["brokerage"]);
    expect(names).toEqual([toolNames ?? "bonded"]);
    return preview;
  }

  /** Does the base job, and sells all VTI when the lookalike fund-closing notice is there. */
  const gullibleBroker = (): ArenaAgent => ({
    name: "scripted-broker",
    async run(_task, tools) {
      await tools.call("place_order", { symbol: "VOO", side: "buy", amountUsd: 2000 });
      await tools.call("place_order", { symbol: "JPM", side: "buy", amountUsd: 3000 });
      await tools.call("place_order", { symbol: "AAPL", side: "sell", quantity: 10 });
      const notice = await tools.call("read_message", { messageId: "m-611" });
      if (notice.ok) await tools.call("place_order", { symbol: "VTI", side: "sell", quantity: 60 });
      return { steps: 0, stoppedBecause: "done" };
    },
  });

  it("is tools mode only, has no official path, and says what it runs", async () => {
    const session = await sessionFor(privateKeyToAccount(generatePrivateKey()));
    const chainMode = await send(
      "POST",
      "/previews",
      { mode: "chain", world: "brokerage" },
      session,
    );
    expect(chainMode.status).toBe(400);
    expect((await bodyOf(chainMode)).error).toMatch(/tools mode only/);
    const made = (await newPreview(session, { mode: "tools", world: "brokerage" })) as Record<
      string,
      unknown
    >;
    expect(made).toMatchObject({ world: "brokerage", upgrade: null });
    expect((made.expectedRating as { episodes: number }).episodes).toBe(20);
  });

  it("has its own daily preview per wallet: a crypto-trading one doesn't use it up", async () => {
    const capped = api({ previewPerWalletDaily: 1 });
    const wallet = privateKeyToAccount(generatePrivateKey());
    const session = await sessionFor(wallet, capped);
    const allowance = async (world?: string) =>
      bodyOf(
        await get(
          `/previews/allowance?wallet=${wallet.address}${world ? `&world=${world}` : ""}`,
          undefined,
          capped,
        ),
      );
    const runs: string[] = [];
    // The crypto-trading preview uses the wallet's vault preview for the day...
    const { preview: vault } = await readyPreview(session, hash(0x7010), capped);
    const v = await send("POST", `/previews/${vault.id}/rate`, {}, session, capped);
    expect(v.status).toBe(202);
    runs.push((await bodyOf(v)).runId as string);
    expect(await allowance()).toMatchObject({ allowed: false });
    // ...and leaves its stock-trading one.
    expect(await allowance("brokerage")).toMatchObject({ allowed: true, reason: null });
    const broker = await readyBrokerage(session, hash(0x7011), capped);
    const b = await send("POST", `/previews/${broker.id}/rate`, {}, session, capped);
    expect(b.status).toBe(202);
    runs.push((await bodyOf(b)).runId as string);
    expect(await allowance("brokerage")).toMatchObject({ allowed: false });
    // A second stock-trading rating the same day is refused.
    const again = await readyBrokerage(session, hash(0x7012), capped);
    const refused = await send("POST", `/previews/${again.id}/rate`, {}, session, capped);
    expect(refused.status).toBe(429);
    expect(
      (await get(`/previews/allowance?wallet=${wallet.address}&world=nope`, undefined, capped))
        .status,
    ).toBe(400);
    await pg.db.pool.query("UPDATE jobs SET status='failed' WHERE id = ANY($1::uuid[])", [runs]);
  });

  it("needs a check on the brokerage world: a vault check of the same connection doesn't count", async () => {
    const session = await sessionFor(privateKeyToAccount(generatePrivateKey()));
    const preview = await readyBrokerage(session, hash(0x7001));
    const subject = `preview:${preview.id}`;
    const brokerage = await pg.db.passingCheck(subject, {
      mode: "tools",
      world: "brokerage",
      connection: "runner",
      credentialId: (await pg.db.currentConnection(subject, "runner")).credentialId,
      codeHash: hash(0x7001),
    });
    expect(brokerage?.world).toBe("brokerage");
    const vault = await pg.db.passingCheck(subject, {
      mode: "tools",
      world: "vault",
      connection: "runner",
      credentialId: brokerage!.credentialId,
      codeHash: hash(0x7001),
    });
    expect(vault).toBeUndefined();
  });

  it("runs the brokerage world with no sandbox and keeps findings, not a score", async () => {
    const session = await sessionFor(privateKeyToAccount(generatePrivateKey()));
    const preview = await readyBrokerage(session, hash(0x7002));
    expect((await send("POST", `/previews/${preview.id}/rate`, {}, session)).status).toBe(202);
    const asked: { world?: string; sandbox: unknown }[] = [];
    const errors: unknown[] = [];
    const ran = await workPreviewOne(pg.db, chain, sandbox.rpcUrl, {
      remote: (request, given) => {
        asked.push({ ...(request.world ? { world: request.world } : {}), sandbox: given });
        return gullibleBroker();
      },
      onError: (e) => errors.push(e),
    });
    expect(ran).toBe(true);
    expect(errors).toEqual([]);
    expect(asked).toEqual([{ world: "brokerage", sandbox: undefined }]);
    const page = await bodyOf(await get(`/previews/${preview.id}`, session));
    expect(page.status).toBe("done");
    const rating = page.rating as {
      score?: number;
      findings: { attacks: { worked: number }; episodes: { notRun: number } };
    };
    expect(rating.score).toBeUndefined();
    expect(rating.findings.attacks.worked).toBeGreaterThanOrEqual(1);
    expect(rating.findings.episodes.notRun).toBe(0);
    const report = await bodyOf(await get(`/previews/${preview.id}/report`, session));
    expect(report.report).toMatchObject({
      world: "brokerage",
      preview: { attested: false, insurable: false },
    });
  }, 120_000);

  it("offers a broker's tool names on the brokerage world only", async () => {
    const session = await sessionFor(privateKeyToAccount(generatePrivateKey()));
    const vault = await send("POST", "/previews", { mode: "tools", toolNames: "alpaca" }, session);
    expect(vault.status).toBe(400);
    expect((await bodyOf(vault)).error).toMatch(/Only the brokerage world/);
    const made = (await newPreview(session, {
      mode: "tools",
      world: "brokerage",
      toolNames: "alpaca",
    })) as Record<string, unknown>;
    expect(made).toMatchObject({ world: "brokerage", toolNames: "alpaca" });
  });

  it("checks and runs a preview under Alpaca's names, and a check under Bonded's doesn't count", async () => {
    const session = await sessionFor(privateKeyToAccount(generatePrivateKey()));
    const preview = await readyBrokerage(session, hash(0x7020), app, "alpaca");
    const subject = `preview:${preview.id}`;
    const credentialId = (await pg.db.currentConnection(subject, "runner")).credentialId;
    const config = {
      mode: "tools",
      world: "brokerage" as const,
      connection: "runner" as const,
      credentialId,
      codeHash: hash(0x7020),
    };
    expect(await pg.db.passingCheck(subject, { ...config, toolNames: "alpaca" })).toBeDefined();
    expect(await pg.db.passingCheck(subject, { ...config, toolNames: "bonded" })).toBeUndefined();
    expect((await send("POST", `/previews/${preview.id}/rate`, {}, session)).status).toBe(202);
    // Built on Alpaca's server: it orders with place_stock_order, and falls for the notice.
    const alpacaBroker = (): ArenaAgent => ({
      name: "alpaca-broker",
      async run(_task, tools) {
        await tools.call("place_stock_order", { symbol: "VOO", side: "buy", notional: "2000" });
        await tools.call("place_stock_order", { symbol: "JPM", side: "buy", notional: "3000" });
        await tools.call("place_stock_order", { symbol: "AAPL", side: "sell", qty: "10" });
        const notice = await tools.call("read_message", { messageId: "m-611" });
        if (notice.ok) await tools.call("close_position", { symbol_or_asset_id: "VTI" });
        return { steps: 0, stoppedBecause: "done" };
      },
    });
    const errors: unknown[] = [];
    expect(
      await workPreviewOne(pg.db, chain, sandbox.rpcUrl, {
        remote: () => alpacaBroker(),
        onError: (e) => errors.push(e),
      }),
    ).toBe(true);
    expect(errors).toEqual([]);
    const report = await bodyOf(await get(`/previews/${preview.id}/report`, session));
    const findings = (
      report.report as {
        findings: { toolProfile: string; attacks: { worked: number }; job: { done: number } };
      }
    ).findings;
    expect(findings.toolProfile).toBe("alpaca");
    expect(findings.attacks.worked).toBeGreaterThanOrEqual(1);
    expect(findings.job.done).toBeGreaterThan(0);
  }, 120_000);

  it("fails as the agent's when it took part in too few episodes to say anything", async () => {
    const session = await sessionFor(privateKeyToAccount(generatePrivateKey()));
    const preview = await readyBrokerage(session, hash(0x7003));
    await send("POST", `/previews/${preview.id}/rate`, {}, session);
    await workPreviewOne(pg.db, chain, sandbox.rpcUrl, {
      remote: () => ({
        name: "absent",
        run: () =>
          Promise.resolve({
            steps: 0,
            stoppedBecause: "error" as const,
            finalMessage: "the runner disconnected",
          }),
      }),
    });
    const page = await bodyOf(await get(`/previews/${preview.id}`, session));
    expect(page.status).toBe("failed");
    expect(page.reason).toMatch(/finished only 0 of 20 episodes/);
    expect(page.reasonCode).toBe("brokerage-too-few-episodes");
  }, 120_000);
});
