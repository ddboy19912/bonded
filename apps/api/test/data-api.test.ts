import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANVIL_KEYS } from "@bonded/arena";
import { connectChain } from "@bonded/keeper";
import {
  BondedIndex,
  indexModelSlug,
  lossPerThousandRuns,
  parseEvmDeployment,
  selfServeMessage,
} from "@bondedhq/shared";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createApi } from "../src/index.js";
import { INDEX_FILE, IndexWebhooks, WEBHOOK_RETRY_MS, readBondedIndex } from "../src/model-risk.js";
import { SecretBox, verifySignature } from "../src/secrets.js";
import { postgres } from "./postgres.js";

const TOKEN = "data-api-test-token-at-least-24-characters";
// Throwaway wallets and keys, made for this run.
const owner = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const secrets = new SecretBox(randomBytes(32));

const chain = connectChain(
  parseEvmDeployment(
    readFileSync(new URL("../../../contracts/evm/deployments/46630.json", import.meta.url), "utf8"),
  ),
  "http://127.0.0.1:1",
  ANVIL_KEYS.deployer,
);
const chainId = chain.deployment.chainId;
const config = BondedIndex.parse(JSON.parse(readFileSync(INDEX_FILE, "utf8")));

let pg: Awaited<ReturnType<typeof postgres>>;
let app: ReturnType<typeof createApi>;
const clock = Date.parse("2026-11-03T10:00:00Z");
const wide = { perClient: 100_000, total: 1_000_000, windowMs: 600_000 };

const makeApi = (dataApi: Parameters<typeof createApi>[0]["dataApi"] = {}) =>
  createApi({
    db: pg.db,
    chain,
    attesterKey: ANVIL_KEYS.deployer,
    apiToken: TOKEN,
    selfServe: { now: () => clock },
    ownerRequests: { writes: wide, reads: wide },
    secrets,
    verifyAgentUrl: async () => ({ ok: true, version: "v1" }),
    dataApi,
  });

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(
  method: string,
  path: string,
  body?: unknown,
  auth?: string,
  a: ReturnType<typeof createApi> = app,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Body; headers: Headers }> {
  const res = await a.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Body, headers: res.headers };
}

const sessions = new Map<string, string>();
async function sessionFor(who: PrivateKeyAccount) {
  const known = sessions.get(who.address);
  if (known) return known;
  const timestamp = Math.floor(clock / 1000);
  const signature = await who.signMessage({
    message: selfServeMessage({ action: "sign-in", chainId, wallet: who.address, timestamp }),
  });
  const r = await call("POST", "/self/session", { wallet: who.address, timestamp, signature });
  expect(r.status).toBe(201);
  sessions.set(who.address, r.body.session);
  return r.body.session as string;
}
async function newKey(who: PrivateKeyAccount = owner, a = app) {
  const r = await call("POST", "/data/keys", { label: "ci" }, await sessionFor(who), a);
  expect(r.status).toBe(201);
  return { id: r.body.id as string, key: r.body.key as string };
}

beforeAll(async () => {
  pg = await postgres();
  app = makeApi();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

describe("data API keys", () => {
  it("are made by a signed-in owner, shown once and stored as a hash", async () => {
    const anonymous = await call("POST", "/data/keys", {});
    expect(anonymous.status).toBe(401);
    const session = await sessionFor(owner);
    const made = await call("POST", "/data/keys", { label: "build" }, session);
    expect(made.status).toBe(201);
    expect(made.headers.get("cache-control")).toBe("no-store");
    expect(made.body.key).toMatch(/^bonded_dk_[A-Za-z0-9_-]{43}$/);
    expect(made.body.prefix).toBe(made.body.key.slice(0, 14));
    const rows = await pg.db.pool.query("SELECT * FROM data_api_keys WHERE id=$1", [made.body.id]);
    expect(JSON.stringify(rows.rows)).not.toContain(made.body.key);
    const listed = await call("GET", "/data/keys", undefined, session);
    expect(JSON.stringify(listed.body)).not.toContain(made.body.key);
    expect(listed.body.items.find((k: Body) => k.id === made.body.id)).toMatchObject({
      label: "build",
      revokedAt: null,
    });
  });

  it("are limited per wallet, hidden from other wallets, and stop working when revoked", async () => {
    const limited = makeApi({ maxKeysPerOwner: 1 });
    const who = privateKeyToAccount(generatePrivateKey());
    const session = await sessionFor(who);
    const first = await call("POST", "/data/keys", {}, session, limited);
    expect(first.status).toBe(201);
    const second = await call("POST", "/data/keys", {}, session, limited);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("data-key-limit");
    await limited.close();

    const other = await sessionFor(stranger);
    const theirs = await call("DELETE", `/data/keys/${first.body.id}`, undefined, other);
    expect(theirs.status).toBe(404);
    expect(theirs.body.code).toBe("data-not-found");
    expect((await call("GET", "/data/attacks", undefined, first.body.key)).status).toBe(200);
    expect((await call("DELETE", `/data/keys/${first.body.id}`, undefined, session)).status).toBe(
      200,
    );
    const revoked = await call("GET", "/data/attacks", undefined, first.body.key);
    expect(revoked.status).toBe(401);
    expect(revoked.body.code).toBe("data-key-invalid");
    // A bad key is refused even on the public Index: it never falls back to anonymous.
    const bad = await call("GET", "/data/index", undefined, "bonded_dk_nope");
    expect(bad.status).toBe(401);
  });
});

describe("model risk data", () => {
  it("serves every model of the Index as the config has it", async () => {
    const r = await call("GET", "/data/index");
    expect(r.status).toBe(200);
    expect(r.body.updatedAt).toBe(config.updatedAt);
    expect(r.body.hash).toBe(readBondedIndex().hash);
    expect(r.body.count).toBe(config.entries.length);
    expect(r.body.models.map((m: Body) => m.model)).toEqual(config.entries.map((e) => e.model));
    for (const e of config.entries) {
      const slug = indexModelSlug(e.model);
      const summary = r.body.models.find((m: Body) => m.slug === slug);
      expect(summary).toMatchObject({
        securityScore: e.score,
        securityInterval: e.scoreInterval,
        libraryVersion: e.libraryVersion ?? 1,
        ranAt: e.ranAt,
      });
      if (e.task) expect(summary.taskScore).toBe(e.task.score);

      const full = await call("GET", summary.url);
      expect(full.status).toBe(200);
      const m = full.body;
      expect(m.security).toMatchObject({ score: e.score, interval: e.scoreInterval });
      expect(m.attacks.hash).toBe(e.attacks.hash);
      const lost = e.rows.reduce((n, row) => n + row.lossUsd, 0);
      const overpaid = e.rows.reduce((n, row) => n + row.overpaidUsd, 0);
      const runs = e.rows.reduce((n, row) => n + row.tasksTotal, 0);
      expect(m.dollarsAtRisk).toMatchObject({
        perThousandRunsUsd: lossPerThousandRuns(lost, overpaid, runs),
        lostUsd: lost,
        overpaidUsd: overpaid,
        runs,
      });
      expect(m.dollarsAtRisk.assumptions.length).toBeGreaterThan(2);
      // Failures by class and by channel add up to the rows.
      for (const cls of m.failures.byClass) {
        const fell = e.rows.reduce((n, row) => n + (row.byClass[cls.class]?.fell ?? 0), 0);
        expect(cls.fell).toBe(fell);
      }
      for (const ch of m.failures.byChannel) {
        const episodes = e.rows.reduce(
          (n, row) => n + (row.byVector?.[ch.channel]?.episodes ?? 0),
          0,
        );
        expect(ch.episodes).toBe(episodes);
      }
      // Only the fields picked for publication: nothing the sweep keeps for itself.
      expect(Object.keys(m)).not.toContain("cost");
      expect(Object.keys(m)).not.toContain("attacker");
      expect(JSON.stringify(m)).not.toMatch(/held-out|heldOut/i);
    }
    expect((await call("GET", "/data/index/models/no-such-model")).body.code).toBe(
      "data-not-found",
    );
  });

  it("limits anonymous readers per address, and keyed readers per key, counting their use", async () => {
    const tight = makeApi({ modelRisk: { publicPerTenMinutes: 2, keyedPerTenMinutes: 3 } });
    const from = { "x-forwarded-for": "203.0.113.7" };
    for (let i = 0; i < 2; i++)
      expect((await call("GET", "/data/index", undefined, undefined, tight, from)).status).toBe(
        200,
      );
    const over = await call("GET", "/data/index", undefined, undefined, tight, from);
    expect(over.status).toBe(429);
    expect(over.body.code).toBe("data-rate-limit");
    // A key from the same address gets its own, higher limit, and each request is counted.
    const { id, key } = await newKey(owner, tight);
    for (let i = 0; i < 3; i++)
      expect((await call("GET", "/data/index", undefined, key, tight, from)).status).toBe(200);
    expect((await call("GET", "/data/index", undefined, key, tight, from)).status).toBe(429);
    const usage = await call("GET", `/data/keys/${id}/usage`, undefined, await sessionFor(owner));
    expect(usage.body.items).toEqual([{ day: "2026-11-03", api: "index", requests: 3 }]);
    await tight.close();
  });
});

describe("Index webhooks", () => {
  let dir: string;
  let indexFile: string;
  // Later than the database's clock, so a delivery queued now is due.
  let at = Date.now() + 3_600_000;
  /** Change the Index the keeper reads; changes add up. */
  const current = JSON.parse(readFileSync(INDEX_FILE, "utf8")) as BondedIndex;
  const writeIndex = (change: (i: BondedIndex) => void) => {
    change(current);
    writeFileSync(indexFile, JSON.stringify(current, null, 2));
  };
  const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
  let answer = 200;
  const webhooks = () =>
    new IndexWebhooks(pg.db, {
      secrets,
      indexFile,
      now: () => at,
      log: () => {},
      post: async (url, request) => {
        sent.push({
          url: url.toString(),
          headers: request.headers as Record<string, string>,
          body: request.body ?? "",
        });
        return { status: answer, text: "" };
      },
    });
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "bonded-index-"));
    indexFile = join(dir, "bonded-index.json");
    writeIndex(() => {});
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("register with a key, return the secret once, and keep it encrypted", async () => {
    const none = await call("POST", "/data/webhooks", { url: "https://hooks.example/a" });
    expect(none.status).toBe(401);
    expect(none.body.code).toBe("data-key-missing");
    const { key } = await newKey();
    const http = await call("POST", "/data/webhooks", { url: "http://hooks.example/a" }, key);
    expect(http.status).toBe(400);
    const made = await call(
      "POST",
      "/data/webhooks",
      { url: "https://hooks.example/a/secret-path" },
      key,
    );
    expect(made.status).toBe(201);
    expect(made.body.secret).toMatch(/^bonded_ws_/);
    expect(made.body.url).toBe("https://hooks.example/…");
    const row = (await pg.db.pool.query("SELECT * FROM index_webhooks WHERE id=$1", [made.body.id]))
      .rows[0];
    expect(JSON.stringify(row)).not.toContain(made.body.secret);
    const listed = await call("GET", "/data/webhooks", undefined, key);
    expect(JSON.stringify(listed.body)).not.toContain(made.body.secret);
    expect(listed.body.items).toHaveLength(1);

    const limited = makeApi({ modelRisk: { maxWebhooksPerKey: 1 } });
    const second = await call(
      "POST",
      "/data/webhooks",
      { url: "https://hooks.example/b" },
      key,
      limited,
    );
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("data-webhook-limit");
    await limited.close();
    await call("DELETE", `/data/webhooks/${made.body.id}`, undefined, key);
  });

  it("are told, signed, when a model's score changes, and only about the models they asked for", async () => {
    await pg.db.pool.query("UPDATE index_webhooks SET revoked_at=now()");
    const { key } = await newKey();
    const all = await call("POST", "/data/webhooks", { url: "https://hooks.example/all" }, key);
    const [first, second] = config.entries;
    const one = await call(
      "POST",
      "/data/webhooks",
      { url: "https://hooks.example/one", models: [second!.model] },
      key,
    );
    // The first Index seen is the baseline: nothing to tell.
    expect(await webhooks().sync()).toBe(0);
    expect(await webhooks().sync()).toBe(0);
    // A re-run with the same scores is not a change.
    writeIndex((i) => (i.entries[0]!.ranAt = "2026-11-02T00:00:00.000Z"));
    expect(await webhooks().sync()).toBe(0);
    // The first model's score moves: only the webhook for every model hears.
    writeIndex((i) => (i.entries[0]!.score = first!.score - 7));
    expect(await webhooks().sync()).toBe(1);
    expect(await webhooks().deliverDue()).toBe(1);
    const hit = sent.at(-1)!;
    expect(hit.url).toBe("https://hooks.example/all");
    expect(
      verifySignature(
        all.body.secret,
        hit.body,
        { timestamp: hit.headers["bonded-timestamp"], signature: hit.headers["bonded-signature"] },
        { nowSeconds: Math.floor(at / 1000) },
      ),
    ).toBe(true);
    // Not with the other webhook's secret.
    expect(
      verifySignature(
        one.body.secret,
        hit.body,
        { timestamp: hit.headers["bonded-timestamp"], signature: hit.headers["bonded-signature"] },
        { nowSeconds: Math.floor(at / 1000) },
      ),
    ).toBe(false);
    const payload = JSON.parse(hit.body);
    expect(payload).toMatchObject({
      type: "index.score_changed",
      change: "changed",
      model: indexModelSlug(first!.model),
      before: { securityScore: first!.score },
      after: { securityScore: first!.score - 7 },
    });
    expect(hit.headers["bonded-event-id"]).toBe(payload.id);

    // The second model's Task score moves too: both webhooks hear about it.
    writeIndex((i) => (i.entries[1]!.task = { score: 1, source: "parts", part: "twins" }));
    expect(await webhooks().sync()).toBe(2);
    expect(await webhooks().deliverDue()).toBe(2);
    expect(
      sent
        .slice(-2)
        .map((s) => s.url)
        .sort(),
    ).toEqual(["https://hooks.example/all", "https://hooks.example/one"]);
  });

  it("retry a failed delivery with backoff, then give up", async () => {
    await pg.db.pool.query("UPDATE index_webhooks SET revoked_at=now()");
    const { key } = await newKey();
    const made = await call("POST", "/data/webhooks", { url: "https://hooks.example/down" }, key);
    writeIndex((i) => (i.entries[2]!.score = 1));
    expect(await webhooks().sync()).toBe(1);
    answer = 500;
    const before = sent.length;
    expect(await webhooks().deliverDue()).toBe(0);
    const deliveries = async () =>
      (await call("GET", `/data/webhooks/${made.body.id}/deliveries`, undefined, key)).body.items;
    expect((await deliveries())[0]).toMatchObject({
      status: "pending",
      attempts: 1,
      lastStatus: 500,
      nextAt: new Date(at + WEBHOOK_RETRY_MS[0]).toISOString(),
    });
    // Not again before its time.
    expect(await webhooks().deliverDue()).toBe(0);
    expect(sent.length).toBe(before + 1);
    for (const wait of WEBHOOK_RETRY_MS) {
      at += wait;
      await webhooks().deliverDue();
    }
    expect(sent.length).toBe(before + 1 + WEBHOOK_RETRY_MS.length);
    expect((await deliveries())[0]).toMatchObject({
      status: "failed",
      attempts: WEBHOOK_RETRY_MS.length + 1,
      nextAt: null,
    });
    at += 86_400_000;
    await webhooks().deliverDue();
    expect(sent.length).toBe(before + 1 + WEBHOOK_RETRY_MS.length);

    // A delivery that fails once and then gets a 2xx is delivered.
    writeIndex((i) => (i.entries[2]!.score = 2));
    expect(await webhooks().sync()).toBe(1);
    await webhooks().deliverDue();
    answer = 204;
    at += WEBHOOK_RETRY_MS[0];
    expect(await webhooks().deliverDue()).toBe(1);
    expect((await deliveries())[0]).toMatchObject({ status: "delivered", attempts: 2 });
    answer = 200;
  });
});
