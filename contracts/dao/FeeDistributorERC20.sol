// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IVoterEscrowMinimal} from "./interfaces/IVoterEscrowMinimal.sol";

contract FeeDistributorERC20 is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint256 public constant WEEK = 7 days;

    IERC20 public immutable reward;   // XPGN (or any ERC20)
    IVoterEscrowMinimal public immutable ve;

    // epoch => amount
    mapping(uint256 => uint256) public epochRewards;
    mapping(uint256 => uint256) public epochSupply; // ve total supply snapshot at epoch start

    // user => last claimed epoch
    mapping(address => uint256) public userLastClaim;

    event Notified(uint256 indexed weekTs, uint256 amount, uint256 veSupply);
    event Claimed(address indexed user, uint256 amount, uint256 fromWeek, uint256 toWeek);

    constructor(address _reward, address _ve, address initialOwner) Ownable(initialOwner) {
        require(_reward != address(0) && _ve != address(0), "0");
        reward = IERC20(_reward);
        ve = IVoterEscrowMinimal(_ve);
    }

    function notifyRewardAmount(uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "amount=0");
        uint256 weekTs = _roundDownWeek(block.timestamp);
        // pull funds
        reward.safeTransferFrom(msg.sender, address(this), amount);

        // snapshot ve total supply at epoch
        uint256 supply = ve.totalSupplyAtTime(weekTs);
        epochSupply[weekTs] = supply;
        epochRewards[weekTs] += amount;

        emit Notified(weekTs, amount, supply);
    }

    function claim(address user) external nonReentrant whenNotPaused returns (uint256) {
        require(user != address(0), "user=0");

        (uint256 fromWeek, uint256 toWeek) = claimWindow(user);
        if (fromWeek == 0 || fromWeek > toWeek) return 0;

        uint256 total;
        for (uint256 w = fromWeek; w <= toWeek; w += WEEK) {
            uint256 amt = epochRewards[w];
            if (amt == 0) continue;

            uint256 supply = epochSupply[w];
            if (supply == 0) continue;

            uint256 bal = ve.balanceOfAtTime(user, w); // user ve at epoch start
            if (bal == 0) continue;

            total += (amt * bal) / supply;
        }

        userLastClaim[user] = toWeek;
        if (total > 0) {
            reward.safeTransfer(user, total);
        }
        emit Claimed(user, total, fromWeek, toWeek);
        return total;
    }

    function claimWindow(address user) public view returns (uint256 fromWeek, uint256 toWeek) {
        uint256 last = userLastClaim[user];
        uint256 start = last == 0 ? _roundDownWeek(block.timestamp) - WEEK * 12 : last + WEEK; // default: last 12 weeks
        uint256 end = _roundDownWeek(block.timestamp);
        if (start > end) return (0, 0);
        return (start, end);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function _roundDownWeek(uint256 t) internal pure returns (uint256) {
        return (t / WEEK) * WEEK;
    }
}
