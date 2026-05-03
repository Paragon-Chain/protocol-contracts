// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

interface IERC20 { function transferFrom(address, address, uint) external returns (bool); }

contract ParagonFarmControllerMock {
    address public immutable lp0; // token for pid 0
    mapping(address => uint256) public depositedPid0;
    uint256 public autoYieldBips; // e.g., 200 = 2%

    constructor(address _lp0) { lp0 = _lp0; }
    function lpToken(uint256 pid) external view returns (address) { require(pid==0, "pid"); return lp0; }

    function depositFor(uint256 pid, uint256 amount, address user, address /*referrer*/) external {
        require(pid == 0, "pid");
        // Router should have transferFrom-approved the token when it calls us
        IERC20(lp0).transferFrom(msg.sender, address(this), amount);
        depositedPid0[user] += amount;
    }

    function setAutoYieldPercent(uint256 bips) external { autoYieldBips = bips; }
}
