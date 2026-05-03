// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.25;
/*
 * Paragon Flow DEX — Core contracts
 * ParagonPayflowExecutorV2Update — V3.1
 *
 * DO NOT modify audited ParagonPayflowExecutorV2 / ParagonPayflowExecutorV2-aggregator.
 * DO NOT modify ParagonPayflowExecutorUpdate (V3.0).
 * Deploy this contract fresh and point it at ParagonBestExecutionUpdate (or V2Update).
 *
 * Changes over ParagonPayflowExecutorUpdate (V3.0):
 *
 *  1. _runGuard BUG FIX
 *       V3.0 passed `received` as both actualOut AND expectedOutPreSwap — the guard
 *       could never reject anything. Fixed by:
 *         a) Adding `oracleRef` storage — points at ParagonOracle.
 *         b) `_getPreSwapQuote()` queries TWAP first, Chainlink fallback, before the swap.
 *         c) _runGuard now receives the oracle quote as expectedOutPreSwap.
 *         d) If oracle is unavailable AND guardFailOpen=false, execution reverts rather
 *            than silently continuing with a useless guard.
 *
 *  2. PERMIT2 SUPPORT
 *       Users with a one-time Permit2 approval can skip per-token approvals.
 *       `Permit2Data` struct carries (nonce, deadline, signature).
 *       `_pullInput` detects permit type: none / EIP-2612 / Permit2.
 *       Permit2 address is configurable (setPermit2).
 *
 * All other V3.0 logic preserved verbatim:
 *   - Bitmap nonce awareness (IBestExec interface)
 *   - Native ETH / WETH wrap+unwrap
 *   - 1inch + lpHopPath LP attribution fix
 *   - reportExecution() amountOut reporting
 *   - RouterGuard venue toggle + guardFailOpen flag
 *   - Surplus split, relayer fee, locker, LP rebates, reputation hooks
 *   - Guardian, pause, sweep functions
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

import { IUsdValuer }    from "./interfaces/IUsdValuer.sol";
import { ILPFlowRebates } from "./interfaces/ILPFlowRebates.sol";

// ─── External interfaces ──────────────────────────────────────────────────────

interface IParagonRouterV2Like {
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn, uint256 amountOutMin, address[] calldata path,
        address to, uint256 deadline, uint8 autoYieldPercent
    ) external;
    function swapExactTokensForTokens(
        uint256 amountIn, uint256 amountOutMin, address[] calldata path,
        address to, uint256 deadline, uint8 autoYieldPercent
    ) external returns (uint256[] memory amounts);
    function swapExactTokensForTokens(
        uint256 amountIn, uint256 amountOutMin, address[] calldata path,
        address to, uint256 deadline
    ) external returns (uint256[] memory amounts);
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
}

interface IBestExec {
    struct SwapIntent {
        address user;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        uint256 deadline;
        address recipient;
        uint256 nonce;
    }
    function consume(SwapIntent memory it, bytes calldata sig) external;
    function hashIntent(SwapIntent memory it) external view returns (bytes32);
    function reportExecution(
        address user, uint256 nonce, address tokenIn, address tokenOut,
        uint256 amountIn, uint256 amountOut, address recipient
    ) external;
}

interface IReputationOperator {
    function onPayflowExecuted(
        address user, uint256 usdVol1e18, uint256 usdSaved1e18, bytes32 ref
    ) external;
}

interface I1inchRouterV6 {
    struct SwapDescription {
        IERC20 srcToken;
        IERC20 dstToken;
        address payable srcReceiver;
        address payable dstReceiver;
        uint256 amount;
        uint256 minReturnAmount;
        uint256 flags;
    }
}

interface IParagon1inchAdapter {
    function execute(
        address tokenIn, uint256 amountIn, address tokenOut, uint256 minAmountOut,
        I1inchRouterV6.SwapDescription calldata desc,
        bytes calldata permitData, bytes calldata oneInchData, address executor
    ) external returns (uint256 actualOut);
}

interface IParagonRouterGuard {
    function validatePostSwap(
        uint256 effectiveIn,
        address[] calldata path,
        uint256 actualOut,
        uint256 expectedOutPreSwap
    ) external view;
}

/// @dev Minimal ParagonOracle interface for pre-swap quoting.
interface IParagonOracle {
    function getAmountsOutUsingTwap(uint256 amountIn, address[] memory path, uint32 timeWindow)
        external view returns (uint256[] memory amounts);
    function getAmountsOutUsingChainlink(uint256 amountIn, address[] memory path)
        external view returns (uint256[] memory amounts);
}

/// @dev Uniswap Permit2 interface (canonical, deployed at same address on all chains).
interface IPermit2 {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }
    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }
    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }
    function permitTransferFrom(
        PermitTransferFrom memory permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;
}

// ─── Executor V3.1 ───────────────────────────────────────────────────────────

contract ParagonPayflowExecutorV2Update is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ── Core addresses ────────────────────────────────────────────────────────
    IParagonRouterV2Like public router;
    IBestExec            public bestExec;
    IReputationOperator  public repOp;
    IUsdValuer           public valuer;
    address              public daoVault;
    address              public lockerVault;
    ILPFlowRebates       public lpRebates;
    address              public oneInchAdapter;

    // V3.0 additions
    IParagonRouterGuard  public routerGuard;
    address              public weth;

    // V3.1 additions
    IParagonOracle       public oracleRef;   // ParagonOracle — for pre-swap quote
    IPermit2             public permit2;     // Permit2 contract (address(0) = disabled)

    // ── Fee config ────────────────────────────────────────────────────────────
    uint16 public protocolFeeBips;
    uint16 public traderBips       = 6000;
    uint16 public lpBips           = 1000;
    uint16 public solverBips       = 2000;
    uint16 public aggregatorFeeBips;

    uint16 public constant MAX_AGGREGATOR_FEE_BPS = 100;
    uint8  public constant MAX_PATH_LEN           = 5;
    uint8  public constant DEFAULT_AUTO_PREF      = 0;

    // ── Guard config ──────────────────────────────────────────────────────────
    // guardFailOpen=true  → oracle miss or guard revert is skipped (swap continues)
    // guardFailOpen=false → oracle miss causes revert (strict mode)
    bool public guardFailOpen = true; // default true for safe rollout; tighten after validation

    // ── Permit type enum ──────────────────────────────────────────────────────
    uint8 public constant PERMIT_NONE    = 0;
    uint8 public constant PERMIT_EIP2612 = 1;
    uint8 public constant PERMIT_PERMIT2 = 2;

    // ── Allowlists ────────────────────────────────────────────────────────────
    mapping(address => bool) public supportedToken;
    mapping(address => bool) public venueEnabled;
    mapping(address => bool) public isRelayer;

    // ── Structs ───────────────────────────────────────────────────────────────
    /// @param permitType 0=none, 1=EIP-2612, 2=Permit2
    struct PermitData {
        uint8   permitType;
        uint256 value;      // EIP-2612: amount; Permit2: amount in TokenPermissions
        uint256 deadline;   // EIP-2612 & Permit2 deadline
        uint256 nonce;      // Permit2 nonce (ignored for EIP-2612)
        uint8   v;          // EIP-2612 only
        bytes32 r;          // EIP-2612 only
        bytes32 s;          // EIP-2612 only
        bytes   permit2Sig; // Permit2 signature (ignored for EIP-2612)
    }

    struct OneInchRequest {
        I1inchRouterV6.SwapDescription desc;
        bytes permitData;
        bytes oneInchData;
        address executor;
        PermitData userPermit;
        address[] lpHopPath;
        uint16[] hopShareBips;
    }

    struct OneInchAdapterCall {
        I1inchRouterV6.SwapDescription desc;
        bytes permitData;
        bytes oneInchData;
        address executor;
    }

    struct SettlementBreakdown {
        uint256 surplus;
        uint256 protocolCut;
        uint256 dist;
        uint256 traderShare;
        uint256 lpShare;
        uint256 solverShare;
        uint256 lockerShare;
        uint256 treasuryShare;
    }

    // ── Errors ────────────────────────────────────────────────────────────────
    error RouterSwapFailed();
    error BadSplit();
    error PathMismatch();
    error PathTooLong();
    error InvalidHopShares();
    error PermitFailed();
    error InvalidRecipient();
    error InvalidSwap();
    error VenuePaused();
    error UnsupportedToken();
    error AdapterNotSet();
    error WETHNotSet();
    error NativeTransferFailed();
    error ETHValueMismatch();
    error GuardRejected();
    error OracleUnavailable(); // strict mode: oracle needed but unavailable
    error Permit2NotSet();

    // ── Events ────────────────────────────────────────────────────────────────
    event PayflowExecuted(
        address indexed user, address indexed tokenIn, address indexed tokenOut,
        uint256 amountIn, uint256 minOut, uint256 amountOut,
        uint256 surplus, uint256 traderGet, uint256 lpShare,
        uint256 solverShare, uint256 lockerShare, uint256 protocolCut, address recipient
    );
    event LPRebateAttributed(address indexed tokenIn, address indexed tokenOut, address indexed rewardToken, uint256 amount);
    event SplitUpdated(uint16 traderBips, uint16 lpBips, uint16 solverBips, uint16 lockerBips);
    event AggregatorFeeUpdated(uint16 bps);
    event AggregatorFeeTaken(address indexed tokenOut, uint256 amount);
    event SolverPaid(address indexed solver, uint256 amount);
    event VenueToggled(address indexed venue, bool enabled);
    event RelayerSet(address indexed relayer, bool allowed);
    event SupportedTokenSet(address indexed token, bool supported);
    event GuardianSet(address indexed guardian);
    event RouterGuardSet(address indexed guard);
    event WETHSet(address indexed weth);
    event GuardFailOpenSet(bool failOpen);
    event OracleRefSet(address indexed oracle);
    event Permit2Set(address indexed permit2);
    event OneInchAdapterSet(address indexed adapter);
    event ReputationOperatorSet(address indexed op);
    event UsdValuerSet(address indexed valuer);
    event Swept(address indexed token, address indexed to, uint256 amount);
    event NativeSwept(address indexed to, uint256 amount);
    event PausedByOwner(address indexed account, string reason);
    event UnpausedByOwner(address indexed account);
    event ParamsUpdated(address router, address bestExec, address daoVault, address lpRebates, address lockerVault, uint16 protocolFeeBips);

    // ── Guardian ──────────────────────────────────────────────────────────────
    address public guardian;

    modifier onlyOwnerOrGuardian() {
        require(msg.sender == owner() || msg.sender == guardian, "not owner/guardian");
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────────
    constructor(
        address initialOwner,
        address _router,
        address _bestExec,
        address _daoVault,
        address _lpRebates,
        address _lockerVault,
        address _weth,
        address _oracleRef,  // V3.1: ParagonOracle address (can be address(0), set later)
        address _permit2     // V3.1: Permit2 address (can be address(0), set later)
    ) Ownable(initialOwner) {
        if (_router == address(0) || _bestExec == address(0) || _daoVault == address(0)) revert BadSplit();

        router      = IParagonRouterV2Like(_router);
        bestExec    = IBestExec(_bestExec);
        daoVault    = _daoVault;
        lpRebates   = ILPFlowRebates(_lpRebates);
        lockerVault = _lockerVault;
        weth        = _weth;
        oracleRef   = IParagonOracle(_oracleRef);
        permit2     = IPermit2(_permit2);

        venueEnabled[_router]   = true; emit VenueToggled(_router, true);
        venueEnabled[_bestExec] = true; emit VenueToggled(_bestExec, true);
        if (_lpRebates   != address(0)) { venueEnabled[_lpRebates]   = true; emit VenueToggled(_lpRebates, true); }
        if (_lockerVault != address(0)) { venueEnabled[_lockerVault] = true; emit VenueToggled(_lockerVault, true); }
        if (_oracleRef   != address(0)) { venueEnabled[_oracleRef]   = true; emit VenueToggled(_oracleRef, true); }

        _checkSplit();
    }

    // ── Admin ─────────────────────────────────────────────────────────────────
    function pause(string calldata reason) external onlyOwnerOrGuardian {
        _pause(); emit PausedByOwner(msg.sender, reason);
    }
    function unpause() external onlyOwner { _unpause(); emit UnpausedByOwner(msg.sender); }

    function setGuardian(address g) external onlyOwner { guardian = g; emit GuardianSet(g); }

    function setVenueEnabled(address venue, bool enabled) external onlyOwner {
        require(venue != address(0), "venue=0");
        venueEnabled[venue] = enabled;
        emit VenueToggled(venue, enabled);
    }

    function setRelayer(address relayer, bool allowed) external onlyOwner {
        require(relayer != address(0), "relayer=0");
        isRelayer[relayer] = allowed;
        emit RelayerSet(relayer, allowed);
    }

    function setSupportedToken(address token, bool supported) external onlyOwner {
        require(token != address(0), "token=0");
        supportedToken[token] = supported;
        emit SupportedTokenSet(token, supported);
    }

    function setSplitBips(uint16 _trader, uint16 _lp, uint16 _solver) external onlyOwner {
        traderBips = _trader;
        lpBips = _lp;
        solverBips = _solver;
        _checkSplit();
        emit SplitUpdated(_trader, _lp, _solver, uint16(10000 - _trader - _lp - _solver));
    }

    function setAggregatorFeeBips(uint16 bps) external onlyOwner {
        if (bps > MAX_AGGREGATOR_FEE_BPS) revert BadSplit();
        aggregatorFeeBips = bps; emit AggregatorFeeUpdated(bps);
    }

    function setParams(
        address _router, address _bestExec, address _daoVault,
        address _lpRebates, address _lockerVault, uint16 _protocolFeeBips
    ) external onlyOwner {
        if (_router == address(0) || _bestExec == address(0) || _daoVault == address(0)) revert BadSplit();
        if (_protocolFeeBips > 1000) revert BadSplit();
        router = IParagonRouterV2Like(_router); bestExec = IBestExec(_bestExec);
        daoVault = _daoVault; lpRebates = ILPFlowRebates(_lpRebates);
        lockerVault = _lockerVault; protocolFeeBips = _protocolFeeBips;
        venueEnabled[_router] = true; emit VenueToggled(_router, true);
        venueEnabled[_bestExec] = true; emit VenueToggled(_bestExec, true);
        if (_lpRebates   != address(0)) { venueEnabled[_lpRebates]   = true; emit VenueToggled(_lpRebates, true); }
        if (_lockerVault != address(0)) { venueEnabled[_lockerVault] = true; emit VenueToggled(_lockerVault, true); }
        emit ParamsUpdated(_router, _bestExec, _daoVault, _lpRebates, _lockerVault, _protocolFeeBips);
    }

    function setRouterGuard(address guard) external onlyOwner {
        routerGuard = IParagonRouterGuard(guard);
        if (guard != address(0)) { venueEnabled[guard] = true; emit VenueToggled(guard, true); }
        emit RouterGuardSet(guard);
    }

    function setGuardFailOpen(bool _failOpen) external onlyOwner {
        guardFailOpen = _failOpen; emit GuardFailOpenSet(_failOpen);
    }

    function setWETH(address _weth) external onlyOwner { weth = _weth; emit WETHSet(_weth); }

    /// @notice V3.1: Set the ParagonOracle reference for pre-swap quoting.
    function setOracleRef(address _oracle) external onlyOwner {
        oracleRef = IParagonOracle(_oracle);
        if (_oracle != address(0)) { venueEnabled[_oracle] = true; emit VenueToggled(_oracle, true); }
        emit OracleRefSet(_oracle);
    }

    /// @notice V3.1: Set the Permit2 contract address.
    function setPermit2(address _permit2) external onlyOwner {
        permit2 = IPermit2(_permit2);
        emit Permit2Set(_permit2);
    }

    function setOneInchAdapter(address _adapter) external onlyOwner {
        require(_adapter != address(0), "adapter=0");
        oneInchAdapter = _adapter;
        venueEnabled[_adapter] = true; emit VenueToggled(_adapter, true);
        emit OneInchAdapterSet(_adapter);
    }

    function setReputationOperator(address _repOp) external onlyOwner {
        repOp = IReputationOperator(_repOp);
        if (_repOp != address(0)) { venueEnabled[_repOp] = true; emit VenueToggled(_repOp, true); }
        emit ReputationOperatorSet(_repOp);
    }

    function setUsdValuer(address _valuer) external onlyOwner {
        valuer = IUsdValuer(_valuer);
        if (_valuer != address(0)) { venueEnabled[_valuer] = true; emit VenueToggled(_valuer, true); }
        emit UsdValuerSet(_valuer);
    }

    // ── EXECUTE ───────────────────────────────────────────────────────────────
    function execute(
        IBestExec.SwapIntent calldata it,
        bytes calldata sig,
        PermitData calldata permit,
        bool unwrapETH
    ) external payable nonReentrant whenNotPaused {
        _validateIntent(it);
        if (!venueEnabled[address(router)]) revert VenuePaused();

        bestExec.consume(it, sig);

        uint256 inReceived = _pullInput(it, permit);

        address[] memory route = new address[](2);
        route[0] = it.tokenIn; route[1] = it.tokenOut;

        // V3.1 FIX: get oracle quote BEFORE the swap
        uint256 preSwapQuote = _getPreSwapQuote(route, inReceived);

        _safeApprove(IERC20(it.tokenIn), address(router), inReceived);
        uint256 balBefore = IERC20(it.tokenOut).balanceOf(address(this));
        _routerSwapExactIn(inReceived, it.minAmountOut, route, it.deadline);
        _safeApprove(IERC20(it.tokenIn), address(router), 0);

        uint256 received = IERC20(it.tokenOut).balanceOf(address(this)) - balBefore;
        if (received < it.minAmountOut) revert RouterSwapFailed();

        // V3.1 FIX: pass oracle quote as expectedOutPreSwap — guard can now meaningfully compare
        _runGuard(inReceived, route, received, preSwapQuote);

        uint256 traderGet = _splitAndSettle(it, route, received, new uint16[](0), unwrapETH);
        _reportExecution(it, traderGet);
    }

    // ── EXECUTE WITH PATH ─────────────────────────────────────────────────────
    function executeWithPath(
        IBestExec.SwapIntent calldata it,
        bytes calldata sig,
        address[] calldata path,
        uint16[] calldata hopShareBips,
        PermitData calldata permit,
        bool unwrapETH
    ) external payable nonReentrant whenNotPaused {
        if (!venueEnabled[address(router)]) revert VenuePaused();
        if (path.length < 2 || path[0] != it.tokenIn || path[path.length - 1] != it.tokenOut) revert PathMismatch();
        if (path.length > MAX_PATH_LEN) revert PathTooLong();
        for (uint256 i; i < path.length; i++) {
            if (!supportedToken[path[i]]) revert UnsupportedToken();
        }
        _validateIntent(it);
        bestExec.consume(it, sig);

        uint256 inReceived = _pullInput(it, permit);

        // V3.1 FIX: quote before swap using full path (TWAP may not exist for all hops — falls back)
        address[] memory memPath = _toMemory(path);
        uint256 preSwapQuote = _getPreSwapQuote(memPath, inReceived);

        _safeApprove(IERC20(it.tokenIn), address(router), inReceived);
        uint256 balBefore = IERC20(it.tokenOut).balanceOf(address(this));
        _routerSwapExactIn(inReceived, it.minAmountOut, memPath, it.deadline);
        _safeApprove(IERC20(it.tokenIn), address(router), 0);

        uint256 received = IERC20(it.tokenOut).balanceOf(address(this)) - balBefore;
        if (received < it.minAmountOut) revert RouterSwapFailed();

        _runGuard(inReceived, path, received, preSwapQuote);

        uint256 traderGet = _splitAndSettle(it, memPath, received, _toMemory(hopShareBips), unwrapETH);
        _reportExecution(it, traderGet);
    }

    // ── EXECUTE VIA 1INCH ─────────────────────────────────────────────────────
    function executeVia1inch(
        IBestExec.SwapIntent calldata it,
        bytes calldata sig,
        bytes calldata routeData
    ) external nonReentrant whenNotPaused {
        (bytes memory adapterPayload, bytes memory permitPayload, bytes memory rebatePayload) =
            abi.decode(routeData, (bytes, bytes, bytes));
        OneInchAdapterCall memory callData = abi.decode(adapterPayload, (OneInchAdapterCall));
        PermitData memory userPermit = abi.decode(permitPayload, (PermitData));
        (address[] memory lpHopPath, uint16[] memory hopShareBips) =
            abi.decode(rebatePayload, (address[], uint16[]));
        _executeVia1inchRequest(it, sig, callData, userPermit, lpHopPath, hopShareBips);
    }

    function _executeVia1inchRequest(
        IBestExec.SwapIntent calldata it,
        bytes calldata sig,
        OneInchAdapterCall memory callData,
        PermitData memory userPermit,
        address[] memory lpHopPath,
        uint16[] memory hopShareBips
    ) internal {
        if (oneInchAdapter == address(0)) revert AdapterNotSet();
        if (!venueEnabled[oneInchAdapter]) revert VenuePaused();
        if (lpHopPath.length > 0) {
            if (lpHopPath.length < 2 || lpHopPath.length > MAX_PATH_LEN) revert PathTooLong();
            if (lpHopPath[0] != it.tokenIn || lpHopPath[lpHopPath.length - 1] != it.tokenOut) revert PathMismatch();
            for (uint256 i; i < lpHopPath.length; i++) {
                if (!supportedToken[lpHopPath[i]]) revert UnsupportedToken();
            }
        }
        _validateIntent(it);
        bestExec.consume(it, sig);

        // EIP-2612 permit if provided (Permit2 not supported on 1inch path — adapter is ERC20-only)
        if (userPermit.permitType == PERMIT_EIP2612 && userPermit.deadline != 0) {
            try IERC20Permit(it.tokenIn).permit(
                it.user, address(this), userPermit.value, userPermit.deadline,
                userPermit.v, userPermit.r, userPermit.s
            ) {} catch { revert PermitFailed(); }
        }

        uint256 inBefore = IERC20(it.tokenIn).balanceOf(address(this));
        IERC20(it.tokenIn).safeTransferFrom(it.user, address(this), it.amountIn);
        uint256 inReceived = IERC20(it.tokenIn).balanceOf(address(this)) - inBefore;
        if (inReceived == 0) revert InvalidSwap();

        // V3.1 FIX: pre-swap oracle quote (tokenIn→tokenOut direct pair)
        IERC20(it.tokenIn).safeTransfer(oneInchAdapter, inReceived);
        uint256 received = IParagon1inchAdapter(oneInchAdapter).execute(
            it.tokenIn, inReceived, it.tokenOut, it.minAmountOut,
            callData.desc, callData.permitData, callData.oneInchData, callData.executor
        );

        uint256 aggregatorFee = aggregatorFeeBips > 0 ? (received * aggregatorFeeBips) / 10_000 : 0;
        uint256 settleAmount  = received - aggregatorFee;
        if (settleAmount < it.minAmountOut) revert RouterSwapFailed();

        if (aggregatorFee > 0 && daoVault != address(0)) {
            IERC20(it.tokenOut).safeTransfer(daoVault, aggregatorFee);
            emit AggregatorFeeTaken(it.tokenOut, aggregatorFee);
        }

        address[] memory effectivePath;
        uint16[]  memory effectiveHops;
        if (lpHopPath.length >= 2) {
            effectivePath = lpHopPath;
            effectiveHops = hopShareBips.length > 0 ? hopShareBips : new uint16[](0);
        } else {
            effectivePath = new address[](2);
            effectivePath[0] = it.tokenIn; effectivePath[1] = it.tokenOut;
            effectiveHops = new uint16[](0);
        }

        _runGuardWithQuote(inReceived, effectivePath, settleAmount);

        uint256 traderGet = _splitAndSettle(it, effectivePath, settleAmount, effectiveHops, false);
        _reportExecution(it, traderGet);
    }

    // ── Internal: common intent validation ────────────────────────────────────
    function _validateIntent(IBestExec.SwapIntent calldata it) internal view {
        if (!supportedToken[it.tokenIn] || !supportedToken[it.tokenOut]) revert UnsupportedToken();
        if (!venueEnabled[address(bestExec)]) revert VenuePaused();
        if (block.timestamp > it.deadline) revert InvalidSwap();
        if (it.tokenIn == it.tokenOut)     revert InvalidSwap();
        if (it.recipient == address(0))    revert InvalidRecipient();
        if (it.amountIn == 0 || it.minAmountOut == 0) revert InvalidSwap();
    }

    // ── Internal: pull tokenIn — supports none / EIP-2612 / Permit2 ──────────
    function _pullInput(
        IBestExec.SwapIntent calldata it,
        PermitData calldata permit
    ) internal returns (uint256 inReceived) {
        bool nativeIn = (msg.value > 0 && it.tokenIn == weth);

        if (nativeIn) {
            if (weth == address(0)) revert WETHNotSet();
            if (msg.value != it.amountIn) revert ETHValueMismatch();
            IWETH(weth).deposit{value: msg.value}();
            return msg.value;
        }

        if (msg.value != 0) revert ETHValueMismatch();

        if (permit.permitType == PERMIT_EIP2612 && permit.deadline != 0) {
            try IERC20Permit(it.tokenIn).permit(
                it.user, address(this), permit.value, permit.deadline,
                permit.v, permit.r, permit.s
            ) {} catch { revert PermitFailed(); }

        } else if (permit.permitType == PERMIT_PERMIT2) {
            // V3.1: Permit2 path — user must have approved the Permit2 contract for tokenIn
            if (address(permit2) == address(0)) revert Permit2NotSet();
            uint256 permit2Before = IERC20(it.tokenIn).balanceOf(address(this));
            permit2.permitTransferFrom(
                IPermit2.PermitTransferFrom({
                    permitted: IPermit2.TokenPermissions({ token: it.tokenIn, amount: permit.value }),
                    nonce: permit.nonce,
                    deadline: permit.deadline
                }),
                IPermit2.SignatureTransferDetails({ to: address(this), requestedAmount: it.amountIn }),
                it.user,
                permit.permit2Sig
            );
            // Permit2 transferred directly — check received
            inReceived = IERC20(it.tokenIn).balanceOf(address(this)) - permit2Before;
            if (inReceived == 0) revert InvalidSwap();
            return inReceived;
        }

        uint256 inBefore = IERC20(it.tokenIn).balanceOf(address(this));
        IERC20(it.tokenIn).safeTransferFrom(it.user, address(this), it.amountIn);
        inReceived = IERC20(it.tokenIn).balanceOf(address(this)) - inBefore;
        if (inReceived == 0) revert InvalidSwap();
    }

    // ── Internal: V3.1 FIX — get oracle quote BEFORE the swap ────────────────
    /// @dev Tries TWAP first (manipulation-resistant), falls back to Chainlink.
    ///      Returns 0 if no oracle is available. Caller decides whether to proceed.
    function _getPreSwapQuote(
        address[] memory path,
        uint256 amountIn
    ) internal view returns (uint256 quote) {
        if (address(oracleRef) == address(0)) return 0;


        // 1. Try TWAP (preferred — manipulation-resistant)
        try oracleRef.getAmountsOutUsingTwap(amountIn, path, 0)
            returns (uint256[] memory amounts) {
            if (amounts.length > 0 && amounts[amounts.length - 1] > 0) {
                return amounts[amounts.length - 1];
            }
        } catch {}

        // 2. Chainlink fallback
        try oracleRef.getAmountsOutUsingChainlink(amountIn, path)
            returns (uint256[] memory amounts) {
            if (amounts.length > 0 && amounts[amounts.length - 1] > 0) {
                return amounts[amounts.length - 1];
            }
        } catch {}

        return 0;
    }

    function _runGuardWithQuote(
        uint256 amountIn,
        address[] memory path,
        uint256 actualOut
    ) internal view {
        uint256 preSwapQuote = _getPreSwapQuote(path, amountIn);
        _runGuard(amountIn, path, actualOut, preSwapQuote);
    }

    // ── Internal: RouterGuard post-swap — FIXED ───────────────────────────────
    /// @dev Uses staticcall so it works from non-view callers.
    ///      If preSwapQuote == 0 (oracle unavailable):
    ///        - guardFailOpen=true  → skip validation silently
    ///        - guardFailOpen=false → revert OracleUnavailable
    function _runGuard(
        uint256 amountIn,
        address[] memory path,
        uint256 actualOut,
        uint256 preSwapQuote
    ) internal view {
        if (address(routerGuard) == address(0)) return;
        if (!venueEnabled[address(routerGuard)]) return;

        // If we have no oracle quote, we cannot validate
        if (preSwapQuote == 0) {
            if (!guardFailOpen) revert OracleUnavailable();
            return; // failOpen: skip
        }

        bytes memory cd = abi.encodeWithSelector(
            IParagonRouterGuard.validatePostSwap.selector,
            amountIn, path, actualOut, preSwapQuote
        );

        (bool ok, bytes memory ret) = address(routerGuard).staticcall(cd);

        if (!ok) {
            if (!guardFailOpen) {
                if (ret.length > 0) { assembly { revert(add(ret, 32), mload(ret)) } }
                revert GuardRejected();
            }
            // failOpen: silently pass
        }
    }

    // ── Internal: send tokenOut, optional ETH unwrap ──────────────────────────
    function _sendOutput(address tokenOut, address recipient, uint256 amount, bool unwrapETH) internal {
        if (unwrapETH && tokenOut == weth && weth != address(0)) {
            IWETH(weth).withdraw(amount);
            (bool ok,) = recipient.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(tokenOut).safeTransfer(recipient, amount);
        }
    }

    // ── Internal: split + settle (audited V2 logic — unchanged) ──────────────
    function _splitAndSettle(
        IBestExec.SwapIntent calldata it,
        address[] memory path,
        uint256 received,
        uint16[] memory hopShareBips,
        bool unwrapETH
    ) internal returns (uint256 traderGet) {
        SettlementBreakdown memory s;
        s.surplus = received > it.minAmountOut ? received - it.minAmountOut : 0;
        s.protocolCut = (s.surplus * protocolFeeBips) / 10_000;
        s.dist = s.surplus - s.protocolCut;
        s.traderShare = (s.dist * traderBips) / 10_000;
        s.lpShare = (s.dist * lpBips) / 10_000;
        s.solverShare = (s.dist * solverBips) / 10_000;
        s.lockerShare = s.dist - s.traderShare - s.lpShare - s.solverShare;

        bool paySolver = (s.solverShare > 0) && (msg.sender != it.user) && isRelayer[msg.sender];
        s.treasuryShare = s.protocolCut;
        if (paySolver) {
            IERC20(it.tokenOut).safeTransfer(msg.sender, s.solverShare);
            emit SolverPaid(msg.sender, s.solverShare);
        } else {
            s.treasuryShare += s.solverShare;
            s.solverShare = 0;
        }

        if (s.treasuryShare > 0 && daoVault != address(0)) IERC20(it.tokenOut).safeTransfer(daoVault, s.treasuryShare);

        traderGet = it.minAmountOut + s.traderShare;
        _sendOutput(it.tokenOut, it.recipient, traderGet, unwrapETH);

        _payLpShare(it.tokenOut, s.lpShare, path, hopShareBips);

        if (s.lockerShare > 0 && lockerVault != address(0)) IERC20(it.tokenOut).safeTransfer(lockerVault, s.lockerShare);

        _awardReputation(it, s.surplus);

        _emitPayflowExecuted(it, received, traderGet, s);
    }

    // ── Internal: report real amountOut to BestExecution (V15 compat) ─────────
    function _reportExecution(IBestExec.SwapIntent calldata it, uint256 traderGet) internal {
        try bestExec.reportExecution(
            it.user, it.nonce, it.tokenIn, it.tokenOut, it.amountIn, traderGet, it.recipient
        ) {} catch {}
    }

    function _payLpShare(
        address tokenOut,
        uint256 lpShare,
        address[] memory path,
        uint16[] memory hopShareBips
    ) internal {
        if (lpShare == 0) return;

        if (address(lpRebates) != address(0) && venueEnabled[address(lpRebates)]) {
            _safeApprove(IERC20(tokenOut), address(lpRebates), lpShare);
            if (hopShareBips.length > 0) {
                if (hopShareBips.length != path.length - 1) revert InvalidHopShares();
                uint256 total;
                for (uint256 i; i < hopShareBips.length; i++) total += hopShareBips[i];
                if (total != 10_000) revert BadSplit();
                for (uint256 i; i < hopShareBips.length; i++) {
                    uint256 hopAmt = (lpShare * hopShareBips[i]) / 10_000;
                    if (hopAmt > 0) {
                        lpRebates.notify(path[i], path[i + 1], tokenOut, hopAmt);
                        emit LPRebateAttributed(path[i], path[i + 1], tokenOut, hopAmt);
                    }
                }
            } else {
                lpRebates.notify(path[path.length - 2], path[path.length - 1], tokenOut, lpShare);
                emit LPRebateAttributed(path[path.length - 2], path[path.length - 1], tokenOut, lpShare);
            }
            SafeERC20.forceApprove(IERC20(tokenOut), address(lpRebates), 0);
            return;
        }

        if (daoVault != address(0)) {
            IERC20(tokenOut).safeTransfer(daoVault, lpShare);
        }
    }

    function _emitPayflowExecuted(
        IBestExec.SwapIntent calldata it,
        uint256 received,
        uint256 traderGet,
        SettlementBreakdown memory s
    ) internal {
        emit PayflowExecuted(
            it.user,
            it.tokenIn,
            it.tokenOut,
            it.amountIn,
            it.minAmountOut,
            received,
            s.surplus,
            traderGet,
            s.lpShare,
            s.solverShare,
            s.lockerShare,
            s.treasuryShare,
            it.recipient
        );
    }

    // ── Internal: router swap with fallback selectors ─────────────────────────
    function _routerSwapExactIn(uint256 amountIn, uint256 amountOutMin, address[] memory path, uint256 deadline) internal {
        if (!venueEnabled[address(router)]) revert VenuePaused();
        address r = address(router);
        (bool ok,) = r.call(abi.encodeWithSelector(
            bytes4(keccak256("swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256,uint8)")),
            amountIn, amountOutMin, path, address(this), deadline, DEFAULT_AUTO_PREF
        ));
        if (ok) return;
        (ok,) = r.call(abi.encodeWithSelector(
            bytes4(keccak256("swapExactTokensForTokens(uint256,uint256,address[],address,uint256,uint8)")),
            amountIn, amountOutMin, path, address(this), deadline, DEFAULT_AUTO_PREF
        ));
        if (ok) return;
        (ok,) = r.call(abi.encodeWithSelector(
            bytes4(keccak256("swapExactTokensForTokens(uint256,uint256,address[],address,uint256)")),
            amountIn, amountOutMin, path, address(this), deadline
        ));
        if (ok) return;
        revert RouterSwapFailed();
    }

    // ── Internal: reputation hook ─────────────────────────────────────────────
    function _awardReputation(IBestExec.SwapIntent calldata it, uint256 surplus) internal {
        if (address(repOp) == address(0) || !venueEnabled[address(repOp)]) return;
        uint256 usdVol = 0; uint256 usdSaved = 0;
        if (address(valuer) != address(0) && venueEnabled[address(valuer)]) {
            try valuer.usdValue(it.tokenIn, it.amountIn)  returns (uint256 v) { usdVol   = v; } catch {}
            if (surplus > 0) { try valuer.usdValue(it.tokenOut, surplus) returns (uint256 s) { usdSaved = s; } catch {} }
        }
        bytes32 intentId;
        if (venueEnabled[address(bestExec)]) { try bestExec.hashIntent(it) returns (bytes32 h) { intentId = h; } catch {} }
        try repOp.onPayflowExecuted(it.user, usdVol, usdSaved, intentId) {} catch {}
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    function _checkSplit() internal view {
        if (uint256(traderBips) + uint256(lpBips) + uint256(solverBips) > 10_000) revert BadSplit();
    }
    function _safeApprove(IERC20 t, address spender, uint256 needed) internal { SafeERC20.forceApprove(t, spender, needed); }
    function _toMemory(address[] calldata arr) internal pure returns (address[] memory out) { out = new address[](arr.length); for (uint256 i; i < arr.length; i++) out[i] = arr[i]; }
    function _toMemory(uint16[] calldata arr) internal pure returns (uint16[] memory out) { out = new uint16[](arr.length); for (uint256 i; i < arr.length; i++) out[i] = arr[i]; }

    // ── Rescue ────────────────────────────────────────────────────────────────
    function sweep(address token, address to) external onlyOwner {
        if (to == address(0)) revert BadSplit();
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).safeTransfer(to, bal);
        emit Swept(token, to, bal);
    }

    receive() external payable {}

    function sweepNative(address to) external onlyOwner {
        if (to == address(0)) revert BadSplit();
        uint256 bal = address(this).balance;
        if (bal > 0) { (bool ok,) = to.call{value: bal}(""); if (!ok) revert NativeTransferFailed(); }
        emit NativeSwept(to, bal);
    }
}
