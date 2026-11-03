// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {GateAnchor} from "../src/GateAnchor.sol";

contract GateAnchorTest is Test {
    GateAnchor internal anchor;
    address internal owner = makeAddr("owner");
    address internal poster = makeAddr("poster");
    address internal stranger = makeAddr("stranger");
    bytes16 internal constant ACCOUNT = bytes16(0x0b5e7c1a2f3d4e5f8a9b1c2d3e4f5a6b);
    bytes32 internal constant MANDATE = keccak256("mandate v1");
    bytes32 internal constant ROOT = keccak256("root");
    /// 2026-11-02 as a Unix day number.
    uint32 internal constant DAY = 20_759;
    /// `gateLogRoot` of keccak256("receipt a"), ("receipt b") and ("receipt c").
    bytes32 internal constant ROOT_ABC =
        0x95bb38e2b18256453824ab978b374e9660ccba0d7f130a959ffd7cbb17b31326;

    event PosterSet(address indexed poster, bool allowed);
    event MandatePosted(
        bytes16 indexed account, uint64 indexed version, bytes32 mandateHash, address indexed poster
    );
    event LogRootPosted(
        bytes16 indexed account, uint32 indexed day, bytes32 root, address indexed poster
    );

    function setUp() public {
        anchor = new GateAnchor(owner);
        vm.prank(owner);
        anchor.setPoster(poster, true);
        vm.warp(uint256(DAY + 1) * 1 days + 600); // ten minutes into the next day
    }

    function test_OnlyTheOwnerSetsPosters() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger)
        );
        anchor.setPoster(stranger, true);

        vm.expectEmit(true, false, false, true);
        emit PosterSet(stranger, true);
        vm.prank(owner);
        anchor.setPoster(stranger, true);
        assertTrue(anchor.isPoster(stranger));

        vm.prank(owner);
        anchor.setPoster(stranger, false);
        assertFalse(anchor.isPoster(stranger));

        vm.prank(owner);
        vm.expectRevert(GateAnchor.ZeroAddress.selector);
        anchor.setPoster(address(0), true);
    }

    function test_OnlyPostersPost() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(GateAnchor.NotPoster.selector, stranger));
        anchor.postMandate(ACCOUNT, 1, MANDATE);
        vm.expectRevert(abi.encodeWithSelector(GateAnchor.NotPoster.selector, stranger));
        anchor.postLogRoot(ACCOUNT, DAY, ROOT);
        vm.stopPrank();

        // A removed poster stops at once.
        vm.prank(owner);
        anchor.setPoster(poster, false);
        vm.prank(poster);
        vm.expectRevert(abi.encodeWithSelector(GateAnchor.NotPoster.selector, poster));
        anchor.postMandate(ACCOUNT, 1, MANDATE);
    }

    function test_PostsAMandateVersionOnceWithAnEvent() public {
        vm.expectEmit(true, true, true, true);
        emit MandatePosted(ACCOUNT, 1, MANDATE, poster);
        vm.prank(poster);
        anchor.postMandate(ACCOUNT, 1, MANDATE);

        GateAnchor.Posted memory p = anchor.mandateHashOf(ACCOUNT, 1);
        assertEq(p.hash, MANDATE);
        assertEq(p.postedAt, block.timestamp);
        assertEq(anchor.mandateHashOf(ACCOUNT, 2).hash, bytes32(0));

        vm.prank(poster);
        vm.expectRevert(
            abi.encodeWithSelector(GateAnchor.MandateAlreadyPosted.selector, ACCOUNT, uint64(1))
        );
        anchor.postMandate(ACCOUNT, 1, keccak256("a different mandate"));
        assertEq(anchor.mandateHashOf(ACCOUNT, 1).hash, MANDATE);

        // Another version, and the same version of another account, are separate.
        vm.startPrank(poster);
        anchor.postMandate(ACCOUNT, 2, keccak256("mandate v2"));
        anchor.postMandate(bytes16(uint128(7)), 1, MANDATE);
        vm.stopPrank();
    }

    function test_PostsADayOnceWithAnEvent() public {
        vm.expectEmit(true, true, true, true);
        emit LogRootPosted(ACCOUNT, DAY, ROOT, poster);
        vm.prank(poster);
        anchor.postLogRoot(ACCOUNT, DAY, ROOT);

        GateAnchor.Posted memory p = anchor.logRootOf(ACCOUNT, DAY);
        assertEq(p.hash, ROOT);
        assertEq(p.postedAt, block.timestamp);
        assertEq(anchor.logRootOf(ACCOUNT, DAY - 1).hash, bytes32(0));

        vm.prank(poster);
        vm.expectRevert(
            abi.encodeWithSelector(GateAnchor.LogRootAlreadyPosted.selector, ACCOUNT, DAY)
        );
        anchor.postLogRoot(ACCOUNT, DAY, keccak256("rewritten"));
        assertEq(anchor.logRootOf(ACCOUNT, DAY).hash, ROOT);
    }

    function test_RefusesADayThatHasNotEnded() public {
        uint32 today = uint32(block.timestamp / 1 days);
        vm.startPrank(poster);
        vm.expectRevert(abi.encodeWithSelector(GateAnchor.DayNotOver.selector, today));
        anchor.postLogRoot(ACCOUNT, today, ROOT);
        vm.expectRevert(abi.encodeWithSelector(GateAnchor.DayNotOver.selector, today + 1));
        anchor.postLogRoot(ACCOUNT, today + 1, ROOT);
        anchor.postLogRoot(ACCOUNT, today - 1, ROOT);
        vm.stopPrank();
    }

    function test_RefusesEmptyValues() public {
        vm.startPrank(poster);
        vm.expectRevert(GateAnchor.ZeroAccount.selector);
        anchor.postMandate(bytes16(0), 1, MANDATE);
        vm.expectRevert(GateAnchor.ZeroVersion.selector);
        anchor.postMandate(ACCOUNT, 0, MANDATE);
        vm.expectRevert(GateAnchor.ZeroHash.selector);
        anchor.postMandate(ACCOUNT, 1, bytes32(0));
        vm.expectRevert(GateAnchor.ZeroAccount.selector);
        anchor.postLogRoot(bytes16(0), DAY, ROOT);
        vm.expectRevert(GateAnchor.ZeroHash.selector);
        anchor.postLogRoot(ACCOUNT, DAY, bytes32(0));
        vm.stopPrank();
    }

    /// Three receipts, as `gateLogRoot` builds them: the first two paired, the third carried up,
    /// and the count sealed in.
    function test_VerifiesAReceiptInThePostedRoot() public {
        bytes32[3] memory receipts =
            [keccak256("receipt a"), keccak256("receipt b"), keccak256("receipt c")];
        bytes32 a = anchor.receiptLeaf(receipts[0]);
        bytes32 b = anchor.receiptLeaf(receipts[1]);
        bytes32 c = anchor.receiptLeaf(receipts[2]);
        bytes32 ab = keccak256(bytes.concat(a, b));
        bytes32 root = keccak256(abi.encode(uint256(3), keccak256(bytes.concat(ab, c))));
        // The same root `gateLogRoot` gives (packages/shared/test/gate-log.test.ts).
        assertEq(root, ROOT_ABC);

        bytes32[] memory proofA = new bytes32[](2);
        proofA[0] = b;
        proofA[1] = c;
        bytes32[] memory proofB = new bytes32[](2);
        proofB[0] = a;
        proofB[1] = c;
        bytes32[] memory proofC = new bytes32[](1);
        proofC[0] = ab;

        // Nothing is posted yet.
        assertFalse(anchor.verifyReceipt(ACCOUNT, DAY, receipts[0], 0, 3, proofA));

        vm.prank(poster);
        anchor.postLogRoot(ACCOUNT, DAY, root);
        assertTrue(anchor.verifyReceipt(ACCOUNT, DAY, receipts[0], 0, 3, proofA));
        assertTrue(anchor.verifyReceipt(ACCOUNT, DAY, receipts[1], 1, 3, proofB));
        assertTrue(anchor.verifyReceipt(ACCOUNT, DAY, receipts[2], 2, 3, proofC));
        // A receipt that isn't in the day, or the wrong proof, day, place or count, fails.
        assertFalse(anchor.verifyReceipt(ACCOUNT, DAY, keccak256("receipt d"), 0, 3, proofA));
        assertFalse(anchor.verifyReceipt(ACCOUNT, DAY, receipts[1], 2, 3, proofC));
        assertFalse(anchor.verifyReceipt(ACCOUNT, DAY - 1, receipts[0], 0, 3, proofA));
        assertFalse(anchor.verifyReceipt(ACCOUNT, DAY, receipts[0], 1, 3, proofA));
        assertFalse(anchor.verifyReceipt(ACCOUNT, DAY, receipts[0], 0, 4, proofA));
        assertFalse(anchor.verifyReceipt(ACCOUNT, DAY, receipts[0], 3, 3, proofA));
        assertFalse(anchor.verifyReceipt(ACCOUNT, DAY, receipts[0], 0, 0, proofA));
        // Too few or too many siblings.
        assertFalse(anchor.verifyReceipt(ACCOUNT, DAY, receipts[2], 2, 3, new bytes32[](0)));
        assertFalse(anchor.verifyReceipt(ACCOUNT, DAY, receipts[2], 2, 3, proofA));
        // An inner node can't pass for a receipt.
        bytes32[] memory proofInner = new bytes32[](1);
        proofInner[0] = c;
        assertFalse(anchor.verifyReceipt(ACCOUNT, DAY, ab, 0, 2, proofInner));
    }

    function test_OwnershipMovesInTwoSteps() public {
        address next = makeAddr("multisig");
        vm.prank(owner);
        anchor.transferOwnership(next);
        assertEq(anchor.owner(), owner);
        vm.prank(next);
        anchor.acceptOwnership();
        assertEq(anchor.owner(), next);
    }
}
