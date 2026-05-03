// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract BoostManagerMock {
    // Return 10% boost (1000 bips) by default
    uint256 public boostBips = 1000;

    function setBoostBips(uint256 bips) external {
        boostBips = bips;
    }

    // Signature expected by Farm: getBoost(user, pid) -> bips
    function getBoost(address /*user*/, uint256 /*pid*/) external view returns (uint256) {
        return boostBips;
    }
}
