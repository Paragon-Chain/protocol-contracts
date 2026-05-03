// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

interface IParagonAgentRegistry {
    function userEnabled(address user, uint256 templateId) external view returns (bool);
    function templateEnabled(uint256 templateId) external view returns (bool);
    function isRouterAllowed(uint256 templateId, address router) external view returns (bool);
    function isTokenAllowed(uint256 templateId, address token) external view returns (bool);
    function getLimits(uint256 templateId) external view returns (uint256 maxDailyUsd1e18, uint32 maxDailyActions);
    function getOracleConfig(uint256 templateId)
        external
        view
        returns (
            bool oracleEnabled,
            address oracle,
            address usdt,
            address wbnb,
            uint16 maxSlippageBips,
            uint32 twapWindow
        );
}

interface IParagonOracleLite {
    function priceUsd1e18(address token, address usdt, address wbnb) external view returns (uint256);
    function getAmountsOutUsingTwap(uint256 amountIn, address[] memory path, uint32 timeWindow)
        external
        view
        returns (uint256[] memory amounts);
}

interface IRouterV2Like {
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);
}

/// @notice Secure agent executor: only runs signed user intents, with policy from registry.
contract ParagonAgentExecutor is Ownable, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    enum ActionType {
        SWAP_EXACT_IN
        // Add more later: COMPOUND, ADD_LIQ, REMOVE_LIQ, etc.
    }

    struct PermitData {
        bool usePermit;         // true => call permit() before transferFrom
        uint256 value;          // allowance value to set (usually amountIn)
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct SwapExactInParams {
        address router;         // must be allowlisted in template
        address[] path;         // tokens must be allowlisted
        uint256 amountIn;       // exact in
        uint256 minOutUser;     // user-level min out (UI slippage)
        uint256 deadline;       // router deadline (also checked by agent deadline)
    }

    struct SignedIntent {
        // Identity / binding
        address user;
        uint256 templateId;
        ActionType actionType;

        // Global constraints
        uint256 agentDeadline;  // intent expires
        uint256 nonce;          // per-user per-template nonce
        uint256 maxUsd1e18;     // extra safety: per-intent USD cap (<= template daily cap)

        // Action payload hash binding
        bytes32 paramsHash;     // keccak256(abi.encode(params...))
    }

    bytes32 private constant INTENT_TYPEHASH =
        keccak256(
            "SignedIntent(address user,uint256 templateId,uint8 actionType,uint256 agentDeadline,uint256 nonce,uint256 maxUsd1e18,bytes32 paramsHash)"
        );

    IParagonAgentRegistry public immutable registry;

    // nonce per user per template
    mapping(address => mapping(uint256 => uint256)) public nonces;

    // daily spend tracking: user => templateId => day => spentUsd1e18
    mapping(address => mapping(uint256 => mapping(uint256 => uint256))) public spentUsd1e18;
    mapping(address => mapping(uint256 => mapping(uint256 => uint32))) public actionsUsed;

    event IntentExecuted(address indexed user, uint256 indexed templateId, ActionType actionType, uint256 nonce);
    event EmergencyTemplateDisabled(address indexed user, uint256 indexed templateId, bool disabled);

    // user => templateId => emergency disable toggle
    mapping(address => mapping(uint256 => bool)) public emergencyDisabled;

    constructor(address initialOwner, address _registry)
        Ownable(initialOwner)
        EIP712("ParagonAgentExecutor", "1")
    {
        require(_registry != address(0), "ZERO_REGISTRY");
        registry = IParagonAgentRegistry(_registry);
    }

    // ---------------- User emergency kill-switch ----------------
    function setEmergencyDisable(uint256 templateId, bool disabled) external {
        emergencyDisabled[msg.sender][templateId] = disabled;
        emit EmergencyTemplateDisabled(msg.sender, templateId, disabled);
    }

    // ---------------- Core execution ----------------
    function executeSwapExactIn(
        SignedIntent calldata intent,
        SwapExactInParams calldata p,
        PermitData calldata permitData,
        bytes calldata signature
    ) external whenNotPaused nonReentrant returns (uint256 amountOut) {
        _validateIntentCommon(intent, signature);

        require(intent.actionType == ActionType.SWAP_EXACT_IN, "BAD_ACTION");
        require(p.router != address(0), "ZERO_ROUTER");
        require(p.path.length >= 2 && p.path.length <= 5, "BAD_PATH");
        require(p.amountIn > 0, "AMOUNTIN=0");
        require(p.deadline >= block.timestamp, "ROUTER_DEADLINE");
        require(intent.agentDeadline >= block.timestamp, "INTENT_EXPIRED");
        require(p.path[0] != address(0) && p.path[p.path.length - 1] != address(0), "ZERO_TOKEN");

        // policy: template + user enabled + emergency
        require(!emergencyDisabled[intent.user][intent.templateId], "EMERGENCY_DISABLED");
        require(registry.templateEnabled(intent.templateId), "TEMPLATE_DISABLED");
        require(registry.userEnabled(intent.user, intent.templateId), "USER_NOT_ENABLED");
        require(registry.isRouterAllowed(intent.templateId, p.router), "ROUTER_NOT_ALLOWED");

        // token allowlist + prevent identical adjacent hops
        for (uint256 i = 0; i < p.path.length; i++) {
            require(registry.isTokenAllowed(intent.templateId, p.path[i]), "TOKEN_NOT_ALLOWED");
            if (i + 1 < p.path.length) require(p.path[i] != p.path[i + 1], "IDENTICAL_HOP");
        }

        // recipient lock: ALWAYS send swap output to the user (prevents “swap to attacker”)
        address user = intent.user;

        // enforce per-day action caps + USD caps
        _consumeDailyCaps(user, intent.templateId, p.path[0], p.amountIn, intent.maxUsd1e18);

        // optional permit to approve executor on tokenIn (EIP-2612)
        if (permitData.usePermit) {
            IERC20Permit(p.path[0]).permit(
                user,
                address(this),
                permitData.value,
                permitData.deadline,
                permitData.v,
                permitData.r,
                permitData.s
            );
        }

        // pull tokens in
        IERC20 tokenIn = IERC20(p.path[0]);
        tokenIn.safeTransferFrom(user, address(this), p.amountIn);

        // approve router
        tokenIn.forceApprove(p.router, 0);
        tokenIn.forceApprove(p.router, p.amountIn);

        // oracle guard minOut (optional, template-defined)
        uint256 oracleMinOut = _oracleMinOut(intent.templateId, p.amountIn, p.path);
        uint256 finalMinOut = p.minOutUser;
        if (oracleMinOut > finalMinOut) finalMinOut = oracleMinOut;

        // execute swap; output to user
        uint256 outBefore = IERC20(p.path[p.path.length - 1]).balanceOf(user);
        IRouterV2Like(p.router).swapExactTokensForTokens(
            p.amountIn,
            finalMinOut,
            p.path,
            user,
            p.deadline
        );
        uint256 outAfter = IERC20(p.path[p.path.length - 1]).balanceOf(user);
        amountOut = outAfter - outBefore;

        // clear approval (best practice)
        tokenIn.forceApprove(p.router, 0);

        emit IntentExecuted(user, intent.templateId, intent.actionType, intent.nonce);
        return amountOut;
    }

    // ---------------- Internal: intent verification ----------------
    function _validateIntentCommon(SignedIntent calldata intent, bytes calldata signature) internal {
        require(intent.user != address(0), "ZERO_USER");
        require(intent.templateId != 0, "BAD_TEMPLATE");
        require(intent.agentDeadline >= block.timestamp, "INTENT_EXPIRED");

        // nonce must match current
        uint256 expectedNonce = nonces[intent.user][intent.templateId];
        require(intent.nonce == expectedNonce, "BAD_NONCE");

        // bind paramsHash via signature
        bytes32 structHash = keccak256(
            abi.encode(
                INTENT_TYPEHASH,
                intent.user,
                intent.templateId,
                uint8(intent.actionType),
                intent.agentDeadline,
                intent.nonce,
                intent.maxUsd1e18,
                intent.paramsHash
            )
        );

        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = digest.recover(signature);
        require(recovered == intent.user, "BAD_SIG");

        // consume nonce
        nonces[intent.user][intent.templateId] = expectedNonce + 1;
    }

    // ---------------- Internal: daily caps ----------------
    function _consumeDailyCaps(
        address user,
        uint256 templateId,
        address tokenIn,
        uint256 amountIn,
        uint256 maxUsdPerIntent1e18
    ) internal {
        (uint256 templateMaxDailyUsd, uint32 templateMaxDailyActions) = registry.getLimits(templateId);
        require(templateMaxDailyActions > 0, "TEMPLATE_ACTIONS_0");

        uint256 day = block.timestamp / 1 days;

        // action count
        uint32 used = actionsUsed[user][templateId][day];
        require(used + 1 <= templateMaxDailyActions, "DAILY_ACTIONS_LIMIT");
        actionsUsed[user][templateId][day] = used + 1;

        // USD value
        uint256 usd = _valueUsd1e18(templateId, tokenIn, amountIn);
        if (maxUsdPerIntent1e18 != 0) {
            require(usd <= maxUsdPerIntent1e18, "INTENT_USD_CAP");
        }

        uint256 spent = spentUsd1e18[user][templateId][day];
        require(spent + usd <= templateMaxDailyUsd, "DAILY_USD_LIMIT");
        spentUsd1e18[user][templateId][day] = spent + usd;
    }

    function _valueUsd1e18(uint256 templateId, address token, uint256 amount) internal view returns (uint256) {
        (bool oracleEnabled, address oracle, address usdt, address wbnb,,) = registry.getOracleConfig(templateId);
        require(oracleEnabled && oracle != address(0), "ORACLE_DISABLED_FOR_CAPS");
        uint256 p = IParagonOracleLite(oracle).priceUsd1e18(token, usdt, wbnb);
        require(p != 0, "NO_USD_PRICE");
        // normalize by token decimals safely (assume <=18; your factory already enforces <=18)
        uint8 dec = _safeDecimals(token);
        return (amount * p) / (10 ** uint256(dec));
    }

    function _oracleMinOut(uint256 templateId, uint256 amountIn, address[] memory path) internal view returns (uint256) {
        (bool oracleEnabled, address oracle,, , uint16 maxSlippageBips, uint32 twapWindow) = registry.getOracleConfig(templateId);
        if (!oracleEnabled || oracle == address(0)) return 0;

        uint256[] memory q = IParagonOracleLite(oracle).getAmountsOutUsingTwap(amountIn, path, twapWindow);
        if (q.length == 0) return 0;
        uint256 quoteOut = q[q.length - 1];
        if (quoteOut == 0) return 0;

        // minOut = quoteOut * (1 - slippage)
        return (quoteOut * (10000 - uint256(maxSlippageBips))) / 10000;
    }

    function _safeDecimals(address token) internal view returns (uint8) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("decimals()"));
        if (!ok || data.length < 32) return 18;
        return uint8(uint256(bytes32(data)));
    }

    // ---------------- Admin safety ----------------
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /// @notice rescue tokens accidentally left in executor (should be near-zero in normal operation)
    function rescue(address token, address to) external onlyOwner {
        require(to != address(0), "ZERO_TO");
        if (token == address(0)) {
            (bool s,) = to.call{value: address(this).balance}("");
            require(s, "NATIVE_FAIL");
        } else {
            IERC20(token).safeTransfer(to, IERC20(token).balanceOf(address(this)));
        }
    }

    receive() external payable {}
}
