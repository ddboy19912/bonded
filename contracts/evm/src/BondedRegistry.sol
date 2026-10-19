// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {
    ERC721URIStorage
} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {BondedTypes} from "./libraries/BondedTypes.sol";
import {IBondedRegistry} from "./interfaces/IBondedRegistry.sol";

/// @title BondedRegistry
/// @notice Agent identities and Bonded Scores. See docs/SPECIFICATION.md Sections 6.2 and 6.4, and ADR-004.
/// @dev ERC-8004-aligned:
///      - Identity follows the ERC-8004 IdentityRegistry shape: agents are ERC-721 tokens,
///        `register(...)` mints one to the caller (the operator), the token URI points to the
///        agent's registration file, and agents carry key/value metadata.
///      - Scores are posted as EIP-712 attestations signed by an attester, so anyone (usually
///        the keeper) can relay the same signed score to every chain. Each posted score is also
///        emitted as an ERC-8004-style `ValidationResponse` (response = score 0-100).
///      On chains with a canonical ERC-8004 registry, an agent can link it via metadata.
contract BondedRegistry is IBondedRegistry, ERC721URIStorage, EIP712, Ownable2Step {
    struct MetadataEntry {
        string key;
        bytes value;
    }

    uint256 private _nextAgentId = 1;
    mapping(address signer => bool) private _attesters;
    mapping(uint256 agentId => BondedTypes.Attestation) private _scores;
    mapping(uint256 agentId => mapping(string key => bytes value)) private _metadata;

    event Registered(uint256 indexed agentId, string tokenURI, address indexed owner);
    event MetadataSet(uint256 indexed agentId, string indexed indexedKey, string key, bytes value);
    event ValidationRequest(
        address indexed validatorAddress,
        uint256 indexed agentId,
        string requestURI,
        bytes32 indexed requestHash
    );
    event ValidationResponse(
        address indexed validatorAddress,
        uint256 indexed agentId,
        bytes32 indexed requestHash,
        uint8 response,
        string responseURI,
        bytes32 responseHash,
        string tag
    );
    event ScorePosted(
        uint256 indexed agentId,
        address indexed attester,
        uint16 score,
        uint16 securityScore,
        uint32 expectedLossBps,
        uint8 modelFamily,
        uint64 issuedAt,
        uint64 expiresAt
    );
    event AttesterSet(address indexed attester, bool allowed);

    error ZeroAddress();
    error UnknownAgent(uint256 agentId);
    error NotAgentOwner();
    error NotAttester(address signer);
    error InvalidScore();
    error ScoreExpired();
    error StaleScore(uint64 issuedAt, uint64 currentIssuedAt);

    constructor(address owner_)
        ERC721("Bonded Agents", "BAGENT")
        EIP712(BondedTypes.EIP712_NAME, BondedTypes.EIP712_VERSION)
        Ownable(owner_)
    {}

    // ---------------------------------------------------------------------------------------
    // Identity (ERC-8004 IdentityRegistry shape)
    // ---------------------------------------------------------------------------------------

    function register() external returns (uint256 agentId) {
        agentId = _register("");
    }

    function register(string calldata agentUri) external returns (uint256 agentId) {
        agentId = _register(agentUri);
    }

    function register(string calldata agentUri, MetadataEntry[] calldata metadata)
        external
        returns (uint256 agentId)
    {
        agentId = _register(agentUri);
        for (uint256 i; i < metadata.length; ++i) {
            _setMetadata(agentId, metadata[i].key, metadata[i].value);
        }
    }

    function setAgentURI(uint256 agentId, string calldata agentUri) external {
        _checkOwner(agentId);
        _setTokenURI(agentId, agentUri);
    }

    function setMetadata(uint256 agentId, string calldata key, bytes calldata value) external {
        _checkOwner(agentId);
        _setMetadata(agentId, key, value);
    }

    function getMetadata(uint256 agentId, string calldata key)
        external
        view
        returns (bytes memory)
    {
        return _metadata[agentId][key];
    }

    // ---------------------------------------------------------------------------------------
    // Scores
    // ---------------------------------------------------------------------------------------

    /// @notice Asks a validator (the Bonded Arena attester) to rate the agent. Owner only.
    /// @dev Signal only: the Arena watches this event. The rating arrives through `postScore`.
    function validationRequest(
        address validatorAddress,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external {
        _checkOwner(agentId);
        emit ValidationRequest(validatorAddress, agentId, requestURI, requestHash);
    }

    /// @notice Posts a signed score. Anyone can relay it; only attester signatures count.
    /// @dev Scores must be unexpired and newer than the one they replace, so an old (possibly
    ///      better) score can't be replayed over a fresh one.
    function postScore(BondedTypes.Attestation calldata attestation, bytes calldata signature)
        external
    {
        if (_ownerOf(attestation.agentId) == address(0)) revert UnknownAgent(attestation.agentId);
        if (attestation.score > 100 || attestation.securityScore > 100) revert InvalidScore();
        if (attestation.expiresAt <= attestation.issuedAt) revert InvalidScore();
        if (block.timestamp >= attestation.expiresAt) revert ScoreExpired();
        uint64 current = _scores[attestation.agentId].issuedAt;
        if (attestation.issuedAt <= current) revert StaleScore(attestation.issuedAt, current);

        bytes32 digest = attestationDigest(attestation);
        address signer = ECDSA.recover(digest, signature);
        if (!_attesters[signer]) revert NotAttester(signer);

        _scores[attestation.agentId] = attestation;
        emit ScorePosted(
            attestation.agentId,
            signer,
            attestation.score,
            attestation.securityScore,
            attestation.expectedLossBps,
            attestation.modelFamily,
            attestation.issuedAt,
            attestation.expiresAt
        );
        // The public ERC-8004 signal is the security grade (the headline Bonded Score); the
        // loss-based `score` stays in storage for insurability and pricing.
        emit ValidationResponse(
            signer,
            attestation.agentId,
            digest,
            uint8(attestation.securityScore), // <= 100, checked above
            "",
            attestation.reportHash,
            "bonded-security-score"
        );
    }

    /// @inheritdoc IBondedRegistry
    function scoreOf(uint256 agentId) external view returns (BondedTypes.Attestation memory) {
        return _scores[agentId];
    }

    /// @inheritdoc IBondedRegistry
    function hasValidScore(uint256 agentId) external view returns (bool) {
        BondedTypes.Attestation storage a = _scores[agentId];
        return a.issuedAt != 0 && block.timestamp < a.expiresAt;
    }

    /// @notice EIP-712 digest of an attestation for this registry (what the attester signs).
    function attestationDigest(BondedTypes.Attestation calldata attestation)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(BondedTypes.hashAttestation(attestation));
    }

    // ---------------------------------------------------------------------------------------
    // Attesters
    // ---------------------------------------------------------------------------------------

    function setAttester(address attester, bool allowed) external onlyOwner {
        if (attester == address(0)) revert ZeroAddress();
        _attesters[attester] = allowed;
        emit AttesterSet(attester, allowed);
    }

    /// @inheritdoc IBondedRegistry
    function isAttester(address signer) external view returns (bool) {
        return _attesters[signer];
    }

    /// @inheritdoc IBondedRegistry
    function agentOwner(uint256 agentId) external view returns (address) {
        return _ownerOf(agentId);
    }

    function totalAgents() external view returns (uint256) {
        return _nextAgentId - 1;
    }

    // ---------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------

    function _register(string memory agentUri) internal returns (uint256 agentId) {
        agentId = _nextAgentId++;
        _safeMint(msg.sender, agentId);
        if (bytes(agentUri).length > 0) _setTokenURI(agentId, agentUri);
        emit Registered(agentId, agentUri, msg.sender);
    }

    function _setMetadata(uint256 agentId, string memory key, bytes memory value) internal {
        _metadata[agentId][key] = value;
        emit MetadataSet(agentId, key, key, value);
    }

    function _checkOwner(uint256 agentId) internal view {
        address owner = _ownerOf(agentId);
        if (owner == address(0)) revert UnknownAgent(agentId);
        if (owner != msg.sender) revert NotAgentOwner();
    }
}
