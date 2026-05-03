// IParagonReputation.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
interface IParagonReputation {
  function addPoints(address user, uint256 points, bytes32 ref) external;
}
