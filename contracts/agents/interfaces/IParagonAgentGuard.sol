// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

interface IParagonAgentGuard {
    /// @notice Validate an intent before execution. Revert if not allowed.
    function validate(bytes32 intentHash, address user, uint8 action, bytes calldata params) external view;
}
