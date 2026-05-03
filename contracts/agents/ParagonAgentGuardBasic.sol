// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/access/Ownable.sol";

contract ParagonAgentGuardBasic is Ownable {
    // action ids (match executor)
    uint8 public constant ACT_FARM_DEPOSIT = 10;
    uint8 public constant ACT_FARM_WITHDRAW = 11;
    uint8 public constant ACT_FARM_HARVEST = 12;
    uint8 public constant ACT_SWAP_EXACT_IN = 1;
    uint8 public constant ACT_ADD_LIQ = 2;
    uint8 public constant ACT_REMOVE_LIQ = 3;

    mapping(address => bool) public allowedFarm;
    mapping(address => mapping(uint256 => bool)) public allowedPid; // farm => pid allowed
    mapping(address => bool) public allowedRouter;
    mapping(address => bool) public allowedToken; // optional coarse control

    // Optional: hard caps per intent (executor has caps too, this is template-level)
    uint16 public maxSlippageBips; // e.g. 100 = 1%
    uint256 public maxAmountIn;    // coarse cap per action

    event AllowedFarm(address farm, bool allowed);
    event AllowedPid(address farm, uint256 pid, bool allowed);
    event AllowedRouter(address router, bool allowed);
    event AllowedToken(address token, bool allowed);
    event GuardLimits(uint16 maxSlippageBips, uint256 maxAmountIn);

    constructor(address owner_) Ownable(owner_) {}

    function setAllowedFarm(address farm, bool ok) external onlyOwner {
        allowedFarm[farm] = ok;
        emit AllowedFarm(farm, ok);
    }

    function setAllowedPid(address farm, uint256 pid, bool ok) external onlyOwner {
        allowedPid[farm][pid] = ok;
        emit AllowedPid(farm, pid, ok);
    }

    function setAllowedRouter(address router, bool ok) external onlyOwner {
        allowedRouter[router] = ok;
        emit AllowedRouter(router, ok);
    }

    function setAllowedToken(address token, bool ok) external onlyOwner {
        allowedToken[token] = ok;
        emit AllowedToken(token, ok);
    }

    function setLimits(uint16 _maxSlippageBips, uint256 _maxAmountIn) external onlyOwner {
        require(_maxSlippageBips <= 2000, "too high"); // 20% upper bound safety
        maxSlippageBips = _maxSlippageBips;
        maxAmountIn = _maxAmountIn;
        emit GuardLimits(_maxSlippageBips, _maxAmountIn);
    }

    /// @notice The executor calls this before execute. params encoding depends on action.
    function validate(bytes32, address, uint8 action, bytes calldata params) external view {
        if (action == ACT_FARM_DEPOSIT || action == ACT_FARM_WITHDRAW || action == ACT_FARM_HARVEST) {
            (address farm, uint256 pid, uint256 amount) = abi.decode(params, (address, uint256, uint256));
            require(allowedFarm[farm], "farm not allowed");
            require(allowedPid[farm][pid], "pid not allowed");
            if (action != ACT_FARM_HARVEST && maxAmountIn > 0) require(amount <= maxAmountIn, "amount too big");
            return;
        }

        if (action == ACT_SWAP_EXACT_IN) {
            (address router, address tokenIn, uint256 amountIn, uint16 slippageBips) =
                abi.decode(params, (address, address, uint256, uint16));
            require(allowedRouter[router], "router not allowed");
            if (allowedToken[tokenIn] || _anyTokenAllowedDisabled()) {
                // ok
            } else {
                revert("token not allowed");
            }
            if (maxAmountIn > 0) require(amountIn <= maxAmountIn, "amount too big");
            if (maxSlippageBips > 0) require(slippageBips <= maxSlippageBips, "slippage too high");
            return;
        }

        // add/remove liq can be guarded similarly later
        revert("action not supported by guard");
    }

    function _anyTokenAllowedDisabled() internal view returns (bool) {
        // If owner never sets any token allowlist, you can interpret that as "no token restriction"
        // (simple approach: allow all). For strict mode, remove this and require explicit tokens.
        return true;
    }
}
