import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RUNNER_FRESH_MS, remoteCooldownMs, type Database } from "@bonded/db";
import { postgres } from "./postgres.js";

let pg: Awaited<ReturnType<typeof postgres>>;
let db: Database;
const CHAIN = 31337;
const remote = { kind: "remote", mode: "tools" };
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
async function agent(id: number, config: unknown = remote, enabled = true) {
  await db.pool.query(
    "INSERT INTO agents(id,chain_id,agent_id,config,enabled,source,owner) VALUES($1,$2,$3,$4,$5,'user','0xowner')",
    [`${CHAIN}:${id}`, CHAIN, id, JSON.stringify(config), enabled],
  );
  return `${CHAIN}:${id}`;
}
const hello = { runnerVersion: "0.1.0", mode: "tools" };
/** The migrations' numbers: 0001 to 0032 (0032 removes the gate's key-holding routes). */
const MIGRATIONS = [...Array.from({ length: 32 }, (_, i) => i + 1)];

beforeAll(async () => {
  pg = await postgres();
  db = pg.db;
}, 120_000);
afterAll(() => pg?.stop());

describe("migrations 0014 to 0032", () => {
  it("apply once, in order, and again is a no-op", async () => {
    const versions = (
      await db.pool.query("SELECT version FROM schema_migrations ORDER BY version")
    ).rows.map((r) => r.version);
    // Numbered by their file names, each once and in order.
    expect(versions).toEqual(MIGRATIONS);
    await db.migrate();
    const tables = (
      await db.pool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_name IN ('runner_tokens','runner_presence','rating_skips','held_out_payloads') ORDER BY 1",
      )
    ).rows.map((r) => r.table_name);
    expect(tables).toEqual([
      "held_out_payloads",
      "rating_skips",
      "runner_presence",
      "runner_tokens",
    ]);
    const columns = (
      await db.pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name='handled_events' AND column_name IN ('agent_id','breach_type','blocked','occurred_at') ORDER BY 1",
      )
    ).rows.map((r) => r.column_name);
    expect(columns).toEqual(["agent_id", "blocked", "breach_type", "occurred_at"]);
    // 0018: what each rating was queued under.
    const rated = (
      await db.pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name='ratings' AND column_name IN ('kind','charged_owner','config') ORDER BY 1",
      )
    ).rows.map((r) => r.column_name);
    expect(rated).toEqual(["charged_owner", "config", "kind"]);
    // 0024: the payment gate; 0031: its card hooks. 0032 dropped the tables of its card route
    // (0025) and payout route (0028), which held customers' Stripe keys.
    const gate = (
      await db.pool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'gate\\_%' ORDER BY 1",
      )
    ).rows.map((r) => r.table_name);
    expect(gate).toEqual([
      "gate_accounts",
      "gate_api_keys",
      "gate_card_hooks",
      "gate_decisions",
      "gate_invoices",
      "gate_log_roots",
      "gate_mandates",
      "gate_payments",
      "gate_refunds",
      "gate_tickets",
      "gate_usage_daily",
      "gate_vendors",
      "gate_watch_wallets",
      "gate_watched_payments",
    ]);
    const merchant = (
      await db.pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name='gate_vendors' AND column_name LIKE 'card\\_merchant\\_%' ORDER BY 1`,
      )
    ).rows.map((r) => r.column_name);
    expect(merchant).toEqual(["card_merchant_id", "card_merchant_name", "card_merchant_norm"]);
    // 0026: each check's input, and what is posted to GateAnchor.
    const anchored = (
      await db.pool.query(
        "SELECT table_name, column_name FROM information_schema.columns WHERE (table_name='gate_decisions' AND column_name='input') OR (table_name IN ('gate_mandates','gate_log_roots') AND column_name='anchored_at') ORDER BY 1",
      )
    ).rows.map((r) => r.table_name);
    expect(anchored).toEqual(["gate_decisions", "gate_log_roots", "gate_mandates"]);
    // 0027: the data APIs.
    const data = (
      await db.pool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_name IN ('data_api_keys','data_api_usage_daily','index_webhooks','index_snapshots','index_webhook_deliveries','ci_runs') ORDER BY 1",
      )
    ).rows.map((r) => r.table_name);
    expect(data).toEqual([
      "ci_runs",
      "data_api_keys",
      "data_api_usage_daily",
      "index_snapshots",
      "index_webhook_deliveries",
      "index_webhooks",
    ]);
  });
});

describe("migration 0029 on gate rows stored before it", () => {
  it("sets a mixed-case base58 account's key back to its case, and leaves the rest", async () => {
    const old = await postgres({ migrate: false });
    try {
      const dir = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
      const files = (await readdir(dir)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
      await old.db.pool.query("CREATE TABLE schema_migrations (version integer PRIMARY KEY)");
      for (const file of files.filter((f) => Number(f.slice(0, 4)) < 29)) {
        await old.db.pool.query(await readFile(join(dir, file), "utf8"));
        await old.db.pool.query("INSERT INTO schema_migrations VALUES ($1)", [
          Number(file.slice(0, 4)),
        ]);
      }
      // As the gate stored them before 0029: every account key in upper case.
      const solana = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
      const iban = "GB29 NWBK 6016 1331 9268 19";
      const id = "00000000-0000-4000-8000-000000000029";
      const q = (sql: string, args: unknown[]) => old.db.pool.query(sql, args);
      await q(
        "INSERT INTO gate_accounts(id,owner,mode,max_payment_cents,max_daily_cents,mandate_hash) VALUES($1,'0xowner','monitor',100,100,'0x')",
        [id],
      );
      for (const [vendor, account] of [
        ["sol", solana],
        ["bank", iban],
      ] as const)
        await q(
          "INSERT INTO gate_vendors(account_id,id,name,account,account_norm) VALUES($1,$2,$2,$3,$4)",
          [id, vendor, account, account.replace(/\s+/g, "").toUpperCase()],
        );
      await q(
        "INSERT INTO gate_payments(account_id,source,kind,payee,payee_norm,amount_cents,reference,reference_norm,day) VALUES($1,'check','invoice',$2,$3,100,'A','A','2026-11-01')",
        [id, solana, solana.toUpperCase()],
      );
      await old.db.migrate();
      const vendors = (
        await q("SELECT id, account_norm FROM gate_vendors WHERE account_id=$1 ORDER BY id", [id])
      ).rows;
      expect(vendors).toEqual([
        { id: "bank", account_norm: "GB29NWBK60161331926819" },
        { id: "sol", account_norm: solana },
      ]);
      const paid = (await q("SELECT payee_norm FROM gate_payments WHERE account_id=$1", [id])).rows;
      expect(paid).toEqual([{ payee_norm: solana }]);
    } finally {
      await old.stop();
    }
  }, 120_000);
});

describe("migrations on a database that main already migrated", () => {
  it("applies only 0020 and later after 0001 to 0019, then nothing", async () => {
    // Before migrations took their version from the file name, the version was the place in the
    // list: on main that put 0001 to 0019 at versions 1 to 19, the same numbers.
    const old = await postgres({ migrate: false });
    try {
      const dir = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
      const files = (await readdir(dir)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
      expect(files.map((f) => Number(f.slice(0, 4)))).toEqual(MIGRATIONS);
      await old.db.pool.query("CREATE TABLE schema_migrations (version integer PRIMARY KEY)");
      for (const [index, file] of files.slice(0, 19).entries()) {
        await old.db.pool.query(await readFile(join(dir, file), "utf8"));
        await old.db.pool.query("INSERT INTO schema_migrations VALUES ($1)", [index + 1]);
      }
      // It holds an agent from the Sep 27 deployment, as the hosted database does.
      await old.db.pool.query(
        "INSERT INTO agents(id,chain_id,agent_id,config) VALUES('46630:2',46630,2,'{}')",
      );
      await old.db.migrate();
      const versions = async () =>
        (
          await old.db.pool.query("SELECT version FROM schema_migrations ORDER BY version")
        ).rows.map((r) => r.version);
      expect(await versions()).toEqual(MIGRATIONS);
      const added = (
        await old.db.pool.query(
          "SELECT table_name FROM information_schema.tables WHERE table_name IN ('previews','notification_settings') ORDER BY 1",
        )
      ).rows.map((r) => r.table_name);
      expect(added).toEqual(["notification_settings", "previews"]);
      // 0022: vault trades, the in-app list and funnel counts.
      const launch = (
        await old.db.pool.query(
          "SELECT table_name FROM information_schema.tables WHERE table_name IN ('vault_trades','owner_notifications','funnel_daily') ORDER BY 1",
        )
      ).rows.map((r) => r.table_name);
      expect(launch).toEqual(["funnel_daily", "owner_notifications", "vault_trades"]);
      // 0023: the database records that its state is from the Sep 27 deployment, so the services
      // wait for the operator before running on the Oct 10 one.
      expect((await old.db.pool.query("SELECT chain_id,registry FROM deployments")).rows).toEqual([
        { chain_id: 46630, registry: "0x35f6d30be731a639235ccad7abedda4d4be8d4f9" },
      ]);
      await old.db.migrate();
      expect(await versions()).toEqual(MIGRATIONS);
    } finally {
      await old.stop();
    }
  }, 120_000);
});

describe("runner tokens", () => {
  it("stores only the hash, finds the live token, and a new token replaces the old one", async () => {
    const key = await agent(1);
    const first = await db.createRunnerToken(key, {
      hash: sha("one"),
      createdBy: "0xOwner",
      signedAt: 100,
    });
    expect(first).toHaveProperty("id");
    const stored = (await db.pool.query("SELECT * FROM runner_tokens WHERE agent_id=$1", [key]))
      .rows[0];
    expect(stored.token_hash).toBe(sha("one"));
    expect(JSON.stringify(stored)).not.toContain('"one"');
    expect(stored.created_by).toBe("0xowner");
    expect(await db.runnerToken(sha("one"))).toMatchObject({
      agentKey: key,
      chainId: CHAIN,
      agentId: "1",
      config: remote,
    });
    await db.createRunnerToken(key, { hash: sha("two"), createdBy: "0xowner", signedAt: 101 });
    expect(await db.runnerToken(sha("one"))).toBeUndefined();
    expect(await db.runnerToken(sha("two"))).toMatchObject({ agentKey: key });
    expect(await db.runnerToken(sha("never"))).toBeUndefined();
  });

  it("refuses a request signed no later than the last one, for create and revoke", async () => {
    const key = await agent(2);
    await db.createRunnerToken(key, { hash: sha("a"), createdBy: "0xowner", signedAt: 200 });
    expect(
      await db.createRunnerToken(key, { hash: sha("b"), createdBy: "0xowner", signedAt: 200 }),
    ).toEqual({ refused: "replayed" });
    expect(await db.revokeRunnerToken(key, 199)).toEqual({ refused: "replayed" });
    expect(await db.revokeRunnerToken(key, 201)).toEqual({ revoked: 1 });
    expect(await db.runnerToken(sha("a"))).toBeUndefined();
    // The revocation's signature can't be replayed either, and nothing is left to revoke.
    expect(await db.revokeRunnerToken(key, 201)).toEqual({ refused: "replayed" });
    expect(await db.revokeRunnerToken(key, 202)).toEqual({ revoked: 0 });
  });

  it("doesn't validate a token of a disabled agent", async () => {
    const key = await agent(3, remote, false);
    await db.createRunnerToken(key, { hash: sha("off"), createdBy: "0xowner", signedAt: 1 });
    expect(await db.runnerToken(sha("off"))).toBeUndefined();
  });
});

describe("held-out ledger", () => {
  it("remembers which payload hashes were used, once each", async () => {
    expect(await db.heldOutPayloadsUsed(["a", "b"])).toEqual(new Set());
    await db.recordHeldOutPayloads(["a", "c"]);
    await db.recordHeldOutPayloads(["a"]);
    expect(await db.heldOutPayloadsUsed(["a", "b", "c"])).toEqual(new Set(["a", "c"]));
    expect(await db.heldOutPayloadsUsed([])).toEqual(new Set());
  });
});

describe("runner presence", () => {
  it("is connected while heartbeats are fresh, and a replaced connection can't touch the new one", async () => {
    const key = await agent(10);
    const t = await db.createRunnerToken(key, {
      hash: sha("p"),
      createdBy: "0xowner",
      signedAt: 1,
    });
    if (!("id" in t)) throw new Error("no token");
    expect(await db.runnerIsConnected(key)).toBe(false);
    const first = await db.runnerConnected(key, { ...hello, teeUrl: "https://tee.example" });
    expect(first).toBeTruthy();
    expect(await db.runnerIsConnected(key)).toBe(true);
    const status = await db.runnerStatus(key);
    expect(status.token?.id).toBe(t.id);
    expect(status.runner).toMatchObject({
      connected: true,
      runnerVersion: "0.1.0",
      mode: "tools",
      teeUrl: "https://tee.example",
    });
    // A second connection on the same token replaces the first.
    const second = await db.runnerConnected(key, hello);
    expect(await db.runnerHeartbeat(first!)).toBe(false);
    await db.runnerDisconnected(first!);
    expect(await db.runnerIsConnected(key)).toBe(true);
    expect(await db.runnerHeartbeat(second!)).toBe(true);
    // Silent for longer than three heartbeats: no longer connected.
    await db.pool.query(
      "UPDATE runner_presence SET last_heartbeat_at=now() - make_interval(secs => $2) WHERE agent_id=$1",
      [key, RUNNER_FRESH_MS / 1000 + 1],
    );
    expect(await db.runnerIsConnected(key)).toBe(false);
    expect((await db.runnerStatus(key)).runner?.connected).toBe(false);
    await db.runnerHeartbeat(second!);
    expect(await db.runnerIsConnected(key)).toBe(true);
    await db.runnerDisconnected(second!);
    expect(await db.runnerIsConnected(key)).toBe(false);
  });

  it("doesn't count a runner whose token wasn't made by the agent's owner", async () => {
    const key = await agent(12);
    await db.createRunnerToken(key, { hash: sha("q"), createdBy: "0xsomeoneelse", signedAt: 1 });
    expect(await db.runnerConnected(key, hello)).toBeTruthy();
    expect(await db.runnerIsConnected(key)).toBe(false);
    expect(await db.revokeAllRunnerTokens(key)).toBe(1);
    expect((await db.runnerStatus(key)).token).toBeNull();
  });

  it("revoking the token disconnects the runner and stops its heartbeats", async () => {
    const key = await agent(11);
    const t = await db.createRunnerToken(key, {
      hash: sha("r"),
      createdBy: "0xowner",
      signedAt: 1,
    });
    if (!("id" in t)) throw new Error("no token");
    const connection = await db.runnerConnected(key, hello);
    await db.revokeRunnerToken(key, 2);
    expect(await db.runnerHeartbeat(connection!)).toBe(false);
    expect(await db.runnerIsConnected(key)).toBe(false);
    expect(await db.runnerConnected(key, hello)).toBeUndefined();
    expect((await db.runnerStatus(key)).token).toBeNull();
  });
});

describe("live loop", () => {
  async function connect(key: string, signedAt = 1) {
    const t = await db.createRunnerToken(key, {
      hash: sha(`${key}:${signedAt}`),
      createdBy: "0xowner",
      signedAt,
    });
    if (!("id" in t)) throw new Error("no token");
    return db.runnerConnected(key, hello);
  }
  async function attest(key: string, expiresAt: number) {
    const runId = await db.enqueue(key);
    await db.pool.query("UPDATE jobs SET status='done' WHERE id=$1", [runId]);
    await db.pool.query(
      "UPDATE ratings SET status='done',created_at=now()-interval '1 day',report=$2 WHERE id=$1",
      [
        runId,
        JSON.stringify({
          scoring: { groups: [{ id: "injection", episodes: 10, breaches: 1 }] },
        }),
      ],
    );
    await db.pool.query(
      "INSERT INTO attestations(id,agent_id,signed,tx_hash) VALUES($1,$2,$3,'0x')",
      [
        runId,
        key,
        JSON.stringify({ attestation: { issuedAt: expiresAt - 30 * 86400, expiresAt } }),
      ],
    );
  }

  it("queues a re-rating only when the agent is idle", async () => {
    const key = await agent(20);
    const first = await db.enqueueIfIdle(key, 60_000);
    expect(first).toBeTruthy();
    expect(await db.enqueueIfIdle(key, 60_000)).toBeUndefined();
    await db.pool.query("UPDATE jobs SET status='failed' WHERE id=$1", [first]);
    // Finished, but within the gap.
    expect(await db.enqueueIfIdle(key, 60_000)).toBeUndefined();
    await db.pool.query("UPDATE ratings SET created_at=now()-interval '2 minutes' WHERE id=$1", [
      first,
    ]);
    expect(await db.enqueueIfIdle(key, 60_000)).toBeTruthy();
  });

  it("finds remote agents with a connected runner whose score is about to expire", async () => {
    const soon = await agent(30);
    const later = await agent(31);
    const offline = await agent(32);
    const builtIn = await agent(33, { kind: "hardened" });
    const now = 2_000_000_000;
    await attest(soon, now + 2 * 86400);
    await attest(later, now + 10 * 86400);
    await attest(offline, now + 86400);
    await attest(builtIn, now + 86400);
    for (const k of [soon, later, builtIn]) await connect(k);
    expect(await db.remoteAgentsExpiring(CHAIN, now + 3 * 86400)).toEqual([soon]);
  });

  it("skips operator-run agents on bounty acceptance, with the reason on record", async () => {
    // Bounties are never run against an agent its operator runs (the operator would see them),
    // so a re-rating would only use up its caps: online or not, it is skipped.
    const chain = 777;
    const ids = { online: `${chain}:1`, offline: `${chain}:2`, builtIn: `${chain}:3` };
    for (const [n, cfg] of [
      [1, remote],
      [2, remote],
      [3, { kind: "partial" }],
    ] as const)
      await db.pool.query(
        "INSERT INTO agents(id,chain_id,agent_id,config,source,owner) VALUES($1,$2,$3,$4,'user','0xowner')",
        [`${chain}:${n}`, chain, n, JSON.stringify(cfg)],
      );
    await connect(ids.online);
    await db.submitBounty({
      chainId: chain,
      submissionId: "5",
      hunter: "0xhunter",
      specUri: "sha256:x",
      specYaml: "x",
      spec: { id: "A1-bounty-x" },
    });
    const job = await db.takeBounty(chain);
    await db.finishBounty(job!, { status: "accepted", verdict: {}, txHash: "0xabc" });
    const queued = (
      await db.pool.query("SELECT agent_id FROM ratings WHERE agent_id LIKE $1 ORDER BY 1", [
        `${chain}:%`,
      ])
    ).rows.map((r) => r.agent_id);
    expect(queued).toEqual([ids.builtIn]);
    for (const id of [ids.online, ids.offline]) {
      const skip = (await db.runnerStatus(id)).lastSkip;
      expect(skip).toMatchObject({ cause: "bounty" });
      expect(skip?.reason).toBe(
        "bounty 5 was accepted, but bounty attacks aren't run against operator-run agents, so no re-rating was queued",
      );
    }
  });

  it("reads observed-rate inputs: scores' validity and breaches with their details", async () => {
    const key = await agent(40, { kind: "hardened" });
    await attest(key, 2_000_000_000);
    await db.pool.query(
      `INSERT INTO handled_events(id,chain_id,vault,breach_id,agent_id,breach_type,blocked,occurred_at)
       VALUES('b1',$1,'0xv',1,40,2,false,to_timestamp(1990000000)),('b2',$1,'0xv',2,NULL,NULL,NULL,NULL)`,
      [CHAIN],
    );
    const inputs = await db.observedRateInputs(CHAIN);
    const mine = inputs.periods.find((p) => p.agentId === "40");
    expect(mine).toEqual({
      agentId: "40",
      from: 2_000_000_000 - 30 * 86400,
      to: 2_000_000_000,
      groups: [{ id: "injection", episodes: 10, breaches: 1 }],
    });
    expect(inputs.breaches).toEqual(
      expect.arrayContaining([
        { agentId: "40", at: new Date(1_990_000_000_000), blocked: false },
        { agentId: null, at: null, blocked: null },
      ]),
    );
  });
});

describe("rating lanes", () => {
  it("keeps remote ratings apart from Bonded's own, and takes turns by owner", async () => {
    const chain = 888;
    const add = async (n: number, owner: string, kind: string) => {
      await db.pool.query(
        "INSERT INTO agents(id,chain_id,agent_id,config,source,owner) VALUES($1,$2,$3,$4,'user',$5)",
        [`${chain}:${n}`, chain, n, JSON.stringify({ kind }), owner],
      );
      return `${chain}:${n}`;
    };
    const builtIn = await add(1, "0xa", "hardened");
    const busy1 = await add(2, "0xbusy", "remote");
    const busy2 = await add(3, "0xbusy", "remote");
    const quiet = await add(4, "0xquiet", "remote");
    // The busy owner already had a rating today; its queued ones are older than the quiet one's.
    const old = await db.enqueue(busy1);
    await db.pool.query("UPDATE jobs SET status='done' WHERE id=$1", [old]);
    const first = await db.enqueue(busy2);
    const second = await db.enqueue(quiet);
    const own = await db.enqueue(builtIn);
    await db.pool.query("UPDATE jobs SET available_at=now()-interval '1 minute' WHERE id=$1", [
      first,
    ]);
    // The builtin lane only sees Bonded's own; the remote lane picks the quiet owner first.
    expect((await db.takeJob(chain, "builtin"))?.id).toBe(own);
    expect((await db.takeJob(chain, "remote"))?.id).toBe(second);
    expect((await db.takeJob(chain, "remote"))?.id).toBe(first);
    expect(await db.takeJob(chain, "remote")).toBeUndefined();
  });

  it("reports a run's progress and an agent's attempts", async () => {
    const key = await agent(50);
    const runId = await db.enqueue(key);
    for (let index = 0; index < 3; index++)
      await db.publish("rating.episode", { runId, index, total: 10, episode: {} });
    expect(await db.runProgress(runId)).toMatchObject({ done: 3, total: 10 });
    await db.pool.query("UPDATE ratings SET status='failed',error='stopped: x' WHERE id=$1", [
      runId,
    ]);
    expect(await db.ratingAttempts(key)).toEqual({
      items: [
        expect.objectContaining({
          runId,
          status: "failed",
          error: "stopped: x",
          agentCaused: false,
          score: null,
        }),
      ],
      page: 1,
      pages: 1,
      total: 1,
    });
  });
});

describe("standing and caps of operator-run agents", () => {
  const quota = (over = {}) => ({
    nowMs: Date.now(),
    perOwnerDaily: 3,
    perAgentDaily: 2,
    laneDaily: 20,
    ...over,
  });
  async function leased(key: string) {
    const runId = await db.enqueue(key);
    const token = "00000000-0000-0000-0000-000000000001";
    await db.pool.query(
      "UPDATE jobs SET status='running',token=$2,lease_until=now()+interval '1 minute' WHERE id=$1",
      [runId, token],
    );
    return { id: runId, token };
  }

  it("doubles the cooldown with each agent-caused stop, supersedes the score, and resets on success", async () => {
    expect([1, 2, 3, 4, 7, 9].map((n) => remoteCooldownMs(n) / 3_600_000)).toEqual([
      1, 2, 4, 8, 48, 48,
    ]);
    const key = await agent(60);
    await db.finish(await leased(key), "stopped: the agent failed in episode 1 of 8", {
      final: true,
      agentCaused: true,
      agentReport: "Traceback: boom",
    });
    let standing = await db.agentStanding(key);
    expect(standing.failuresInRow).toBe(1);
    expect(standing.superseded?.reason).toBe("stopped: the agent failed in episode 1 of 8");
    const first = standing.cooldownUntil!.getTime();
    await db.finish(await leased(key), "stopped: again", { final: true, agentCaused: true });
    standing = await db.agentStanding(key);
    expect(standing.failuresInRow).toBe(2);
    expect(standing.cooldownUntil!.getTime() - first).toBeGreaterThan(3_500_000);
    // The runner's words are kept apart from the system's reason.
    const attempts = (await db.ratingAttempts(key)).items;
    expect(attempts.at(-1)).toMatchObject({ agentCaused: true, agentReport: "Traceback: boom" });
    // An infrastructure failure doesn't count against the agent.
    await db.finish(await leased(key), "rating failed; retry scheduled");
    expect((await db.agentStanding(key)).failuresInRow).toBe(2);
    // While cooling down, nothing is queued for it, renewals included.
    expect(await db.enqueueIfIdle(key, 0, quota())).toBeUndefined();
    await db.finish(await leased(key));
    expect(await db.agentStanding(key)).toEqual({
      failuresInRow: 0,
      superseded: null,
      cooldownUntil: null,
    });
  });

  it("caps remote ratings per agent, per owner and for the lane, apart from the built-in designs", async () => {
    const chain = 999;
    const add = async (n: number, owner: string, kind: string) => {
      await db.pool.query(
        "INSERT INTO agents(id,chain_id,agent_id,config,source,owner) VALUES($1,$2,$3,$4,'user',$5)",
        [`${chain}:${n}`, chain, n, JSON.stringify({ kind }), owner],
      );
      return `${chain}:${n}`;
    };
    const [a1, a2, b1, design] = [
      await add(1, "0xa", "remote"),
      await add(2, "0xa", "remote"),
      await add(3, "0xb", "remote"),
      await add(4, "0xc", "hardened"),
    ];
    const rate = (key: string, over = {}) =>
      db.enqueueUserRating(key, chain, {
        nowMs: Date.now(),
        perAgentMs: 0,
        dailyCap: 1,
        remote: quota(over),
      });
    expect(await rate(a1)).toHaveProperty("runId");
    expect(await rate(a1)).toHaveProperty("runId");
    expect(await rate(a1)).toEqual({ refused: "agent-daily" });
    expect(await rate(a2)).toHaveProperty("runId");
    // Owner 0xa has had three today.
    expect(await rate(a2)).toEqual({ refused: "owner-daily" });
    expect(await rate(b1, { laneDaily: 3 })).toEqual({ refused: "lane-daily" });
    // The remote ratings didn't use the built-in designs' daily allowance (1 here).
    expect(
      await db.enqueueUserRating(design, chain, { nowMs: Date.now(), perAgentMs: 0, dailyCap: 1 }),
    ).toHaveProperty("runId");
  });

  it("counts ratings by what they were queued as, so registering again doesn't reset the caps", async () => {
    const chain = 998;
    const add = async (n: number, owner: string, kind: string) => {
      await db.pool.query(
        `INSERT INTO agents(id,chain_id,agent_id,config,source,owner) VALUES($1,$2,$3,$4,'user',$5)
         ON CONFLICT(id) DO UPDATE SET config=EXCLUDED.config,owner=EXCLUDED.owner`,
        [`${chain}:${n}`, chain, n, JSON.stringify({ kind }), owner],
      );
      return `${chain}:${n}`;
    };
    const [one, two] = [await add(1, "0xa", "remote"), await add(2, "0xa", "remote")];
    const caps = { perOwnerDaily: 1, perAgentDaily: 1, laneDaily: 1 };
    const rate = (key: string) =>
      db.enqueueUserRating(key, chain, {
        nowMs: Date.now(),
        perAgentMs: 0,
        dailyCap: 100,
        remote: quota(caps),
      });
    expect(await rate(one)).toHaveProperty("runId");
    expect(await rate(two)).toEqual({ refused: "owner-daily" });
    // Agent 1 registered again as a built-in design: its remote rating still counts, for its owner
    // and for the lane.
    await add(1, "0xa", "hardened");
    expect(await rate(two)).toEqual({ refused: "owner-daily" });
    // And another owner registering agent 1 doesn't move the charge off 0xa.
    await add(1, "0xz", "hardened");
    expect(await rate(two)).toEqual({ refused: "owner-daily" });
    const queued = (
      await db.pool.query("SELECT kind,charged_owner,config FROM ratings WHERE agent_id=$1", [one])
    ).rows;
    expect(queued).toEqual([{ kind: "remote", charged_owner: "0xa", config: { kind: "remote" } }]);
  });
});
