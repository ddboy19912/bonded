// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title GateAnchor
/// @notice Public record of the off-chain payment gate's hashes (apps/api/GATE.md): the hash of
///         each version of a gate account's mandate, and one log root per account per UTC day
///         over that day's signed receipts. Once posted, neither can be changed, so Bonded can't
///         rewrite a mandate or a day's decisions later without it showing.
/// @dev Separate from the protocol: it holds no money and no other contract reads it, and the
///      frozen attestation format (BondedTypes.Attestation) is untouched.
///      - A gate account is named by its UUID's 16 bytes (`gateAccountKey` in packages/shared).
///      - A day is the Unix day number (seconds since 1970 / 86,400), and only a day that has
///        ended on chain can be posted.
///      - A day's root is a Merkle tree over its receipts' EIP-712 hashes in decision order, with
///        the count bound in: keccak256(abi.encode(count, treeRoot)) (`gateLogRoot` in
///        packages/shared). It commits to every receipt, their order and their number, and
///        `verifyReceipt` checks a proof made off chain.
///      - Posters are set by the owner, like the registry's attesters: the keeper's key posts.
contract GateAnchor is Ownable2Step {
    /// @notice A posted hash and when it was posted.
    struct Posted {
        bytes32 hash;
        uint64 postedAt;
    }

    mapping(address poster => bool) private _posters;
    mapping(bytes16 account => mapping(uint64 version => Posted)) private _mandates;
    mapping(bytes16 account => mapping(uint32 day => Posted)) private _logRoots;

    event PosterSet(address indexed poster, bool allowed);
    event MandatePosted(
        bytes16 indexed account, uint64 indexed version, bytes32 mandateHash, address indexed poster
    );
    event LogRootPosted(
        bytes16 indexed account, uint32 indexed day, bytes32 root, address indexed poster
    );

    error ZeroAddress();
    error NotPoster(address caller);
    error ZeroAccount();
    error ZeroHash();
    error ZeroVersion();
    error DayNotOver(uint32 day);
    error MandateAlreadyPosted(bytes16 account, uint64 version);
    error LogRootAlreadyPosted(bytes16 account, uint32 day);

    constructor(address owner_) Ownable(owner_) {}

    modifier onlyPoster() {
        if (!_posters[msg.sender]) revert NotPoster(msg.sender);
        _;
    }

    /// @notice Allows or removes a poster. Owner only.
    function setPoster(address poster, bool allowed) external onlyOwner {
        if (poster == address(0)) revert ZeroAddress();
        _posters[poster] = allowed;
        emit PosterSet(poster, allowed);
    }

    function isPoster(address poster) external view returns (bool) {
        return _posters[poster];
    }

    /// @notice Records the hash of one version of an account's mandate. Posters only; a version
    ///         can be posted once.
    function postMandate(bytes16 account, uint64 version, bytes32 mandateHash) external onlyPoster {
        if (account == bytes16(0)) revert ZeroAccount();
        if (version == 0) revert ZeroVersion();
        if (mandateHash == bytes32(0)) revert ZeroHash();
        Posted storage p = _mandates[account][version];
        if (p.hash != bytes32(0)) revert MandateAlreadyPosted(account, version);
        p.hash = mandateHash;
        p.postedAt = uint64(block.timestamp);
        emit MandatePosted(account, version, mandateHash, msg.sender);
    }

    /// @notice Records the log root of an account's receipts for one UTC day that has ended.
    ///         Posters only; a day can be posted once.
    function postLogRoot(bytes16 account, uint32 day, bytes32 root) external onlyPoster {
        if (account == bytes16(0)) revert ZeroAccount();
        if (root == bytes32(0)) revert ZeroHash();
        if (uint256(day) >= block.timestamp / 1 days) revert DayNotOver(day);
        Posted storage p = _logRoots[account][day];
        if (p.hash != bytes32(0)) revert LogRootAlreadyPosted(account, day);
        p.hash = root;
        p.postedAt = uint64(block.timestamp);
        emit LogRootPosted(account, day, root, msg.sender);
    }

    /// @notice The posted hash of a mandate version; zero if it hasn't been posted.
    function mandateHashOf(bytes16 account, uint64 version) external view returns (Posted memory) {
        return _mandates[account][version];
    }

    /// @notice The posted receipt root of a day; zero if it hasn't been posted.
    function logRootOf(bytes16 account, uint32 day) external view returns (Posted memory) {
        return _logRoots[account][day];
    }

    /// @notice The leaf a receipt's EIP-712 hash takes in a day's tree (hashed twice, so a leaf
    ///         can never pass for an inner node).
    function receiptLeaf(bytes32 receiptHash) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(receiptHash))));
    }

    /// @notice Whether a receipt is in the root posted for its account and day, at `index` of the
    ///         day's `count` receipts, by its siblings (leaf up). False when no root is posted.
    function verifyReceipt(
        bytes16 account,
        uint32 day,
        bytes32 receiptHash,
        uint256 index,
        uint256 count,
        bytes32[] calldata siblings
    ) external view returns (bool) {
        bytes32 root = _logRoots[account][day].hash;
        if (root == bytes32(0) || count == 0 || index >= count) return false;
        bytes32 node = receiptLeaf(receiptHash);
        uint256 used;
        // A level with an odd number of nodes carries its last one up, with no sibling.
        for (uint256 n = count; n > 1; n = (n + 1) / 2) {
            if ((index ^ 1) < n) {
                if (used == siblings.length) return false;
                bytes32 sibling = siblings[used++];
                node = index % 2 == 0
                    ? keccak256(bytes.concat(node, sibling))
                    : keccak256(bytes.concat(sibling, node));
            }
            index /= 2;
        }
        return used == siblings.length && keccak256(abi.encode(count, node)) == root;
    }
}
