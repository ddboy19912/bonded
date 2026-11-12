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
 * The handler checks it against Bonded's published keys (`${apiUrl}/.well-known/bonded-agent-keys.json`)
 * and refuses calls for any owner but its own. The scheme lives in @bondedhq/shared
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
/** Bonded's API, where the signing keys are published. */
export const BONDED_AGENT_API_URL = "https://api-production-ba50.up.railway.app";
/** Where an API publishes the keys that sign calls to agents. */
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
