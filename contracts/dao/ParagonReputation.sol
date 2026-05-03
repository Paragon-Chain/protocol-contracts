// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @title ParagonReputation — Non-transferable “DAO XP” ledger with activity timestamp
/// @notice Operators (backend, quest systems) can add/subtract points. Read-only for other contracts/UIs.
///         Tracks lastEarnedAt(user) so voting power can decay after inactivity.
contract ParagonReputation is Ownable {
    mapping(address => uint256) public points;
    mapping(address => bool)    public operators;

    /// Timestamp of the last time the user's *effective* points were earned/credited (or activity poked).
    mapping(address => uint256) public lastEarnedAt;

    event OperatorUpdated(address indexed operator, bool allowed);
    event PointsAdded(address indexed user, uint256 amount, bytes32 ref);
    event PointsRemoved(address indexed user, uint256 amount);
    event PointsSet(address indexed user, uint256 amount);
    event ActivityPoked(address indexed user, uint256 timestamp);

    constructor(address initialOwner) Ownable(initialOwner) {}

    modifier onlyOperator() {
        require(operators[msg.sender], "Reputation: not operator");
        _;
    }

    function setOperator(address op, bool allowed) external onlyOwner {
        operators[op] = allowed;
        emit OperatorUpdated(op, allowed);
    }

    /// v1 add (backward compatible)
    function addPoints(address user, uint256 amount) external onlyOperator {
        _addPoints(user, amount, bytes32(0));
    }

    /// v2 add with reference (preferred by ReputationOperator)
    function addPoints(address user, uint256 amount, bytes32 ref) external onlyOperator {
        _addPoints(user, amount, ref);
    }

    function _addPoints(address user, uint256 amount, bytes32 ref) internal {
        if (amount == 0) {
            // pure activity "tick" can be done via pokeActivity()
            return;
        }
        points[user] += amount;
        lastEarnedAt[user] = block.timestamp;
        emit PointsAdded(user, amount, ref);
    }

    /// Decrease points (does NOT move lastEarnedAt forward)
    function removePoints(address user, uint256 amount) external onlyOperator {
        uint256 p = points[user];
        uint256 newP = amount > p ? 0 : p - amount;
        points[user] = newP;
        emit PointsRemoved(user, amount);
    }

    /// Optional admin function for migrations/corrections.
    /// If this increases the user's points, we also advance lastEarnedAt to now.
    function setPoints(address user, uint256 amount) external onlyOwner {
        uint256 prev = points[user];
        points[user] = amount;
        if (amount > prev) {
            lastEarnedAt[user] = block.timestamp;
        }
        emit PointsSet(user, amount);
    }

    /// Let an operator “poke” activity (no points granted) to keep accounts warm after quests, etc.
    function pokeActivity(address user) external onlyOperator {
        lastEarnedAt[user] = block.timestamp;
        emit ActivityPoked(user, block.timestamp);
    }

    /// Convenience: batch airdrop
    function addPointsBatch(address[] calldata users, uint256[] calldata amounts, bytes32 ref) external onlyOperator {
        require(users.length == amounts.length, "len mismatch");
        for (uint256 i = 0; i < users.length; i++) {
            _addPoints(users[i], amounts[i], ref);
        }
    }
}
