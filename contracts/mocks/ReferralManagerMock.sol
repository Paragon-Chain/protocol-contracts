// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ReferralManagerMock {
    mapping(address => uint256) public points;

    event Recorded(address indexed user, address indexed referrer, uint256 amount);

    // A very simple API: record referral and add points
    function recordReferral(address user, address referrer, uint256 amount) external {
        if (referrer != address(0) && user != address(0) && amount > 0) {
            points[user] += amount;
            emit Recorded(user, referrer, amount);
        }
    }

    function pointsOf(address user) external view returns (uint256) {
        return points[user];
    }
}
