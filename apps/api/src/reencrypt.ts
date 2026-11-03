import type { Database } from "@bonded/db";
import {
  agentUrlContext,
  gatePayoutContext,
  gateStripeContext,
  webhookContext,
  type SecretBox,
} from "./secrets.js";

/** What one table's pass did. */
export interface ReencryptCount {
  /** Encrypted with the old key and now (or, in a dry run, would be) with the new one. */
  reencrypted: number;
  /** Already encrypted with the new key: a rerun after a finished or partial run. */
  already: number;
}

export interface ReencryptResult {
  agentUrls: ReencryptCount;
  webhooks: ReencryptCount;
  /** Each linked Stripe account's key and endpoint secrets, counted one by one. */
  gateStripe: ReencryptCount;
  /** Each payout link's events endpoint secret. */
  gatePayout: ReencryptCount;
  dryRun: boolean;
}

/** The key id in a stored "v1.<key id>.…" value. */
const keyIdOf = (sealed: string) => sealed.split(".")[1];

/**
 * Moves every stored secret (Agent URL secrets, revoked ones included, webhook signing secrets,
 * the payment gate's Stripe keys and endpoint secrets, and its payout links' events secrets)
 * from the `from` key to the `to` key,
 * for rotating AGENT_URL_SECRET_KEY. One
 * transaction with the rows locked: a value that won't decrypt with either key (malformed, or
 * under a third key) rolls everything back, naming its row but never the secret. Values already
 * under `to` are left alone, so a rerun is safe. With `dryRun`, everything is checked and
 * counted and nothing is written.
 */
export async function reencryptSecrets(
  db: Pick<Database, "pool">,
  from: SecretBox,
  to: SecretBox,
  options: { dryRun?: boolean } = {},
): Promise<ReencryptResult> {
  if (from.keyId === to.keyId) throw new Error("the old and new keys are the same");
  const dryRun = options.dryRun ?? false;
  const client = await db.pool.connect();
  const move = (sealed: string, context: string, row: string, count: ReencryptCount) => {
    const already = keyIdOf(sealed) === to.keyId;
    let plain: string;
    try {
      // A value already under the new key must still decrypt with it.
      plain = (already ? to : from).decrypt(sealed, context);
    } catch (error) {
      throw new Error(`${row}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    if (already) {
      count.already++;
      return undefined;
    }
    count.reencrypted++;
    return to.encrypt(plain, context);
  };
  try {
    await client.query("BEGIN");
    const agentUrls: ReencryptCount = { reencrypted: 0, already: 0 };
    const urls = await client.query<{ id: string; secret_ciphertext: string }>(
      "SELECT id, secret_ciphertext FROM agent_urls ORDER BY id FOR UPDATE",
    );
    for (const r of urls.rows) {
      const sealed = move(
        r.secret_ciphertext,
        agentUrlContext(r.id),
        `agent URL ${r.id}`,
        agentUrls,
      );
      if (sealed && !dryRun)
        await client.query("UPDATE agent_urls SET secret_ciphertext=$2 WHERE id=$1", [
          r.id,
          sealed,
        ]);
    }
    const webhooks: ReencryptCount = { reencrypted: 0, already: 0 };
    const hooks = await client.query<{ owner: string; webhook_secret_ciphertext: string }>(
      `SELECT owner, webhook_secret_ciphertext FROM notification_settings
       WHERE webhook_secret_ciphertext IS NOT NULL ORDER BY owner FOR UPDATE`,
    );
    for (const r of hooks.rows) {
      const sealed = move(
        r.webhook_secret_ciphertext,
        webhookContext(r.owner),
        `webhook of ${r.owner}`,
        webhooks,
      );
      if (sealed && !dryRun)
        await client.query(
          "UPDATE notification_settings SET webhook_secret_ciphertext=$2 WHERE owner=$1",
          [r.owner, sealed],
        );
    }
    // The payment gate's linked Stripe accounts: the restricted key and the endpoints' secrets.
    const gateStripe: ReencryptCount = { reencrypted: 0, already: 0 };
    const links = await client.query<{
      account_id: string;
      key_ciphertext: string;
      authorization_secret_ciphertext: string | null;
      events_secret_ciphertext: string | null;
    }>(
      `SELECT account_id, key_ciphertext, authorization_secret_ciphertext, events_secret_ciphertext
       FROM gate_stripe_links ORDER BY account_id FOR UPDATE`,
    );
    for (const r of links.rows) {
      const row = `Stripe link of gate account ${r.account_id}`;
      const key = move(r.key_ciphertext, gateStripeContext(r.account_id, "key"), row, gateStripe);
      const auth = r.authorization_secret_ciphertext
        ? move(
            r.authorization_secret_ciphertext,
            gateStripeContext(r.account_id, "authorization"),
            row,
            gateStripe,
          )
        : undefined;
      const events = r.events_secret_ciphertext
        ? move(
            r.events_secret_ciphertext,
            gateStripeContext(r.account_id, "events"),
            row,
            gateStripe,
          )
        : undefined;
      if ((key || auth || events) && !dryRun)
        await client.query(
          `UPDATE gate_stripe_links SET key_ciphertext=COALESCE($2,key_ciphertext),
             authorization_secret_ciphertext=COALESCE($3,authorization_secret_ciphertext),
             events_secret_ciphertext=COALESCE($4,events_secret_ciphertext) WHERE account_id=$1`,
          [r.account_id, key ?? null, auth ?? null, events ?? null],
        );
    }
    // The payout links' events secrets. The payout credential itself is sealed to the payout
    // proxy in the TEE, not to this key, so it is not touched.
    const gatePayout: ReencryptCount = { reencrypted: 0, already: 0 };
    const payoutLinks = await client.query<{
      account_id: string;
      events_secret_ciphertext: string;
    }>(
      "SELECT account_id, events_secret_ciphertext FROM gate_payout_links ORDER BY account_id FOR UPDATE",
    );
    for (const r of payoutLinks.rows) {
      const sealed = move(
        r.events_secret_ciphertext,
        gatePayoutContext(r.account_id),
        `payout link of gate account ${r.account_id}`,
        gatePayout,
      );
      if (sealed && !dryRun)
        await client.query(
          "UPDATE gate_payout_links SET events_secret_ciphertext=$2 WHERE account_id=$1",
          [r.account_id, sealed],
        );
    }
    await client.query(dryRun ? "ROLLBACK" : "COMMIT");
    return { agentUrls, webhooks, gateStripe, gatePayout, dryRun };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
