// Makes a new AGENT_URL_SIGNING_KEY: the Ed25519 key Bonded signs every call to an agent's URL
// with (docs/AGENT-URL-SIGNED-CALLS.md). Prints the private key, for the API's and the
// arena-worker's environment, and the public key set the API will publish at
// /.well-known/bonded-agent-keys.json. Nothing is stored or sent anywhere.
//
//   pnpm --filter @bonded/api agent-url-key
//
// The first production key also goes into the SDK (BONDED_AGENT_KEYS in
// packages/sdk/src/signature.ts) before it is published, so a handler still starts when the keys
// address can't be reached.
//
// To rotate: add the new key second for an hour (AGENT_URL_SIGNING_KEY=<old>,<new>): both are
// published, the old one still signs, and cached copies of the keys file (an hour at most) run
// out. Then put it first (<new>,<old>): the new one signs. Remove the old one once handlers have
// fetched the new set (they refetch within a day, or at once for an unknown key).
import console from "node:console";
import { agentUrlSigner, newAgentUrlSigningKey } from "@bondedhq/shared";

const key = await newAgentUrlSigningKey();
const signer = await agentUrlSigner(key);
console.log("Private key (set as AGENT_URL_SIGNING_KEY; keep it secret, never commit it):\n");
console.log(`  ${key}\n`);
console.log(`Key id: ${signer.kid}`);
console.log("Public key set it publishes:\n");
console.log(JSON.stringify(signer.keySet(), null, 2));
console.log(
  "\nFor the first production key: add that public key to BONDED_AGENT_KEYS in packages/sdk/src/signature.ts before publishing the SDK.",
);
