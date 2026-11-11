import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ANVIL_KEYS,
  INDEX_VARIANTS_DIR,
  OFFCHAIN_SEEDS_DIR,
  OFFCHAIN_STAGED_SEEDS_DIR,
  loadAttackLibrary,
  loadOffchainSeeds,
  payloadHash,
  proseHash,
} from "@bonded/arena";
import { connectChain } from "@bonded/keeper";
import { parseEvmDeployment, selfServeMessage } from "@bondedhq/shared";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createApi } from "../src/index.js";
import { workCheckOne } from "../src/check-worker.js";
import { DEFAULT_REMOTE_POLICY } from "../src/remote-policy.js";
import { SecretBox } from "../src/secrets.js";
import type { ConnectionCheckRunner } from "../src/connections.js";
import { ciVerdict } from "../src/ci-runs.js";
import type { PreviewSubject } from "../src/previews.js";
import { Refused } from "../src/refused.js";
import { LIBRARY_SEED_ID, leaksHeldOut, publicAttacks } from "../src/attack-data.js";
import { postgres } from "./postgres.js";

const TOKEN = "ci-data-test-token-at-least-24-characters";
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

let pg: Awaited<ReturnType<typeof postgres>>;
let app: ReturnType<typeof createApi>;
const clock = Date.now();
const wide = { perClient: 100_000, total: 1_000_000, windowMs: 600_000 };

const makeApi = (
  dataApi: Parameters<typeof createApi>[0]["dataApi"] = {},
  previewPerWalletDaily = 100,
) =>
  createApi({
    db: pg.db,
    chain,
    attesterKey: ANVIL_KEYS.deployer,
    apiToken: TOKEN,
    selfServe: {
      now: () => clock,
      remote: {
        ...DEFAULT_REMOTE_POLICY,
        checksPerWalletHourly: 1000,
        checksHourly: 1000,
        previewCreatesPerWalletDaily: 1000,
        urlVerifiesPerWalletHourly: 1000,
        urlVerifiesHourly: 1000,
        previewPerWalletDaily,
      },
    },
    ownerRequests: { writes: wide, reads: wide, checksPerClientHourly: 100_000 },
    secrets,
    verifyAgentUrl: async () => ({ ok: true, version: "v1.0.0" }),
    dataApi,
  });

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(
  method: string,
  path: string,
  body?: unknown,
  auth?: string,
  a: ReturnType<typeof createApi> = app,
): Promise<{ status: number; body: Body; text: string }> {
  const res = await a.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Body, text };
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
  const r = await call("POST", "/data/keys", {}, await sessionFor(who), a);
  expect(r.status).toBe(201);
  return r.body.key as string;
}
/** A preview reached by a verified Agent URL, as the Test your agent page sets one up. */
async function urlPreview(who: PrivateKeyAccount = owner, verify = true, a = app) {
  const session = await sessionFor(who);
  const made = await call("POST", "/previews", { mode: "tools", connection: "url" }, session, a);
  expect(made.status).toBe(201);
  const id = made.body.id as string;
  const url = await call(
    "POST",
    `/previews/${id}/agent-url`,
    { url: "https://agent.example/bonded" },
    session,
    a,
  );
  expect(url.status).toBe(201);
  if (verify)
    expect((await call("POST", `/previews/${id}/agent-url/verify`, {}, session, a)).status).toBe(
      200,
    );
  return id;
}
/** A check runner that passes, as the gateway's would after one benign episode. */
const passing: ConnectionCheckRunner = async ({ onEvent }) => {
  onEvent({ type: "started" });
  onEvent({ type: "done", exitCode: 0, durationMs: 3000 });
  return {
    passed: true,
    problems: [],
    taskCompleted: true,
    toolsCalled: 2,
    surfacesRead: ["dm"],
    durationMs: 3000,
  };
};
/**
 * The preview rating worker, faked: take the queued preview rating and finish it with a report
 * that has this Security score and Task score. No sandbox, no gateway, no model.
 */
async function finishRating(score: number | null, taskScore: number | null = 70, fail?: string) {
  const job = await pg.db.takePreviewJob(chainId);
  expect(job).toBeDefined();
  if (!fail)
    await pg.db.pool.query("UPDATE ratings SET report=$2 WHERE id=$1", [
      job!.id,
      JSON.stringify({
        marker: "ci-report",
        scoring: { score: 40, tier: "C" },
        ...(score === null ? {} : { susceptibility: { grade: score } }),
        task: { score: taskScore },
      }),
    ]);
  await pg.db.finishPreview(
    job!,
    fail ? { status: "failed", error: fail, final: true } : { status: "done" },
  );
  return job!.id;
}

beforeAll(async () => {
  pg = await postgres();
  app = makeApi();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await pg?.stop();
});

describe("testing in CI", () => {
  it("refuses a stock-trading preview before it uses the day's preview rating", async () => {
    const who = privateKeyToAccount(generatePrivateKey());
    const key = await newKey(who);
    const session = await sessionFor(who);
    const made = await call(
      "POST",
      "/previews",
      { mode: "tools", connection: "url", world: "brokerage" },
      session,
    );
    expect(made.status).toBe(201);
    const run = await call("POST", "/ci/runs", { previewId: made.body.id, minScore: 70 }, key);
    expect(run.status).toBe(409);
    expect(run.body).toMatchObject({
      code: "brokerage-no-score",
      error: expect.stringMatching(/findings, not a score/) as unknown,
    });
    // Nothing was queued or counted against the wallet.
    const queued = await pg.db.pool.query(
      "SELECT count(*)::int AS n FROM ratings WHERE preview_id=$1",
      [made.body.id],
    );
    expect(queued.rows[0].n).toBe(0);
  });

  it("runs the check, then the preview rating, then passes or fails against the minimum", async () => {
    const key = await newKey();
    const previewId = await urlPreview();
    const none = await call("POST", "/ci/runs", { previewId, minScore: 70 });
    expect(none.status).toBe(401);
    expect(none.body.code).toBe("data-key-missing");

    // No passing check yet: the run starts with one.
    const started = await call(
      "POST",
      "/ci/runs",
      { previewId, minScore: 70, label: "abc123" },
      key,
    );
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({
      status: "checking",
      done: false,
      result: null,
      minScore: 70,
      label: "abc123",
      previewId,
      ratingId: null,
      statusUrl: `/ci/runs/${started.body.runId}`,
      reportUrl: `/ci/runs/${started.body.runId}/report`,
    });
    const status = () => call("GET", started.body.statusUrl, undefined, key);
    expect((await status()).body.status).toBe("checking");
    expect(await workCheckOne(pg.db, chainId, { secrets, runCheck: passing })).toBe(true);
    // The check passed: reading the run queues the preview rating.
    const rating = await status();
    expect(rating.body.status).toBe("rating");
    expect(rating.body.ratingId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await call("GET", rating.body.reportUrl, undefined, key)).status).toBe(202);
    expect((await status()).body.status).toBe("rating");

    expect(await finishRating(82)).toBe(rating.body.ratingId);
    const passed = await status();
    expect(passed.body).toMatchObject({
      status: "passed",
      done: true,
      result: "pass",
      score: 82,
      taskScore: 70,
    });
    const report = await call("GET", passed.body.reportUrl, undefined, key);
    expect(report.status).toBe(200);
    expect(report.body).toMatchObject({
      attested: false,
      insurable: false,
      report: { marker: "ci-report" },
    });

    // A check passed in the last day: the next run goes straight to its rating.
    const next = await call("POST", "/ci/runs", { previewId, minScore: 90 }, key);
    expect(next.body.status).toBe("rating");
    await finishRating(82);
    const failed = await call("GET", next.body.statusUrl, undefined, key);
    expect(failed.body).toMatchObject({ status: "failed", result: "fail", score: 82 });
    expect(failed.body.reason).toMatch(/under the minimum of 90/);

    // A rating that stops ends the run with its reason, never a pass.
    const third = await call("POST", "/ci/runs", { previewId, minScore: 0 }, key);
    await finishRating(null, null, "stopped: the agent failed an episode");
    const stopped = await call("GET", third.body.statusUrl, undefined, key);
    expect(stopped.body).toMatchObject({ status: "error", result: null, done: true });
    expect(stopped.body.reason).toMatch(/the agent failed an episode/);

    // The owner's runs, newest first.
    const list = await call("GET", "/ci/runs", undefined, key);
    expect(list.body.items.map((r: Body) => r.runId)).toEqual([
      third.body.runId,
      next.body.runId,
      started.body.runId,
    ]);
  });

  it("keeps runs and reports to the owner's keys, and rates only verified Agent URLs", async () => {
    const key = await newKey();
    const theirs = await newKey(stranger);
    const previewId = await urlPreview();
    const run = await call("POST", "/ci/runs", { previewId, minScore: 50 }, key);
    expect(run.status).toBe(202);
    for (const path of [run.body.statusUrl, run.body.reportUrl]) {
      const r = await call("GET", path, undefined, theirs);
      expect(r.status).toBe(404);
      expect(r.body.code).toBe("data-not-found");
    }
    // Another wallet's preview is not found.
    const other = await call("POST", "/ci/runs", { previewId, minScore: 50 }, theirs);
    expect(other.status).toBe(404);
    // A preview reached by the runner, and an Agent URL not yet verified, are refused.
    const session = await sessionFor(owner);
    const runner = await call("POST", "/previews", { mode: "tools" }, session);
    const byRunner = await call(
      "POST",
      "/ci/runs",
      { previewId: runner.body.id, minScore: 1 },
      key,
    );
    expect(byRunner.status).toBe(409);
    expect(byRunner.body.code).toBe("ci-needs-agent-url");
    const unverified = await urlPreview(owner, false);
    const early = await call("POST", "/ci/runs", { previewId: unverified, minScore: 1 }, key);
    expect(early.status).toBe(409);
    expect(early.body.error).toMatch(/Verify your Agent URL/);
    // A failed check ends the run.
    await workCheckOne(pg.db, chainId, {
      secrets,
      runCheck: async () => ({
        passed: false,
        problems: ["Your agent didn't answer."],
        taskCompleted: false,
        toolsCalled: 0,
        surfacesRead: [],
      }),
    });
    const ended = await call("GET", run.body.statusUrl, undefined, key);
    expect(ended.body).toMatchObject({ status: "error", done: true });
    expect(ended.body.reason).toMatch(/connection check failed: Your agent didn't answer/);
  });

  it("is held to the key's run limit and to the preview caps the page has", async () => {
    const capped = makeApi({ ci: { createsPerHour: 2 } }, 1);
    const who = privateKeyToAccount(generatePrivateKey());
    const key = await newKey(who, capped);
    const previewId = await urlPreview(who, true, capped);
    const first = await call("POST", "/ci/runs", { previewId, minScore: 1 }, key, capped);
    await workCheckOne(pg.db, chainId, { secrets, runCheck: passing });
    expect((await call("GET", first.body.statusUrl, undefined, key, capped)).body.status).toBe(
      "rating",
    );
    await finishRating(60);
    // One preview rating a day per wallet (the page's cap): the second is refused, not started.
    const second = await call("POST", "/ci/runs", { previewId, minScore: 1 }, key, capped);
    expect(second.status).toBe(429);
    expect(second.body.retryAt).toBeDefined();
    const third = await call("POST", "/ci/runs", { previewId, minScore: 1 }, key, capped);
    expect(third.status).toBe(429);
    expect(third.body.code).toBe("ci-run-limit");
    await capped.close();
  });

  it("decides pass or fail from the scores alone", () => {
    expect(ciVerdict({ minScore: 70, minTaskScore: null }, { score: 70, taskScore: null })).toEqual(
      { passed: true, reason: "Security score 70, at or over the minimum of 70." },
    );
    expect(
      ciVerdict({ minScore: 70, minTaskScore: 50 }, { score: 90, taskScore: null }).passed,
    ).toBe(false);
    expect(ciVerdict({ minScore: 70, minTaskScore: 50 }, { score: 90, taskScore: 49 }).passed).toBe(
      false,
    );
  });

  it("queues the rating once when two readers poll at once, and keeps it on the run", async () => {
    const key = await newKey();
    const previewId = await urlPreview();
    const started = await call("POST", "/ci/runs", { previewId, minScore: 1 }, key);
    expect(started.body.status).toBe("checking");
    expect(await workCheckOne(pg.db, chainId, { secrets, runCheck: passing })).toBe(true);
    // The preview rating flow with a slow queue: the first reader's queueing waits until released,
    // and a reader after it is refused as the real flow refuses one (a rating already queued).
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let queues = 0;
    const slow = makeApi({
      ci: {
        previewRating: {
          subject: async () => ({}) as PreviewSubject,
          problem: async () => undefined,
          passing: async () => true,
          startCheck: async () => {
            throw new Error("not used");
          },
          queue: async () => {
            if (queues++ > 0)
              throw new Refused(409, "This preview's rating is already queued or running.");
            entered();
            await gate;
            return (await pg.db.enqueuePreviewRating(previewId, {
              nowMs: clock,
              perWalletDaily: 100,
              daily: 1000,
            })) as { runId: string };
          },
        },
      },
    });
    const status = () => call("GET", started.body.statusUrl, undefined, key, slow);
    const first = status();
    await inside;
    // The second reader finds the first one at work: the run is still checking, not ended.
    const second = await status();
    expect(second.body.status).toBe("checking");
    release();
    const rating = (await first).body;
    expect(rating.status).toBe("rating");
    expect(queues).toBe(1);
    expect((await status()).body).toMatchObject({ status: "rating", ratingId: rating.ratingId });
    await finishRating(75);
    expect((await status()).body).toMatchObject({ status: "passed", score: 75 });
    await slow.close();
  });
});

describe("attack data", () => {
  const library = loadAttackLibrary();
  const offchain = loadOffchainSeeds();
  // A held-out attack as a rating would hold it: a library attack's spec, reworded, under a
  // held-out id, and its payload's hash.
  const base = library.find((a) => !a.campaign)!;
  const heldOut = {
    ...base,
    id: "A6-held-out-1a2b3c4d",
    class: "A6" as const,
    tags: [...base.tags, "held-out"],
    payloadTemplate: `${base.payloadTemplate} (held-out rewording)`,
  };
  const heldOutHash = payloadHash(heldOut);

  it("is gated by a key and counted", async () => {
    const anonymous = await call("GET", "/data/attacks");
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.code).toBe("data-key-missing");
    const session = await sessionFor(owner);
    const made = await call("POST", "/data/keys", {}, session);
    expect((await call("GET", "/data/attacks", undefined, made.body.key)).status).toBe(200);
    expect(
      (await call("GET", "/data/attacks?rail=offchain&class=O1", undefined, made.body.key)).status,
    ).toBe(200);
    const usage = await call("GET", `/data/keys/${made.body.id}/usage`, undefined, session);
    expect(usage.body.items).toMatchObject([{ api: "attacks", requests: 2 }]);
  });

  it("holds the published library and nothing else", async () => {
    const key = await newKey();
    const r = await call("GET", "/data/attacks", undefined, key);
    const ids = r.body.attacks.map((a: Body) => a.id as string);
    expect(ids.sort()).toEqual([...library.map((a) => a.id), ...offchain.map((s) => s.id)].sort());
    const files = readdirSync(OFFCHAIN_SEEDS_DIR).filter((f) => f.endsWith(".yaml"));
    for (const a of r.body.attacks.filter((x: Body) => x.rail === "offchain")) {
      expect(a.id).toMatch(LIBRARY_SEED_ID);
      expect(files).toContain(`${a.id}.yaml`);
      expect(a.source.path).toBe(`apps/arena/offchain-seeds/${a.id}.yaml`);
      for (const image of a.images)
        expect(image.path).toMatch(/^apps\/arena\/offchain-seeds\/images\//);
    }
    // The Muse Image forgeries come with their metadata.
    const stamp = r.body.attacks.find((a: Body) => a.id === "O1-muse-rent-stamp-001");
    expect(stamp.images[0].forgery).toMatchObject({ model: "muse-image-1.0" });
    // Staged seeds and the Index's variants are not in it, nor any private folder.
    const others = [OFFCHAIN_STAGED_SEEDS_DIR, INDEX_VARIANTS_DIR].flatMap((dir) =>
      readdirSync(dir)
        .filter((f) => f.endsWith(".yaml"))
        .map((f) => f.replace(/\.yaml$/, "")),
    );
    for (const id of others) expect(r.text).not.toContain(id);
    expect(r.text).not.toMatch(/"(datasets|ratings)\//);
    expect(r.text).not.toMatch(/held-out-[0-9a-f]{8}/);
  });

  it("never names a held-out attack's id or hash, in the export or the traces", async () => {
    const retire = new Date(Date.now() + 30 * 86_400_000);
    await pg.db.addHeldOutAttacks(chainId, [heldOut], retire);
    await pg.db.pool.query(
      "INSERT INTO held_out_payloads(hash) VALUES($1) ON CONFLICT DO NOTHING",
      [heldOutHash],
    );
    // Episodes on record: one of a library attack, one of the held-out one.
    const episode = (attackId: string, attackClass: string, breached: boolean) => ({
      runId: "00000000-0000-4000-8000-000000000001",
      index: 0,
      total: 2,
      episode: {
        attackId,
        attackClass,
        ruling: breached ? "breach" : "ignored",
        verdict: { breached, totalLossUsd: breached ? 120 : 0, frozen: false },
        detail: { note: `trace of ${attackId}` },
      },
    });
    await pg.db.publish("rating.episode", episode(base.id, base.class, true));
    await pg.db.publish("rating.episode", episode(heldOut.id, heldOut.class, true));

    const key = await newKey();
    const r = await call("GET", "/data/attacks", undefined, key);
    expect(r.status).toBe(200);
    const traces = await call("GET", "/data/attacks/traces", undefined, key);
    expect(traces.status).toBe(200);
    expect(traces.body.items).toEqual([
      expect.objectContaining({ attackId: base.id, label: "breach", lossUsd: 120 }),
    ]);
    for (const text of [r.text, traces.text]) {
      expect(text).not.toContain(heldOut.id);
      expect(text).not.toContain(heldOutHash);
      expect(text).not.toContain("held-out rewording");
    }
    const only = await call("GET", `/data/attacks/traces?attack=${heldOut.id}`, undefined, key);
    expect(only.status).toBe(404);
  });

  it("drops variants and held-out attacks, and catches any that slip through", () => {
    const seed = offchain[0]!;
    const variant = { ...seed, id: `${seed.id}-fdeadbeef`, variantOf: seed.id };
    const marked = library[1]!;
    const marks = {
      ids: new Set([heldOut.id, "O2-private-001"]),
      hashes: new Set([heldOutHash, payloadHash(marked), proseHash(offchain[1]!)]),
    };
    const out = publicAttacks(
      {
        offchain: [...offchain, variant, { ...seed, id: "O2-private-001" }],
        onchain: [...library, heldOut],
      },
      marks,
    );
    const ids = out.map((a) => a.id);
    expect(ids).not.toContain(variant.id);
    expect(ids).not.toContain("O2-private-001");
    expect(ids).not.toContain(heldOut.id);
    expect(ids).not.toContain(marked.id);
    expect(ids).not.toContain(offchain[1]!.id);
    expect(ids).toContain(seed.id);
    const text = JSON.stringify(out);
    expect(leaksHeldOut(text, marks)).toBe(false);
    expect(leaksHeldOut(`${text}${heldOutHash}`, marks)).toBe(true);
    expect(leaksHeldOut(`${text}"${heldOut.id}"`, marks)).toBe(true);
  });
});
