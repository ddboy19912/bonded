// Makes a new AGENT_URL_SIGNING_KEY: the Ed25519 key Bonded signs every call to an agent's URL
// with (docs/AGENT-URL-SIGNED-CALLS.md). Prints the private key, for the API's and the
// arena-worker's environment, and the public key set the API will publish at
// /.well-known/bonded-agent-keys.json. Nothing is stored or sent anywhere.
//
//   pnpm --filter @bonded/api agent-url-key
//
// To rotate: put the new key first and keep the old one after it, comma-separated
// (AGENT_URL_SIGNING_KEY=<new>,<old>). Both are published; the new one signs. Remove the old one
// once handlers have fetched the new set (they refetch within a day, or at once for an unknown key).
import console from "node:console";
import { agentUrlSigner, newAgentUrlSigningKey } from "@bondedhq/shared";

const key = await newAgentUrlSigningKey();
const signer = await agentUrlSigner(key);
console.log("Private key (set as AGENT_URL_SIGNING_KEY; keep it secret, never commit it):\n");
console.log(`  ${key}\n`);
console.log(`Key id: ${signer.kid}`);
console.log("Public key set it publishes:\n");
console.log(JSON.stringify(signer.keySet(), null, 2));
