import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reencryptSecrets } from "../src/reencrypt.js";
import { SecretBox, cardHookContext, secretBoxFromEnv, webhookContext } from "../src/secrets.js";
import { postgres } from "./postgres.js";

const box = () => new SecretBox(randomBytes(32));
const OWNER = "0x00000000000000000000000000000000000000aa";

describe("re-encrypting stored secrets for a new AGENT_URL_SECRET_KEY", () => {
  let pg: Awaited<ReturnType<typeof postgres>>;
  let oldKey: SecretBox;
  let newKey: SecretBox;
  beforeAll(async () => {
    pg = await postgres();
  }, 180_000);
  afterAll(async () => {
    await pg?.stop();
  });
  beforeEach(async () => {
    oldKey = box();
    newKey = box();
    await pg.db.pool.query("DELETE FROM notification_settings");
  });

  /** A wallet address for a test webhook. */
  const wallet = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
  /** Stores a webhook whose secret is sealed by `key`. */
  const addSealed = async (key: SecretBox, secret: string, owner: string) => {
    await addWebhook(owner, key.encrypt(secret, webhookContext(owner)));
    return owner;
  };
  async function addWebhook(owner: string, sealed: string | null) {
    await pg.db.pool.query(
      `INSERT INTO notification_settings(owner,webhook_url,webhook_secret_ciphertext)
       VALUES($1,'https://hook.example',$2)`,
      [owner, sealed],
    );
  }
  const hookSecret = async (owner: string) =>
    (
      await pg.db.pool.query(
        "SELECT webhook_secret_ciphertext FROM notification_settings WHERE owner=$1",
        [owner],
      )
    ).rows[0].webhook_secret_ciphertext as string | null;

  it("moves webhook secrets to the new key", async () => {
    await addWebhook(OWNER, oldKey.encrypt("bonded_ws_one", webhookContext(OWNER)));
    await addWebhook("0x00000000000000000000000000000000000000bb", null);

    const result = await reencryptSecrets(pg.db, oldKey, newKey);
    expect(result).toEqual({
      webhooks: { reencrypted: 1, already: 0 },
      cardHooks: { reencrypted: 0, already: 0 },
      dryRun: false,
    });
    expect(newKey.decrypt((await hookSecret(OWNER))!, webhookContext(OWNER))).toBe("bonded_ws_one");
    // The old key reads nothing any more, and a webhook without a secret stays without one.
    const sealed = (await hookSecret(OWNER))!;
    expect(() => oldKey.decrypt(sealed, webhookContext(OWNER))).toThrow(
      /another AGENT_URL_SECRET_KEY/,
    );
    expect(await hookSecret("0x00000000000000000000000000000000000000bb")).toBeNull();
  });

  it("moves card hook signing secrets, each bound to its hook, and skips Marqeta's", async () => {
    const account = randomUUID();
    await pg.db.pool.query(
      `INSERT INTO gate_accounts(id,owner,mode,max_payment_cents,max_daily_cents,mandate_hash)
       VALUES($1,$2,'enforce',100,100,'0x00')`,
      [account, OWNER],
    );
    // A throwaway value shaped like a signing secret, made for this test.
    const secret = `whsec_${randomBytes(12).toString("hex")}`;
    const stripe = randomUUID();
    const marqeta = randomUUID();
    await pg.db.pool.query(
      `INSERT INTO gate_card_hooks(id,account_id,provider,secret_ciphertext,created_by)
       VALUES($1,$2,'stripe',$3,$4)`,
      [stripe, account, oldKey.encrypt(secret, cardHookContext(stripe)), OWNER],
    );
    await pg.db.pool.query(
      `INSERT INTO gate_card_hooks(id,account_id,provider,basic_user,basic_password_hash,created_by)
       VALUES($1,$2,'marqeta','bonded_1',$3,$4)`,
      [marqeta, account, "ab".repeat(32), OWNER],
    );
    const result = await reencryptSecrets(pg.db, oldKey, newKey);
    expect(result.cardHooks).toEqual({ reencrypted: 1, already: 0 });
    const row = (
      await pg.db.pool.query("SELECT secret_ciphertext FROM gate_card_hooks WHERE id=$1", [stripe])
    ).rows[0];
    expect(newKey.decrypt(row.secret_ciphertext, cardHookContext(stripe))).toBe(secret);
    await pg.db.pool.query("DELETE FROM gate_card_hooks");
  });

  it("is safe to run again: values already under the new key are left as they are", async () => {
    const id = await addSealed(oldKey, "bonded_ws_live", wallet(1));
    await reencryptSecrets(pg.db, oldKey, newKey);
    const after = await hookSecret(id);
    const again = await reencryptSecrets(pg.db, oldKey, newKey);
    expect(again.webhooks).toEqual({ reencrypted: 0, already: 1 });
    expect(await hookSecret(id)).toBe(after);
  });

  it("finishes a partial rotation: rows on either key end up on the new one", async () => {
    const a = await addSealed(oldKey, "bonded_ws_a", wallet(2));
    const b = await addSealed(newKey, "bonded_ws_b", wallet(3));
    const result = await reencryptSecrets(pg.db, oldKey, newKey);
    expect(result.webhooks).toEqual({ reencrypted: 1, already: 1 });
    expect(newKey.decrypt((await hookSecret(a))!, webhookContext(a))).toBe("bonded_ws_a");
    expect(newKey.decrypt((await hookSecret(b))!, webhookContext(b))).toBe("bonded_ws_b");
  });

  it("counts but writes nothing in a dry run", async () => {
    const id = await addSealed(oldKey, "bonded_ws_live", wallet(4));
    const before = await hookSecret(id);
    const result = await reencryptSecrets(pg.db, oldKey, newKey, { dryRun: true });
    expect(result).toMatchObject({ webhooks: { reencrypted: 1, already: 0 }, dryRun: true });
    expect(await hookSecret(id)).toBe(before);
  });

  it("rolls everything back when a value is under neither key, naming the row but not the secret", async () => {
    // Rows go in owner order: the good one is re-encrypted before the stray one fails.
    const good = await addSealed(oldKey, "bonded_ws_good", wallet(5));
    const before = await hookSecret(good);
    const stray = await addSealed(box(), "bonded_ws_stray_secret", `0x${"f".repeat(40)}`);
    const error = await reencryptSecrets(pg.db, oldKey, newKey).then(
      () => new Error("expected a failure"),
      (e: unknown) => e as Error,
    );
    expect(error.message).toMatch(stray);
    expect(error.message).toMatch(/another AGENT_URL_SECRET_KEY/);
    expect(error.message).not.toContain("bonded_ws_stray_secret");
    // The row before it was re-encrypted in the transaction, then rolled back.
    expect(await hookSecret(good)).toBe(before);
  });

  it("refuses the same key as old and new", async () => {
    await expect(reencryptSecrets(pg.db, oldKey, oldKey)).rejects.toThrow(/the same/);
  });

  it("reads either key's variable, naming it when malformed", () => {
    const hex = randomBytes(32).toString("hex");
    expect(
      secretBoxFromEnv({ AGENT_URL_SECRET_KEY_NEW: hex }, "AGENT_URL_SECRET_KEY_NEW"),
    ).toBeInstanceOf(SecretBox);
    expect(secretBoxFromEnv({}, "AGENT_URL_SECRET_KEY_OLD")).toBeUndefined();
    expect(() =>
      secretBoxFromEnv({ AGENT_URL_SECRET_KEY_OLD: "abc" }, "AGENT_URL_SECRET_KEY_OLD"),
    ).toThrow("AGENT_URL_SECRET_KEY_OLD must be 32 bytes");
  });
});
