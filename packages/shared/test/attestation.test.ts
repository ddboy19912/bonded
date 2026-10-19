import { hashStruct, hashTypedData, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  ATTESTATION_TYPE_STRING,
  ATTESTATION_TYPEHASH,
  Attestation,
  ATTESTATION_TYPES,
  QUOTE_TYPES,
  QUOTE_TYPE_STRING,
  QUOTE_TYPEHASH,
  attestationMessage,
  attestationTypedData,
  bondedDomain,
  quoteMessage,
  quoteTypedData,
  type Quote,
} from "../src/index.js";

// Well-known Anvil test key #0. Never holds real funds.
const attester = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const registry = "0x5555555555555555555555555555555555555555";
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;

const attestation: Attestation = {
  agentId: "42",
  score: 96,
  securityScore: 90,
  expectedLossBps: 30,
  reportHash: hash(1),
  mandateHash: hash(2),
  codeHash: hash(3),
  teeMeasurement: hash(0),
  modelFamily: "anthropic-claude",
  issuedAt: 1_790_000_000,
  expiresAt: 1_792_592_000,
};

const quote: Quote = {
  agentId: "42",
  vault: "0x6666666666666666666666666666666666666666",
  coverAmount: "100000000000",
  premiumRateBps: 120,
  score: 96,
  modelFamily: "anthropic-claude",
  mandateHash: hash(2),
  reportHash: hash(1),
  minBond: "10000000000",
  expiresAt: 1_790_086_400,
  nonce: "1",
};

describe("EIP-712 type strings", () => {
  // These literals are duplicated in contracts/evm/test/BondedTypes.t.sol.
  it("match the strings the Solidity typehashes use", () => {
    expect(ATTESTATION_TYPE_STRING).toBe(
      "Attestation(uint256 agentId,uint16 score,uint16 securityScore,uint32 expectedLossBps,bytes32 reportHash,bytes32 mandateHash,bytes32 codeHash,bytes32 teeMeasurement,uint8 modelFamily,uint64 issuedAt,uint64 expiresAt)",
    );
    expect(QUOTE_TYPE_STRING).toBe(
      "Quote(uint256 agentId,address vault,uint256 coverAmount,uint32 premiumRateBps,uint16 score,uint8 modelFamily,bytes32 mandateHash,bytes32 reportHash,uint256 minBond,uint64 expiresAt,uint256 nonce)",
    );
    expect(ATTESTATION_TYPEHASH).toBe(
      "0x047f40647bc853acdc6f48ec8ccc7a20a30ac0c6c74367542d3ffc1f49175b74",
    );
    expect(QUOTE_TYPEHASH).toBe(
      "0x77aa80c26f664e0586b9e93f383edc272af05d2cd2ddf13ee5e7597ebe314fcc",
    );
  });

  // Same expected values as contracts/evm/test/BondedTypes.t.sol.
  it("produce the struct hashes Solidity expects", () => {
    expect(
      hashStruct({
        data: attestationMessage(attestation),
        primaryType: "Attestation",
        types: ATTESTATION_TYPES,
      }),
    ).toBe("0x685a3dea4f32925fdd04ec3467510d9914fdd03bdd5067940ce449a98d857e5e");
    expect(
      hashStruct({ data: quoteMessage(quote), primaryType: "Quote", types: QUOTE_TYPES }),
    ).toBe("0xdad36c5fd409fde62c1bec61b5ce3eafb81d2631b5e1e0eb7f3084ef519ff7ff");
  });
});

describe("Attestation", () => {
  it("rejects expiry before issue time", () => {
    expect(Attestation.safeParse({ ...attestation, expiresAt: attestation.issuedAt }).success).toBe(
      false,
    );
  });

  it("rejects scores above 100", () => {
    expect(Attestation.safeParse({ ...attestation, score: 101 }).success).toBe(false);
  });

  it("round-trips a signature to the attester address", async () => {
    const typed = attestationTypedData(bondedDomain(46630, registry), attestation);
    const signature = await attester.signTypedData(typed);
    expect(await recoverTypedDataAddress({ ...typed, signature })).toBe(attester.address);
  });

  it("binds the signature to the chain", async () => {
    const onRobinhood = hashTypedData(
      attestationTypedData(bondedDomain(46630, registry), attestation),
    );
    const onArbitrum = hashTypedData(
      attestationTypedData(bondedDomain(421614, registry), attestation),
    );
    expect(onRobinhood).not.toBe(onArbitrum);
  });
});

describe("Quote", () => {
  // Same expected digest as test_QuoteDigestMatchesTypeScript in contracts/evm/test/CoverManager.t.sol,
  // where CoverManager is deployed at this address on chain 31337.
  it("produces the digest CoverManager expects", () => {
    const domain = bondedDomain(31337, "0x0000000000000000000000000000000000001234");
    expect(hashTypedData(quoteTypedData(domain, quote))).toBe(
      "0x01be0f221106d2450c0f8547deae4a5c5f116de1d04f81e2863e7bc06ce72177",
    );
  });

  it("round-trips a signature to the attester address", async () => {
    const typed = quoteTypedData(bondedDomain(46630, registry), quote);
    const signature = await attester.signTypedData(typed);
    expect(await recoverTypedDataAddress({ ...typed, signature })).toBe(attester.address);
  });
});
