import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reencryptSecrets } from "../src/reencrypt.js";
import {
  SecretBox,
  agentUrlContext,
  gateStripeContext,
  secretBoxFromEnv,
  webhookContext,
} from "../src/secrets.js";
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
    await pg.db.pool.query("DELETE FROM agent_urls");
    await pg.db.pool.query("DELETE FROM notification_settings");
  });

  /** Stores an Agent URL with its secret sealed by `key`. */
  async function addUrl(key: SecretBox, secret: string, revoked = false, id = randomUUID()) {
    await pg.db.pool.query(
      `INSERT INTO agent_urls(id,owner_key,url,secret_ciphertext,created_by,revoked_at)
       VALUES($1,$2,'https://agent.example',$3,$4,$5)`,
      [
        id,
        `46630:${Math.floor(Math.random() * 1e9)}`,
        key.encrypt(secret, agentUrlContext(id)),
        OWNER,
        revoked ? new Date() : null,
      ],
    );
    return id;
  }
  async function addWebhook(owner: string, sealed: string | null) {
    await pg.db.pool.query(
      `INSERT INTO notification_settings(owner,webhook_url,webhook_secret_ciphertext)
       VALUES($1,'https://hook.example',$2)`,
      [owner, sealed],
    );
  }
  const urlSecret = async (id: string) =>
    (await pg.db.pool.query("SELECT secret_ciphertext FROM agent_urls WHERE id=$1", [id])).rows[0]
      .secret_ciphertext as string;
  const hookSecret = async (owner: string) =>
    (
      await pg.db.pool.query(
        "SELECT webhook_secret_ciphertext FROM notification_settings WHERE owner=$1",
        [owner],
      )
    ).rows[0].webhook_secret_ciphertext as string | null;

  it("moves every Agent URL secret, revoked ones too, and webhook secrets to the new key", async () => {
    const live = await addUrl(oldKey, "bonded_as_live");
    const revoked = await addUrl(oldKey, "bonded_as_revoked", true);
    await addWebhook(OWNER, oldKey.encrypt("bonded_ws_one", webhookContext(OWNER)));
    await addWebhook("0x00000000000000000000000000000000000000bb", null);

    const result = await reencryptSecrets(pg.db, oldKey, newKey);
    expect(result).toEqual({
      agentUrls: { reencrypted: 2, already: 0 },
      webhooks: { reencrypted: 1, already: 0 },
      gateStripe: { reencrypted: 0, already: 0 },
      dryRun: false,
    });
    expect(newKey.decrypt(await urlSecret(live), agentUrlContext(live))).toBe("bonded_as_live");
    expect(newKey.decrypt(await urlSecret(revoked), agentUrlContext(revoked))).toBe(
      "bonded_as_revoked",
    );
    expect(newKey.decrypt((await hookSecret(OWNER))!, webhookContext(OWNER))).toBe("bonded_ws_one");
    // The old key reads nothing any more, and a webhook without a secret stays without one.
    const sealed = await urlSecret(live);
    expect(() => oldKey.decrypt(sealed, agentUrlContext(live))).toThrow(
      /another AGENT_URL_SECRET_KEY/,
    );
    expect(await hookSecret("0x00000000000000000000000000000000000000bb")).toBeNull();
  });

  it("moves the payment gate's Stripe key and endpoint secrets, each bound to its account", async () => {
    const account = randomUUID();
    await pg.db.pool.query(
      `INSERT INTO gate_accounts(id,owner,mode,max_payment_cents,max_daily_cents,mandate_hash)
       VALUES($1,$2,'enforce',100,100,'0x00')`,
      [account, OWNER],
    );
    // Throwaway values shaped like Stripe's, made for this test.
    const key = `rk_test_${randomBytes(12).toString("hex")}`;
    const events = `whsec_${randomBytes(12).toString("hex")}`;
    await pg.db.pool.query(
      `INSERT INTO gate_stripe_links(account_id,key_ciphertext,key_hint,livemode,cardholder_id,
         events_secret_ciphertext,linked_by) VALUES($1,$2,'rk_test_…',false,'ich_1',$3,$4)`,
      [
        account,
        oldKey.encrypt(key, gateStripeContext(account, "key")),
        oldKey.encrypt(events, gateStripeContext(account, "events")),
        OWNER,
      ],
    );
    const result = await reencryptSecrets(pg.db, oldKey, newKey);
    expect(result.gateStripe).toEqual({ reencrypted: 2, already: 0 });
    const row = (
      await pg.db.pool.query("SELECT * FROM gate_stripe_links WHERE account_id=$1", [account])
    ).rows[0];
    expect(newKey.decrypt(row.key_ciphertext, gateStripeContext(account, "key"))).toBe(key);
    expect(newKey.decrypt(row.events_secret_ciphertext, gateStripeContext(account, "events"))).toBe(
      events,
    );
    expect(row.authorization_secret_ciphertext).toBeNull();
    await pg.db.pool.query("DELETE FROM gate_stripe_links");
    expect((await reencryptSecrets(pg.db, newKey, box())).gateStripe).toEqual({
      reencrypted: 0,
      already: 0,
    });
  });

  it("is safe to run again: values already under the new key are left as they are", async () => {
    const id = await addUrl(oldKey, "bonded_as_live");
    await reencryptSecrets(pg.db, oldKey, newKey);
    const after = await urlSecret(id);
    const again = await reencryptSecrets(pg.db, oldKey, newKey);
    expect(again.agentUrls).toEqual({ reencrypted: 0, already: 1 });
    expect(await urlSecret(id)).toBe(after);
  });

  it("finishes a partial rotation: rows on either key end up on the new one", async () => {
    const a = await addUrl(oldKey, "bonded_as_a");
    const b = await addUrl(newKey, "bonded_as_b");
    const result = await reencryptSecrets(pg.db, oldKey, newKey);
    expect(result.agentUrls).toEqual({ reencrypted: 1, already: 1 });
    expect(newKey.decrypt(await urlSecret(a), agentUrlContext(a))).toBe("bonded_as_a");
    expect(newKey.decrypt(await urlSecret(b), agentUrlContext(b))).toBe("bonded_as_b");
  });

  it("counts but writes nothing in a dry run", async () => {
    const id = await addUrl(oldKey, "bonded_as_live");
    const before = await urlSecret(id);
    const result = await reencryptSecrets(pg.db, oldKey, newKey, { dryRun: true });
    expect(result).toMatchObject({ agentUrls: { reencrypted: 1, already: 0 }, dryRun: true });
    expect(await urlSecret(id)).toBe(before);
  });

  it("rolls everything back when a value is under neither key, naming the row but not the secret", async () => {
    // Rows go in id order: the good one is re-encrypted before the stray one fails.
    const good = await addUrl(
      oldKey,
      "bonded_as_good",
      false,
      "00000000-0000-4000-8000-000000000001",
    );
    const before = await urlSecret(good);
    const stray = await addUrl(
      box(),
      "bonded_as_stray_secret",
      false,
      "ffffffff-0000-4000-8000-000000000001",
    );
    const error = await reencryptSecrets(pg.db, oldKey, newKey).then(
      () => new Error("expected a failure"),
      (e: unknown) => e as Error,
    );
    expect(error.message).toBe(
      `agent URL ${stray}: the stored secret was encrypted with another AGENT_URL_SECRET_KEY`,
    );
    expect(error.message).not.toContain("bonded_as_stray_secret");
    // The row before it was re-encrypted in the transaction, then rolled back.
    expect(await urlSecret(good)).toBe(before);
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
