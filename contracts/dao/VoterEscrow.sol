// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract VoterEscrow is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Locked {
        uint256 amount; // XPGN amount locked
        uint256 end;    // unlock timestamp (rounded to week)
    }

    IERC20 public immutable XPGN;

    uint256 public constant WEEK = 7 days;
    uint256 public constant MAXTIME = 4 * 365 days; // 4 years

    // Global "point" state:
    // totalSlope: sum(amount / MAXTIME) across all active locks
    // totalBias:  sum( slope * (end - pointTs) ) at pointTs
    int256 public totalSlope;
    int256 public totalBias;
    uint256 public pointTs;

    // When a lock ends at time T (rounded to week), slope decreases by (amount/MAXTIME)
    mapping(uint256 => int256) public slopeChanges; // T => deltaSlope

    mapping(address => Locked) public locked;

    event LockCreated(address indexed user, uint256 amount, uint256 end);
    event LockAmountIncreased(address indexed user, uint256 amount);
    event LockExtended(address indexed user, uint256 newEnd);
    event Withdrawn(address indexed user, uint256 amount);
    event Checkpoint(uint256 ts, int256 slope, int256 bias);

    constructor(address _token, address initialOwner) Ownable(initialOwner) {
        require(_token != address(0), "token=0");
        XPGN = IERC20(_token);
        pointTs = _roundDownWeek(block.timestamp);
    }

    // ---- views

    function token() external view returns (address) { return address(XPGN); }

    function balanceOf(address account) public view returns (uint256) {
        Locked memory l = locked[account];
        if (block.timestamp >= l.end) return 0;
        uint256 dt = l.end - block.timestamp;
        return (l.amount * dt) / MAXTIME;
    }

    function balanceOfAtTime(address account, uint256 ts) public view returns (uint256) {
        Locked memory l = locked[account];
        if (ts >= l.end) return 0;
        if (ts < block.timestamp) ts = block.timestamp; // disallow pre-current read to avoid confusion
        uint256 dt = l.end - ts;
        return (l.amount * dt) / MAXTIME;
    }

    function totalSupply() public view returns (uint256) {
        (int256 bias,,) = _supplyAt(block.timestamp, pointTs, totalBias, totalSlope);
        return bias <= 0 ? 0 : uint256(bias);
    }

    function totalSupplyAtTime(uint256 ts) public view returns (uint256) {
        if (ts < block.timestamp) ts = block.timestamp;
        (int256 bias,,) = _supplyAt(ts, pointTs, totalBias, totalSlope);
        return bias <= 0 ? 0 : uint256(bias);
    }

    // ---- core write ops

    function create_lock(uint256 amount, uint256 unlockTime) external whenNotPaused nonReentrant {
        require(amount > 0, "amount=0");
        Locked memory l = locked[msg.sender];
        require(l.amount == 0, "lock exists");
        uint256 end = _roundedUnlock(unlockTime);
        require(end > block.timestamp, "end<=now");
        require(end <= block.timestamp + MAXTIME, "end>MAXTIME");

        _checkpoint();

        // old -> new deltas
        int256 oldSlope = 0;
        int256 oldBias  = 0;
        if (l.amount > 0 && l.end > block.timestamp) {
            oldSlope = int256(l.amount / MAXTIME);
            oldBias  = int256((l.amount * (l.end - block.timestamp)) / MAXTIME);
            slopeChanges[l.end] -= oldSlope;
        }

        l.amount = amount;
        l.end = end;
        locked[msg.sender] = l;

        int256 newSlope = int256(amount / MAXTIME);
        int256 newBias  = int256((amount * (end - block.timestamp)) / MAXTIME);

        totalSlope = totalSlope + newSlope - oldSlope;
        totalBias  = totalBias + newBias - oldBias;

        slopeChanges[end] += newSlope;

        XPGN.safeTransferFrom(msg.sender, address(this), amount);

        emit LockCreated(msg.sender, amount, end);
        emit Checkpoint(block.timestamp, totalSlope, totalBias);
    }

    function increase_amount(uint256 amount) external whenNotPaused nonReentrant {
        require(amount > 0, "amount=0");
        Locked memory l = locked[msg.sender];
        require(l.amount > 0, "no lock");
        require(l.end > block.timestamp, "expired");

        _checkpoint();

        int256 oldSlope = int256(l.amount / MAXTIME);
        int256 oldBias  = int256((l.amount * (l.end - block.timestamp)) / MAXTIME);
        slopeChanges[l.end] -= oldSlope;

        l.amount += amount;
        locked[msg.sender] = l;

        int256 newSlope = int256(l.amount / MAXTIME);
        int256 newBias  = int256((l.amount * (l.end - block.timestamp)) / MAXTIME);

        totalSlope = totalSlope + newSlope - oldSlope;
        totalBias  = totalBias + newBias - oldBias;

        slopeChanges[l.end] += newSlope;

        XPGN.safeTransferFrom(msg.sender, address(this), amount);

        emit LockAmountIncreased(msg.sender, amount);
        emit Checkpoint(block.timestamp, totalSlope, totalBias);
    }

    function increase_unlock_time(uint256 newUnlockTime) external whenNotPaused nonReentrant {
        Locked memory l = locked[msg.sender];
        require(l.amount > 0, "no lock");
        require(l.end > block.timestamp, "expired");

        uint256 newEnd = _roundedUnlock(newUnlockTime);
        require(newEnd > l.end, "not extend");
        require(newEnd <= block.timestamp + MAXTIME, "end>MAXTIME");

        _checkpoint();

        int256 oldSlope = int256(l.amount / MAXTIME);
        int256 oldBias  = int256((l.amount * (l.end - block.timestamp)) / MAXTIME);
        slopeChanges[l.end] -= oldSlope;

        l.end = newEnd;
        locked[msg.sender] = l;

        int256 newSlope = int256(l.amount / MAXTIME);
        int256 newBias  = int256((l.amount * (newEnd - block.timestamp)) / MAXTIME);

        totalSlope = totalSlope + newSlope - oldSlope;
        totalBias  = totalBias + newBias - oldBias;

        slopeChanges[newEnd] += newSlope;

        emit LockExtended(msg.sender, newEnd);
        emit Checkpoint(block.timestamp, totalSlope, totalBias);
    }

    function withdraw() external nonReentrant {
        Locked memory l = locked[msg.sender];
        require(block.timestamp >= l.end, "not unlocked");
        uint256 amt = l.amount;
        require(amt > 0, "nothing");

        _checkpoint();

        int256 oldSlope = int256(amt / MAXTIME);
        int256 oldBias  = int256((amt * (l.end > block.timestamp ? (l.end - block.timestamp) : 0)) / MAXTIME);

        totalSlope = totalSlope - oldSlope;
        totalBias  = totalBias - oldBias;

        if (l.end > 0) {
            slopeChanges[l.end] -= oldSlope;
        }

        delete locked[msg.sender];

        XPGN.safeTransfer(msg.sender, amt);
        emit Withdrawn(msg.sender, amt);
        emit Checkpoint(block.timestamp, totalSlope, totalBias);
    }

    // ---- admin

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ---- internals

    function _checkpoint() internal {
        (int256 newBias, int256 newSlope, uint256 newTs) =
            _supplyAt(block.timestamp, pointTs, totalBias, totalSlope);

        totalBias = newBias;
        totalSlope = newSlope;
        pointTs = newTs;
    }

    function _supplyAt(
        uint256 targetTs,
        uint256 fromTs,
        int256 bias,
        int256 slope
    ) internal view returns (int256, int256, uint256) {
        if (targetTs < fromTs) targetTs = fromTs;
        uint256 ts = fromTs;

        while (ts < targetTs) {
            uint256 next = _roundDownWeek(ts + WEEK);
            if (next > targetTs) next = targetTs;

            uint256 dt = next - ts;
            bias -= slope * int256(dt);
            if (bias < 0) bias = 0;

            int256 dSlope = slopeChanges[next];
            slope += dSlope;
            if (slope < 0) slope = 0;

            ts = next;
        }
        return (bias, slope, ts);
    }

    function _roundDownWeek(uint256 t) internal pure returns (uint256) {
        return (t / WEEK) * WEEK;
    }

    function _roundedUnlock(uint256 t) internal pure returns (uint256) {
        // round down to whole weeks for anti-grief & consistency
        return ((t + WEEK - 1) / WEEK) * WEEK;
    }
}
