// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {BondedTypes} from "../src/libraries/BondedTypes.sol";
import {BondedRegistry} from "../src/BondedRegistry.sol";

contract BondedRegistryTest is Test {
    BondedRegistry internal registry;
    address internal owner = makeAddr("owner");
    address internal operator = makeAddr("operator");
    address internal attester;
    uint256 internal attesterKey;
    uint256 internal agentId;

    function setUp() public {
        vm.warp(1_790_000_000);
        (attester, attesterKey) = makeAddrAndKey("attester");
        registry = new BondedRegistry(owner);
        vm.prank(owner);
        registry.setAttester(attester, true);
        vm.prank(operator);
        agentId = registry.register("ipfs://bonded/agents/1.json");
    }

    function _attestation(uint16 score, uint64 issuedAt)
        internal
        view
        returns (BondedTypes.Attestation memory)
    {
        return BondedTypes.Attestation({
            agentId: agentId,
            score: score,
            securityScore: score,
            expectedLossBps: 30,
            reportHash: keccak256("report"),
            mandateHash: keccak256("mandate"),
            codeHash: keccak256("code v1"),
            teeMeasurement: bytes32(0),
            modelFamily: 1,
            issuedAt: issuedAt,
            expiresAt: issuedAt + 30 days
        });
    }

    function _sign(BondedTypes.Attestation memory a, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, registry.attestationDigest(a));
        return abi.encodePacked(r, s, v);
    }

    // ----- Identity ----------------------------------------------------------------------

    function test_RegistersAgentsAsTokensOwnedByTheOperator() public {
        assertEq(agentId, 1);
        assertEq(registry.ownerOf(agentId), operator);
        assertEq(registry.agentOwner(agentId), operator);
        assertEq(registry.tokenURI(agentId), "ipfs://bonded/agents/1.json");
        assertEq(registry.totalAgents(), 1);
        assertEq(registry.agentOwner(99), address(0));

        vm.prank(operator);
        uint256 second = registry.register();
        assertEq(second, 2);
    }

    function test_RegistersWithMetadata() public {
        BondedRegistry.MetadataEntry[] memory metadata = new BondedRegistry.MetadataEntry[](1);
        metadata[0] = BondedRegistry.MetadataEntry({key: "framework", value: bytes("eliza")});
        vm.prank(operator);
        uint256 id = registry.register("ipfs://x", metadata);
        assertEq(registry.getMetadata(id, "framework"), bytes("eliza"));
    }

    function test_OnlyTheOwnerUpdatesUriAndMetadata() public {
        vm.prank(operator);
        registry.setMetadata(
            agentId, "erc8004", abi.encode(uint256(11_155_111), address(0x8004), uint256(7))
        );
        vm.prank(operator);
        registry.setAgentURI(agentId, "ipfs://v2");
        assertEq(registry.tokenURI(agentId), "ipfs://v2");

        vm.startPrank(makeAddr("stranger"));
        vm.expectRevert(BondedRegistry.NotAgentOwner.selector);
        registry.setMetadata(agentId, "x", "");
        vm.expectRevert(BondedRegistry.NotAgentOwner.selector);
        registry.setAgentURI(agentId, "ipfs://evil");
        vm.expectRevert(abi.encodeWithSelector(BondedRegistry.UnknownAgent.selector, 5));
        registry.setAgentURI(5, "x");
        vm.stopPrank();
    }

    function test_OwnerCanRequestValidation() public {
        vm.expectEmit(true, true, true, true);
        emit BondedRegistry.ValidationRequest(attester, agentId, "ipfs://req", keccak256("request"));
        vm.prank(operator);
        registry.validationRequest(attester, agentId, "ipfs://req", keccak256("request"));

        vm.expectRevert(BondedRegistry.NotAgentOwner.selector);
        registry.validationRequest(attester, agentId, "ipfs://req", keccak256("request"));
    }

    // ----- Scores ------------------------------------------------------------------------

    function test_AnyoneCanRelayASignedScore() public {
        BondedTypes.Attestation memory a = _attestation(96, uint64(block.timestamp));
        bytes memory signature = _sign(a, attesterKey);

        vm.expectEmit(true, true, true, true);
        emit BondedRegistry.ValidationResponse(
            attester,
            agentId,
            registry.attestationDigest(a),
            96,
            "",
            a.reportHash,
            "bonded-security-score"
        );
        vm.prank(makeAddr("keeper"));
        registry.postScore(a, signature);

        BondedTypes.Attestation memory stored = registry.scoreOf(agentId);
        assertEq(stored.score, 96);
        assertEq(stored.codeHash, a.codeHash);
        assertTrue(registry.hasValidScore(agentId));

        vm.warp(a.expiresAt);
        assertFalse(registry.hasValidScore(agentId));
    }

    function test_PublicSecurityScoreIsIndependentOfInsuranceScore() public {
        BondedTypes.Attestation memory a = _attestation(95, uint64(block.timestamp));
        a.securityScore = 0;
        bytes memory signature = _sign(a, attesterKey);

        vm.expectEmit(true, true, true, true);
        emit BondedRegistry.ValidationResponse(
            attester,
            agentId,
            registry.attestationDigest(a),
            0,
            "",
            a.reportHash,
            "bonded-security-score"
        );
        registry.postScore(a, signature);

        BondedTypes.Attestation memory stored = registry.scoreOf(agentId);
        assertEq(stored.securityScore, 0);
        assertEq(stored.score, 95);
        assertTrue(registry.hasValidScore(agentId));
        (bool insurable, uint16 minBondBps, uint16 maxCoverBps) = BondedTypes.tierRule(stored.score);
        assertTrue(insurable);
        assertEq(minBondBps, 1000);
        assertEq(maxCoverBps, 1000);
    }

    function test_RejectsSecurityScoreAboveOneHundred() public {
        BondedTypes.Attestation memory a = _attestation(95, uint64(block.timestamp));
        a.securityScore = 101;
        bytes memory signature = _sign(a, attesterKey);

        vm.expectRevert(BondedRegistry.InvalidScore.selector);
        registry.postScore(a, signature);
        assertFalse(registry.hasValidScore(agentId));
    }

    function test_RejectsSecurityScoreTamperedAfterSigning() public {
        BondedTypes.Attestation memory a = _attestation(95, uint64(block.timestamp));
        a.securityScore = 0;
        bytes memory signature = _sign(a, attesterKey);
        a.securityScore = 100;

        vm.expectPartialRevert(BondedRegistry.NotAttester.selector);
        registry.postScore(a, signature);
        assertFalse(registry.hasValidScore(agentId));
    }

    function test_RejectsScoresFromNonAttesters() public {
        BondedTypes.Attestation memory a = _attestation(96, uint64(block.timestamp));
        (address stranger, uint256 strangerKey) = makeAddrAndKey("stranger");
        bytes memory signature = _sign(a, strangerKey);
        vm.expectRevert(abi.encodeWithSelector(BondedRegistry.NotAttester.selector, stranger));
        registry.postScore(a, signature);
    }

    function test_OlderScoresCannotReplaceNewerOnes() public {
        BondedTypes.Attestation memory fresh = _attestation(41, uint64(block.timestamp));
        registry.postScore(fresh, _sign(fresh, attesterKey));

        // A better but older score can't be replayed over the fresh one.
        BondedTypes.Attestation memory old = _attestation(96, uint64(block.timestamp - 1 days));
        bytes memory signature = _sign(old, attesterKey);
        vm.expectRevert(
            abi.encodeWithSelector(BondedRegistry.StaleScore.selector, old.issuedAt, fresh.issuedAt)
        );
        registry.postScore(old, signature);
        assertEq(registry.scoreOf(agentId).score, 41);
    }

    function test_RejectsExpiredInvalidAndUnknownScores() public {
        BondedTypes.Attestation memory a = _attestation(96, uint64(block.timestamp - 31 days));
        bytes memory signature = _sign(a, attesterKey);
        vm.expectRevert(BondedRegistry.ScoreExpired.selector);
        registry.postScore(a, signature);

        a = _attestation(101, uint64(block.timestamp));
        signature = _sign(a, attesterKey);
        vm.expectRevert(BondedRegistry.InvalidScore.selector);
        registry.postScore(a, signature);

        a = _attestation(96, uint64(block.timestamp));
        a.agentId = 77;
        signature = _sign(a, attesterKey);
        vm.expectRevert(abi.encodeWithSelector(BondedRegistry.UnknownAgent.selector, 77));
        registry.postScore(a, signature);
    }

    function test_AttesterSetIsOwnerManaged() public {
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this))
        );
        registry.setAttester(address(this), true);

        vm.prank(owner);
        registry.setAttester(attester, false);
        assertFalse(registry.isAttester(attester));

        vm.prank(owner);
        vm.expectRevert(BondedRegistry.ZeroAddress.selector);
        registry.setAttester(address(0), true);
    }

    function test_AttestationDigestUsesTheSharedStructHash() public view {
        // Same struct hash as BondedTypesTest (pinned against viem), wrapped in this registry's domain.
        BondedTypes.Attestation memory a = BondedTypes.Attestation({
            agentId: 42,
            score: 96,
            securityScore: 90,
            expectedLossBps: 30,
            reportHash: bytes32(uint256(1)),
            mandateHash: bytes32(uint256(2)),
            codeHash: bytes32(uint256(3)),
            teeMeasurement: bytes32(0),
            modelFamily: 1,
            issuedAt: 1_790_000_000,
            expiresAt: 1_792_592_000
        });
        assertEq(
            BondedTypes.hashAttestation(a),
            0x685a3dea4f32925fdd04ec3467510d9914fdd03bdd5067940ce449a98d857e5e
        );
        assertTrue(registry.attestationDigest(a) != bytes32(0));
    }
}
