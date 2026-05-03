// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.25;
/*
 * ParagonSplitRouterUpdate
 *
 * DO NOT modify any audited Paragon contracts.
 *
 * Enables true best execution by routing a single signed intent across multiple
 * venues simultaneously in one transaction. For example: 60% via Paragon AMM,
 * 40% via 1inch — the user receives the aggregate output minus a single surplus split.
 *
 * Architecture:
 *   User signs SwapIntent (same struct as BestExecution).
 *   Caller provides VenueSplit[] describing how to divide amountIn across venues.
 *   This contract:
 *     1. Calls bestExec.consume() to burn the nonce.
 *     2. Pulls total amountIn from user.
 *     3. Sends each venue's portion to its adapter (or routes directly via Paragon router).
 *     4. Collects all tokenOut received.
 *     5. Verifies total >= minAmountOut.
 *     6. Calls _splitAndSettle (same surplus split logic as PayflowExecutorV2Update).
 *     7. Reports real amountOut to BestExecution.
 *
 * Venue types:
 *   VENUE_PARAGON (0) — routes via Paragon AMM directly. path must be provided.
 *   VENUE_ADAPTER  (1) — delegates to an IGenericVenueAdapter. adapterData is forwarded.
 *
 * This contract does NOT replace PayflowExecutorV2Update — it is an alternative
 * entry point for multi-venue fills. Both can coexist; both call the same bestExec.
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

import { ILPFlowRebates } from "./interfaces/ILPFlowRebates.sol";
import { IUsdValuer }     from "./interfaces/IUsdValuer.sol";

// ─── Interfaces ───────────────────────────────────────────────────────────────

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

interface IParagonRouterV2Like {
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn, uint256 amountOutMin, address[] calldata path,
        address to, uint256 deadline, uint8 autoYieldPercent
    ) external;
    function swapExactTokensForTokens(
        uint256 amountIn, uint256 amountOutMin, address[] calldata path,
        address to, uint256 deadline, uint8 autoYieldPercent
    ) external returns (uint256[] memory);
    function swapExactTokensForTokens(
        uint256 amountIn, uint256 amountOutMin, address[] calldata path,
        address to, uint256 deadline
    ) external returns (uint256[] memory);
}

/// @dev Unified adapter interface — both Paragon1inchAdapter and future adapters implement this.
interface IGenericVenueAdapter {
    function executeForSplitRouter(
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 minAmountOut,
        bytes calldata adapterData
    ) external returns (uint256 actualOut);
}

interface IParagonRouterGuard {
    function validatePostSwap(
        uint256 effectiveIn, address[] calldata path,
        uint256 actualOut, uint256 expectedOutPreSwap
    ) external view;
}

interface IParagonOracle {
    function getAmountsOutUsingTwap(uint256 amountIn, address[] memory path, uint32 timeWindow)
        external view returns (uint256[] memory amounts);
    function getAmountsOutUsingChainlink(uint256 amountIn, address[] memory path)
        external view returns (uint256[] memory amounts);
}

interface IReputationOperator {
    function onPayflowExecuted(address user, uint256 usdVol1e18, uint256 usdSaved1e18, bytes32 ref) external;
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
}

// ─── Split Router ─────────────────────────────────────────────────────────────

contract ParagonSplitRouterUpdate is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ── Venue type constants ──────────────────────────────────────────────────
    uint8 public constant VENUE_PARAGON = 0; // route through Paragon AMM directly
    uint8 public constant VENUE_ADAPTER = 1; // delegate to IGenericVenueAdapter

    // ── Core addresses ────────────────────────────────────────────────────────
    IBestExec            public bestExec;
    IParagonRouterV2Like public router;
    ILPFlowRebates       public lpRebates;
    IParagonRouterGuard  public routerGuard;
    IParagonOracle       public oracleRef;
    IReputationOperator  public repOp;
    IUsdValuer           public valuer;
    address              public daoVault;
    address              public lockerVault;
    address              public weth;

    // ── Fee config ────────────────────────────────────────────────────────────
    uint16 public protocolFeeBips;
    uint16 public traderBips  = 6000;
    uint16 public lpBips      = 1000;
    uint16 public solverBips  = 2000;
    uint8  public constant MAX_VENUES          = 8;
    uint8  public constant MAX_PATH_LEN        = 5;
    uint8  public constant DEFAULT_AUTO_PREF   = 0;

    bool public guardFailOpen = true;

    // ── Allowlists ────────────────────────────────────────────────────────────
    mapping(address => bool) public supportedToken;
    mapping(address => bool) public venueEnabled;
    mapping(address => bool) public allowedAdapter;
    mapping(address => bool) public isRelayer;

    // ── Structs ───────────────────────────────────────────────────────────────
    /**
     * @param venueType  VENUE_PARAGON or VENUE_ADAPTER
     * @param splitBips  Portion of total amountIn routed to this venue (must sum to 10_000)
     * @param adapter    For VENUE_ADAPTER: the IGenericVenueAdapter address.
     *                   For VENUE_PARAGON: ignored (uses `router`).
     * @param path       For VENUE_PARAGON: token path array.
     *                   For VENUE_ADAPTER: the LP hop path for rebate attribution (optional).
     * @param adapterData Arbitrary bytes forwarded to adapter.executeForSplitRouter().
     *                    Empty for VENUE_PARAGON.
     */
    struct VenueSplit {
        uint8   venueType;
        uint16  splitBips;
        address adapter;
        address[] path;
        bytes   adapterData;
    }

    struct PermitData {
        uint256 value;
        uint256 deadline;
        uint8   v;
        bytes32 r;
        bytes32 s;
    }

    // ── Errors ────────────────────────────────────────────────────────────────
    error BadSplit();
    error BadVenueType();
    error AdapterNotAllowed();
    error VenuePaused();
    error UnsupportedToken();
    error InvalidSwap();
    error InvalidRecipient();
    error SlippageExceeded();
    error RouterSwapFailed();
    error TooManyVenues();
    error PathMismatch();
    error PathTooLong();
    error NativeTransferFailed();
    error ETHValueMismatch();
    error PermitFailed();
    error GuardRejected();
    error OracleUnavailable();

    // ── Events ────────────────────────────────────────────────────────────────
    event SplitExecuted(
        address indexed user, address indexed tokenIn, address indexed tokenOut,
        uint256 amountIn, uint256 totalOut, uint256 surplus,
        uint256 traderGet, uint256 lpShare, uint256 solverShare,
        uint256 lockerShare, uint256 protocolCut, uint256 numVenues
    );
    event VenueRouted(uint8 venueType, address adapter, uint256 amountIn, uint256 amountOut);
    event LPRebateAttributed(address indexed tokenIn, address indexed tokenOut, address indexed rewardToken, uint256 amount);
    event SplitUpdated(uint16 traderBips, uint16 lpBips, uint16 solverBips, uint16 lockerBips);
    event SolverPaid(address indexed solver, uint256 amount);
    event VenueToggled(address indexed venue, bool enabled);
    event AdapterAllowed(address indexed adapter, bool allowed);
    event RelayerSet(address indexed relayer, bool allowed);
    event SupportedTokenSet(address indexed token, bool supported);
    event GuardianSet(address indexed guardian);
    event Swept(address indexed token, address indexed to, uint256 amount);
    event NativeSwept(address indexed to, uint256 amount);
    event PausedByOwner(address indexed account, string reason);
    event UnpausedByOwner(address indexed account);

    // ── Guardian ──────────────────────────────────────────────────────────────
    address public guardian;
    modifier onlyOwnerOrGuardian() {
        require(msg.sender == owner() || msg.sender == guardian, "not owner/guardian");
        _;
    }

    // ── Constructor ───────────────────────────────────────────────────────────
    constructor(
        address initialOwner,
        address _bestExec,
        address _router,
        address _daoVault,
        address _lpRebates,
        address _lockerVault,
        address _weth,
        address _oracleRef
    ) Ownable(initialOwner) {
        require(_bestExec != address(0) && _router != address(0) && _daoVault != address(0), "zero");
        bestExec    = IBestExec(_bestExec);
        router      = IParagonRouterV2Like(_router);
        daoVault    = _daoVault;
        lpRebates   = ILPFlowRebates(_lpRebates);
        lockerVault = _lockerVault;
        weth        = _weth;
        oracleRef   = IParagonOracle(_oracleRef);
        venueEnabled[_router]   = true; emit VenueToggled(_router, true);
        venueEnabled[_bestExec] = true; emit VenueToggled(_bestExec, true);
        if (_lpRebates   != address(0)) { venueEnabled[_lpRebates]   = true; emit VenueToggled(_lpRebates, true); }
        if (_lockerVault != address(0)) { venueEnabled[_lockerVault] = true; emit VenueToggled(_lockerVault, true); }
        _checkSplit();
    }

    // ── Admin ─────────────────────────────────────────────────────────────────
    function pause(string calldata reason) external onlyOwnerOrGuardian { _pause(); emit PausedByOwner(msg.sender, reason); }
    function unpause() external onlyOwner { _unpause(); emit UnpausedByOwner(msg.sender); }
    function setGuardian(address g) external onlyOwner { guardian = g; emit GuardianSet(g); }
    function setSupportedToken(address token, bool s) external onlyOwner { require(token != address(0)); supportedToken[token] = s; emit SupportedTokenSet(token, s); }
    function setVenueEnabled(address venue, bool enabled) external onlyOwner { require(venue != address(0)); venueEnabled[venue] = enabled; emit VenueToggled(venue, enabled); }
    function setAllowedAdapter(address adapter, bool allowed) external onlyOwner { require(adapter != address(0)); allowedAdapter[adapter] = allowed; if (allowed) { venueEnabled[adapter] = true; } emit AdapterAllowed(adapter, allowed); }
    function setRelayer(address r, bool allowed) external onlyOwner {
        require(r != address(0));
        isRelayer[r] = allowed;
        emit RelayerSet(r, allowed);
    }
    function setGuardFailOpen(bool v) external onlyOwner { guardFailOpen = v; }
    function setWETH(address _weth) external onlyOwner { weth = _weth; }
    function setRouterGuard(address g) external onlyOwner { routerGuard = IParagonRouterGuard(g); if (g != address(0)) { venueEnabled[g] = true; emit VenueToggled(g, true); } }
    function setOracleRef(address o) external onlyOwner { oracleRef = IParagonOracle(o); if (o != address(0)) { venueEnabled[o] = true; emit VenueToggled(o, true); } }
    function setReputationOperator(address r) external onlyOwner { repOp = IReputationOperator(r); }
    function setUsdValuer(address v) external onlyOwner { valuer = IUsdValuer(v); }
    function setSplitBips(uint16 _trader, uint16 _lp, uint16 _solver) external onlyOwner {
        traderBips = _trader;
        lpBips = _lp;
        solverBips = _solver;
        _checkSplit();
        emit SplitUpdated(_trader, _lp, _solver, uint16(10_000 - _trader - _lp - _solver));
    }
    function setProtocolFeeBips(uint16 bps) external onlyOwner {
        require(bps <= 1000, "protocol fee too high");
        protocolFeeBips = bps;
    }

    // ── EXECUTE SPLIT ─────────────────────────────────────────────────────────
    /**
     * @notice Execute a signed intent split across multiple venues.
     * @param it        Signed swap intent.
     * @param sig       EIP-712 signature over `it`.
     * @param venues    Array of venue splits. splitBips must sum to exactly 10_000.
     * @param permit    Optional EIP-2612 permit for tokenIn approval.
     * @param unwrapETH If true and tokenOut == weth, unwrap to native ETH for recipient.
     */
    function executeSplit(
        IBestExec.SwapIntent calldata it,
        bytes calldata sig,
        VenueSplit[] calldata venues,
        PermitData calldata permit,
        bool unwrapETH
    ) external payable nonReentrant whenNotPaused {
        // ── Validate intent ──
        if (!supportedToken[it.tokenIn] || !supportedToken[it.tokenOut]) revert UnsupportedToken();
        if (!venueEnabled[address(bestExec)]) revert VenuePaused();
        if (block.timestamp > it.deadline) revert InvalidSwap();
        if (it.tokenIn == it.tokenOut)     revert InvalidSwap();
        if (it.recipient == address(0))    revert InvalidRecipient();
        if (it.amountIn == 0 || it.minAmountOut == 0) revert InvalidSwap();

        // ── Validate venues ──
        if (venues.length == 0 || venues.length > MAX_VENUES) revert TooManyVenues();
        {
            uint256 totalBips;
            for (uint256 i; i < venues.length; i++) {
                totalBips += venues[i].splitBips;
                if (venues[i].venueType == VENUE_ADAPTER) {
                    if (!allowedAdapter[venues[i].adapter]) revert AdapterNotAllowed();
                } else if (venues[i].venueType == VENUE_PARAGON) {
                    if (venues[i].path.length < 2) revert PathMismatch();
                    if (venues[i].path.length > MAX_PATH_LEN) revert PathTooLong();
                    if (venues[i].path[0] != it.tokenIn ||
                        venues[i].path[venues[i].path.length - 1] != it.tokenOut) revert PathMismatch();
                } else {
                    revert BadVenueType();
                }
            }
            if (totalBips != 10_000) revert BadSplit();
        }

        // ── Consume intent ──
        bestExec.consume(it, sig);

        // ── Pull input ──
        uint256 inReceived = _pullInput(it, permit);

        // ── Pre-swap oracle quote (on full amountIn for consistent comparison) ──
        uint256 preSwapQuote = _getPreSwapQuoteForVenues(venues, it.tokenIn, it.tokenOut, inReceived);

        // ── Route across venues ──
        uint256 totalOut;
        uint256 remaining = inReceived;

        for (uint256 i; i < venues.length; i++) {
            VenueSplit calldata v = venues[i];

            // Last venue gets whatever is left (avoids dust from rounding)
            uint256 portionIn = (i == venues.length - 1)
                ? remaining
                : (inReceived * v.splitBips) / 10_000;

            if (portionIn == 0) continue;
            remaining -= portionIn;

            uint256 portionOut;

            if (v.venueType == VENUE_PARAGON) {
                portionOut = _routeParagon(it.tokenIn, portionIn, it.tokenOut, it.deadline, v.path);
            } else {
                portionOut = _routeAdapter(it.tokenIn, portionIn, it.tokenOut, v.adapter, v.adapterData);
            }

            totalOut += portionOut;
            emit VenueRouted(v.venueType, v.venueType == VENUE_ADAPTER ? v.adapter : address(router), portionIn, portionOut);
        }

        if (totalOut < it.minAmountOut) revert SlippageExceeded();

        // ── Guard (blended price) ──
        {
            address[] memory guardPath = new address[](2);
            guardPath[0] = it.tokenIn; guardPath[1] = it.tokenOut;
            _runGuard(inReceived, guardPath, totalOut, preSwapQuote);
        }

        // ── Settle ──
        uint256 traderGet = _splitAndSettle(it, totalOut, venues, unwrapETH);
        _reportExecution(it, traderGet);
    }

    // ── Internal: route via Paragon AMM ──────────────────────────────────────
    function _routeParagon(
        address tokenIn, uint256 amountIn, address tokenOut,
        uint256 deadline, address[] calldata path
    ) internal returns (uint256 out) {
        if (!venueEnabled[address(router)]) revert VenuePaused();

        _safeApprove(IERC20(tokenIn), address(router), amountIn);
        uint256 balBefore = IERC20(tokenOut).balanceOf(address(this));

        address r = address(router);
        address[] memory memPath = _toMemory(path);

        (bool ok,) = r.call(abi.encodeWithSelector(
            bytes4(keccak256("swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256,uint8)")),
            amountIn, 1, memPath, address(this), deadline, DEFAULT_AUTO_PREF
        ));
        if (!ok) {
            (ok,) = r.call(abi.encodeWithSelector(
                bytes4(keccak256("swapExactTokensForTokens(uint256,uint256,address[],address,uint256,uint8)")),
                amountIn, 1, memPath, address(this), deadline, DEFAULT_AUTO_PREF
            ));
        }
        if (!ok) {
            (ok,) = r.call(abi.encodeWithSelector(
                bytes4(keccak256("swapExactTokensForTokens(uint256,uint256,address[],address,uint256)")),
                amountIn, 1, memPath, address(this), deadline
            ));
        }
        if (!ok) revert RouterSwapFailed();

        _safeApprove(IERC20(tokenIn), address(router), 0);
        out = IERC20(tokenOut).balanceOf(address(this)) - balBefore;
    }

    // ── Internal: route via generic adapter ──────────────────────────────────
    function _routeAdapter(
        address tokenIn, uint256 amountIn, address tokenOut,
        address adapter, bytes calldata adapterData
    ) internal returns (uint256 out) {
        if (!venueEnabled[adapter]) revert VenuePaused();

        // Transfer portionIn to adapter first (same as 1inch pattern)
        IERC20(tokenIn).safeTransfer(adapter, amountIn);

        out = IGenericVenueAdapter(adapter).executeForSplitRouter(
            tokenIn, amountIn, tokenOut,
            1, // minAmountOut=1; overall slippage checked on aggregate at end
            adapterData
        );
        // Adapter must return tokenOut to this contract
    }

    // ── Internal: split + settle ──────────────────────────────────────────────
    function _splitAndSettle(
        IBestExec.SwapIntent calldata it,
        uint256 totalOut,
        VenueSplit[] calldata venues,
        bool unwrapETH
    ) internal returns (uint256 traderGet) {
        uint256 surplus     = totalOut > it.minAmountOut ? totalOut - it.minAmountOut : 0;
        uint256 protocolCut = (surplus * protocolFeeBips) / 10_000;
        uint256 dist        = surplus - protocolCut;
        uint256 traderShare = (dist * traderBips) / 10_000;
        uint256 lpShare     = (dist * lpBips)     / 10_000;
        uint256 solverShare = (dist * solverBips) / 10_000;
        uint256 lockerShare = dist - traderShare - lpShare - solverShare;

        bool paySolver = (solverShare > 0) && (msg.sender != it.user) && (isRelayer[msg.sender]);
        uint256 treasuryShare = protocolCut;
        if (paySolver) {
            IERC20(it.tokenOut).safeTransfer(msg.sender, solverShare);
            emit SolverPaid(msg.sender, solverShare);
        } else {
            treasuryShare += solverShare;
            solverShare = 0;
        }

        if (treasuryShare > 0 && daoVault != address(0)) {
            IERC20(it.tokenOut).safeTransfer(daoVault, treasuryShare);
        }

        traderGet = it.minAmountOut + traderShare;
        _sendOutput(it.tokenOut, it.recipient, traderGet, unwrapETH);

        // LP rebates — distribute across venues weighted by splitBips
        if (lpShare > 0 && address(lpRebates) != address(0) && venueEnabled[address(lpRebates)]) {
            _safeApprove(IERC20(it.tokenOut), address(lpRebates), lpShare);

            for (uint256 i; i < venues.length; i++) {
                VenueSplit calldata v = venues[i];
                address[] calldata vPath = v.path;
                if (vPath.length < 2) continue;

                uint256 vShare = (lpShare * v.splitBips) / 10_000;
                if (vShare == 0) continue;

                // Attribute to last hop of this venue's path
                address hopIn  = vPath[vPath.length - 2];
                address hopOut = vPath[vPath.length - 1];
                lpRebates.notify(hopIn, hopOut, it.tokenOut, vShare);
                emit LPRebateAttributed(hopIn, hopOut, it.tokenOut, vShare);
            }

            SafeERC20.forceApprove(IERC20(it.tokenOut), address(lpRebates), 0);
        } else if (lpShare > 0 && daoVault != address(0)) {
            IERC20(it.tokenOut).safeTransfer(daoVault, lpShare);
        }

        if (lockerShare > 0 && lockerVault != address(0)) IERC20(it.tokenOut).safeTransfer(lockerVault, lockerShare);

        emit SplitExecuted(
            it.user,
            it.tokenIn,
            it.tokenOut,
            it.amountIn,
            totalOut,
            surplus,
            traderGet,
            lpShare,
            solverShare,
            lockerShare,
            treasuryShare,
            venues.length
        );
    }

    // ── Internal: pull input (EIP-2612 or standard transferFrom) ─────────────
    function _pullInput(IBestExec.SwapIntent calldata it, PermitData calldata permit) internal returns (uint256 inReceived) {
        bool nativeIn = (msg.value > 0 && it.tokenIn == weth);
        if (nativeIn) {
            require(weth != address(0), "WETH not set");
            if (msg.value != it.amountIn) revert ETHValueMismatch();
            IWETH(weth).deposit{value: msg.value}();
            return msg.value;
        }
        if (msg.value != 0) revert ETHValueMismatch();
        if (permit.deadline != 0) {
            try IERC20Permit(it.tokenIn).permit(
                it.user, address(this), permit.value, permit.deadline, permit.v, permit.r, permit.s
            ) {} catch { revert PermitFailed(); }
        }
        uint256 inBefore = IERC20(it.tokenIn).balanceOf(address(this));
        IERC20(it.tokenIn).safeTransferFrom(it.user, address(this), it.amountIn);
        inReceived = IERC20(it.tokenIn).balanceOf(address(this)) - inBefore;
        if (inReceived == 0) revert InvalidSwap();
    }

    // ── Internal: send output (with optional ETH unwrap) ─────────────────────
    function _sendOutput(address tokenOut, address recipient, uint256 amount, bool unwrapETH) internal {
        if (unwrapETH && tokenOut == weth && weth != address(0)) {
            IWETH(weth).withdraw(amount);
            (bool ok,) = recipient.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(tokenOut).safeTransfer(recipient, amount);
        }
    }

    // ── Internal: pre-swap oracle quote ──────────────────────────────────────
    function _getPreSwapQuoteForVenues(
        VenueSplit[] calldata venues,
        address tokenIn,
        address tokenOut,
        uint256 totalAmountIn
    ) internal view returns (uint256 quote) {
        if (address(oracleRef) == address(0)) return 0;

        uint256 remaining = totalAmountIn;

        for (uint256 i; i < venues.length; i++) {
            uint256 portionIn = (i == venues.length - 1)
                ? remaining
                : (totalAmountIn * venues[i].splitBips) / 10_000;
            remaining -= portionIn;

            if (portionIn == 0) continue;

            address[] memory quotePath;
            if (venues[i].path.length >= 2) {
                quotePath = _toMemory(venues[i].path);
            } else {
                quotePath = new address[](2);
                quotePath[0] = tokenIn;
                quotePath[1] = tokenOut;
            }

            uint256 venueQuote = _quotePath(quotePath, portionIn);
            if (venueQuote == 0) return 0;
            quote += venueQuote;
        }
    }

    function _quotePath(address[] memory path, uint256 amountIn) internal view returns (uint256) {
        try oracleRef.getAmountsOutUsingTwap(amountIn, path, 0)
            returns (uint256[] memory a) { if (a.length > 0 && a[a.length-1] > 0) return a[a.length-1]; } catch {}
        try oracleRef.getAmountsOutUsingChainlink(amountIn, path)
            returns (uint256[] memory a) { if (a.length > 0 && a[a.length-1] > 0) return a[a.length-1]; } catch {}
        return 0;
    }

    // ── Internal: RouterGuard ─────────────────────────────────────────────────
    function _runGuard(uint256 amountIn, address[] memory path, uint256 actualOut, uint256 preSwapQuote) internal view {
        if (address(routerGuard) == address(0)) return;
        if (!venueEnabled[address(routerGuard)]) return;
        if (preSwapQuote == 0) { if (!guardFailOpen) revert OracleUnavailable(); return; }
        bytes memory cd = abi.encodeWithSelector(IParagonRouterGuard.validatePostSwap.selector, amountIn, path, actualOut, preSwapQuote);
        (bool ok, bytes memory ret) = address(routerGuard).staticcall(cd);
        if (!ok) { if (!guardFailOpen) { if (ret.length > 0) { assembly { revert(add(ret, 32), mload(ret)) } } revert GuardRejected(); } }
    }

    // ── Internal: report execution ────────────────────────────────────────────
    function _reportExecution(IBestExec.SwapIntent calldata it, uint256 traderGet) internal {
        try bestExec.reportExecution(it.user, it.nonce, it.tokenIn, it.tokenOut, it.amountIn, traderGet, it.recipient) {} catch {}
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    function _checkSplit() internal view {
        if (uint256(traderBips) + uint256(lpBips) + uint256(solverBips) > 10_000) revert BadSplit();
    }

    function _safeApprove(IERC20 t, address spender, uint256 needed) internal { SafeERC20.forceApprove(t, spender, needed); }
    function _toMemory(address[] calldata arr) internal pure returns (address[] memory out) { out = new address[](arr.length); for (uint256 i; i < arr.length; i++) out[i] = arr[i]; }

    // ── Rescue ────────────────────────────────────────────────────────────────
    function sweep(address token, address to) external onlyOwner {
        require(to != address(0));
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).safeTransfer(to, bal);
        emit Swept(token, to, bal);
    }
    receive() external payable {}
    function sweepNative(address to) external onlyOwner {
        require(to != address(0));
        uint256 bal = address(this).balance;
        if (bal > 0) { (bool ok,) = to.call{value: bal}(""); if (!ok) revert NativeTransferFailed(); }
        emit NativeSwept(to, bal);
    }
}
