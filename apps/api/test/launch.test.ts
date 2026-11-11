import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { ANVIL_KEYS, Sandbox, createAgentVault } from "@bonded/arena";
import { Keeper, connectChain, type ServiceChain } from "@bonded/keeper";
import {
  Quote,
  coverManagerAbi,
  coverPoolAbi,
  demoRouterAbi,
  mandateHash,
  mandateVaultAbi,
  operatorBondAbi,
  quoteMessage,
  selfServeMessage,
  signQuote,
  testTokenAbi,
} from "@bondedhq/shared";
import { createWalletClient, encodeFunctionData, http, parseUnits, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createApi } from "../src/index.js";
import { SecretBox } from "../src/secrets.js";
import { Notifier } from "../src/notifications.js";
import { OwnerAlerts } from "../src/owner-alerts.js";
import { AgentStatusReader } from "../src/agent-status.js";
import { runnerTokenHash, newRunnerToken } from "../src/runners.js";
import { postgres } from "./postgres.js";

const TOKEN = "test-api-token-at-least-24-characters";

describe("bring your own agent, launch round: report data, vault status, health, alerts", () => {
  let pg: Awaited<ReturnType<typeof postgres>>;
  let sandbox: Sandbox;
  let chain: ServiceChain;
  let app: ReturnType<typeof createApi>;
  let clock = Date.now();
  const owner = privateKeyToAccount(ANVIL_KEYS.operator);
  let agentId: string;
  let vault: `0x${string}`;
  let key: string;

  beforeAll(async () => {
    pg = await postgres();
    sandbox = await Sandbox.start();
    chain = connectChain(sandbox.deployment, sandbox.rpcUrl, ANVIL_KEYS.deployer);
    app = makeApi();
    const made = await createAgentVault(sandbox);
    agentId = made.agentId.toString();
    vault = made.address;
    key = `${sandbox.deployment.chainId}:${agentId}`;
    await pg.db.upsertUserAgent(sandbox.deployment.chainId, agentId, owner.address, {
      kind: "remote",
      mandate: made.mandate,
      mode: "tools",
      vault,
    });
    // One trade through the vault, signed by its agent key.
    const agent = createWalletClient({
      account: privateKeyToAccount(ANVIL_KEYS.agent),
      chain: sandbox.chain,
      transport: http(sandbox.rpcUrl),
    });
    const d = sandbox.deployment;
    const execute = async (target: `0x${string}`, data: `0x${string}`) =>
      sandbox.publicClient.waitForTransactionReceipt({
        hash: await agent.writeContract({
          address: vault,
          abi: mandateVaultAbi,
          functionName: "execute",
          args: [target, data],
        }),
      });
    await execute(
      d.usdg,
      encodeFunctionData({
        abi: testTokenAbi,
        functionName: "approve",
        args: [d.router, parseUnits("1500", 6)],
      }),
    );
    await execute(
      d.router,
      encodeFunctionData({
        abi: demoRouterAbi,
        functionName: "swap",
        args: [d.usdg, d.nvda, parseUnits("1500", 6), vault],
      }),
    );
    await new Keeper(pg.db, chain, 0n).tick();
  }, 240_000);
  afterAll(async () => {
    await app?.close();
    await sandbox?.stop();
    await pg?.stop();
  });

  function makeApi(extra: Partial<Parameters<typeof createApi>[0]> = {}) {
    return createApi({
      db: pg.db,
      chain,
      attesterKey: ANVIL_KEYS.deployer,
      apiToken: TOKEN,
      selfServe: { now: () => clock },
      secrets: new SecretBox(randomBytes(32)),
      allowLoopbackUrls: true,
      vaultStatusCacheMs: 0,
      statusCacheMs: 0,
      ...extra,
    });
  }
  async function sessionFor(who: PrivateKeyAccount, a = app) {
    clock += 1000;
    const timestamp = Math.floor(clock / 1000);
    const signature = await who.signMessage({
      message: selfServeMessage({
        action: "sign-in",
        chainId: sandbox.deployment.chainId,
        wallet: who.address,
        timestamp,
      }),
    });
    const res = await a.request("/self/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: who.address, timestamp, signature }),
    });
    return ((await res.json()) as { session: string }).session;
  }
  const get = (path: string, session?: string, a = app) =>
    Promise.resolve(
      a.request(path, { headers: session ? { Authorization: `Bearer ${session}` } : {} }),
    );
  const body = async (r: Response | Promise<Response>) =>
    (await (await r).json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  it("shows the vault's trades, the agent key's gas and the cover with the agent's record", async () => {
    const record = await body(get(`/self/agents/${agentId}`));
    expect(record.vaultActivity).toMatchObject({ total: 2, trades24h: 2, trades7d: 2 });
    expect(record.vaultActivity.lastTxHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(record.agentGas).toMatchObject({ low: false, basis: "measured" });
    expect(record.agentGas.estimatedTradesLeft).toBeGreaterThan(20);
    expect(record.cover).toBeNull();
    expect(record.coverWithoutVaultTrades).toBe(false);
    const activity = await body(get(`/self/agents/${agentId}/vault-activity`));
    expect(activity.agentKey).toBe(privateKeyToAccount(ANVIL_KEYS.agent).address.toLowerCase());
    expect((await get("/self/agents/999999/vault-activity")).status).toBe(404);
  });

  it("gives every refusal a stable code next to its sentence", async () => {
    const r = await get(`/self/agents/${agentId}/health`);
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({
      error: "Sign in with your wallet first.",
      code: "not-signed-in",
    });
    const bad = await body(get("/arena/runs/not-a-uuid"));
    expect(bad).toMatchObject({ error: "invalid request", code: "invalid-request" });
  });

  it("puts the agent's health in one answer, with problems as coded sentences", async () => {
    const session = await sessionFor(owner);
    const h = await body(get(`/self/agents/${agentId}/health`, session));
    expect(h.score).toBeNull();
    expect(h.vault).toMatchObject({ address: vault.toLowerCase(), frozen: false });
    expect(h.vault.activity.total).toBe(2);
    expect(h.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "no-score", severity: "problem" }),
        expect.objectContaining({ code: "runner-token-missing", action: expect.any(String) }),
      ]),
    );
    expect(h.ok).toBe(false);
    expect(h.nextRating).toMatchObject({ status: "none" });
    // Another wallet: not found.
    const stranger = await sessionFor(privateKeyToAccount(generatePrivateKey()));
    const other = await get(`/self/agents/${agentId}/health`, stranger);
    expect(other.status).toBe(404);
    expect((await body(other)).code).toBe("not-found");
  });

  it("suggests a mandate from the passing check and the ratings, with presets", async () => {
    const session = await sessionFor(owner);
    await pg.db.pool.query(
      `INSERT INTO connection_checks(id,subject,chain_id,owner,mode,connection,status,result,finished_at)
       VALUES($1,$2,$3,$4,'tools','runner','passed',$5,now())`,
      [
        randomUUID(),
        key,
        sandbox.deployment.chainId,
        owner.address.toLowerCase(),
        JSON.stringify({
          passed: true,
          problems: [],
          trading: {
            trades: 1,
            tokens: ["tNVDA", "tUSDG"],
            usedRouter: true,
            transfers: 0,
            approvals: 0,
            largestTradeUsd: 2000,
            totalOutflowUsd: 2000,
          },
        }),
      ],
    );
    const s = await body(get(`/self/agents/${agentId}/suggested-mandate`, session));
    expect(s.basis).toMatchObject({ sources: ["check"], trades: 1, largestTradeUsd: 2000 });
    expect(s.presets[0].rules).toMatchObject({
      chainId: sandbox.deployment.chainId,
      mode: "enforce",
      maxTradeUsd: 2500,
      assets: [sandbox.deployment.nvda],
      baseAsset: sandbox.deployment.usdg,
    });
    expect(s.presets.map((p: { id: string }) => p.id)).toEqual(["conservative", "active"]);
    expect(s).toMatchObject({ tokens: ["tNVDA"], largestTradeUsd: 2000 });
    expect((await get(`/self/agents/${agentId}/suggested-mandate`)).status).toBe(401);
  });

  it("compares two of a preview's ratings for its owner only, and suggests its mandate", async () => {
    const session = await sessionFor(owner);
    const preview = await pg.db.createPreview(
      {
        chainId: sandbox.deployment.chainId,
        owner: owner.address,
        mode: "tools",
        connection: "runner",
      },
      { nowMs: Date.now(), perWalletDaily: 10 },
    );
    if ("refused" in preview) throw new Error("refused");
    const rating = async (score: number, a6: number, trading?: unknown) => {
      const id = randomUUID();
      await pg.db.pool.query(
        "INSERT INTO ratings(id,preview_id,kind,status,charged_owner,report) VALUES($1,$2,'preview','done',$3,$4)",
        [
          id,
          preview.id,
          owner.address.toLowerCase(),
          JSON.stringify({
            scoring: { score, tier: "BBB", expectedLossBps: 100 - score },
            classes: [
              {
                class: "A1",
                name: "Injection via token metadata",
                episodes: 4,
                breaches: 1,
                lossUsd: 10,
              },
              {
                class: "A6",
                name: "Social engineering",
                episodes: 4,
                breaches: a6,
                lossUsd: 100 * a6,
              },
            ],
            ...(trading ? { trading } : {}),
          }),
        ],
      );
      return id;
    };
    const before = await rating(54, 3);
    const after = await rating(81, 0, {
      trades: 3,
      tokens: ["tTSLA", "tUSDG"],
      usedRouter: true,
      transfers: 0,
      approvals: 0,
      largestTradeUsd: 3000,
      totalOutflowUsd: 6000,
    });
    const cmp = await body(get(`/arena/runs/compare?from=${before}&to=${after}`, session));
    expect(cmp.from).toMatchObject({ score: 54, runId: before });
    expect(cmp.to).toMatchObject({ score: 81 });
    expect(cmp.sameAgent).toBe(true);
    expect(cmp.diff.score).toBe(27);
    expect(cmp.diff.classes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ class: "A6", breaches: -3, from: { episodes: 4, breaches: 3 } }),
        expect.objectContaining({ class: "A1", breaches: 0 }),
      ]),
    );
    const anon = await get(`/arena/runs/compare?from=${before}&to=${after}`);
    expect(anon.status).toBe(404);
    expect((await body(anon)).code).toBe("not-found");
    const s = await body(get(`/previews/${preview.id}/suggested-mandate`, session));
    expect(s.basis.sources).toEqual(["preview"]);
    expect(s.presets[1].rules.maxTradeUsd).toBe(6000);
  });

  it("doesn't compare a stock-trading preview's findings, or make one official", async () => {
    const session = await sessionFor(owner);
    // Rows made directly: createPreview counts toward the funnel another test here reads.
    const made = async (world: "vault" | "brokerage") => {
      const id = randomUUID();
      await pg.db.pool.query(
        `INSERT INTO previews(id,chain_id,owner,mode,connection,world,created_at,updated_at)
         VALUES($1,$2,$3,'tools','runner',$4,now(),now())`,
        [id, sandbox.deployment.chainId, owner.address.toLowerCase(), world],
      );
      return { id };
    };
    const brokerage = await made("brokerage");
    const findings = async () => {
      const id = randomUUID();
      await pg.db.pool.query(
        "INSERT INTO ratings(id,preview_id,kind,status,charged_owner,report) VALUES($1,$2,'preview','done',$3,$4)",
        [
          id,
          brokerage.id,
          owner.address.toLowerCase(),
          JSON.stringify({ world: "brokerage", findings: { attacks: { worked: 1 } } }),
        ],
      );
      return id;
    };
    // Finished, with findings and no score: said plainly, not "its rating is running".
    const cmp = await get(
      `/ratings/compare?from=${await findings()}&to=${await findings()}`,
      session,
    );
    expect(cmp.status).toBe(409);
    expect(await body(cmp)).toMatchObject({
      code: "brokerage-no-score",
      error: expect.stringMatching(/findings, not a score/) as unknown,
    });
    // "Make it official" links a vault preview only: a registered agent is rated on the vault.
    const agentKey = `${sandbox.deployment.chainId}:9001`;
    expect(await pg.db.linkPreviewUpgrade(brokerage.id, owner.address, agentKey)).toBe(false);
    expect(await pg.db.previewUpgradedTo(agentKey)).toBeUndefined();
    const vault = await made("vault");
    expect(await pg.db.linkPreviewUpgrade(vault.id, owner.address, agentKey)).toBe(true);
    expect((await pg.db.previewUpgradedTo(agentKey))?.id).toBe(vault.id);
  });

  it("alerts the owner once per event, honours opt-outs, and lists them in the inbox", async () => {
    const session = await sessionFor(owner);
    // A posted score that expires in two days: expiring, and a renewal is due.
    const runId = randomUUID();
    await pg.db.pool.query(
      "INSERT INTO ratings(id,agent_id,kind,status) VALUES($1,$2,'remote','done')",
      [runId, key],
    );
    const expiresAt = Math.floor(Date.now() / 1000) + 2 * 86_400;
    await pg.db.pool.query(
      "INSERT INTO attestations(id,agent_id,signed,tx_hash) VALUES($1,$2,$3,'0xabc')",
      [
        runId,
        key,
        JSON.stringify({
          attestation: { score: 72, expiresAt, issuedAt: expiresAt - 30 * 86_400 },
        }),
      ],
    );
    // A runner token, and no runner: offline while the renewal is due.
    await pg.db.createRunnerToken(key, {
      hash: runnerTokenHash(newRunnerToken()),
      createdBy: owner.address.toLowerCase(),
      signedAt: Date.now(),
    });
    // A breach the keeper indexed, its claim filed and paid.
    await pg.db.pool.query(
      `INSERT INTO handled_events(id,chain_id,vault,breach_id,status,tx_hash,breach_type,blocked,occurred_at,claim_filed_at)
       VALUES('b1',$1,$2,0,'claimed','0xdef',2,false,now(),now())`,
      [sandbox.deployment.chainId, vault.toLowerCase()],
    );
    // The owner turned "claim paid" off.
    const muted = await app.request("/self/notifications", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session}` },
      body: JSON.stringify({ muted: ["claim_paid"] }),
    });
    expect((await body(muted)).muted).toEqual(["claim_paid"]);

    const alerts = new OwnerAlerts(
      pg.db,
      sandbox.deployment.chainId,
      new Notifier(pg.db),
      new AgentStatusReader(pg.db, chain, { ttlMs: 0 }),
    );
    expect(await alerts.sweep()).toBe(4);
    expect(await alerts.sweep()).toBe(0);

    const inbox = await body(get("/self/notifications/inbox", session));
    expect(inbox.unread).toBe(4);
    expect(inbox.items.map((i: { kind: string }) => i.kind).sort()).toEqual([
      "breach-recorded",
      "claim-filed",
      "runner-offline",
      "score-expiring",
    ]);
    const expiring = inbox.items.find((i: { kind: string }) => i.kind === "score-expiring");
    expect(expiring).toMatchObject({ code: "score-expiring", read: false, subject: key });
    expect(expiring.message).toMatch(/score expires on/);
    expect(expiring.kind).toBe("score-expiring");
    const read = await app.request("/self/notifications/inbox/read", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session}` },
      body: JSON.stringify({ through: inbox.items[0].id }),
    });
    expect(await read.json()).toEqual({ marked: 4 });
    expect((await body(get("/self/notifications/inbox?unread=1", session))).items).toEqual([]);
    expect((await get("/self/notifications/inbox")).status).toBe(401);

    // The health panel now reads the same problems.
    const h = await body(get(`/self/agents/${agentId}/health`, session));
    expect(h.score).toMatchObject({ value: 72, status: "expiring", valid: true });
    expect(h.problems.map((p: { code: string }) => p.code)).toEqual(
      expect.arrayContaining(["score-expiring", "runner-offline", "breach-recorded"]),
    );
  });

  it("publishes a cached status page, and funnel counts only to the operator", async () => {
    const withGateway = makeApi({
      gatewayUrl: "https://gateway.example",
      statusFetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      version: "abc123",
    });
    const status = await body(withGateway.request("/status"));
    expect(status).toMatchObject({
      version: "abc123",
      gateway: { configured: true, up: true },
      lanes: { check: { healthy: true }, remote: { healthy: true } },
      previewQueue: 0,
    });
    expect(JSON.stringify(status)).not.toMatch(/0x[0-9a-fA-F]{40}/);
    await withGateway.close();

    // A running rating counts as running; once its lease runs out (the worker stopped renewing
    // it) the lane is unhealthy even though nothing is queued.
    const runId = randomUUID();
    await pg.db.pool.query(
      "INSERT INTO ratings(id,agent_id,kind,status,progress) VALUES($1,$2,'remote','running',$3)",
      [runId, key, JSON.stringify({ startedAt: new Date(Date.now() - 120_000).toISOString() })],
    );
    await pg.db.pool.query(
      "INSERT INTO jobs(id,status,lease_until) VALUES($1,'running',now()+interval '60 seconds')",
      [runId],
    );
    const fresh = await body(app.request("/status"));
    expect(fresh.lanes.remote).toMatchObject({
      healthy: true,
      queued: 0,
      running: 1,
      staleRunning: 0,
    });
    expect(fresh.lanes.remote.oldestRunningSeconds).toBeGreaterThanOrEqual(119);
    await pg.db.pool.query("UPDATE jobs SET lease_until=now()-interval '5 minutes' WHERE id=$1", [
      runId,
    ]);
    const stalled = await body(app.request("/status"));
    expect(stalled.ok).toBe(false);
    expect(stalled.lanes.remote).toMatchObject({
      healthy: false,
      queued: 0,
      running: 1,
      staleRunning: 1,
    });
    expect(stalled.lanes.check).toMatchObject({ healthy: true, running: 0 });
    await pg.db.pool.query("DELETE FROM jobs WHERE id=$1", [runId]);
    await pg.db.pool.query("DELETE FROM ratings WHERE id=$1", [runId]);

    const anon = await get("/stats/funnel");
    expect(anon.status).toBe(401);
    expect((await body(anon)).code).toBe("not-signed-in");
    const funnel = await body(
      app.request("/stats/funnel?days=7", { headers: { Authorization: `Bearer ${TOKEN}` } }),
    );
    expect(funnel.days).toHaveLength(7);
    expect(funnel.totals).toMatchObject({ onboarded: 1, first_vault_trade: 1, preview_started: 1 });
    expect(JSON.stringify(funnel)).not.toMatch(/0x/);
  });

  it("starts a check from the terminal with the runner token alone, for its own registration only", async () => {
    const check = (token?: string, a = app) =>
      Promise.resolve(
        a.request("/runner/check", {
          method: "POST",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        }),
      );
    const none = await check();
    expect(none.status).toBe(401);
    expect((await body(none)).code).toBe("runner-token-invalid");
    expect((await check(newRunnerToken())).status).toBe(401);

    let seq = 60_000;
    const make = async (subject: string, by: string) => {
      const token = newRunnerToken();
      clock += 1000;
      const made = await pg.db.createRunnerToken(subject, {
        hash: runnerTokenHash(token),
        createdBy: by.toLowerCase(),
        signedAt: Date.now() + (seq += 10_000),
      });
      if ("refused" in made) throw new Error("refused");
      return token;
    };
    const first = await make(key, owner.address);
    const started = await check(first);
    expect(started.status).toBe(201);
    const view = await body(started);
    expect(view).toMatchObject({ subject: { agentId }, streamToken: expect.any(String) });
    // No runner is connected, so it fails at once, saying so with its code.
    expect(view.issues).toEqual([
      expect.objectContaining({ code: "runner-not-connected", severity: "problem" }),
    ]);
    const stream = await app.request(`/checks/${view.checkId}/events?token=${view.streamToken}`);
    expect(stream.status).toBe(200);
    await stream.body?.cancel();
    // The stream token opens that check only.
    const otherCheck = await app.request(
      `/checks/${randomUUID()}/events?token=${view.streamToken}`,
    );
    expect(otherCheck.status).toBe(401);

    // A newer token replaces it: the old one is refused.
    const second = await make(key, owner.address);
    expect((await check(first)).status).toBe(401);
    expect((await check(second)).status).toBe(201);

    // A token made by someone who isn't the agent's owner (stale after a change of hands).
    const stale = await make(key, privateKeyToAccount(generatePrivateKey()).address);
    expect((await check(stale)).status).toBe(401);

    // A preview's token checks that preview.
    const preview = await pg.db.createPreview(
      {
        chainId: sandbox.deployment.chainId,
        owner: owner.address,
        mode: "tools",
        connection: "runner",
      },
      { nowMs: Date.now(), perWalletDaily: 10 },
    );
    if ("refused" in preview) throw new Error("refused");
    const previewToken = await make(`preview:${preview.id}`, owner.address);
    const p = await body(check(previewToken));
    expect(p.subject).toEqual({ previewId: preview.id });

    // The same per-address cap as the page.
    const capped = makeApi({ ownerRequests: { checksPerClientHourly: 1 } });
    expect((await check(previewToken, capped)).status).toBe(201);
    const refused = await check(previewToken, capped);
    expect(refused.status).toBe(429);
    expect((await body(refused)).code).toBe("check-limit");
    await capped.close();
  });

  it("reports a lapsed cover after the chain clears its active policy, and alerts once", async () => {
    const d = sandbox.deployment;
    const operator = connectChain(d, sandbox.rpcUrl, ANVIL_KEYS.operator);
    const usd = (n: number) => BigInt(n) * 1_000_000n;
    const made = await createAgentVault(sandbox, { deposit: 1_000 });
    const lapsing = made.address;
    await pg.db.upsertUserAgent(d.chainId, made.agentId.toString(), owner.address, {
      kind: "remote",
      mandate: made.mandate,
      mode: "tools",
      vault: lapsing,
    });
    // A bond, pool capacity, and cover bound on the vault.
    await operator.send(d.usdg, testTokenAbi, "faucet", [usd(110_000)]);
    await operator.send(d.usdg, testTokenAbi, "approve", [d.bond, usd(10_000)]);
    await operator.send(d.bond, operatorBondAbi, "stake", [made.agentId, usd(10_000)]);
    await operator.send(d.usdg, testTokenAbi, "approve", [d.pool, usd(100_000)]);
    await operator.send(d.pool, coverPoolAbi, "deposit", [
      usd(100_000),
      operator.wallet.account.address,
    ]);
    const chainNow = Number((await operator.read.getBlock()).timestamp);
    const signed = await signQuote(
      Quote.parse({
        agentId: made.agentId.toString(),
        vault: lapsing,
        coverAmount: usd(5_000).toString(),
        premiumRateBps: 120,
        score: 90,
        modelFamily: "unknown",
        mandateHash: mandateHash(made.mandate),
        reportHash: `0x${"ab".repeat(32)}`,
        minBond: "0",
        expiresAt: chainNow + 3600,
        nonce: "7",
      }),
      { chainId: d.chainId, coverManager: d.coverManager, attesterKey: ANVIL_KEYS.deployer },
    );
    await operator.send(d.coverManager, coverManagerAbi, "buyCover", [
      quoteMessage(signed.quote),
      signed.signature,
    ]);
    // The depositor takes everything out: nothing is left to pay premiums with.
    const depositor = connectChain(d, sandbox.rpcUrl, ANVIL_KEYS.depositor);
    const shares = await operator.read.readContract({
      address: lapsing,
      abi: mandateVaultAbi,
      functionName: "balanceOf",
      args: [depositor.wallet.account.address],
    });
    await depositor.send(lapsing, mandateVaultAbi, "redeem", [
      shares,
      depositor.wallet.account.address,
      depositor.wallet.account.address,
    ]);
    const advance = async (seconds: number) => {
      await operator.read.request({ method: "evm_increaseTime", params: [seconds] } as never);
      await operator.read.request({ method: "evm_mine", params: [] } as never);
    };
    // Every keeper tick accrues (interval 0) and indexes the CoverBound event.
    const keeper = new Keeper(pg.db, chain, 0n, 0);
    const reader = new AgentStatusReader(pg.db, chain, { ttlMs: 0 });

    // A day on, the premium can't be collected: past due, in the grace period.
    await advance(86_400);
    await keeper.tick();
    const due = (await reader.read(lapsing)).cover!;
    expect(due).toMatchObject({ status: "active", active: true });
    expect(due.pastDueSince).not.toBeNull();
    const grace = Number(
      await operator.read.readContract({
        address: d.coverManager,
        abi: coverManagerAbi,
        functionName: "gracePeriod",
      }),
    );
    expect(Date.parse(due.lapsesAt!) - Date.parse(due.pastDueSince!)).toBe(grace * 1000);

    // Past the grace period: the policy lapses, and CoverManager clears activePolicyOf.
    await advance(grace + 3600);
    await keeper.tick();
    expect(
      await operator.read.readContract({
        address: d.coverManager,
        abi: coverManagerAbi,
        functionName: "activePolicyOf",
        args: [lapsing],
      }),
    ).toBe(0n);
    const lapsed = (await reader.read(lapsing)).cover!;
    expect(lapsed).toMatchObject({
      policyId: due.policyId,
      status: "lapsed",
      active: false,
      pastDueSince: due.pastDueSince,
      lapsesAt: due.lapsesAt,
    });

    const session = await sessionFor(owner);
    const h = await body(get(`/self/agents/${made.agentId}/health`, session));
    expect(h.cover).toMatchObject({
      status: "lapsed",
      policyStatus: "lapsed",
      policyId: due.policyId,
    });
    expect(h.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "cover-lapsing" })]),
    );

    const alerts = new OwnerAlerts(pg.db, d.chainId, new Notifier(pg.db), reader);
    await alerts.sweep();
    await alerts.sweep();
    const sent = await pg.db.pool.query(
      "SELECT dedupe_key FROM owner_notifications WHERE type='cover_lapsing' AND subject=$1",
      [`${d.chainId}:${made.agentId}`],
    );
    expect(sent.rows).toEqual([{ dedupe_key: `cover_lapsed:${due.policyId}` }]);
  }, 120_000);
});

void ({} as Hex);
