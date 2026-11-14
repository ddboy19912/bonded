import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { ANVIL_KEYS, Sandbox } from "@bonded/arena";
import { connectChain, type ServiceChain } from "@bonded/keeper";
import { selfServeMessage } from "@bondedhq/shared";
import { privateKeyToAccount } from "viem/accounts";
import { accountOwnerId } from "../src/accounts.js";
import { createApi } from "../src/index.js";
import type { EmailSender } from "../src/notifications.js";
import { postgres } from "./postgres.js";

/**
 * Sign-in without a wallet (docs/ACCOUNTS.md): email codes and passkeys, on the same sessions a
 * wallet gets. Real Postgres; passkeys from a software authenticator that answers exactly as a
 * browser's would (P-256, "none" attestation).
 */

const RP_ID = "bonded.example";
const ORIGIN = "https://www.bonded.example";

let pg: Awaited<ReturnType<typeof postgres>>;
let sandbox: Sandbox;
let chain: ServiceChain;
let chainId: number;

function api(extra: Partial<Parameters<typeof createApi>[0]> = {}) {
  return createApi({
    db: pg.db,
    chain,
    attesterKey: ANVIL_KEYS.deployer,
    apiToken: "test-api-token-at-least-24-characters",
    webOrigins: [ORIGIN],
    webauthn: { rpId: RP_ID, origins: [ORIGIN] },
    ownerRequests: {
      writes: { perClient: 100_000, total: 100_000, windowMs: 60_000 },
      reads: { perClient: 100_000, total: 100_000, windowMs: 60_000 },
    },
    ...extra,
  });
}

beforeAll(async () => {
  pg = await postgres();
  sandbox = await Sandbox.start();
  chainId = sandbox.deployment.chainId;
  chain = connectChain(sandbox.deployment, sandbox.rpcUrl, ANVIL_KEYS.deployer);
}, 180_000);
afterAll(async () => {
  await sandbox?.stop();
  await pg?.stop();
});

const bodyOf = async (r: Response) => (await r.json()) as Record<string, unknown>;
const call = (
  app: ReturnType<typeof createApi>,
  method: string,
  path: string,
  body?: unknown,
  session?: string,
) =>
  Promise.resolve(
    app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(session ? { Authorization: `Bearer ${session}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

let n = 0;
const freshEmail = () => `team-${Date.now()}-${++n}@example.com`;

/** Email sign-in end to end with codes shown: the session's answer. */
async function emailSignIn(app: ReturnType<typeof createApi>, email: string) {
  const sent = await bodyOf(await call(app, "POST", "/account/email/code", { email }));
  const made = await call(app, "POST", "/account/email/session", { email, code: sent.code });
  expect(made.status).toBe(201);
  return bodyOf(made);
}

const b64u = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString("base64url");
const sha = (data: Uint8Array | Buffer | string) => createHash("sha256").update(data).digest();

/** A passkey in software: what a browser's authenticator answers, signed with P-256. */
class SoftPasskey {
  readonly id = randomBytes(16);
  private readonly keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  private counter = 0;
  constructor(
    private readonly origin = ORIGIN,
    private readonly rpId = RP_ID,
  ) {}

  private clientData(type: string, challenge: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin }));
  }

  /** The answer to `navigator.credentials.create` with the server's options. */
  register(options: { challenge: string }) {
    const jwk = this.keys.publicKey.export({ format: "jwk" });
    const cose = new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.id.length);
    const counter = Buffer.alloc(4);
    const authData = Buffer.concat([
      sha(this.rpId),
      Buffer.from([0x45]),
      counter,
      Buffer.alloc(16),
      idLength,
      this.id,
      Buffer.from(isoCBOR.encode(cose)),
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", new Uint8Array(authData)],
      ]) as never,
    );
    return {
      id: b64u(this.id),
      rawId: b64u(this.id),
      type: "public-key",
      response: {
        clientDataJSON: b64u(this.clientData("webauthn.create", options.challenge)),
        attestationObject: b64u(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
    };
  }

  /** The answer to `navigator.credentials.get` with the server's options. */
  authenticate(options: { challenge: string }) {
    const clientDataJSON = this.clientData("webauthn.get", options.challenge);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(++this.counter);
    const authData = Buffer.concat([sha(this.rpId), Buffer.from([0x05]), counter]);
    const signature = sign(
      "sha256",
      Buffer.concat([authData, sha(clientDataJSON)]),
      this.keys.privateKey,
    );
    return {
      id: b64u(this.id),
      rawId: b64u(this.id),
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
      },
      clientExtensionResults: {},
    };
  }
}

describe("email sign-in", () => {
  it("signs in with a 6-digit code, as an account whose owner id is in a wallet's format", async () => {
    const app = api({ showEmailCodes: true });
    const email = freshEmail();
    const sent = await call(app, "POST", "/account/email/code", { email: email.toUpperCase() });
    expect(sent.status).toBe(202);
    const { code } = await bodyOf(sent);
    expect(code).toMatch(/^\d{6}$/);
    const wrong = await call(app, "POST", "/account/email/session", {
      email,
      code: code === "000000" ? "000001" : "000000",
    });
    expect(wrong.status).toBe(400);
    expect((await bodyOf(wrong)).error).toMatch(/isn't right/);
    const made = await bodyOf(await call(app, "POST", "/account/email/session", { email, code }));
    expect(made.session).toMatch(/^bonded_ss_/);
    expect(made.wallet).toMatch(/^0x[0-9a-f]{40}$/);
    expect(made.account).toEqual({ email });
    // The same session works where a wallet's does: a preview belongs to the account.
    const preview = await call(
      app,
      "POST",
      "/previews",
      { mode: "tools", world: "brokerage" },
      made.session as string,
    );
    expect(preview.status).toBe(201);
    expect((await bodyOf(preview)).owner).toBe(made.wallet);
    // A code works once.
    const again = await call(app, "POST", "/account/email/session", { email, code });
    expect(again.status).toBe(400);
    expect((await bodyOf(again)).error).toMatch(/expired/);
    // The same address is the same account next time.
    expect((await emailSignIn(app, email)).wallet).toBe(made.wallet);
    expect(
      await bodyOf(await call(app, "GET", "/account", undefined, made.session as string)),
    ).toMatchObject({
      email,
      wallet: made.wallet,
      passkeys: [],
    });
  });

  it("stops after 5 wrong codes, and limits codes per address", async () => {
    const app = api({ showEmailCodes: true });
    const email = freshEmail();
    const { code } = await bodyOf(await call(app, "POST", "/account/email/code", { email }));
    const wrong = code === "123456" ? "654321" : "123456";
    const answers: number[] = [];
    for (let i = 0; i < 5; i++)
      answers.push(
        (await call(app, "POST", "/account/email/session", { email, code: wrong })).status,
      );
    expect(answers).toEqual([400, 400, 400, 400, 429]);
    // Even the right code is refused now: ask for a new one.
    expect((await call(app, "POST", "/account/email/session", { email, code })).status).toBe(429);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++)
      statuses.push((await call(app, "POST", "/account/email/code", { email })).status);
    expect(statuses).toEqual([202, 202, 202, 202, 429]);
  });

  it("sends the code by email, and never puts it in the answer", async () => {
    const sentMail: { to: string; subject: string; text: string }[] = [];
    const email: EmailSender = { send: async (m) => void sentMail.push(m) };
    const app = api({ email });
    const address = freshEmail();
    const sent = await bodyOf(await call(app, "POST", "/account/email/code", { email: address }));
    expect(sent).toEqual({ sent: true });
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0]!.to).toBe(address);
    const code = /\b(\d{6})\b/.exec(sentMail[0]!.text)![1]!;
    expect(sentMail[0]!.subject).toContain(code);
    const made = await call(app, "POST", "/account/email/session", { email: address, code });
    expect(made.status).toBe(201);
  });

  it("is off, saying so, with no email sender", async () => {
    const app = api();
    const r = await call(app, "POST", "/account/email/code", { email: freshEmail() });
    expect(r.status).toBe(503);
    expect((await bodyOf(r)).error).toMatch(/Connect a wallet instead/);
  });

  it("derives an owner id no wallet has a key for, the same for the same account", () => {
    const id = "6f1d2c1e-0000-4000-8000-000000000001";
    expect(accountOwnerId(id)).toBe(accountOwnerId(id));
    expect(accountOwnerId(id)).toMatch(/^0x[0-9a-f]{40}$/);
    expect(accountOwnerId(id)).not.toBe(accountOwnerId(`${id.slice(0, -1)}2`));
  });
});

describe("passkeys", () => {
  it("adds a passkey to an account, then signs in with it as the same account", async () => {
    const app = api({ showEmailCodes: true });
    const email = freshEmail();
    const first = await emailSignIn(app, email);
    const session = first.session as string;
    const key = new SoftPasskey();
    const regOptions = await bodyOf(
      await call(app, "POST", "/account/passkeys/options", {}, session),
    );
    expect(regOptions.rp).toMatchObject({ id: RP_ID, name: "Bonded" });
    const added = await call(
      app,
      "POST",
      "/account/passkeys",
      { response: key.register(regOptions as { challenge: string }), name: "MacBook" },
      session,
    );
    expect(added.status).toBe(201);
    const listed = await bodyOf(await call(app, "GET", "/account", undefined, session));
    expect(listed.passkeys).toEqual([
      expect.objectContaining({ id: b64u(key.id), name: "MacBook" }),
    ]);

    // Signed out, a passkey signs in: no email needed.
    const options = await bodyOf(await call(app, "POST", "/account/passkey/options", {}));
    const answer = key.authenticate(options as { challenge: string });
    const made = await call(app, "POST", "/account/passkey/session", { response: answer });
    expect(made.status).toBe(201);
    const body = await bodyOf(made);
    expect(body.wallet).toBe(first.wallet);
    expect(body.account).toEqual({ email });
    // The same signed answer again: its challenge is spent.
    expect((await call(app, "POST", "/account/passkey/session", { response: answer })).status).toBe(
      401,
    );
  });

  it("refuses a passkey Bonded doesn't know, one for another site, and a challenge it didn't give", async () => {
    const app = api({ showEmailCodes: true });
    const { session } = await emailSignIn(app, freshEmail());
    const unknown = new SoftPasskey();
    const options = (await bodyOf(await call(app, "POST", "/account/passkey/options", {}))) as {
      challenge: string;
    };
    expect(
      (
        await call(app, "POST", "/account/passkey/session", {
          response: unknown.authenticate(options),
        })
      ).status,
    ).toBe(401);

    // Registered here, but answering for another origin (a phishing page): refused.
    const key = new SoftPasskey();
    const reg = (await bodyOf(
      await call(app, "POST", "/account/passkeys/options", {}, session as string),
    )) as {
      challenge: string;
    };
    await call(
      app,
      "POST",
      "/account/passkeys",
      { response: key.register(reg) },
      session as string,
    );
    const phished = new SoftPasskey("https://bonded-login.example");
    Object.assign(phished, { id: key.id, keys: (key as unknown as { keys: unknown }).keys });
    const fresh = (await bodyOf(await call(app, "POST", "/account/passkey/options", {}))) as {
      challenge: string;
    };
    expect(
      (
        await call(app, "POST", "/account/passkey/session", {
          response: phished.authenticate(fresh),
        })
      ).status,
    ).toBe(401);

    // A challenge Bonded never gave.
    const made = { challenge: b64u(randomBytes(32)) };
    expect(
      (await call(app, "POST", "/account/passkey/session", { response: key.authenticate(made) }))
        .status,
    ).toBe(401);
  });

  it("adds a passkey only for a signed-in account, and removes it", async () => {
    const app = api({ showEmailCodes: true });
    expect((await call(app, "POST", "/account/passkeys/options", {})).status).toBe(401);
    // A wallet's session has no account.
    const wallet = privateKeyToAccount(ANVIL_KEYS.operator);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await wallet.signMessage({
      message: selfServeMessage({ action: "sign-in", chainId, wallet: wallet.address, timestamp }),
    });
    const walletSession = (
      await bodyOf(
        await call(app, "POST", "/self/session", { wallet: wallet.address, timestamp, signature }),
      )
    ).session as string;
    const refused = await call(app, "POST", "/account/passkeys/options", {}, walletSession);
    expect(refused.status).toBe(404);
    expect((await bodyOf(refused)).error).toMatch(/wallet's, not an email account's/);

    const { session } = await emailSignIn(app, freshEmail());
    const key = new SoftPasskey();
    const reg = (await bodyOf(
      await call(app, "POST", "/account/passkeys/options", {}, session as string),
    )) as {
      challenge: string;
    };
    await call(
      app,
      "POST",
      "/account/passkeys",
      { response: key.register(reg) },
      session as string,
    );
    expect(
      (await call(app, "DELETE", `/account/passkeys/${b64u(key.id)}`, undefined, session as string))
        .status,
    ).toBe(200);
    const after = await bodyOf(await call(app, "GET", "/account", undefined, session as string));
    expect(after.passkeys).toEqual([]);
  });
});
