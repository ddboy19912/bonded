import { agentUrlSigner, newAgentUrlSigningKey } from "@bondedhq/shared";

/**
 * Bonded's side of Agent URL signatures, for tests: one key for every gateway in a test file, and
 * the wallet test agents belong to (calls are signed for it, and the agents check that).
 */
export const TEST_SIGNER = await agentUrlSigner(await newAgentUrlSigningKey());
export const TEST_KEYS = TEST_SIGNER.keySet().keys;
export const OWNER = "0x00000000000000000000000000000000000a11ce";
export const MALLORY = "0x000000000000000000000000000000000000bad0";
