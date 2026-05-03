// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.25;
/*
 * Paragon Flow DEX — Core contracts
 * ParagonPayflowExecutorUpdate — V3
 *
 * DO NOT modify audited ParagonPayflowExecutorV2 / ParagonPayflowExecutorV2-aggregator.
 * Deploy this contract fresh and point it at ParagonBestExecutionUpdate.
 *
 * Changes over V2-aggregator:
 *  1. ROUTERGUARD INTEGRATION
 *       validatePostSwap() is called after every swap (Paragon AMM and 1inch paths).
 *       RouterGuard is optional (address(0) = disabled). Guardian can disable it.
 *       failOpen semantics: if guard reverts unexpectedly, behavior controlled by guardFailOpen flag.
 *
 *  2. NATIVE ETH / WETH SUPPORT
 *       execute() and executeWithPath() accept msg.value.
 *       If tokenIn is WETH and msg.value == amountIn, ETH is deposited to WETH before swap.
 *       If tokenOut is WETH and recipient wants native ETH, unwrap and send ETH.
 *       executeVia1inch() does NOT support native ETH (1inch adapter is ERC20-only).
 *
 *  3. LP ATTRIBUTION FIX FOR 1INCH MULTI-HOP
 *       executeVia1inch() now accepts an optional `lpHopPath` parameter: the actual
 *       intermediate token path the 1inch route traversed. LP rebates are attributed
 *       per-hop using this path instead of the dummy [tokenIn, tokenOut] 2-element array.
 *       If lpHopPath is empty, falls back to [tokenIn, tokenOut] (backward compatible).
 *
 *  4. REAL amountOut REPORTED TO BESTEXECUTION
 *       After every successful swap + settle, reportExecution() is called on
 *       ParagonBestExecutionUpdate so the BestExecution event has real fill data.
 *       Falls back gracefully if bestExec is a V14 contract (no reportExecution).
 *
 * All audited V2 logic preserved: reentrancy guard, pause, venue toggles, surplus
 * split math, relayer fee deduction order, permit handling, reputation hooks,
 * guardian pattern, sweep functions.
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

import { IUsdValuer } from "./interfaces/IUsdValuer.sol";
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

/// @dev Matches ParagonBestExecutionUpdate. Also backward-compatible with V14 via try/catch.
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
    // V15 only — called after swap settles
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

/// @dev Minimal RouterGuard interface used by this contract.
interface IParagonRouterGuard {
    function validatePostSwap(
        uint256 effectiveIn,
        address[] calldata path,
        uint256 actualOut,
        uint256 expectedOutPreSwap
    ) external view;
}

interface IParagonOracle {
    function getAmountsOutUsingTwap(uint256 amountIn, address[] memory path, uint32 timeWindow)
        external view returns (uint256[] memory amounts);
    function getAmountsOutUsingChainlink(uint256 amountIn, address[] memory path)
        external view returns (uint256[] memory amounts);
}

// ─── Executor V3 ─────────────────────────────────────────────────────────────

contract ParagonPayflowExecutorUpdate is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ── Core addresses ────────────────────────────────────────────────────────
    IParagonRouterV2Like public router;
    IBestExec            public bestExec;
    IReputationOperator  public repOp;         // optional
    IUsdValuer           public valuer;        // optional
    address              public daoVault;
    address              public lockerVault;
    ILPFlowRebates       public lpRebates;
    address              public oneInchAdapter;

    // V3: RouterGuard + WETH
    IParagonRouterGuard  public routerGuard;   // optional; address(0) = disabled
    address              public weth;          // WETH contract for native ETH wrap/unwrap
    IParagonOracle       public oracleRef;     // optional; used for meaningful pre-swap guard quotes

    // ── Fee config (unchanged from V2) ───────────────────────────────────────
    uint16 public protocolFeeBips;
    uint16 public traderBips    = 6000;  // 60%
    uint16 public lpBips        = 1000;  // 10%
    uint16 public solverBips    = 2000;  // 20%
    uint16 public aggregatorFeeBips;

    uint16 public constant MAX_AGGREGATOR_FEE_BPS = 100;  // 1.00%
    uint8  public constant MAX_PATH_LEN           = 5;
    uint8  public constant DEFAULT_AUTO_PREF      = 0;

    // ── Guard config ──────────────────────────────────────────────────────────
    // If true, a RouterGuard revert is tolerated (logs warning, swap still settles).
    bool public guardFailOpen = false;

    // ── Allowlists ───────────────────────────────────────────────────────────
    mapping(address => bool) public supportedToken;
    mapping(address => bool) public venueEnabled;
    mapping(address => bool) public isRelayer;

    // ── Structs ───────────────────────────────────────────────────────────────
    struct PermitData {
        uint256 value;
        uint256 deadline;
        uint8   v;
        bytes32 r;
        bytes32 s;
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
    error OracleUnavailable();

    // ── Events ────────────────────────────────────────────────────────────────
    event PayflowExecuted(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 minOut,
        uint256 amountOut,
        uint256 surplus,
        uint256 traderGet,
        uint256 lpShare,
        uint256 solverShare,
        uint256 lockerShare,
        uint256 protocolCut,
        address recipient
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
    event OneInchAdapterSet(address indexed adapter);
    event ReputationOperatorSet(address indexed op);
    event UsdValuerSet(address indexed valuer);
    event Swept(address indexed token, address indexed to, uint256 amount);
    event NativeSwept(address indexed to, uint256 amount);
    event PausedByOwner(address indexed account, string reason);
    event UnpausedByOwner(address indexed account);
    event ParamsUpdated(address router, address bestExec, address daoVault, address lpRebates, address lockerVault, uint16 protocolFeeBips);
    event GuardSkipped(string reason); // emitted when guardFailOpen=true and guard reverts

    // ── Guardian ─────────────────────────────────────────────────────────────
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
        address _weth         // can be address(0) to defer; set via setWETH later
    ) Ownable(initialOwner) {
        if (_router == address(0) || _bestExec == address(0) || _daoVault == address(0)) revert BadSplit();

        router      = IParagonRouterV2Like(_router);
        bestExec    = IBestExec(_bestExec);
        daoVault    = _daoVault;
        lpRebates   = ILPFlowRebates(_lpRebates);
        lockerVault = _lockerVault;
        weth        = _weth;

        venueEnabled[_router]    = true;  emit VenueToggled(_router, true);
        venueEnabled[_bestExec]  = true;  emit VenueToggled(_bestExec, true);
        if (_lpRebates   != address(0)) { venueEnabled[_lpRebates]   = true; emit VenueToggled(_lpRebates, true); }
        if (_lockerVault != address(0)) { venueEnabled[_lockerVault] = true; emit VenueToggled(_lockerVault, true); }

        _checkSplit();
    }

    // ── Admin ─────────────────────────────────────────────────────────────────
    function pause(string calldata reason) external onlyOwnerOrGuardian {
        _pause();
        emit PausedByOwner(msg.sender, reason);
    }

    function unpause() external onlyOwner {
        _unpause();
        emit UnpausedByOwner(msg.sender);
    }

    function setGuardian(address g) external onlyOwner {
        guardian = g;
        emit GuardianSet(g);
    }

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
        lpBips     = _lp;
        solverBips = _solver;
        _checkSplit();
        emit SplitUpdated(_trader, _lp, _solver, uint16(10000 - _trader - _lp - _solver));
    }

    function setAggregatorFeeBips(uint16 bps) external onlyOwner {
        if (bps > MAX_AGGREGATOR_FEE_BPS) revert BadSplit();
        aggregatorFeeBips = bps;
        emit AggregatorFeeUpdated(bps);
    }

    function setParams(
        address _router, address _bestExec, address _daoVault,
        address _lpRebates, address _lockerVault, uint16 _protocolFeeBips
    ) external onlyOwner {
        if (_router == address(0) || _bestExec == address(0) || _daoVault == address(0)) revert BadSplit();
        if (_protocolFeeBips > 1000) revert BadSplit();

        router      = IParagonRouterV2Like(_router);
        bestExec    = IBestExec(_bestExec);
        daoVault    = _daoVault;
        lpRebates   = ILPFlowRebates(_lpRebates);
        lockerVault = _lockerVault;
        protocolFeeBips = _protocolFeeBips;

        venueEnabled[_router]   = true; emit VenueToggled(_router, true);
        venueEnabled[_bestExec] = true; emit VenueToggled(_bestExec, true);
        if (_lpRebates   != address(0)) { venueEnabled[_lpRebates]   = true; emit VenueToggled(_lpRebates, true); }
        if (_lockerVault != address(0)) { venueEnabled[_lockerVault] = true; emit VenueToggled(_lockerVault, true); }

        emit ParamsUpdated(_router, _bestExec, _daoVault, _lpRebates, _lockerVault, _protocolFeeBips);
    }

    // V3: RouterGuard + WETH setters
    function setRouterGuard(address guard) external onlyOwner {
        routerGuard = IParagonRouterGuard(guard);
        if (guard != address(0)) { venueEnabled[guard] = true; emit VenueToggled(guard, true); }
        emit RouterGuardSet(guard);
    }

    function setGuardFailOpen(bool _failOpen) external onlyOwner {
        guardFailOpen = _failOpen;
        emit GuardFailOpenSet(_failOpen);
    }

    function setWETH(address _weth) external onlyOwner {
        weth = _weth;
        emit WETHSet(_weth);
    }

    function setOracleRef(address _oracle) external onlyOwner {
        oracleRef = IParagonOracle(_oracle);
        if (_oracle != address(0)) { venueEnabled[_oracle] = true; emit VenueToggled(_oracle, true); }
        emit OracleRefSet(_oracle);
    }

    function setOneInchAdapter(address _adapter) external onlyOwner {
        require(_adapter != address(0), "adapter=0");
        oneInchAdapter = _adapter;
        venueEnabled[_adapter] = true;
        emit VenueToggled(_adapter, true);
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

    // ── EXECUTE — simple 2-hop, native ETH supported ──────────────────────────
    /**
     * @notice Execute a signed swap intent via Paragon AMM.
     * @dev    Native ETH: if tokenIn == weth and msg.value == amountIn, ETH is wrapped
     *         automatically. If tokenOut == weth and unwrapETH == true, output is unwrapped
     *         and sent as native ETH to recipient.
     * @param unwrapETH If true and tokenOut is WETH, unwrap and send ETH to recipient.
     */
    function execute(
        IBestExec.SwapIntent calldata it,
        bytes calldata sig,
        PermitData calldata permit,
        bool unwrapETH
    ) external payable nonReentrant whenNotPaused {
        if (!supportedToken[it.tokenIn] || !supportedToken[it.tokenOut]) revert UnsupportedToken();
        if (!venueEnabled[address(bestExec)]) revert VenuePaused();
        if (!venueEnabled[address(router)])   revert VenuePaused();
        if (block.timestamp > it.deadline)    revert InvalidSwap();
        if (it.tokenIn == it.tokenOut)        revert InvalidSwap();
        if (it.recipient == address(0))       revert InvalidRecipient();
        if (it.amountIn == 0 || it.minAmountOut == 0) revert InvalidSwap();

        bestExec.consume(it, sig);

        uint256 inReceived = _pullInput(it, permit);

        _safeApprove(IERC20(it.tokenIn), address(router), inReceived);

        address[] memory route = new address[](2);
        route[0] = it.tokenIn;
        route[1] = it.tokenOut;

        uint256 preSwapQuote = _getPreSwapQuote(route, inReceived);

        uint256 balBefore = IERC20(it.tokenOut).balanceOf(address(this));
        _routerSwapExactIn(inReceived, it.minAmountOut, route, it.deadline);
        _safeApprove(IERC20(it.tokenIn), address(router), 0);

        uint256 received = IERC20(it.tokenOut).balanceOf(address(this)) - balBefore;
        if (received < it.minAmountOut) revert RouterSwapFailed();

        // V3: post-swap oracle guard
        _runGuard(inReceived, route, received, preSwapQuote);

        uint256 traderGet = _splitAndSettle(it, route, received, new uint16[](0), unwrapETH);
        _reportExecution(it, traderGet);
    }

    // ── EXECUTE WITH PATH — multi-hop, native ETH supported ──────────────────
    function executeWithPath(
        IBestExec.SwapIntent calldata it,
        bytes calldata sig,
        address[] calldata path,
        uint16[] calldata hopShareBips,
        PermitData calldata permit,
        bool unwrapETH
    ) external payable nonReentrant whenNotPaused {
        if (!venueEnabled[address(bestExec)]) revert VenuePaused();
        if (!venueEnabled[address(router)])   revert VenuePaused();

        if (path.length < 2 || path[0] != it.tokenIn || path[path.length - 1] != it.tokenOut) revert PathMismatch();
        if (path.length > MAX_PATH_LEN) revert PathTooLong();
        for (uint256 i; i < path.length; i++) {
            if (!supportedToken[path[i]]) revert UnsupportedToken();
        }

        if (it.tokenIn == it.tokenOut)        revert InvalidSwap();
        if (it.recipient == address(0))       revert InvalidRecipient();
        if (it.amountIn == 0 || it.minAmountOut == 0) revert InvalidSwap();
        if (block.timestamp > it.deadline)    revert InvalidSwap();

        bestExec.consume(it, sig);

        uint256 inReceived = _pullInput(it, permit);

        address[] memory memPath = _toMemory(path);
        uint256 preSwapQuote = _getPreSwapQuote(memPath, inReceived);

        _safeApprove(IERC20(it.tokenIn), address(router), inReceived);

        uint256 balBefore = IERC20(it.tokenOut).balanceOf(address(this));
        _routerSwapExactIn(inReceived, it.minAmountOut, memPath, it.deadline);
        _safeApprove(IERC20(it.tokenIn), address(router), 0);

        uint256 received = IERC20(it.tokenOut).balanceOf(address(this)) - balBefore;
        if (received < it.minAmountOut) revert RouterSwapFailed();

        _runGuard(inReceived, memPath, received, preSwapQuote);

        uint256 traderGet = _splitAndSettle(it, memPath, received, _toMemory(hopShareBips), unwrapETH);
        _reportExecution(it, traderGet);
    }

    // ── EXECUTE VIA 1INCH — LP attribution fix + guard ────────────────────────
    /**
     * @notice Execute via the 1inch adapter.
     * @dev routeData encodes OneInchRequest with adapter payload, permit, and rebate path data.
     */
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
        if (oneInchAdapter == address(0))       revert AdapterNotSet();
        if (!venueEnabled[address(bestExec)])   revert VenuePaused();
        if (!venueEnabled[oneInchAdapter])      revert VenuePaused();
        if (!supportedToken[it.tokenIn] || !supportedToken[it.tokenOut]) revert UnsupportedToken();

        if (block.timestamp > it.deadline)       revert InvalidSwap();
        if (it.tokenIn == it.tokenOut)           revert InvalidSwap();
        if (it.recipient == address(0))          revert InvalidRecipient();
        if (it.amountIn == 0 || it.minAmountOut == 0) revert InvalidSwap();

        // Validate lpHopPath if provided
        if (lpHopPath.length > 0) {
            if (lpHopPath.length < 2) revert PathMismatch();
            if (lpHopPath.length > MAX_PATH_LEN) revert PathTooLong();
            if (lpHopPath[0] != it.tokenIn || lpHopPath[lpHopPath.length - 1] != it.tokenOut) revert PathMismatch();
            for (uint256 i; i < lpHopPath.length; i++) {
                if (!supportedToken[lpHopPath[i]]) revert UnsupportedToken();
            }
        }

        bestExec.consume(it, sig);

        if (userPermit.deadline != 0) {
            try IERC20Permit(it.tokenIn).permit(
                it.user, address(this), userPermit.value, userPermit.deadline,
                userPermit.v, userPermit.r, userPermit.s
            ) {} catch { revert PermitFailed(); }
        }

        uint256 inBefore = IERC20(it.tokenIn).balanceOf(address(this));
        IERC20(it.tokenIn).safeTransferFrom(it.user, address(this), it.amountIn);
        uint256 inReceived = IERC20(it.tokenIn).balanceOf(address(this)) - inBefore;
        if (inReceived == 0) revert InvalidSwap();

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

        // V3: use lpHopPath if provided, otherwise fall back to [tokenIn, tokenOut]
        address[] memory effectivePath;
        uint16[]  memory effectiveHops;

        if (lpHopPath.length >= 2) {
            effectivePath = lpHopPath;
            effectiveHops = hopShareBips.length > 0 ? hopShareBips : new uint16[](0);
        } else {
            effectivePath    = new address[](2);
            effectivePath[0] = it.tokenIn;
            effectivePath[1] = it.tokenOut;
            effectiveHops    = new uint16[](0);
        }

        address[] memory guardPath = effectivePath;
        uint256 preSwapQuote = _getPreSwapQuote(guardPath, inReceived);
        _runGuard(inReceived, guardPath, settleAmount, preSwapQuote);

        uint256 traderGet = _splitAndSettle(it, effectivePath, settleAmount, effectiveHops, false);
        _reportExecution(it, traderGet);
    }

    // ── Internal: pull tokenIn from user (with optional ETH wrap) ─────────────
    function _pullInput(
        IBestExec.SwapIntent calldata it,
        PermitData calldata permit
    ) internal returns (uint256 inReceived) {
        bool nativeIn = (msg.value > 0 && it.tokenIn == weth);

        if (nativeIn) {
            // Native ETH path: wrap on behalf of user
            if (weth == address(0)) revert WETHNotSet();
            if (msg.value != it.amountIn) revert ETHValueMismatch();
            IWETH(weth).deposit{value: msg.value}();
            inReceived = msg.value;
        } else {
            if (msg.value != 0) revert ETHValueMismatch(); // reject accidental ETH
            if (permit.deadline != 0) {
                try IERC20Permit(it.tokenIn).permit(
                    it.user, address(this), permit.value, permit.deadline,
                    permit.v, permit.r, permit.s
                ) {} catch { revert PermitFailed(); }
            }
            uint256 inBefore = IERC20(it.tokenIn).balanceOf(address(this));
            IERC20(it.tokenIn).safeTransferFrom(it.user, address(this), it.amountIn);
            inReceived = IERC20(it.tokenIn).balanceOf(address(this)) - inBefore;
            if (inReceived == 0) revert InvalidSwap();
        }
    }

    // ── Internal: send tokenOut to recipient (with optional ETH unwrap) ────────
    function _sendOutput(
        address tokenOut,
        address recipient,
        uint256 amount,
        bool unwrapETH
    ) internal {
        if (unwrapETH && tokenOut == weth && weth != address(0)) {
            if (weth == address(0)) revert WETHNotSet();
            IWETH(weth).withdraw(amount);
            (bool ok,) = recipient.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(tokenOut).safeTransfer(recipient, amount);
        }
    }

    // ── Internal: RouterGuard post-swap validation ─────────────────────────────
    function _getPreSwapQuote(address[] memory path, uint256 amountIn) internal view returns (uint256 quote) {
        if (address(oracleRef) == address(0)) return 0;

        try oracleRef.getAmountsOutUsingTwap(amountIn, path, 0)
            returns (uint256[] memory amounts) {
            if (amounts.length > 0 && amounts[amounts.length - 1] > 0) {
                return amounts[amounts.length - 1];
            }
        } catch {}

        try oracleRef.getAmountsOutUsingChainlink(amountIn, path)
            returns (uint256[] memory amounts) {
            if (amounts.length > 0 && amounts[amounts.length - 1] > 0) {
                return amounts[amounts.length - 1];
            }
        } catch {}

        return 0;
    }

    function _runGuard(
        uint256 amountIn,
        address[] memory path,
        uint256 actualOut,
        uint256 expectedOut
    ) internal view {
        if (address(routerGuard) == address(0)) return;
        if (!venueEnabled[address(routerGuard)]) return;
        if (expectedOut == 0) {
            if (!guardFailOpen) revert OracleUnavailable();
            return;
        }

        // Convert memory path to calldata-compatible via assembly trick: use a direct
        // call to avoid the calldata requirement. The guard is a view function.
        address guard = address(routerGuard);
        bytes memory cd = abi.encodeWithSelector(
            IParagonRouterGuard.validatePostSwap.selector,
            amountIn,
            path,
            actualOut,
            expectedOut
        );

        (bool ok, bytes memory ret) = guard.staticcall(cd);

        if (!ok) {
            // If failOpen, log and continue; otherwise revert
            if (!guardFailOpen) {
                // Bubble up the revert reason or use generic error
                if (ret.length > 0) {
                    assembly { revert(add(ret, 32), mload(ret)) }
                }
                revert GuardRejected();
            }
            // failOpen: emit warning event — not possible in view context, so just return
        }
    }

    // ── Internal: split + settle (all audited V2 logic preserved) ─────────────
    function _splitAndSettle(
        IBestExec.SwapIntent calldata it,
        address[] memory path,
        uint256 received,
        uint16[] memory hopShareBips,
        bool unwrapETH
    ) internal returns (uint256 traderGet) {
        SettlementBreakdown memory s;
        s.surplus = received > it.minAmountOut ? (received - it.minAmountOut) : 0;
        s.protocolCut = (s.surplus * protocolFeeBips) / 10_000;
        s.dist = s.surplus - s.protocolCut;
        s.traderShare = (s.dist * traderBips) / 10_000;
        s.lpShare = (s.dist * lpBips) / 10_000;
        s.solverShare = (s.dist * solverBips) / 10_000;
        s.lockerShare = s.dist - s.traderShare - s.lpShare - s.solverShare;

        bool paySolver = (s.solverShare > 0) && (msg.sender != it.user) && (isRelayer[msg.sender]);
        s.treasuryShare = s.protocolCut;
        if (paySolver) {
            IERC20(it.tokenOut).safeTransfer(msg.sender, s.solverShare);
            emit SolverPaid(msg.sender, s.solverShare);
        } else {
            s.treasuryShare += s.solverShare;
            s.solverShare = 0;
        }

        if (s.treasuryShare > 0 && daoVault != address(0)) {
            IERC20(it.tokenOut).safeTransfer(daoVault, s.treasuryShare);
        }

        traderGet = it.minAmountOut + s.traderShare;
        _sendOutput(it.tokenOut, it.recipient, traderGet, unwrapETH);

        _payLpShare(it.tokenOut, s.lpShare, path, hopShareBips);

        if (s.lockerShare > 0 && lockerVault != address(0)) {
            IERC20(it.tokenOut).safeTransfer(lockerVault, s.lockerShare);
        }

        _awardReputation(it, s.surplus);

        _emitPayflowExecuted(it, received, traderGet, s);
    }

    // ── Internal: report real amountOut to BestExecution ─────────────────────
    /// @dev Gracefully skips if bestExec doesn't have reportExecution (V14 compat).
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

    // ── Internal: router swap with fallback selectors (unchanged from V2) ─────
    function _routerSwapExactIn(
        uint256 amountIn, uint256 amountOutMin,
        address[] memory path, uint256 deadline
    ) internal {
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

    // ── Internal: reputation hook (unchanged from V2) ─────────────────────────
    function _awardReputation(IBestExec.SwapIntent calldata it, uint256 surplus) internal {
        if (address(repOp) == address(0) || !venueEnabled[address(repOp)]) return;

        uint256 usdVol = 0; uint256 usdSaved = 0;
        if (address(valuer) != address(0) && venueEnabled[address(valuer)]) {
            try valuer.usdValue(it.tokenIn, it.amountIn)  returns (uint256 v) { usdVol   = v; } catch {}
            if (surplus > 0) {
                try valuer.usdValue(it.tokenOut, surplus)  returns (uint256 s) { usdSaved = s; } catch {}
            }
        }

        bytes32 intentId;
        if (venueEnabled[address(bestExec)]) {
            try bestExec.hashIntent(it) returns (bytes32 h) { intentId = h; } catch {}
        }

        try repOp.onPayflowExecuted(it.user, usdVol, usdSaved, intentId) {} catch {}
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    function _checkSplit() internal view {
        if (uint256(traderBips) + uint256(lpBips) > 10_000) revert BadSplit();
    }

    function _safeApprove(IERC20 t, address spender, uint256 needed) internal {
        SafeERC20.forceApprove(t, spender, needed);
    }

    function _toMemory(address[] calldata arr) internal pure returns (address[] memory out) {
        out = new address[](arr.length);
        for (uint256 i; i < arr.length; i++) out[i] = arr[i];
    }

    function _toMemory(uint16[] calldata arr) internal pure returns (uint16[] memory out) {
        out = new uint16[](arr.length);
        for (uint256 i; i < arr.length; i++) out[i] = arr[i];
    }

    // ── Rescue functions ──────────────────────────────────────────────────────
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
        if (bal > 0) {
            (bool ok,) = to.call{value: bal}("");
            if (!ok) revert NativeTransferFailed();
        }
        emit NativeSwept(to, bal);
    }
}
