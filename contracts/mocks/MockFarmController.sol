// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

contract MockFarmControllerV2 {
    using SafeERC20 for IERC20;

    address public immutable rewardToken;
    address public immutable lp;

    // “Per harvest” reward minted by harvest(). Keep your existing behavior.
    uint256 public rewardPerHarvest = 100 ether;

    struct UserInfo { uint256 amount; uint256 rewardDebt; }
    mapping(uint256 => mapping(address => UserInfo)) public userInfo;

    // NEW: track last harvest block so pendingReward can drop after harvest
    mapping(uint256 => uint64) public lastGlobalHarvestBlock;              // per pid
    mapping(uint256 => mapping(address => uint64)) public lastHarvestBlock; // per pid/user

    constructor(address _rewardToken, address _lp) {
        rewardToken = _rewardToken;
        lp = _lp;
    }

    // --------- OLD API (your JS uses these) ---------

    function lpToken() external view returns (address) {
        return lp;
    }

    function deposit(uint256 pid, uint256 amount) external {
        if (amount > 0) {
            IERC20(lp).safeTransferFrom(msg.sender, address(this), amount);
            userInfo[pid][msg.sender].amount += amount;
        }
    }

    function harvest(uint256 pid) external {
        _harvestTo(pid, msg.sender);
    }

    function harvest(uint256 pid, address to) external {
        _harvestTo(pid, to);
    }

    /// NEW: pendingReward is now dynamic.
    /// - Returns 0 in the same block any harvest happened for this pid.
    /// - Otherwise returns rewardPerHarvest (simple mock behavior).
    function pendingReward(uint256 pid, address /*u*/) external view returns (uint256) {
        if (lastGlobalHarvestBlock[pid] == uint64(block.number)) return 0;
        return rewardPerHarvest;
    }

    // --------- NEW API (executor requires these) ---------

    function lpToken(uint256) external view returns (address) {
        return lp;
    }

    function depositFor(uint256 pid, uint256 amount, address user, address /*referrer*/) external {
        if (amount > 0) {
            IERC20(lp).safeTransferFrom(msg.sender, address(this), amount);
            userInfo[pid][user].amount += amount;
        }
    }

    // --------- test helpers ---------

    function setRewardPerHarvest(uint256 newReward) external {
        rewardPerHarvest = newReward;
    }

    // --------- internal ---------

    function _harvestTo(uint256 pid, address to) internal {
        // mark harvest happened (so pendingReward drops to 0 for this block)
        lastGlobalHarvestBlock[pid] = uint64(block.number);
        lastHarvestBlock[pid][to] = uint64(block.number);

        // farm is mint authority (reward.owner() == farm in your deploy)
        IMintable(rewardToken).mint(to, rewardPerHarvest);
    }
}
