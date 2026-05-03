// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/Nonces.sol";

interface IParagonStake { function balanceOf(address) external view returns (uint256); }
interface IParagonReputation { function points(address) external view returns (uint256); }
// Optional (preferred) extension on Reputation
interface IParagonReputationExt is IParagonReputation { function lastEarnedAt(address) external view returns (uint256); }
// Fallback source (e.g., ReputationOperator)
interface ILastSeen { function lastSeen(address) external view returns (uint256); }

/// @title ParagonGovPower (govXPGN) — Non-transferable voting token backed by stXPGN & decaying Reputation
contract ParagonGovPower is ERC20, ERC20Permit, ERC20Votes, Ownable {
    using Math for uint256;

    // ---- Sources ----
    IParagonStake public immutable stToken;
    IParagonReputation public immutable reputation;

    // ---- Weights (raw multipliers; tune off-chain to desired scale) ----
    uint256 public stakeWeight; // applied to sqrt(stake)
    uint256 public repWeight;   // applied to decayed reputation points

    // ---- Decay config (in bips, 10_000 = 1.0) ----
    uint16  public graceDays = 7;          // days without decay
    uint16  public decayBaseBipsDay = 9950; // 0.50% per-day decay after grace (9950/10000)^days
    address public lastSeenProvider;       // optional: ReputationOperator
    bool    public useRepLastEarned = true; // true=read lastEarnedAt from Reputation, false=read lastSeen from provider

    // ---- Events ----
    event WeightsUpdated(uint256 stakeWeight, uint256 repWeight);
    event DecayParamsUpdated(uint16 graceDays, uint16 decayBaseBipsDay);
    event ActivitySourceUpdated(address lastSeenProvider, bool useRepLastEarned);
    event Recomputed(address indexed user, uint256 newVotingPower);

    constructor(
        string memory name_,
        string memory symbol_,
        address initialOwner,
        address stToken_,
        address reputation_,
        uint256 stakeWeight_,
        uint256 repWeight_
    )
        ERC20(name_, symbol_)
        ERC20Permit(name_) // OZ v5
        Ownable(initialOwner)
    {
        require(stToken_ != address(0) && reputation_ != address(0), "govXPGN: zero addr");
        stToken     = IParagonStake(stToken_);
        reputation  = IParagonReputation(reputation_);
        stakeWeight = stakeWeight_;
        repWeight   = repWeight_;
    }

    // ---- Non-transferable (mint/burn only) ----
    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Votes)
    {
        require(from == address(0) || to == address(0), "govXPGN: non-transferable");
        super._update(from, to, value);
    }

    // Resolve Nonces diamond inheritance (ERC20Permit + ERC20Votes in OZ v5)
    function nonces(address owner)
        public
        view
        override(ERC20Permit, Nonces)
        returns (uint256)
    {
        return super.nonces(owner);
    }

    // ---------- Admin ----------
    function setWeights(uint256 _stakeWeight, uint256 _repWeight) external onlyOwner {
        stakeWeight = _stakeWeight;
        repWeight   = _repWeight;
        emit WeightsUpdated(_stakeWeight, _repWeight);
    }

    function setDecayParams(uint16 _graceDays, uint16 _decayBaseBipsDay) external onlyOwner {
        require(_decayBaseBipsDay <= 10_000, "govXPGN: base>1.0");
        graceDays        = _graceDays;
        decayBaseBipsDay = _decayBaseBipsDay;
        emit DecayParamsUpdated(_graceDays, _decayBaseBipsDay);
    }

    /// @param op The operator that exposes lastSeen(user), or zero if unused
    /// @param _useRepLastEarned true to read lastEarnedAt(user) from Reputation (preferred)
    function setLastSeenProvider(address op, bool _useRepLastEarned) external onlyOwner {
        lastSeenProvider = op;
        useRepLastEarned = _useRepLastEarned;
        emit ActivitySourceUpdated(op, _useRepLastEarned);
    }

    // ---------- View helpers ----------
    function _powBips(uint256 baseBips, uint256 exp) internal pure returns (uint256) {
        // exp-by-squaring in 1e4 space
        uint256 ONE = 10_000;
        uint256 res = ONE;
        while (exp > 0) {
            if (exp & 1 == 1) res = (res * baseBips) / ONE;
            baseBips = (baseBips * baseBips) / ONE;
            exp >>= 1;
        }
        return res;
    }

    function _lastActivity(address user) internal view returns (uint256 ts) {
        if (useRepLastEarned) {
            // Try to read from Reputation if it implements lastEarnedAt(user)
            try IParagonReputationExt(address(reputation)).lastEarnedAt(user) returns (uint256 t) {
                return t;
            } catch { /* fallthrough */ }
        }
        if (lastSeenProvider != address(0)) {
            try ILastSeen(lastSeenProvider).lastSeen(user) returns (uint256 t2) { return t2; } catch {}
        }
        return 0;
    }

    function _decayFactorBips(uint256 lastTs) internal view returns (uint256) {
        if (lastTs == 0) return 10_000; // unknown → no decay until first earn (tunable choice)
        uint256 t = block.timestamp;
        uint256 g = uint256(graceDays) * 1 days;
        if (t <= lastTs + g) return 10_000;
        uint256 daysIdle = (t - lastTs - g) / 1 days;
        return _powBips(decayBaseBipsDay, daysIdle); // 10_000 == 1.0
    }

    function decayedPoints(address user) public view returns (uint256) {
        uint256 pts = reputation.points(user);
        if (pts == 0) return 0;
        uint256 fBips = _decayFactorBips(_lastActivity(user));
        return (pts * fBips) / 10_000;
    }

    /// Live (view) voting power without touching storage — useful for Snapshot strategies
    function powerOf(address user) public view returns (uint256) {
        uint256 st   = stToken.balanceOf(user);
        uint256 rp   = decayedPoints(user);
        uint256 stakePart = Math.sqrt(st) * stakeWeight;
        uint256 repPart   = rp * repWeight;
        return stakePart + repPart;
    }

    // ---------- Sync methods (tokenized voting units) ----------
    /// Recompute and mint/burn to match current power (includes decay)
    function recompute(address user) public {
        uint256 target  = powerOf(user);
        uint256 current = balanceOf(user);
        if (target > current) _mint(user, target - current);
        else if (current > target) _burn(user, current - target);
        emit Recomputed(user, target);
    }

    function recomputeBatch(address[] calldata users) external {
        for (uint256 i = 0; i < users.length; i++) {
            recompute(users[i]);
        }
    }
}
