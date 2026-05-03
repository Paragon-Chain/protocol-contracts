// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

contract RepOpMock {
    event Payflow(address user, uint256 usdVol, uint256 usdSaved, bytes32 ref);
    address public lastUser;
    uint256 public lastVol;
    uint256 public lastSaved;
    bytes32 public lastRef;

    function onPayflowExecuted(address user, uint256 usdVol1e18, uint256 usdSaved1e18, bytes32 ref) external {
        lastUser = user; lastVol = usdVol1e18; lastSaved = usdSaved1e18; lastRef = ref;
        emit Payflow(user, usdVol1e18, usdSaved1e18, ref);
    }
}
