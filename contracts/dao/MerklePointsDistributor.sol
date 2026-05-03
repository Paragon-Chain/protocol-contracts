// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

interface IParagonReputation {
    function addPoints(address user, uint256 amount) external;
    function setOperator(address op, bool allowed) external;
}

interface IParagonGovPower {
    function recompute(address user) external;
}

/// @title MerklePointsDistributor
/// @notice Users claim reputation points per epoch using a Merkle proof.
/// Root is set by the DAO (multisig). After minting points, we call GovPower.recompute().
contract MerklePointsDistributor is Ownable {
    IParagonReputation public reputation;
    IParagonGovPower   public govPower;

    // epoch => merkleRoot
    mapping(uint256 => bytes32) public merkleRoot;
    // epoch => user => claimed?
    mapping(uint256 => mapping(address => bool)) public claimed;

    event RootUpdated(uint256 indexed epoch, bytes32 root);
    event Claimed(uint256 indexed epoch, address indexed user, uint256 amount, address caller);
    event ReputationSet(address indexed rep);
    event GovPowerSet(address indexed gov);

    constructor(address initialOwner, address _reputation, address _govPower) Ownable(initialOwner) {
        reputation = IParagonReputation(_reputation);
        govPower   = IParagonGovPower(_govPower);
        emit ReputationSet(_reputation);
        emit GovPowerSet(_govPower);
    }

    function setReputation(address _reputation) external onlyOwner {
        reputation = IParagonReputation(_reputation);
        emit ReputationSet(_reputation);
    }

    function setGovPower(address _govPower) external onlyOwner {
        govPower = IParagonGovPower(_govPower);
        emit GovPowerSet(_govPower);
    }

    /// @notice Set or update the Merkle root for an epoch.
    function setRoot(uint256 epoch, bytes32 root) external onlyOwner {
        merkleRoot[epoch] = root;
        emit RootUpdated(epoch, root);
    }

    /// @notice Claim for yourself.
    function claim(uint256 epoch, uint256 amount, bytes32[] calldata proof) external {
        _claimTo(epoch, msg.sender, amount, proof, msg.sender);
    }

    /// @notice Relayed claim (sponsoring gas, etc.)
    function claimFor(
        uint256 epoch,
        address account,
        uint256 amount,
        bytes32[] calldata proof,
        address receiver
    ) external {
        _claimTo(epoch, account, amount, proof, receiver);
    }

    function _claimTo(
        uint256 epoch,
        address account,
        uint256 amount,
        bytes32[] calldata proof,
        address receiver
    ) internal {
        require(!claimed[epoch][account], "already claimed");
        bytes32 root = merkleRoot[epoch];
        require(root != bytes32(0), "root not set");

        // leaf = keccak256(abi.encodePacked(account, amount))
        bytes32 leaf = keccak256(abi.encodePacked(account, amount));
        require(MerkleProof.verify(proof, root, leaf), "bad proof");

        claimed[epoch][account] = true;

        // Mint points → refresh voting power
        reputation.addPoints(receiver, amount);
        try govPower.recompute(receiver) {} catch {}

        emit Claimed(epoch, receiver, amount, msg.sender);
    }
}
