// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BondedTypes} from "../src/libraries/BondedTypes.sol";

/// @notice Pins the EIP-712 encoding to the TypeScript side (packages/shared).
/// @dev The expected hashes were produced by viem from the same fixtures used in
///      packages/shared/test/attestation.test.ts. If either side changes, both tests fail.
contract BondedTypesTest is Test {
    bytes32 constant EXPECTED_ATTESTATION_TYPEHASH =
        0x047f40647bc853acdc6f48ec8ccc7a20a30ac0c6c74367542d3ffc1f49175b74;
    bytes32 constant EXPECTED_QUOTE_TYPEHASH =
        0x77aa80c26f664e0586b9e93f383edc272af05d2cd2ddf13ee5e7597ebe314fcc;
    bytes32 constant EXPECTED_ATTESTATION_STRUCT_HASH =
        0x685a3dea4f32925fdd04ec3467510d9914fdd03bdd5067940ce449a98d857e5e;
    bytes32 constant EXPECTED_QUOTE_STRUCT_HASH =
        0xdad36c5fd409fde62c1bec61b5ce3eafb81d2631b5e1e0eb7f3084ef519ff7ff;

    function test_TypehashesMatchTypeScript() public pure {
        assertEq(BondedTypes.ATTESTATION_TYPEHASH, EXPECTED_ATTESTATION_TYPEHASH);
        assertEq(BondedTypes.QUOTE_TYPEHASH, EXPECTED_QUOTE_TYPEHASH);
    }

    function test_AttestationStructHashMatchesTypeScript() public pure {
        BondedTypes.Attestation memory a = BondedTypes.Attestation({
            agentId: 42,
            score: 96,
            securityScore: 90,
            expectedLossBps: 30,
            reportHash: bytes32(uint256(1)),
            mandateHash: bytes32(uint256(2)),
            codeHash: bytes32(uint256(3)),
            teeMeasurement: bytes32(0),
            modelFamily: 1, // anthropic-claude
            issuedAt: 1_790_000_000,
            expiresAt: 1_792_592_000
        });
        assertEq(BondedTypes.hashAttestation(a), EXPECTED_ATTESTATION_STRUCT_HASH);
    }

    function test_QuoteStructHashMatchesTypeScript() public pure {
        BondedTypes.Quote memory q = BondedTypes.Quote({
            agentId: 42,
            vault: 0x6666666666666666666666666666666666666666,
            coverAmount: 100_000_000_000,
            premiumRateBps: 120,
            score: 96,
            modelFamily: 1,
            mandateHash: bytes32(uint256(2)),
            reportHash: bytes32(uint256(1)),
            minBond: 10_000_000_000,
            expiresAt: 1_790_086_400,
            nonce: 1
        });
        assertEq(BondedTypes.hashQuote(q), EXPECTED_QUOTE_STRUCT_HASH);
    }

    function test_EnumCodesMatchTypeScript() public pure {
        assertEq(uint8(BondedTypes.MandateMode.Monitor), 0);
        assertEq(uint8(BondedTypes.MandateMode.Enforce), 1);
        assertEq(uint8(BondedTypes.BreachType.UnauthorizedTarget), 0);
        assertEq(uint8(BondedTypes.BreachType.UnauthorizedApproval), 1);
        assertEq(uint8(BondedTypes.BreachType.UnauthorizedTransfer), 2);
        assertEq(uint8(BondedTypes.BreachType.Deferred), 3);
        assertEq(uint8(BondedTypes.BreachType.Limit), 4);
        assertEq(uint8(BondedTypes.BreachType.Asset), 5);
    }

    /// @dev Mirrors TIER_RULES in packages/shared/src/tiers.ts (tested there too).
    function test_TierRulesMatchTypeScript() public pure {
        _assertTier(100, true, 1000, 1000); // AAA
        _assertTier(60, true, 1000, 1000); // BBB lower bound
        _assertTier(59, true, 2000, 1000); // BB
        _assertTier(45, true, 2000, 1000);
        _assertTier(44, true, 3000, 200); // B
        _assertTier(25, true, 3000, 200);
        _assertTier(24, false, 0, 0); // CCC
        _assertTier(0, false, 0, 0);
    }

    function _assertTier(uint16 score, bool insurable, uint16 minBondBps, uint16 maxCoverBps)
        internal
        pure
    {
        (bool i, uint16 b, uint16 c) = BondedTypes.tierRule(score);
        assertEq(i, insurable);
        assertEq(b, minBondBps);
        assertEq(c, maxCoverBps);
    }
}
