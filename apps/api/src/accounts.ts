import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AccountRecord, Database } from "@bonded/db";
import type { EmailSender } from "./notifications.js";
import type { RateLimiter } from "./rate-limit.js";
import { clientAddress } from "./rate-limit.js";
import { Refused, handle } from "./refused.js";
import {
  SESSION_PREFIX,
  SESSION_TTL_MS,
  SESSIONS_PER_WALLET_HOURLY,
  type SessionWallet,
} from "./sessions.js";

/**
 * Sign-in without a wallet (docs/ACCOUNTS.md), for teams that aren't crypto-native: an email
 * address proved with a one-time code, then passkeys for one-tap sign-in. An account's sessions
 * are the same `bonded_ss_` tokens a wallet's are, and its owner id has a wallet's format
 * (`accountOwnerId`), so every route that takes a session works for it unchanged. It is not a
 * wallet: nothing can sign for it, so on-chain actions (official ratings, vaults, cover) stay
 * wallet-only.
 */

/** A one-time code's life, wrong tries and how many one address may ask for in an hour. */
export const EMAIL_CODE_TTL_MS = 10 * 60_000;
export const EMAIL_CODE_ATTEMPTS = 5;
export const EMAIL_CODES_PER_HOUR = 5;
/** A passkey challenge's life. */
export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60_000;

/** Where passkeys are valid: the site's domain and the origins its pages are served from. */
export interface WebAuthnConfig {
  rpId: string;
  origins: string[];
}

/** WEBAUTHN_RP_ID and WEBAUTHN_ORIGINS, defaulting to bondedhq.xyz. */
export function webAuthnFromEnv(
  env: Record<string, string | undefined> = process.env,
): WebAuthnConfig {
  const rpId = env.WEBAUTHN_RP_ID?.trim() || "bondedhq.xyz";
  const origins = (env.WEBAUTHN_ORIGINS ?? "https://www.bondedhq.xyz,https://bondedhq.xyz")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  return { rpId, origins };
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * An account's owner id: 0x and the first 40 hex characters of sha256("bonded-account\n" + id).
 * Stable for the account, in the format owner columns take, and no wallet's: nobody holds a key
 * for it.
 */
export const accountOwnerId = (accountId: string) =>
  `0x${sha256(`bonded-account\n${accountId}`).slice(0, 40)}`;

const codeHash = (email: string, code: string) => sha256(`${email.toLowerCase()}\n${code}`);

const emailInput = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/, "Enter an email address.");

const codeRequest = z.strictObject({ email: emailInput });
const codeAnswer = z.strictObject({
  email: emailInput,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Enter the 6-digit code from the email."),
});
// The browser's WebAuthn answers, as @simplewebauthn/browser sends them; the library checks them.
const registrationInput = z.strictObject({
  response: z.looseObject({ id: z.string().min(1).max(1024) }),
  name: z.string().trim().min(1).max(60).optional(),
});
const authenticationInput = z.strictObject({
  response: z.looseObject({ id: z.string().min(1).max(1024) }),
});

/** The account behind a session, or a 404 when the session is a wallet's. */
type SessionAccount = (c: Context) => Promise<AccountRecord>;

export function accountRoutes(
  app: Hono,
  options: {
    db: Database;
    chainId: number;
    wallet: SessionWallet;
    writes: RateLimiter;
    webauthn: WebAuthnConfig;
    /** The sign-in code's sender. Without one, codes can't be sent (unless `showCodes`). */
    email?: EmailSender;
    /** Local development and tests only: no email is sent, and the code comes back in the answer. */
    showCodes?: boolean;
  },
): SessionAccount {
  const { db, chainId, webauthn } = options;
  const limit = (c: Context) => {
    if (!options.writes.allow(clientAddress(c.req.raw.headers)))
      throw new Refused(429, "too many requests; try again in a few minutes");
  };

  const account: SessionAccount = async (c) => {
    const owner = await options.wallet(c);
    const found = await db.accountByOwner(owner);
    if (!found) throw new Refused(404, "This session is a wallet's, not an email account's.");
    return found;
  };

  /** Opens a session for an account: the same token and answer a wallet's sign-in gives. */
  async function openSession(c: Context, a: AccountRecord, signedBy: string) {
    const token = `${SESSION_PREFIX}${randomBytes(32).toString("base64url")}`;
    const opened = await db.createSession(
      {
        tokenHash: sha256(token),
        chainId,
        wallet: a.ownerId,
        // Each code or passkey challenge opens one session.
        signatureHash: sha256(signedBy),
        ttlMs: SESSION_TTL_MS,
      },
      SESSIONS_PER_WALLET_HOURLY,
    );
    if ("refused" in opened)
      throw opened.refused === "replayed"
        ? new Refused(409, "That sign-in was already used. Sign in again.")
        : new Refused(429, "Too many sign-ins for this account. Try again in an hour.");
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        session: token,
        wallet: a.ownerId,
        account: { email: a.email },
        expiresAt: opened.expiresAt.toISOString(),
      },
      201,
    );
  }

  /** Step 1 of email sign-in: a 6-digit code to the address. New addresses get an account. */
  app.post(
    "/account/email/code",
    handle(async (c) => {
      limit(c);
      const { email } = codeRequest.parse(await c.req.json());
      if (!options.email && !options.showCodes)
        throw new Refused(
          503,
          "Email sign-in isn't available right now. Connect a wallet instead.",
        );
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const made = await db.createEmailCode(email, codeHash(email, code), {
        ttlMs: EMAIL_CODE_TTL_MS,
        perEmailHourly: EMAIL_CODES_PER_HOUR,
      });
      if ("refused" in made)
        throw new Refused(429, "Too many codes for this address. Try again in an hour.");
      if (options.email)
        await options.email
          .send({
            to: email,
            subject: `Your Bonded sign-in code: ${code}`,
            text: [
              `Your Bonded sign-in code is ${code}.`,
              "",
              "It works once, for 10 minutes. If you didn't ask for it, ignore this email: nobody can sign in without the code.",
            ].join("\n"),
          })
          .catch(() => {
            throw new Refused(503, "The sign-in email couldn't be sent. Try again in a minute.");
          });
      return c.json({ sent: true, ...(options.showCodes ? { code } : {}) }, 202);
    }),
  );

  /** Step 2: the code for a session. */
  app.post(
    "/account/email/session",
    handle(async (c) => {
      limit(c);
      const { email, code } = codeAnswer.parse(await c.req.json());
      const used = await db.useEmailCode(email, codeHash(email, code), EMAIL_CODE_ATTEMPTS);
      if ("refused" in used)
        throw used.refused === "wrong"
          ? new Refused(400, "That code isn't right. Check the latest email and try again.")
          : used.refused === "too-many-tries"
            ? new Refused(429, "Too many wrong codes. Ask for a new one.")
            : new Refused(400, "That code has expired. Ask for a new one.");
      const a = await db.accountForEmail(email, accountOwnerId);
      return openSession(c, a, `email-code:${used.id}`);
    }),
  );

  /** The signed-in account: its email and passkeys. */
  app.get(
    "/account",
    handle(async (c) => {
      const a = await account(c);
      const keys = await db.passkeysOf(a.id);
      return c.json({
        email: a.email,
        wallet: a.ownerId,
        passkeys: keys.map((k) => ({
          id: k.id,
          name: k.name,
          createdAt: k.createdAt.toISOString(),
          lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
        })),
      });
    }),
  );

  /** Adding a passkey, step 1: the options the browser needs (signed in). */
  app.post(
    "/account/passkeys/options",
    handle(async (c) => {
      limit(c);
      const a = await account(c);
      const existing = await db.passkeysOf(a.id);
      const opts = await generateRegistrationOptions({
        rpName: "Bonded",
        rpID: webauthn.rpId,
        userName: a.email,
        userID: new TextEncoder().encode(a.id),
        attestationType: "none",
        excludeCredentials: existing.map((k) => ({ id: k.id, transports: k.transports })),
        authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
      });
      await db.createPasskeyChallenge({
        challenge: opts.challenge,
        purpose: "register",
        accountId: a.id,
        ttlMs: PASSKEY_CHALLENGE_TTL_MS,
      });
      return c.json(opts);
    }),
  );

  /** Adding a passkey, step 2: the browser's answer, checked and kept. */
  app.post(
    "/account/passkeys",
    handle(async (c) => {
      limit(c);
      const a = await account(c);
      const input = registrationInput.parse(await c.req.json());
      const verified = await verifyRegistrationResponse({
        response: input.response as unknown as RegistrationResponseJSON,
        expectedChallenge: async (challenge) =>
          (await db.usePasskeyChallenge(challenge, "register", a.id)) !== undefined,
        expectedOrigin: webauthn.origins,
        expectedRPID: webauthn.rpId,
        requireUserVerification: false,
      }).catch(() => ({ verified: false as const }));
      if (!verified.verified) throw new Refused(400, "That passkey couldn't be added. Try again.");
      const { credential } = verified.registrationInfo;
      const added = await db.addPasskey({
        id: credential.id,
        accountId: a.id,
        publicKey: credential.publicKey,
        counter: credential.counter,
        transports: credential.transports ?? [],
        name: input.name ?? "Passkey",
      });
      if (!added) throw new Refused(409, "That passkey is already added.");
      return c.json({ id: credential.id, name: input.name ?? "Passkey" }, 201);
    }),
  );

  /** Removing a passkey from the signed-in account. */
  app.delete(
    "/account/passkeys/:id",
    handle(async (c) => {
      const a = await account(c);
      if (!(await db.deletePasskey(a.id, c.req.param("id") ?? "")))
        throw new Refused(404, "That passkey isn't on this account.");
      return c.json({ removed: true });
    }),
  );

  /** Passkey sign-in, step 1: a challenge any of the browser's passkeys for Bonded can answer. */
  app.post(
    "/account/passkey/options",
    handle(async (c) => {
      limit(c);
      const opts = await generateAuthenticationOptions({
        rpID: webauthn.rpId,
        userVerification: "preferred",
      });
      await db.createPasskeyChallenge({
        challenge: opts.challenge,
        purpose: "sign-in",
        ttlMs: PASSKEY_CHALLENGE_TTL_MS,
      });
      return c.json(opts);
    }),
  );

  /** Passkey sign-in, step 2: the browser's signed answer for a session. */
  app.post(
    "/account/passkey/session",
    handle(async (c) => {
      limit(c);
      const input = authenticationInput.parse(await c.req.json());
      const key = await db.passkey(input.response.id);
      if (!key) throw new Refused(401, "That passkey isn't registered with Bonded.");
      let challengeUsed = "";
      const verified = await verifyAuthenticationResponse({
        response: input.response as unknown as AuthenticationResponseJSON,
        expectedChallenge: async (challenge) => {
          const id = await db.usePasskeyChallenge(challenge, "sign-in");
          if (id) challengeUsed = id;
          return id !== undefined;
        },
        expectedOrigin: webauthn.origins,
        expectedRPID: webauthn.rpId,
        credential: {
          id: key.id,
          publicKey: new Uint8Array(key.publicKey),
          counter: key.counter,
          transports: key.transports,
        },
        requireUserVerification: false,
      }).catch(() => ({ verified: false as const, authenticationInfo: undefined }));
      if (!verified.verified || !verified.authenticationInfo)
        throw new Refused(401, "That passkey sign-in didn't check out. Try again.");
      await db.passkeyUsed(key.id, verified.authenticationInfo.newCounter);
      const a = await db.accountById(key.accountId);
      if (!a) throw new Refused(401, "That passkey isn't registered with Bonded.");
      await db.markAccountSignIn(a.id);
      return openSession(c, a, `passkey:${challengeUsed}`);
    }),
  );

  return account;
}
