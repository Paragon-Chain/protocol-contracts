// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

contract ValuerMock {
    // 1:1 “USD” for tests (units: 1e18)
    function usdValue(address /*token*/, uint256 amount) external pure returns (uint256) {
        return amount;
    }
}
