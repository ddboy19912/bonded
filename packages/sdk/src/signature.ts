/**
 * Agent URL request signatures: how an agent knows a request really comes from Bonded, for its
 * owner.
 *
 * Bonded signs every call to an Agent URL with its own Ed25519 key (no shared secret):
 * - `bonded-timestamp`: unix seconds;
 * - `bonded-owner`: the wallet that saved the URL on Bonded;
 * - `bonded-signature`: `v2=<key id>:<base64url signature>` over
 *   `v2.<key id>.<timestamp>.<owner>.<raw body>`.
 *
 * The handler checks it against Bonded's published keys (BONDED_AGENT_KEYS_URL) and refuses calls
 * for any owner but its own. The scheme lives in @bondedhq/shared
 * (`@bondedhq/shared/agent-url`, which the gateway signs with). Web Crypto only, so it runs in
 * Node 22+, Bun, Deno, Cloudflare Workers and edge runtimes.
 */
import {
  AGENT_URL_KEYS_PATH,
  AGENT_URL_OWNER_HEADER,
  AGENT_URL_SIGNATURE_HEADER,
  AGENT_URL_TIMESTAMP_HEADER,
  AGENT_URL_TOLERANCE_SECONDS,
  type AgentUrlPublicKey,
  agentUrlSigner,
  newAgentUrlSigningKey,
} from "@bondedhq/shared/agent-url";

export const SIGNATURE_HEADER = AGENT_URL_SIGNATURE_HEADER;
export const TIMESTAMP_HEADER = AGENT_URL_TIMESTAMP_HEADER;
export const OWNER_HEADER = AGENT_URL_OWNER_HEADER;
/** How far a request's timestamp may be from the agent's clock, either way. */
export const SIGNATURE_TOLERANCE_SECONDS = AGENT_URL_TOLERANCE_SECONDS;
/**
 * Where Bonded publishes the keys that sign calls to agents. It is on Bonded's own domain, not the
 * API's host name, because this address is built into every deployed handler: the API can move
 * without breaking them.
 */
export const BONDED_AGENT_KEYS_URL = `https://www.bondedhq.xyz${AGENT_URL_KEYS_PATH}`;
/**
 * Bonded's production keys, built in: used only when BONDED_AGENT_KEYS_URL can't be reached and
 * no key set was fetched before, so a handler still starts then. The same set the keys address
 * publishes (docs/AGENT-URL-SIGNED-CALLS.md, Section 6): on a key rotation, add the new public key
 * here before a release.
 */
export const BONDED_AGENT_KEYS: AgentUrlPublicKey[] = [
  // The first production key, made 2026-11-14.
  { kid: "ind7eq0xdV0-", alg: "Ed25519", x: "tWhxWPMrq6BKcQs838cUlF_5SecIG1NBy8L_IRIkSBg" },
];
/** Where another Bonded deployment (a local Arena, a staging API) publishes its keys. */
export const keysUrlOf = (apiUrl: string) => `${apiUrl.replace(/\/+$/, "")}${AGENT_URL_KEYS_PATH}`;

/**
 * A stand-in for Bonded, for testing your endpoint locally: a fresh key, `sign` to sign a body
 * for an owner the way Bonded does, and `keys` to give the handler (`createBondedHandler({ keys })`).
 * Bonded signs real calls itself, with keys your handler fetches.
 */
export async function createTestSigner(): Promise<{
  keys: AgentUrlPublicKey[];
  sign(
    owner: string,
    body: string,
    timestamp?: number,
  ): Promise<{ "bonded-timestamp": string; "bonded-owner": string; "bonded-signature": string }>;
}> {
  const signer = await agentUrlSigner(await newAgentUrlSigningKey());
  return {
    keys: signer.keySet().keys,
    async sign(owner, body, timestamp = Math.floor(Date.now() / 1000)) {
      const headers = await signer.sign(owner, body, timestamp * 1000);
      return {
        "bonded-timestamp": headers[TIMESTAMP_HEADER]!,
        "bonded-owner": headers[OWNER_HEADER]!,
        "bonded-signature": headers[SIGNATURE_HEADER]!,
      };
    },
  };
}
