import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { ANVIL_KEYS, Sandbox, createAgentVault } from "@bonded/arena";
import { connectChain, type ServiceChain } from "@bonded/keeper";
import { selfServeMessage } from "@bondedhq/shared";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createApi } from "../src/index.js";
import { SecretBox, agentUrlContext, secretBoxFromEnv, verifySignature } from "../src/secrets.js";
import {
  Notifier,
  ResendEmail,
  emailFromEnv,
  emailText,
  type EmailSender,
  type RatingNotification,
} from "../src/notifications.js";
import { safeRequest } from "@bonded/arena";
import { signAgentUrlRequest } from "@bondedhq/shared";
import { workOne } from "../src/worker.js";
import {
  DbRunnerAuth,
  RunnerPresenceWriter,
  newRunnerToken,
  runnerTokenHash,
} from "../src/runners.js";
import { postgres } from "./postgres.js";

describe("secrets at rest", () => {
  const box = new SecretBox(randomBytes(32));
  it("encrypt with AES-256-GCM, bound to their row and key", () => {
    const sealed = box.encrypt("bonded_as_secret", agentUrlContext("a"));
    expect(sealed).toMatch(/^v1\.[0-9a-f]{8}\./);
    expect(sealed).not.toContain("bonded_as_secret");
    expect(box.decrypt(sealed, agentUrlContext("a"))).toBe("bonded_as_secret");
    // Two encryptions differ (fresh IV each time).
    expect(box.encrypt("x", "c")).not.toBe(box.encrypt("x", "c"));
    // Copied to another row, it doesn't decrypt; nor with another key; nor tampered with.
    expect(() => box.decrypt(sealed, agentUrlContext("b"))).toThrow("could not be decrypted");
    expect(() => new SecretBox(randomBytes(32)).decrypt(sealed, agentUrlContext("a"))).toThrow(
      "another AGENT_URL_SECRET_KEY",
    );
    const parts = sealed.split(".");
    parts[4] = Buffer.from("tampered").toString("base64url");
    expect(() => box.decrypt(parts.join("."), agentUrlContext("a"))).toThrow();
    // Errors never carry the secret.
    try {
      box.decrypt(sealed, "other");
    } catch (e) {
      expect(String(e)).not.toContain("bonded_as_secret");
    }
  });
  it("read the key from AGENT_URL_SECRET_KEY (hex or base64), or are off without it", () => {
    expect(secretBoxFromEnv({})).toBeUndefined();
    const hex = randomBytes(32).toString("hex");
    expect(secretBoxFromEnv({ AGENT_URL_SECRET_KEY: hex })?.keyId).toBe(
      secretBoxFromEnv({
        AGENT_URL_SECRET_KEY: Buffer.from(hex, "hex").toString("base64"),
      })?.keyId,
    );
    expect(() => secretBoxFromEnv({ AGENT_URL_SECRET_KEY: "short" })).toThrow(/must be 32 bytes/);
    expect(() => secretBoxFromEnv({ AGENT_URL_SECRET_KEY: "short" })).not.toThrow(/short/);
  });
  it("check webhook calls signed as v1=HMAC-SHA256(secret, timestamp.body) by @bondedhq/shared", async () => {
    const headers = await signAgentUrlRequest("s3cret", '{"a":1}', 1_000_000);
    expect(headers["bonded-timestamp"]).toBe("1000");
    const check = (body: string, nowSeconds: number, secret = "s3cret") =>
      verifySignature(
        secret,
        body,
        { timestamp: headers["bonded-timestamp"], signature: headers["bonded-signature"] },
        { nowSeconds },
      );
    expect(check('{"a":1}', 1100)).toBe(true);
    expect(check('{"a":2}', 1100)).toBe(false);
    expect(check('{"a":1}', 1100, "other")).toBe(false);
    expect(check('{"a":1}', 2000)).toBe(false);
  });
});

describe("the email sender", () => {
  it("is off unless RESEND_API_KEY and EMAIL_FROM are both set", () => {
    expect(emailFromEnv({})).toBeUndefined();
    expect(emailFromEnv({ RESEND_API_KEY: "k" })).toBeUndefined();
    expect(emailFromEnv({ EMAIL_FROM: "a@b.c" })).toBeUndefined();
    expect(emailFromEnv({ RESEND_API_KEY: "k", EMAIL_FROM: "Bonded <a@b.c>" })).toBeInstanceOf(
      ResendEmail,
    );
  });
  it("sends through Resend's API, and says so when it refuses", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = new ResendEmail("key", "Bonded <a@b.c>", (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as typeof fetch);
    await ok.send({ to: "me@example.com", subject: "s", text: "t" });
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      from: "Bonded <a@b.c>",
      to: ["me@example.com"],
      subject: "s",
      text: "t",
    });
    const refused = new ResendEmail(
      "key",
      "a@b.c",
      (async () => new Response("no", { status: 422 })) as unknown as typeof fetch,
    );
    await expect(refused.send({ to: "x@y.z", subject: "s", text: "t" })).rejects.toThrow("422");
  });
  it("words a finished preview plainly", () => {
    const text = emailText({
      type: "rating_finished",
      ratingId: "r",
      previewId: "p",
      chainId: 1,
      status: "done",
      score: 812,
      tier: "A",
      label: "Preview: not on chain, not insurable",
      at: "",
    });
    expect(text.subject).toBe("Bonded: your preview rating finished");
    expect(text.text).toMatch(/finished; insurance score 812 \(A\)/);
    expect(text.text).toMatch(/not on chain, not insurable/);
  });
});

describe("webhook POSTs (the Arena's safeRequest)", () => {
  it("refuses plain http, private addresses and redirects", async () => {
    const opts = { timeoutMs: 2000, maxBytes: 1024 };
    await expect(
      safeRequest(new URL("http://example.com/x"), { ...opts, method: "POST", body: "{}" }),
    ).rejects.toThrow(/https/);
    await expect(
      safeRequest(new URL("https://10.0.0.1/x"), { ...opts, method: "POST", body: "{}" }),
    ).rejects.toThrow(/private or internal/);
    await expect(
      safeRequest(new URL("https://127.0.0.1/x"), { ...opts, method: "POST", body: "{}" }),
    ).rejects.toThrow(/private or internal/);
    const server = createServer((_req, res) => {
      res.writeHead(302, { Location: "http://10.0.0.1/" });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    await expect(
      safeRequest(new URL(`http://127.0.0.1:${port}/`), {
        ...opts,
        method: "POST",
        body: "{}",
        allowLoopback: true,
      }),
    ).rejects.toThrow(/redirects/);
    server.close();
  });
});

describe("notifications", () => {
  let pg: Awaited<ReturnType<typeof postgres>>;
  let sandbox: Sandbox;
  let chain: ServiceChain;
  let app: ReturnType<typeof createApi>;
  let server: Server;
  let port: number;
  let status = 200;
  const received: { headers: IncomingHttpHeaders; body: string }[] = [];
  const secrets = new SecretBox(randomBytes(32));
  const emails: { to: string; subject: string; text: string }[] = [];
  const email: EmailSender = { send: async (m) => void emails.push(m) };
  let clock = Date.now();

  beforeAll(async () => {
    pg = await postgres();
    sandbox = await Sandbox.start();
    chain = connectChain(sandbox.deployment, sandbox.rpcUrl, ANVIL_KEYS.deployer);
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.writeHead(status);
        res.end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
    app = makeApi();
  }, 180_000);
  afterAll(async () => {
    server?.close();
    await app?.close();
    await sandbox?.stop();
    await pg?.stop();
  });
  function makeApi(extra: Partial<Parameters<typeof createApi>[0]> = {}) {
    return createApi({
      db: pg.db,
      chain,
      attesterKey: ANVIL_KEYS.deployer,
      apiToken: "test-api-token-at-least-24-characters",
      selfServe: { now: () => clock },
      secrets,
      email,
      allowLoopbackUrls: true,
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
  const save = (session: string, body: unknown, a = app, path = "/self/notifications") =>
    Promise.resolve(
      a.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session}` },
        body: JSON.stringify(body),
      }),
    );
  const note = (ratingId: string, type: RatingNotification["type"] = "rating_finished") => ({
    type,
    ratingId,
    previewId: "p",
    chainId: sandbox.deployment.chainId,
    status: "done",
    score: 700,
    at: new Date().toISOString(),
  });
  /** A real rating row, so a notification can be recorded against it. */
  async function ratingRow() {
    const id = crypto.randomUUID();
    const preview = (
      await pg.db.pool.query(
        "INSERT INTO previews(id,chain_id,owner,mode,connection) VALUES($1,1,'0xa','tools','runner') RETURNING id",
        [crypto.randomUUID()],
      )
    ).rows[0].id;
    await pg.db.pool.query(
      "INSERT INTO ratings(id,preview_id,kind,status) VALUES($1,$2,'preview','done')",
      [id, preview],
    );
    return id;
  }

  it("settings: a webhook gets its own secret, shown once; an email only when the service sends email", async () => {
    const who = privateKeyToAccount(generatePrivateKey());
    const session = await sessionFor(who);
    const res = await save(session, {
      webhookUrl: `http://127.0.0.1:${port}/hook`,
      email: "me@example.com",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.webhookSecret).toMatch(/^bonded_ws_/);
    // Shown masked: the origin of the webhook, the first letter of the address.
    expect(body).toMatchObject({
      webhook: { url: `http://127.0.0.1:${port}/…` },
      email: "m***@example.com",
      emailAvailable: true,
    });
    const shown = await (
      await app.request("/self/notifications", { headers: { Authorization: `Bearer ${session}` } })
    ).text();
    expect(shown).not.toContain(body.webhookSecret as string);
    // The same URL again keeps its secret; rotating gives a new one.
    expect(
      (
        (await (
          await save(session, { webhookUrl: `http://127.0.0.1:${port}/hook` })
        ).json()) as Record<string, unknown>
      ).webhookSecret,
    ).toBeUndefined();
    const rotated = (await (
      await save(session, {}, app, "/self/notifications/webhook-secret")
    ).json()) as Record<string, unknown>;
    expect(rotated.webhookSecret).not.toBe(body.webhookSecret);
    // Bad and unsafe input.
    expect((await save(session, { email: "not-an-email" })).status).toBe(400);
    const strict = makeApi({ allowLoopbackUrls: false, webOrigins: ["https://bonded.example"] });
    expect((await save(session, { webhookUrl: "http://127.0.0.1/x" }, strict)).status).toBe(400);
    expect(
      (await save(session, { webhookUrl: "https://bonded.example/hook" }, strict)).status,
    ).toBe(400);
    // Without the secret key no webhook; without an email sender no email.
    const bare = makeApi({ secrets: undefined, email: undefined });
    const off = await save(session, { webhookUrl: "https://hooks.example/x" }, bare);
    expect(off.status).toBe(409);
    expect((await save(session, { email: "me@example.com" }, bare)).status).toBe(409);
    // Removing the webhook removes its secret.
    const removed = (await (await save(session, { webhookUrl: null })).json()) as Record<
      string,
      unknown
    >;
    expect(removed).toMatchObject({ webhook: null });
    expect((await pg.db.notificationSettings(who.address))?.webhookSecretCiphertext).toBeNull();
  });

  it("are sent signed, once per rating and outcome, and never throw", async () => {
    const who = privateKeyToAccount(generatePrivateKey());
    const session = await sessionFor(who);
    const { webhookSecret: secret } = (await (
      await save(session, { webhookUrl: `http://127.0.0.1:${port}/hook`, email: "me@example.com" })
    ).json()) as { webhookSecret: string };
    const logs: string[] = [];
    const notifier = new Notifier(pg.db, {
      secrets,
      email,
      allowLoopback: true,
      log: (l) => logs.push(l),
    });
    const ratingId = await ratingRow();
    received.length = 0;
    emails.length = 0;
    notifier.notify(who.address, note(ratingId));
    notifier.notify(who.address, note(ratingId));
    await notifier.idle();
    expect(received).toHaveLength(1);
    const hit = received[0]!;
    expect(
      verifySignature(secret, hit.body, {
        timestamp: hit.headers["bonded-timestamp"] as string,
        signature: hit.headers["bonded-signature"] as string,
      }),
    ).toBe(true);
    expect(JSON.parse(hit.body)).toMatchObject({ type: "rating_finished", ratingId, score: 700 });
    expect(emails).toEqual([expect.objectContaining({ to: "me@example.com" })]);
    // A failing webhook or email is logged without the URL or address, and never thrown.
    status = 500;
    const failing = new Notifier(pg.db, {
      secrets,
      email: { send: async () => Promise.reject(new Error("smtp down me@example.com")) },
      allowLoopback: true,
      log: (l) => logs.push(l),
    });
    failing.notify(who.address, note(await ratingRow(), "rating_failed"));
    await failing.idle();
    status = 200;
    expect(logs.join("\n")).toMatch(/answered 500/);
    expect(logs.join("\n")).not.toContain("127.0.0.1");
    expect(logs.join("\n")).not.toContain("me@example.com");
    expect(logs.join("\n")).not.toContain(secret);
    // Nobody to tell: nothing happens.
    const quiet = new Notifier(pg.db, { secrets });
    quiet.notify(privateKeyToAccount(generatePrivateKey()).address, note(await ratingRow()));
    quiet.notify(null, note(await ratingRow()));
    await quiet.idle();
  });

  it("come from the rating worker when an owner's rating ends, without blocking it", async () => {
    const vault = await createAgentVault(sandbox);
    const owner = privateKeyToAccount(generatePrivateKey());
    const key = `${sandbox.deployment.chainId}:${vault.agentId}`;
    await pg.db.upsertUserAgent(
      sandbox.deployment.chainId,
      vault.agentId.toString(),
      owner.address,
      {
        kind: "remote",
        mandate: vault.mandate,
        codeHash: `0x${"c".repeat(64)}`,
        mode: "tools",
      },
    );
    const token = newRunnerToken();
    await pg.db.createRunnerToken(key, {
      hash: runnerTokenHash(token),
      createdBy: owner.address,
      signedAt: 1,
    });
    const identity = await new DbRunnerAuth(pg.db, sandbox.deployment.chainId).validate(token);
    const presence = new RunnerPresenceWriter(pg.db);
    presence.onEvent({
      type: "connected",
      key: identity!.key,
      at: Date.now(),
      hello: { type: "hello", runnerVersion: "0.2.0", protocol: 1, mode: "tools" },
    });
    await presence.flush();
    const runId = await pg.db.enqueue(key);
    const sent: { owner: string | null | undefined; n: RatingNotification }[] = [];
    const notifier = {
      notify: (o: string | null | undefined, n: RatingNotification) =>
        void sent.push({ owner: o, n }),
    } as unknown as Notifier;
    // No gateway on this worker: the rating fails at once, saying why, and the owner hears.
    await workOne(pg.db, chain, sandbox.rpcUrl, ANVIL_KEYS.deployer, undefined, undefined, {
      notifier,
    });
    expect(sent).toEqual([
      {
        owner: owner.address.toLowerCase(),
        n: expect.objectContaining({
          type: "rating_failed",
          ratingId: runId,
          agentId: vault.agentId.toString(),
          reason: expect.stringMatching(/^gateway not available/),
        }),
      },
    ]);
  }, 120_000);
});
