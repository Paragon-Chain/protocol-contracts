// IPayflowEvents.sol (optional, for subgraph)
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
interface IPayflowEvents {
  event PayflowExecuted(bytes32 intentId, address user, uint256 spentGas, uint256 usdVolume, uint256 usdSaved, uint256 feeBips);
}
