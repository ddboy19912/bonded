import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ANVIL_KEYS,
  REMOTE_CONTROLS,
  Sandbox,
  createAgentVault,
  loadAttackLibrary,
  signAttestation,
  type AgentVault,
  type VerifiedTee,
} from "@bonded/arena";
import { connectChain, type ServiceChain } from "@bonded/keeper";
import {
  attestationMessage,
  bondedRegistryAbi,
  operatorBondAbi,
  testTokenAbi,
  mandateHash,
  mandateVaultAbi,
  selfServeMessage,
  type RemoteAgentSpec,
  type SelfServeRequest,
} from "@bondedhq/shared";
import { privateKeyToAccount } from "viem/accounts";
import { createApi } from "../src/index.js";
import {
  DbRunnerAuth,
  RUNNER_TOKEN_PREFIX,
  RunnerPresenceWriter,
  runnerTokenHash,
} from "../src/runners.js";
import { runTeeChecks, type Attest } from "../src/tee-watch.js";
import { renewExpiringScores } from "../src/live-loop.js";
import { workOne } from "../src/worker.js";
import { DEFAULT_REMOTE_POLICY, type RemoteRatingPolicy } from "../src/remote-policy.js";
import { postgres } from "./postgres.js";

let pg: Awaited<ReturnType<typeof postgres>>;
let sandbox: Sandbox;
let chain: ServiceChain;
let app: ReturnType<typeof createApi>;
let auth: DbRunnerAuth;
let presence: RunnerPresenceWriter;
let mine: AgentVault;
let builtIn: AgentVault;
const owner = privateKeyToAccount(ANVIL_KEYS.operator);
const stranger = privateKeyToAccount(ANVIL_KEYS.depositor);
let clock = Date.now();
const now = () => Math.floor(clock / 1000);
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const CODE = hash(0xc0de);
const API_TOKEN = "test-api-token-at-least-24-characters";
const remote: RemoteAgentSpec = { codeHash: CODE, mode: "tools" };

function api(
  requests = { perClient: 1000, total: 1000, windowMs: 60_000 },
  limits: { perAgentMs?: number; remote?: RemoteRatingPolicy } = {},
) {
  return createApi({
    db: pg.db,
    chain,
    attesterKey: ANVIL_KEYS.deployer,
    apiToken: API_TOKEN,
    gatewayUrl: "https://gateway.example",
    selfServe: { requests, now: () => clock, ...limits },
  });
}

beforeAll(async () => {
  pg = await postgres();
  sandbox = await Sandbox.start();
  chain = connectChain(sandbox.deployment, sandbox.rpcUrl, ANVIL_KEYS.deployer);
  mine = await createAgentVault(sandbox);
  builtIn = await createAgentVault(sandbox);
  // Its operator stakes a bond: ratings of an operator-run agent need one.
  {
    const op = connectChain(sandbox.deployment, sandbox.rpcUrl, ANVIL_KEYS.operator);
    const d = sandbox.deployment;
    await op.send(d.usdg, testTokenAbi, "faucet", [1_000_000_000n]);
    await op.send(d.usdg, testTokenAbi, "approve", [d.bond, 1_000_000_000n]);
    await op.read.waitForTransactionReceipt({
      hash: await op.send(d.bond, operatorBondAbi, "stake", [mine.agentId, 1_000_000_000n]),
    });
  }
  app = api();
  auth = new DbRunnerAuth(pg.db, sandbox.deployment.chainId);
  presence = new RunnerPresenceWriter(pg.db);
}, 180_000);
afterAll(async () => {
  await sandbox?.stop();
  await pg?.stop();
});

const sign = (request: SelfServeRequest, who = owner) =>
  who.signMessage({ message: selfServeMessage(request) });
const bodyOf = async (r: Response) => (await r.json()) as Record<string, unknown>;
const send = (method: string, path: string, body: unknown, a = app) =>
  a.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const key = (v: AgentVault) => `${sandbox.deployment.chainId}:${v.agentId}`;

/** Register `v` as the owner's own agent; `sent` overrides what is sent after signing `signed`. */
async function registerRemote(
  v: AgentVault,
  signed: RemoteAgentSpec = remote,
  sent: Partial<RemoteAgentSpec> & Record<string, unknown> = {},
  who = owner,
) {
  const timestamp = now();
  const agentId = v.agentId.toString();
  const signature = await sign(
    {
      action: "register",
      chainId: sandbox.deployment.chainId,
      agentId,
      vault: v.address,
      kind: "remote",
      mandateHash: mandateHash(v.mandate),
      remote: signed,
      timestamp,
    },
    who,
  );
  return send("POST", "/self/agents", {
    agentId,
    vault: v.address,
    kind: "remote",
    mandate: v.mandate,
    ...signed,
    ...sent,
    timestamp,
    signature,
  });
}
/** A signed runner token request (create or revoke) for `v`. */
async function tokenRequest(
  v: AgentVault,
  action: "runner-token" | "revoke-runner-token",
  who = owner,
  timestamp = now(),
) {
  const agentId = v.agentId.toString();
  const signature = await sign(
    { action, chainId: sandbox.deployment.chainId, agentId, timestamp },
    who,
  );
  return { timestamp, signature };
}
const createToken = async (v: AgentVault, who = owner, a = app) =>
  send(
    "POST",
    `/self/agents/${v.agentId}/runner-token`,
    await tokenRequest(v, "runner-token", who),
    a,
  );
const revokeToken = async (v: AgentVault, who = owner) =>
  send(
    "DELETE",
    `/self/agents/${v.agentId}/runner-token`,
    await tokenRequest(v, "revoke-runner-token", who),
  );
/**
 * A passing connection check of the agent's connection as it is now, as the check lane would
 * record one: a remote rating needs one in the last 24 hours (previews.test.ts tests that rule).
 */
async function passCheck(v: AgentVault) {
  const record = await pg.db.agentRecord(key(v));
  const config = (record?.config ?? {}) as { mode?: string; codeHash?: string; kind?: string };
  if (config.kind !== "remote") return;
  const current = await pg.db.currentConnection(key(v), "runner");
  const code = config.codeHash ?? current.code?.hash ?? null;
  await pg.db.pool.query(
    `INSERT INTO connection_checks(id,subject,chain_id,owner,mode,connection,credential_id,code_hash,
       status,result,finished_at)
     VALUES(gen_random_uuid(),$1,$2,$3,$4,'runner',$5,$6,'passed','{"passed":true}',now())`,
    [key(v), sandbox.deployment.chainId, record?.owner, config.mode, current.credentialId, code],
  );
}
async function rate(v: AgentVault, a = app) {
  await passCheck(v);
  const timestamp = now();
  const agentId = v.agentId.toString();
  const signature = await sign({
    action: "rate",
    chainId: sandbox.deployment.chainId,
    agentId,
    timestamp,
  });
  return send("POST", `/self/agents/${agentId}/rate`, { timestamp, signature }, a);
}
/** Connect a runner for `token`, as the gateway would: validate, then report its hello. */
async function connect(token: string, mode: "tools" | "chain" = "tools") {
  const identity = await auth.validate(token);
  if (!identity) throw new Error("token refused");
  presence.onEvent({
    type: "connected",
    key: identity.key,
    at: Date.now(),
    hello: { type: "hello", runnerVersion: "0.1.0", protocol: 1, mode },
  });
  await presence.flush();
  return identity;
}
const tick = () => {
  clock += 1000;
};

describe("registering your own agent", () => {
  it("signs the declared code hash, mode and TEE: changing any after signing is refused", async () => {
    expect((await registerRemote(mine, remote, { mode: "chain" })).status).toBe(403);
    expect((await registerRemote(mine, remote, { codeHash: hash(1) })).status).toBe(403);
    const chainMode = { ...remote, mode: "chain" as const };
    expect(
      (
        await registerRemote(mine, chainMode, {
          tee: { url: "https://tee.example", composeHash: hash(9) },
        })
      ).status,
    ).toBe(403);
    expect((await registerRemote(mine, remote, {}, stranger)).status).toBe(403);
  });

  it("refuses a TEE in tool mode: the runner's tool calls come from outside the TEE", async () => {
    const res = await registerRemote(mine, {
      ...remote,
      tee: { url: "https://tee.example", composeHash: hash(9) },
    });
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).error).toMatch(/must be rated in chain mode/);
  });

  it("refuses Sentinel and a plain-http TEE for your own agent", async () => {
    expect((await registerRemote(mine, remote, { sentinel: true })).status).toBe(400);
    const http = { ...remote, tee: { url: "http://tee.example", composeHash: hash(9) } };
    expect((await registerRemote(mine, http)).status).toBe(400);
  });

  it("stores it as a remote agent and shows what was declared", async () => {
    const res = await registerRemote(mine);
    expect(res.status).toBe(201);
    expect(await bodyOf(res)).toMatchObject({ registered: true, kind: "remote", mode: "tools" });
    const status = await bodyOf(await app.request(`/self/agents/${mine.agentId}`));
    expect(status).toMatchObject({
      kind: "remote",
      codeHash: CODE,
      mode: "tools",
      tee: null,
      coverCaps: { declared: 5_000, tee: 20_000 },
    });
    const config = (await pg.db.agentRecord(key(mine)))!.config;
    // Remote ratings run each published attack 3 times by default (built-in designs: 5).
    expect(config).toMatchObject({ kind: "remote", codeHash: CODE, mode: "tools", repeats: 3 });
  });
});

describe("runner tokens", () => {
  let first = "";

  it("are made only for the agent's owner, for an agent registered as your own", async () => {
    expect((await createToken(mine, stranger)).status).toBe(403);
    const unregistered = await createAgentVault(sandbox);
    expect((await createToken(unregistered)).status).toBe(404);
    // A built-in design has no runner.
    tick();
    const signature = await sign({
      action: "register",
      chainId: sandbox.deployment.chainId,
      agentId: builtIn.agentId.toString(),
      vault: builtIn.address,
      kind: "partial",
      mandateHash: mandateHash(builtIn.mandate),
      timestamp: now(),
    });
    expect(
      (
        await send("POST", "/self/agents", {
          agentId: builtIn.agentId.toString(),
          vault: builtIn.address,
          kind: "partial",
          mandate: builtIn.mandate,
          timestamp: now(),
          signature,
        })
      ).status,
    ).toBe(201);
    expect((await createToken(builtIn)).status).toBe(409);
  });

  it("refuse an expired or forged signature", async () => {
    const old = await tokenRequest(mine, "runner-token", owner, now() - 11 * 60);
    expect((await send("POST", `/self/agents/${mine.agentId}/runner-token`, old)).status).toBe(400);
    // A signature for another action: it recovers to some other address.
    const timestamp = now();
    const signature = await sign({
      action: "rate",
      chainId: sandbox.deployment.chainId,
      agentId: mine.agentId.toString(),
      timestamp,
    });
    expect(
      (await send("POST", `/self/agents/${mine.agentId}/runner-token`, { timestamp, signature }))
        .status,
    ).toBe(403);
  });

  it("are shown once and stored only as a hash; the runner status never shows one", async () => {
    tick();
    const res = await createToken(mine);
    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await bodyOf(res);
    first = body.token as string;
    expect(first.startsWith(RUNNER_TOKEN_PREFIX)).toBe(true);
    expect(body.gatewayUrl).toBe("https://gateway.example");
    const rows = (await pg.db.pool.query("SELECT * FROM runner_tokens")).rows;
    expect(JSON.stringify(rows)).not.toContain(first);
    expect(rows.map((r) => r.token_hash)).toContain(runnerTokenHash(first));
    const status = await app.request(`/self/agents/${mine.agentId}/runner`);
    const text = await status.text();
    expect(text).not.toContain(first);
    expect(JSON.parse(text)).toMatchObject({
      token: { id: body.tokenId },
      runner: null,
      gatewayUrl: "https://gateway.example",
    });
  });

  it("can't be made twice from one signature", async () => {
    tick();
    const signed = await tokenRequest(mine, "runner-token");
    const path = `/self/agents/${mine.agentId}/runner-token`;
    expect((await send("POST", path, signed)).status).toBe(201);
    const again = await send("POST", path, signed);
    expect(again.status).toBe(409);
    expect((await bodyOf(again)).error).toMatch(/already used/);
    // The earlier token was replaced.
    expect(await auth.validate(first)).toBeNull();
  });

  it("validate in the gateway, connect a runner in the registered mode only, and revoke", async () => {
    tick();
    const token = (await bodyOf(await createToken(mine))).token as string;
    const identity = await auth.validate(token);
    expect(identity).toMatchObject({
      key: key(mine),
      agentId: mine.agentId.toString(),
      mode: "tools",
    });
    expect(await auth.validate("bonded_rt_not-a-token")).toBeNull();
    expect(await auth.validate("something-else")).toBeNull();
    // A runner in the other mode is recorded, but doesn't count as connected, and says why.
    await connect(token, "chain");
    expect(await pg.db.runnerIsConnected(key(mine))).toBe(false);
    expect(await bodyOf(await app.request(`/self/agents/${mine.agentId}/runner`))).toMatchObject({
      runner: { connected: false, mode: "chain" },
      problem: expect.stringMatching(/--mode tools/),
    });
    await connect(token);
    expect(await pg.db.runnerIsConnected(key(mine))).toBe(true);
    expect(await bodyOf(await app.request(`/self/agents/${mine.agentId}/runner`))).toMatchObject({
      runner: { connected: true, mode: "tools", runnerVersion: "0.1.0" },
      problem: null,
    });

    tick();
    expect((await revokeToken(mine, stranger)).status).toBe(403);
    const revoked = await revokeToken(mine);
    expect(revoked.status).toBe(200);
    expect(await bodyOf(revoked)).toEqual({ revoked: 1 });
    // The gateway checks the token at every heartbeat: it is gone, so the runner is dropped.
    expect(await auth.validate(token)).toBeNull();
    expect(await pg.db.runnerIsConnected(key(mine))).toBe(false);
    expect(await bodyOf(await app.request(`/self/agents/${mine.agentId}/runner`))).toMatchObject({
      token: null,
      runner: null,
    });
  });

  it("need no operator token, but any other DELETE does", async () => {
    const res = await app.request("/arena/runs/00000000-0000-0000-0000-000000000000", {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  it("are rate-limited per client", async () => {
    const limited = api({ perClient: 2, total: 100, windowMs: 60_000 });
    tick();
    expect((await createToken(mine, owner, limited)).status).toBe(201);
    tick();
    expect((await createToken(mine, owner, limited)).status).toBe(201);
    tick();
    const third = await createToken(mine, owner, limited);
    expect(third.status).toBe(429);
  });
});

describe("rating your own agent", () => {
  it("is refused with no runner connected, then queued once one is", async () => {
    tick();
    const none = await rate(mine);
    expect(none.status).toBe(409);
    expect((await bodyOf(none)).error).toMatch(/no runner is connected/);
    tick();
    const token = (await bodyOf(await createToken(mine))).token as string;
    await connect(token);
    const queued = await rate(mine);
    expect(queued.status).toBe(202);
    // The usual limit applies: one rating an hour.
    const again = await rate(mine);
    expect(again.status).toBe(429);
    expect((await bodyOf(again)).error).toMatch(/^one rating an hour per agent/);
    // For an operator-run agent the interval is its policy's, not the built-in designs' one.
    const tenMinutes = api(undefined, {
      perAgentMs: 0,
      remote: { ...DEFAULT_REMOTE_POLICY, perAgentMs: 10 * 60_000 },
    });
    const refused = await rate(mine, tenMinutes);
    expect(refused.status).toBe(429);
    expect((await bodyOf(refused)).error).toMatch(/^one rating every 10 minutes per agent/);
    const status = await bodyOf(await tenMinutes.request(`/self/agents/${mine.agentId}`));
    expect(
      Date.parse(status.nextRatingAt as string) - Date.parse(status.lastRatingAt as string),
    ).toBe(10 * 60_000);
  });

  it("fails at once, saying why, on a worker without the Arena Gateway", async () => {
    const run = (
      await pg.db.pool.query("SELECT id FROM ratings WHERE agent_id=$1 ORDER BY created_at DESC", [
        key(mine),
      ])
    ).rows[0].id;
    let failure: unknown;
    await workOne(pg.db, chain, sandbox.rpcUrl, ANVIL_KEYS.deployer, (e) => (failure = e));
    expect(String(failure)).toMatch(/gateway not available/);
    const row = await bodyOf(await app.request(`/arena/runs/${run}`));
    expect(row).toMatchObject({ status: "failed" });
    expect(row.error).toMatch(/^gateway not available/);
  }, 120_000);

  it("is retried, saying why, when the runner went away before the job ran", async () => {
    await pg.db.pool.query("UPDATE runner_presence SET connected=false WHERE agent_id=$1", [
      key(mine),
    ]);
    const run = await pg.db.enqueue(key(mine));
    await workOne(pg.db, chain, sandbox.rpcUrl, ANVIL_KEYS.deployer);
    const row = await bodyOf(await app.request(`/arena/runs/${run}`));
    expect(row).toMatchObject({
      status: "queued",
      error: expect.stringMatching(/runner is not connected/),
    });
    await pg.db.pool.query("UPDATE jobs SET status='failed' WHERE id=$1", [run]);
  }, 120_000);
});

describe("binding, cover caps and the live loop", () => {
  /** Post a score for `v` with this TEE measurement, and record it as the worker would. */
  async function postScore(v: AgentVault, teeMeasurement: `0x${string}`, expiresIn = 30 * 86400) {
    const d = sandbox.deployment;
    const current = await chain.read.readContract({
      address: d.registry,
      abi: bondedRegistryAbi,
      functionName: "scoreOf",
      args: [v.agentId],
    });
    const issuedAt = Math.max(
      Number((await chain.read.getBlock()).timestamp),
      Number(current.issuedAt) + 1,
    );
    const signed = await signAttestation(
      {
        agentId: v.agentId.toString(),
        score: 96,
        securityScore: 96,
        expectedLossBps: 30,
        mandateHash: mandateHash(v.mandate),
        reportHash: hash(Number(issuedAt)),
        codeHash: CODE,
        teeMeasurement,
        modelFamily: "unknown",
        issuedAt,
        expiresAt: issuedAt + expiresIn,
      },
      { chainId: d.chainId, registry: d.registry, attesterKey: ANVIL_KEYS.deployer },
    );
    const op = connectChain(d, sandbox.rpcUrl, ANVIL_KEYS.operator);
    await chain.read.waitForTransactionReceipt({
      hash: await op.send(d.registry, bondedRegistryAbi, "postScore", [
        attestationMessage(signed.attestation),
        signed.signature,
      ]),
    });
    const runId = await pg.db.enqueue(key(v));
    await pg.db.pool.query("UPDATE jobs SET status='done' WHERE id=$1", [runId]);
    await pg.db.pool.query(
      "UPDATE ratings SET status='done',report=$2,created_at=now()-interval '1 day' WHERE id=$1",
      [
        runId,
        JSON.stringify({
          tee: null,
          coverage: { readSurfaces: ["dm"] },
          heldOut: { seed: "abc" },
          liveness: { controls: 2, completed: 2, rate: 1 },
          scoring: { groups: [] },
        }),
      ],
    );
    await pg.db.pool.query(
      "INSERT INTO attestations(id,agent_id,signed,tx_hash) VALUES($1,$2,$3,'0x')",
      [runId, key(v), JSON.stringify(signed)],
    );
    return signed;
  }
  const quote = (v: AgentVault, usd: number) =>
    send("POST", "/quotes", {
      agentId: v.agentId.toString(),
      vault: v.address,
      coverAmount: (BigInt(usd) * 1_000_000n).toString(),
    });

  it("labels a score without a TEE measurement declared, with coverage and the held-out seed", async () => {
    await postScore(mine, hash(0));
    const score = await bodyOf(await app.request(`/agents/${mine.agentId}/score`));
    expect(score).toMatchObject({
      binding: "declared",
      coverage: { readSurfaces: ["dm"] },
      heldOut: { seed: "abc" },
      liveness: { controls: 2, completed: 2, rate: 1 },
    });
    const run = await bodyOf(await app.request(`/arena/runs/${score.runId}`));
    expect(run).toMatchObject({ binding: "declared", heldOut: { seed: "abc" } });
  }, 120_000);

  it("caps a declared agent's cover at 5,000 tUSDG as underwriting policy, not a built-in one", async () => {
    const over = await quote(mine, 6_000);
    expect(over.status).toBe(409);
    expect((await bodyOf(over)).error).toMatch(
      /^underwriting policy: cover for an agent with a declared binding is capped at 5,000 tUSDG/,
    );
    // Under the cap the policy has nothing to say; the pool's own checks and pricing follow.
    expect((await bodyOf(await quote(mine, 4_000))).error).not.toMatch(/underwriting policy/);
    // A built-in design has no binding cap.
    await postScore(builtIn, hash(0));
    expect((await bodyOf(await quote(builtIn, 6_000))).error).not.toMatch(/underwriting policy/);
  }, 120_000);

  it("keeps a remote score's restrictions when the agent is registered again as a built-in design", async () => {
    // The founder's sequence: a declared remote score, cover over the cap refused, the same
    // vault and mandate registered again as "hardened". The old score must not price cover
    // without its cap, and an outstanding supersession stays whatever the agent is now.
    const v = await createAgentVault(sandbox);
    tick();
    expect((await registerRemote(v)).status).toBe(201);
    await postScore(v, hash(0));
    expect((await bodyOf(await quote(v, 6_000))).error).toMatch(/^underwriting policy/);
    tick();
    const signature = await sign({
      action: "register",
      chainId: sandbox.deployment.chainId,
      agentId: v.agentId.toString(),
      vault: v.address,
      kind: "hardened",
      mandateHash: mandateHash(v.mandate),
      timestamp: now(),
    });
    const again = await send("POST", "/self/agents", {
      agentId: v.agentId.toString(),
      vault: v.address,
      kind: "hardened",
      mandate: v.mandate,
      timestamp: now(),
      signature,
    });
    expect(again.status).toBe(201);
    const refused = await quote(v, 6_000);
    expect(refused.status).toBe(409);
    expect((await bodyOf(refused)).error).toMatch(
      /^this agent was registered again after its current score was posted/,
    );
    // A stop the agent caused while it was remote still supersedes its score as a built-in.
    await pg.db.pool.query(
      `INSERT INTO agent_standing(agent_id,failures_in_row,superseded_at,superseded_reason,cooldown_until)
       VALUES($1,1,now(),'stopped: the agent failed in episode 2 of 40',now())`,
      [key(v)],
    );
    expect((await bodyOf(await quote(v, 6_000))).error).toMatch(/score is superseded/);
    // A complete rating of the current registration ends both (posting one clears the standing,
    // as the runners-db test shows): a built-in design's score has no binding cap.
    await pg.db.pool.query("DELETE FROM agent_standing WHERE agent_id=$1", [key(v)]);
    await postScore(v, hash(0));
    const priced = await bodyOf(await quote(v, 6_000));
    expect(String(priced.error ?? "")).not.toMatch(
      /underwriting policy|registered again|superseded/,
    );
  }, 120_000);

  it("renews a score about to expire only while the runner is connected", async () => {
    // Earlier tests' ratings are done with, and a day old.
    await pg.db.pool.query("UPDATE jobs SET status='failed' WHERE status<>'done'");
    await pg.db.pool.query("UPDATE ratings SET created_at=now()-interval '1 day'");
    const expiry = (
      (await bodyOf(await app.request(`/agents/${mine.agentId}/score`))).signed as {
        attestation: { expiresAt: number };
      }
    ).attestation.expiresAt;
    // Four days out: nothing to do.
    expect(
      await renewExpiringScores(pg.db, sandbox.deployment.chainId, expiry - 4 * 86400),
    ).toEqual([]);
    // Two days out, runner connected: queued, once.
    await pg.db.pool.query(
      "UPDATE runner_presence SET connected=true,last_heartbeat_at=now() WHERE agent_id=$1",
      [key(mine)],
    );
    expect(
      await renewExpiringScores(pg.db, sandbox.deployment.chainId, expiry - 2 * 86400),
    ).toEqual([key(mine)]);
    expect(
      await renewExpiringScores(pg.db, sandbox.deployment.chainId, expiry - 2 * 86400),
    ).toEqual([]);
    // Runner offline: the score is left to lapse.
    await pg.db.pool.query("UPDATE jobs SET status='failed'");
    await pg.db.pool.query("UPDATE ratings SET created_at=now()-interval '1 day'");
    await pg.db.dropRunner(key(mine));
    expect(await renewExpiringScores(pg.db, sandbox.deployment.chainId, expiry)).toEqual([]);
  }, 120_000);

  it("checks an operator's TEE like Bonded's own; a changed measurement blocks quotes and re-rates", async () => {
    const tee = { url: "https://tee.example", composeHash: hash(9) };
    tick();
    const tokenBefore = (await bodyOf(await app.request(`/self/agents/${mine.agentId}/runner`)))
      .token;
    expect(tokenBefore).not.toBeNull();
    expect((await registerRemote(mine, { ...remote, mode: "chain", tee })).status).toBe(201);
    // Registering again revokes the runner token: the owner makes a new one for the new setup.
    expect(
      (await bodyOf(await app.request(`/self/agents/${mine.agentId}/runner`))).token,
    ).toBeNull();
    tick();
    await connect((await bodyOf(await createToken(mine))).token as string, "chain");
    await pg.db.dropRunner(key(mine));
    const rated = hash(5);
    const signed = await postScore(mine, rated);
    const vaultAgent = await chain.read.readContract({
      address: mine.address,
      abi: mandateVaultAbi,
      functionName: "agent",
    });
    await pg.db.recordTeeRating({
      agentId: key(mine),
      ratedMeasurement: rated,
      ratedReportHash: signed.attestation.reportHash,
      evmAddress: vaultAgent,
    });
    const live = (measurement: string) =>
      (async () => ({ measurement, evmAddress: vaultAgent }) as unknown as VerifiedTee) as Attest;
    await pg.db.pool.query("UPDATE jobs SET status='failed'");
    await pg.db.pool.query("UPDATE ratings SET created_at=now()-interval '1 day'");

    // Changed, with the runner offline: quotes stop and the skip is on record.
    await runTeeChecks(pg.db, chain, live(hash(6)));
    expect((await pg.db.teeCheck(key(mine)))?.blockingStatus).toBe("mismatch");
    expect((await bodyOf(await quote(mine, 1_000))).error).toMatch(/no longer matches/);
    const status = await bodyOf(await app.request(`/self/agents/${mine.agentId}/runner`));
    expect(status.lastSkip).toMatchObject({ cause: "tee-changed" });
    const before = Number(
      (await pg.db.pool.query("SELECT count(*) FROM ratings WHERE agent_id=$1", [key(mine)]))
        .rows[0].count,
    );

    // Changed, with the runner connected: a re-rating is queued, once.
    await pg.db.pool.query(
      "UPDATE runner_presence SET connected=true,last_heartbeat_at=now() WHERE agent_id=$1",
      [key(mine)],
    );
    await runTeeChecks(pg.db, chain, live(hash(6)));
    await runTeeChecks(pg.db, chain, live(hash(6)));
    const after = Number(
      (await pg.db.pool.query("SELECT count(*) FROM ratings WHERE agent_id=$1", [key(mine)]))
        .rows[0].count,
    );
    expect(after - before).toBe(1);
  }, 120_000);

  it("reports observed rates with their counts and exposure", async () => {
    const res = await bodyOf(await app.request("/stats/observed-rates"));
    expect(res).toMatchObject({
      chainId: sandbox.deployment.chainId,
      usingObserved: false,
      threshold: { minAgentYears: 25, minBreaches: 10 },
      breaches: { total: 0 },
      breachesWithoutDetails: 0,
    });
    expect(res.exposure).toMatchObject({ agentYears: expect.any(Number) });
    expect((res.groups as unknown[]).length).toBe(5);
    expect((res.assumptions as string[]).length).toBeGreaterThan(0);
  });
});

describe("who may be rated, and what a rating will be", () => {
  it("shows the expected size and time budget, and every rating a page at a time", async () => {
    const status = await bodyOf(await app.request(`/self/agents/${mine.agentId}`));
    const plan = status.expectedRating as { maxEpisodes: number; budgetSeconds: number };
    // At most: every published attack 3 times, one held-out variant per class the library has
    // seeds for, 3 times, and the controls (no assumed held-out size).
    const library = loadAttackLibrary();
    const classes = new Set(library.map((a) => a.class)).size;
    expect(plan.maxEpisodes).toBe((library.length + classes) * 3 + REMOTE_CONTROLS);
    // 40 seconds an episode, at most 3 hours.
    expect(plan.budgetSeconds).toBe(Math.min(3 * 3600, plan.maxEpisodes * 40));
    expect(status.standing).toMatchObject({ failuresInRow: 0, superseded: null });
    const page = await bodyOf(await app.request(`/self/agents/${mine.agentId}/ratings?limit=2`));
    expect((page.items as unknown[]).length).toBe(2);
    expect(page.total).toBeGreaterThan(2);
    const next = await bodyOf(
      await app.request(`/self/agents/${mine.agentId}/ratings?limit=2&page=2`),
    );
    expect(next.page).toBe(2);
  });

  it("refuses a rating with no operator bond, and one under an earlier owner's config", async () => {
    const nobond = await createAgentVault(sandbox);
    tick();
    expect((await registerRemote(nobond)).status).toBe(201);
    tick();
    await connect((await bodyOf(await createToken(nobond))).token as string);
    clock += 2 * 3_600_000;
    const res = await rate(nobond);
    expect(res.status).toBe(409);
    expect((await bodyOf(res)).error).toMatch(/stake an operator bond/);

    // The agent changed hands (here: its registration names someone else).
    await pg.db.pool.query("UPDATE agents SET owner=$2 WHERE id=$1", [
      key(mine),
      stranger.address.toLowerCase(),
    ]);
    const moved = await rate(mine);
    expect(moved.status).toBe(409);
    expect((await bodyOf(moved)).error).toMatch(/re-register to rate under your own config/);
    // Renewals check the same, and record why they couldn't.
    const { remoteRatingProblem } = await import("../src/eligibility.js");
    expect(await remoteRatingProblem(chain, mine.agentId.toString(), stranger.address)).toMatch(
      /changed hands/,
    );
    await pg.db.pool.query("UPDATE agents SET owner=$2 WHERE id=$1", [
      key(mine),
      owner.address.toLowerCase(),
    ]);
  });

  it("holds a stopped agent's next rating back for the cooldown, saying when", async () => {
    tick();
    await connect((await bodyOf(await createToken(mine))).token as string, "chain");
    // An hour of cooldown, on the API's clock.
    await pg.db.pool.query(
      `INSERT INTO agent_standing(agent_id,failures_in_row,superseded_at,superseded_reason,cooldown_until)
       VALUES($1,1,now(),'stopped: x',to_timestamp($2))`,
      [key(mine), clock / 1000 + 3600],
    );
    const res = await rate(mine);
    expect(res.status).toBe(429);
    expect((await bodyOf(res)).error).toMatch(/stopped by the agent, so the next waits until/);
    await pg.db.pool.query("DELETE FROM agent_standing WHERE agent_id=$1", [key(mine)]);
  });
});
