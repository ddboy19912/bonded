// Rotates AGENT_URL_SECRET_KEY: re-encrypts every stored webhook and card hook signing secret
// from the old key to the new one, in one transaction (docs/DEVELOPING.md, "Rotating
// AGENT_URL_SECRET_KEY").
//
//   pnpm secrets:reencrypt -- [--dry-run]
//
// Reads DATABASE_URL, AGENT_URL_SECRET_KEY_OLD and AGENT_URL_SECRET_KEY_NEW from the environment
// or .env; none is printed. Safe to run again: values already under the new key are skipped.
import process from "node:process";
import console from "node:console";
import { parseArgs } from "node:util";
import { loadDotEnv } from "@bonded/arena";
import { Database } from "@bonded/db";
import { reencryptSecrets } from "../dist/reencrypt.js";
import { secretBoxFromEnv } from "../dist/secrets.js";

const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } } });
loadDotEnv();
const need = (name) => {
  const box = secretBoxFromEnv(process.env, name);
  if (!box) throw new Error(`${name} isn't set`);
  return box;
};
const from = need("AGENT_URL_SECRET_KEY_OLD");
const to = need("AGENT_URL_SECRET_KEY_NEW");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL isn't set");
const db = new Database(process.env.DATABASE_URL);
try {
  const r = await reencryptSecrets(db, from, to, { dryRun: values["dry-run"] });
  const verb = r.dryRun ? "would re-encrypt" : "re-encrypted";
  console.log(`key ${from.keyId} -> ${to.keyId}${r.dryRun ? " (dry run: nothing written)" : ""}`);
  console.log(
    `webhooks:   ${verb} ${r.webhooks.reencrypted}, already on the new key ${r.webhooks.already}`,
  );
  console.log(
    `card hooks: ${verb} ${r.cardHooks.reencrypted}, already on the new key ${r.cardHooks.already}`,
  );
  if (!r.dryRun)
    console.log("now set AGENT_URL_SECRET_KEY to the new key on api and arena-worker and redeploy");
} finally {
  await db.close();
}
