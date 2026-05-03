// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/access/Ownable.sol";

interface IParagonOracleLite {
    function priceUsd1e18(address token, address usdt, address wbnb) external view returns (uint256);
}

/// @notice Registry for agent templates + user enable/disable.
/// @dev Keep this "dumb": store policy. Executor enforces.
contract ParagonAgentRegistry is Ownable {
    struct TemplatePolicy {
        bool enabled;

        // Allowlists
        mapping(address => bool) allowedRouter;
        mapping(address => bool) allowedToken;

        // Limits (per user per day)
        uint256 maxDailyUsd1e18;     // e.g., 500e18 = $500/day
        uint32  maxDailyActions;     // e.g., 20 actions/day

        // Oracle guard
        bool    oracleEnabled;
        uint16  maxSlippageBips;     // e.g., 100 = 1.00%
        uint32  twapWindow;          // 0 = default in oracle
        address oracle;              // ParagonOracle
        address usdt;                // canonical USDT for valuation
        address wbnb;                // canonical WBNB for valuation
    }

    uint256 public templateCount;
    mapping(uint256 => TemplatePolicy) private _policy;

    // user => templateId => enabled
    mapping(address => mapping(uint256 => bool)) public userEnabled;

    event TemplateCreated(uint256 indexed templateId);
    event TemplateEnabled(uint256 indexed templateId, bool enabled);
    event RouterAllowed(uint256 indexed templateId, address router, bool allowed);
    event TokenAllowed(uint256 indexed templateId, address token, bool allowed);
    event LimitsUpdated(uint256 indexed templateId, uint256 maxDailyUsd1e18, uint32 maxDailyActions);
    event OracleConfigUpdated(
        uint256 indexed templateId,
        bool oracleEnabled,
        address oracle,
        address usdt,
        address wbnb,
        uint16 maxSlippageBips,
        uint32 twapWindow
    );
    event UserTemplateToggled(address indexed user, uint256 indexed templateId, bool enabled);

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ---------- Template admin ----------
    function createTemplate() external onlyOwner returns (uint256 id) {
        id = ++templateCount;
        _policy[id].enabled = true;
        emit TemplateCreated(id);
    }

    function setTemplateEnabled(uint256 templateId, bool on) external onlyOwner {
        _requireTemplate(templateId);
        _policy[templateId].enabled = on;
        emit TemplateEnabled(templateId, on);
    }

    function setAllowedRouter(uint256 templateId, address router, bool allowed) external onlyOwner {
        _requireTemplate(templateId);
        require(router != address(0), "ZERO_ROUTER");
        _policy[templateId].allowedRouter[router] = allowed;
        emit RouterAllowed(templateId, router, allowed);
    }

    function setAllowedToken(uint256 templateId, address token, bool allowed) external onlyOwner {
        _requireTemplate(templateId);
        require(token != address(0), "ZERO_TOKEN");
        _policy[templateId].allowedToken[token] = allowed;
        emit TokenAllowed(templateId, token, allowed);
    }

    function setLimits(uint256 templateId, uint256 maxDailyUsd1e18, uint32 maxDailyActions) external onlyOwner {
        _requireTemplate(templateId);
        require(maxDailyActions > 0, "ACTIONS=0");
        _policy[templateId].maxDailyUsd1e18 = maxDailyUsd1e18;
        _policy[templateId].maxDailyActions = maxDailyActions;
        emit LimitsUpdated(templateId, maxDailyUsd1e18, maxDailyActions);
    }

    function setOracleConfig(
        uint256 templateId,
        bool oracleEnabled,
        address oracle,
        address usdt,
        address wbnb,
        uint16 maxSlippageBips,
        uint32 twapWindow
    ) external onlyOwner {
        _requireTemplate(templateId);
        if (oracleEnabled) {
            require(oracle != address(0) && usdt != address(0) && wbnb != address(0), "ORACLE_CFG_ZERO");
            require(maxSlippageBips <= 2000, "SLIP_TOO_HIGH"); // cap at 20%
        }
        _policy[templateId].oracleEnabled = oracleEnabled;
        _policy[templateId].oracle = oracle;
        _policy[templateId].usdt = usdt;
        _policy[templateId].wbnb = wbnb;
        _policy[templateId].maxSlippageBips = maxSlippageBips;
        _policy[templateId].twapWindow = twapWindow;

        emit OracleConfigUpdated(templateId, oracleEnabled, oracle, usdt, wbnb, maxSlippageBips, twapWindow);
    }

    // ---------- User ----------
    function setUserEnabled(uint256 templateId, bool enabled) external {
        _requireTemplate(templateId);
        userEnabled[msg.sender][templateId] = enabled;
        emit UserTemplateToggled(msg.sender, templateId, enabled);
    }

    // ---------- Views for executor ----------
    function templateEnabled(uint256 templateId) external view returns (bool) {
        return _policy[templateId].enabled;
    }

    function isRouterAllowed(uint256 templateId, address router) external view returns (bool) {
        return _policy[templateId].allowedRouter[router];
    }

    function isTokenAllowed(uint256 templateId, address token) external view returns (bool) {
        return _policy[templateId].allowedToken[token];
    }

    function getLimits(uint256 templateId) external view returns (uint256 maxDailyUsd1e18, uint32 maxDailyActions) {
        maxDailyUsd1e18 = _policy[templateId].maxDailyUsd1e18;
        maxDailyActions = _policy[templateId].maxDailyActions;
    }

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
        )
    {
        TemplatePolicy storage p = _policy[templateId];
        return (p.oracleEnabled, p.oracle, p.usdt, p.wbnb, p.maxSlippageBips, p.twapWindow);
    }

    function _requireTemplate(uint256 templateId) internal view {
        require(templateId > 0 && templateId <= templateCount, "BAD_TEMPLATE");
    }
}
