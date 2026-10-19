import { keccak256, stringToBytes, type TypedDataDomain } from "viem";
import { z } from "zod";
import { bytes32, evmAddress, uintString, unixSeconds } from "./common.js";

/**
 * Signed messages from the Arena's attester. See docs/SPECIFICATION.md Section 6.4.
 * Attestations are posted to every chain's BondedRegistry; quotes are accepted by CoverManager.
 * The EIP-712 type strings below must match the Solidity typehashes in `BondedTypes.sol`.
 */

/** Model family of the agent's brain, used for correlation caps. Codes are uint8 on-chain. */
export const ModelFamily = z.enum([
  "unknown",
  "anthropic-claude",
  "openai-gpt",
  "google-gemini",
  "meta-llama",
  "mistral",
  "deepseek",
  "qwen",
  "xai-grok",
  "decision-model",
  "other",
]);
export type ModelFamily = z.infer<typeof ModelFamily>;

export const MODEL_FAMILY_CODE: Record<ModelFamily, number> = {
  unknown: 0,
  "anthropic-claude": 1,
  "openai-gpt": 2,
  "google-gemini": 3,
  "meta-llama": 4,
  mistral: 5,
  deepseek: 6,
  qwen: 7,
  "xai-grok": 8,
  /** Typed decision models such as Laya or Jev. */
  "decision-model": 9,
  other: 255,
};

export const ZERO_BYTES32 = `0x${"0".repeat(64)}` as const;

export const Attestation = z
  .object({
    agentId: uintString,
    /** The loss-based insurance score, 0–100: drives insurability, bond and cover, and pricing. */
    score: z.number().int().min(0).max(100),
    /** The public security grade (susceptibility), 0–100: the headline Bonded Score. */
    securityScore: z.number().int().min(0).max(100),
    /** Expected annual loss as a fraction of cover, in basis points. */
    expectedLossBps: z.number().int().min(0).max(10_000),
    /** Hash of the full Arena report. */
    reportHash: bytes32,
    /** Hash of the mandate the agent was rated under. */
    mandateHash: bytes32,
    /** Hash of the agent's code/config version that was rated. */
    codeHash: bytes32,
    /** TEE measurement of the running agent, or zero when not in a TEE. */
    teeMeasurement: bytes32.default(ZERO_BYTES32),
    modelFamily: ModelFamily,
    issuedAt: unixSeconds,
    expiresAt: unixSeconds,
  })
  .refine((a) => a.expiresAt > a.issuedAt, {
    message: "expiresAt must be after issuedAt",
    path: ["expiresAt"],
  });
export type Attestation = z.infer<typeof Attestation>;

export const Quote = z.object({
  agentId: uintString,
  vault: evmAddress,
  /** Cover amount in base-asset units (USDC has 6 decimals). */
  coverAmount: uintString,
  /** Annual premium rate in basis points of cover. */
  premiumRateBps: z.number().int().min(0).max(10_000),
  score: z.number().int().min(0).max(100),
  modelFamily: ModelFamily,
  mandateHash: bytes32,
  reportHash: bytes32,
  /** Minimum operator bond in base-asset units. */
  minBond: uintString,
  expiresAt: unixSeconds,
  nonce: uintString,
});
export type Quote = z.infer<typeof Quote>;

export const EIP712_DOMAIN_NAME = "Bonded";
export const EIP712_DOMAIN_VERSION = "1";

export function bondedDomain(chainId: number, verifyingContract: `0x${string}`): TypedDataDomain {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId,
    verifyingContract,
  };
}

export const ATTESTATION_TYPES = {
  Attestation: [
    { name: "agentId", type: "uint256" },
    { name: "score", type: "uint16" },
    { name: "securityScore", type: "uint16" },
    { name: "expectedLossBps", type: "uint32" },
    { name: "reportHash", type: "bytes32" },
    { name: "mandateHash", type: "bytes32" },
    { name: "codeHash", type: "bytes32" },
    { name: "teeMeasurement", type: "bytes32" },
    { name: "modelFamily", type: "uint8" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export const QUOTE_TYPES = {
  Quote: [
    { name: "agentId", type: "uint256" },
    { name: "vault", type: "address" },
    { name: "coverAmount", type: "uint256" },
    { name: "premiumRateBps", type: "uint32" },
    { name: "score", type: "uint16" },
    { name: "modelFamily", type: "uint8" },
    { name: "mandateHash", type: "bytes32" },
    { name: "reportHash", type: "bytes32" },
    { name: "minBond", type: "uint256" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/** The EIP-712 type strings. Solidity typehashes are keccak256 of these exact strings. */
export const ATTESTATION_TYPE_STRING = encodeTypeString(
  "Attestation",
  ATTESTATION_TYPES.Attestation,
);
export const QUOTE_TYPE_STRING = encodeTypeString("Quote", QUOTE_TYPES.Quote);
export const ATTESTATION_TYPEHASH = keccak256(stringToBytes(ATTESTATION_TYPE_STRING));
export const QUOTE_TYPEHASH = keccak256(stringToBytes(QUOTE_TYPE_STRING));

function encodeTypeString(name: string, fields: readonly { name: string; type: string }[]): string {
  return `${name}(${fields.map((field) => `${field.type} ${field.name}`).join(",")})`;
}

/** Converts a validated attestation into the message shape viem signs. */
export function attestationMessage(input: Attestation) {
  const a = Attestation.parse(input);
  return {
    agentId: BigInt(a.agentId),
    score: a.score,
    securityScore: a.securityScore,
    expectedLossBps: a.expectedLossBps,
    reportHash: a.reportHash,
    mandateHash: a.mandateHash,
    codeHash: a.codeHash,
    teeMeasurement: a.teeMeasurement,
    modelFamily: MODEL_FAMILY_CODE[a.modelFamily],
    issuedAt: BigInt(a.issuedAt),
    expiresAt: BigInt(a.expiresAt),
  };
}

/** Converts a validated quote into the message shape viem signs. */
export function quoteMessage(input: Quote) {
  const q = Quote.parse(input);
  return {
    agentId: BigInt(q.agentId),
    vault: q.vault,
    coverAmount: BigInt(q.coverAmount),
    premiumRateBps: q.premiumRateBps,
    score: q.score,
    modelFamily: MODEL_FAMILY_CODE[q.modelFamily],
    mandateHash: q.mandateHash,
    reportHash: q.reportHash,
    minBond: BigInt(q.minBond),
    expiresAt: BigInt(q.expiresAt),
    nonce: BigInt(q.nonce),
  };
}

/** Full typed-data payload for signing or verifying an attestation with viem. */
export function attestationTypedData(domain: TypedDataDomain, attestation: Attestation) {
  return {
    domain,
    types: ATTESTATION_TYPES,
    primaryType: "Attestation" as const,
    message: attestationMessage(attestation),
  };
}

/** Full typed-data payload for signing or verifying a quote with viem. */
export function quoteTypedData(domain: TypedDataDomain, quote: Quote) {
  return {
    domain,
    types: QUOTE_TYPES,
    primaryType: "Quote" as const,
    message: quoteMessage(quote),
  };
}
