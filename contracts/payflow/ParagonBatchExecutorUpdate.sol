// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.25;
/*
 * ParagonBatchExecutorUpdate
 *
 * DO NOT modify any audited Paragon contracts.
 *
 * Settles multiple users' signed intents in a single transaction.
 * This contract is a thin orchestration layer — it holds no tokens, no approvals,
 * and no custody. All swap logic, surplus splitting, and safety checks remain
 * inside the downstream executors (PayflowExecutorV2Update, ParagonSplitRouterUpdate).
 *
 * How it works:
 *   1. Caller (relayer/keeper) submits BatchItem[] — one per user intent.
 *   2. For each item, the batch executor calls the appropriate downstream contract:
 *        ROUTE_SIMPLE  → PayflowExecutorV2Update.execute()
 *        ROUTE_PATH    → PayflowExecutorV2Update.executeWithPath()
 *        ROUTE_1INCH   → PayflowExecutorV2Update.executeVia1inch()
 *        ROUTE_SPLIT   → ParagonSplitRouterUpdate.executeSplit()
 *   3. Each call is wrapped in try/catch.
 *        skipOnFailure=true  → failed item is skipped, batch continues.
 *        skipOnFailure=false → failed item reverts the entire batch.
 *   4. BatchCompleted event reports how many succeeded vs. skipped.
 *
 * Token flow:
 *   - Each downstream executor pulls tokenIn directly from the user via transferFrom.
 *   - This contract never holds ERC20 tokens in steady state.
 *   - Native ETH: BatchItem.ethValue is forwarded per-item via call{value}.
 *     Caller must send msg.value == sum of all BatchItem.ethValue in the batch.
 *
 * Relayer economics:
 *   - msg.sender is recorded as the relayer for every downstream call.
 *   - If msg.sender is in the downstream executor's isRelayer mapping,
 *     relayer fees accumulate per-item in tokenOut directly to msg.sender.
 *   - Register this contract's callers as relayers on each downstream executor.
 *
 * Security:
 *   - nonReentrant: downstream calls complete fully before the next item begins.
 *   - Pausable + guardian: emergency stop.
 *   - maxBatchSize: prevents gas-limit DoS.
 *   - No approve/delegatecall: no elevated trust surface.
 */

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// ─── Downstream executor interfaces ──────────────────────────────────────────

interface IBestExecIntent {
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
}

// Matches PayflowExecutorV2Update.PermitData
struct PermitData {
    uint8   permitType; // 0=none, 1=EIP-2612, 2=Permit2
    uint256 value;
    uint256 deadline;
    uint256 nonce;
    uint8   v;
    bytes32 r;
    bytes32 s;
    bytes   permit2Sig;
}

interface IPayflowExecutorV2 {
    function execute(
        IBestExecIntent.SwapIntent calldata it,
        bytes calldata sig,
        PermitData calldata permit,
        bool unwrapETH
    ) external payable;

    function executeWithPath(
        IBestExecIntent.SwapIntent calldata it,
        bytes calldata sig,
        address[] calldata path,
        uint16[] calldata hopShareBips,
        PermitData calldata permit,
        bool unwrapETH
    ) external payable;

    function executeVia1inch(
        IBestExecIntent.SwapIntent calldata it,
        bytes calldata sig,
        bytes calldata routeData
    ) external;
}

// Minimal 1inch SwapDescription — mirrors I1inchRouterV6.SwapDescription
struct I1inchDesc {
    IERC20 srcToken;
    IERC20 dstToken;
    address payable srcReceiver;
    address payable dstReceiver;
    uint256 amount;
    uint256 minReturnAmount;
    uint256 flags;
}

// Matches ParagonSplitRouterUpdate.VenueSplit
struct VenueSplit {
    uint8     venueType;
    uint16    splitBips;
    address   adapter;
    address[] path;
    bytes     adapterData;
}

// Simple PermitData for SplitRouter (EIP-2612 only)
struct SplitPermitData {
    uint256 value;
    uint256 deadline;
    uint8   v;
    bytes32 r;
    bytes32 s;
}

interface IParagonSplitRouter {
    function executeSplit(
        IBestExecIntent.SwapIntent calldata it,
        bytes calldata sig,
        VenueSplit[] calldata venues,
        SplitPermitData calldata permit,
        bool unwrapETH
    ) external payable;
}

// ─── Batch Executor ───────────────────────────────────────────────────────────

contract ParagonBatchExecutorUpdate is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // ── Route type constants ──────────────────────────────────────────────────
    uint8 public constant ROUTE_SIMPLE = 0; // PayflowExecutorV2Update.execute()
    uint8 public constant ROUTE_PATH   = 1; // PayflowExecutorV2Update.executeWithPath()
    uint8 public constant ROUTE_1INCH  = 2; // PayflowExecutorV2Update.executeVia1inch()
    uint8 public constant ROUTE_SPLIT  = 3; // ParagonSplitRouterUpdate.executeSplit()

    // ── Registered downstream contracts ──────────────────────────────────────
    IPayflowExecutorV2   public payflowExecutor;
    IParagonSplitRouter  public splitRouter;

    // ── Config ────────────────────────────────────────────────────────────────
    uint8 public maxBatchSize = 50; // gas-limit DoS guard; owner can raise/lower

    // ── Guardian ──────────────────────────────────────────────────────────────
    address public guardian;

    modifier onlyOwnerOrGuardian() {
        require(msg.sender == owner() || msg.sender == guardian, "not owner/guardian");
        _;
    }

    // ── Structs ───────────────────────────────────────────────────────────────

    /**
     * @dev A single intent to be settled within a batch.
     *
     * @param intent        The signed SwapIntent.
     * @param sig           EIP-712 signature.
     * @param routeType     ROUTE_SIMPLE / ROUTE_PATH / ROUTE_1INCH / ROUTE_SPLIT.
     * @param routeData     ABI-encoded route parameters. See encoding guide below.
     * @param ethValue      Native ETH to forward to the downstream call (for WETH wrap).
     *                      0 for standard ERC20 swaps.
     * @param skipOnFailure If true, a failed fill is skipped; batch continues.
     *                      If false, a failed fill reverts the entire batch.
     *
     * routeData encoding:
     *   ROUTE_SIMPLE:
     *     abi.encode(PermitData permit, bool unwrapETH)
     *
     *   ROUTE_PATH:
     *     abi.encode(address[] path, uint16[] hopShareBips, PermitData permit, bool unwrapETH)
     *
     *   ROUTE_1INCH:
     *     abi.encode(
     *       I1inchDesc desc,
     *       bytes permitData,
     *       bytes oneInchData,
     *       address executor1inch,
     *       PermitData userPermit,
     *       address[] lpHopPath,
     *       uint16[] hopShareBips
     *     )
     *
     *   ROUTE_SPLIT:
     *     abi.encode(VenueSplit[] venues, SplitPermitData permit, bool unwrapETH)
     */
    struct BatchItem {
        IBestExecIntent.SwapIntent intent;
        bytes   sig;
        uint8   routeType;
        bytes   routeData;
        uint256 ethValue;
        bool    skipOnFailure;
    }

    // ── Errors ────────────────────────────────────────────────────────────────
    error BatchTooLarge();
    error BatchItemFailed(uint256 index, address user, uint256 nonce);
    error UnknownRouteType(uint8 routeType);
    error ETHValueMismatch();       // sum of ethValues != msg.value
    error ExecutorNotSet();
    error SplitRouterNotSet();
    error NativeTransferFailed();

    // ── Events ────────────────────────────────────────────────────────────────
    event BatchCompleted(
        address indexed relayer,
        uint256 totalItems,
        uint256 succeeded,
        uint256 skipped
    );
    event BatchItemSucceeded(
        uint256 indexed index,
        address indexed user,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 nonce
    );
    event BatchItemSkipped(
        uint256 indexed index,
        address indexed user,
        uint256 nonce,
        bytes   reason
    );
    event RelayerPayoutForwarded(address indexed relayer, address indexed token, uint256 amount);
    event PayflowExecutorSet(address indexed executor);
    event SplitRouterSet(address indexed splitRouter);
    event MaxBatchSizeSet(uint8 size);
    event GuardianSet(address indexed guardian);
    event Swept(address indexed token, address indexed to, uint256 amount);
    event NativeSwept(address indexed to, uint256 amount);
    event PausedByOwner(address indexed account, string reason);
    event UnpausedByOwner(address indexed account);

    // ── Constructor ───────────────────────────────────────────────────────────
    constructor(
        address initialOwner,
        address _payflowExecutor,
        address _splitRouter         // can be address(0); set later via setSplitRouter
    ) Ownable(initialOwner) {
        require(_payflowExecutor != address(0), "executor=0");
        payflowExecutor = IPayflowExecutorV2(_payflowExecutor);
        if (_splitRouter != address(0)) {
            splitRouter = IParagonSplitRouter(_splitRouter);
        }
        emit PayflowExecutorSet(_payflowExecutor);
        emit SplitRouterSet(_splitRouter);
    }

    // ── Admin ─────────────────────────────────────────────────────────────────
    function setPayflowExecutor(address e) external onlyOwner {
        require(e != address(0), "executor=0");
        payflowExecutor = IPayflowExecutorV2(e);
        emit PayflowExecutorSet(e);
    }

    function setSplitRouter(address s) external onlyOwner {
        splitRouter = IParagonSplitRouter(s);
        emit SplitRouterSet(s);
    }

    function setMaxBatchSize(uint8 size) external onlyOwner {
        require(size > 0, "size=0");
        maxBatchSize = size;
        emit MaxBatchSizeSet(size);
    }

    function setGuardian(address g) external onlyOwner {
        guardian = g;
        emit GuardianSet(g);
    }

    function pause(string calldata reason) external onlyOwnerOrGuardian {
        _pause();
        emit PausedByOwner(msg.sender, reason);
    }

    function unpause() external onlyOwner {
        _unpause();
        emit UnpausedByOwner(msg.sender);
    }

    // ── BATCH EXECUTE ─────────────────────────────────────────────────────────

    /**
     * @notice Settle multiple signed intents in a single transaction.
     * @dev    msg.value must equal the sum of all BatchItem.ethValue fields.
     *         Caller must be registered as a relayer on each downstream executor
     *         to receive per-fill relayer fees in tokenOut.
     * @param items  Array of intents to settle. Max length = maxBatchSize.
     */
    function executeBatch(BatchItem[] calldata items)
        external
        payable
        nonReentrant
        whenNotPaused
    {
        uint256 len = items.length;
        if (len == 0 || len > maxBatchSize) revert BatchTooLarge();

        // Verify total ETH sent matches declared per-item ethValues
        {
            uint256 totalEth;
            for (uint256 i; i < len; i++) totalEth += items[i].ethValue;
            if (totalEth != msg.value) revert ETHValueMismatch();
        }

        uint256 succeeded;
        uint256 skipped;

        for (uint256 i; i < len; i++) {
            BatchItem calldata item = items[i];

            (bool ok, bytes memory err) = _settle(item);

            if (ok) {
                _forwardRelayerPayout(item.intent.tokenOut, msg.sender);
                succeeded++;
                emit BatchItemSucceeded(
                    i,
                    item.intent.user,
                    item.intent.tokenIn,
                    item.intent.tokenOut,
                    item.intent.amountIn,
                    item.intent.nonce
                );
            } else {
                if (!item.skipOnFailure) {
                    // Strict mode: propagate the revert from the downstream call
                    revert BatchItemFailed(i, item.intent.user, item.intent.nonce);
                }
                skipped++;
                emit BatchItemSkipped(i, item.intent.user, item.intent.nonce, err);
            }
        }

        // Return any unspent ETH (edge case: rounding or skipped ETH items)
        _returnExcessETH();

        emit BatchCompleted(msg.sender, len, succeeded, skipped);
    }

    // ── Internal: dispatch to correct downstream executor ─────────────────────

    function _settle(BatchItem calldata item) internal returns (bool ok, bytes memory err) {
        if (item.routeType == ROUTE_SIMPLE) {
            return _settleSimple(item);
        } else if (item.routeType == ROUTE_PATH) {
            return _settlePath(item);
        } else if (item.routeType == ROUTE_1INCH) {
            return _settle1inch(item);
        } else if (item.routeType == ROUTE_SPLIT) {
            return _settleSplit(item);
        } else {
            // Unknown route type — treat as failure
            return (false, abi.encodeWithSelector(UnknownRouteType.selector, item.routeType));
        }
    }

    function _forwardRelayerPayout(address token, address relayer) internal {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal == 0) return;

        IERC20(token).safeTransfer(relayer, bal);
        emit RelayerPayoutForwarded(relayer, token, bal);
    }

    // ── ROUTE_SIMPLE ──────────────────────────────────────────────────────────
    function _settleSimple(BatchItem calldata item) internal returns (bool ok, bytes memory err) {
        if (address(payflowExecutor) == address(0)) return (false, abi.encodeWithSelector(ExecutorNotSet.selector));

        (PermitData memory permit, bool unwrapETH) =
            abi.decode(item.routeData, (PermitData, bool));

        try payflowExecutor.execute{value: item.ethValue}(
            item.intent,
            item.sig,
            permit,
            unwrapETH
        ) {
            ok = true;
        } catch (bytes memory reason) {
            ok  = false;
            err = reason;
        }
    }

    // ── ROUTE_PATH ────────────────────────────────────────────────────────────
    function _settlePath(BatchItem calldata item) internal returns (bool ok, bytes memory err) {
        if (address(payflowExecutor) == address(0)) return (false, abi.encodeWithSelector(ExecutorNotSet.selector));

        (
            address[] memory path,
            uint16[]  memory hopShareBips,
            PermitData memory permit,
            bool unwrapETH
        ) = abi.decode(item.routeData, (address[], uint16[], PermitData, bool));

        try payflowExecutor.executeWithPath{value: item.ethValue}(
            item.intent,
            item.sig,
            path,
            hopShareBips,
            permit,
            unwrapETH
        ) {
            ok = true;
        } catch (bytes memory reason) {
            ok  = false;
            err = reason;
        }
    }

    // ── ROUTE_1INCH ───────────────────────────────────────────────────────────
    function _settle1inch(BatchItem calldata item) internal returns (bool ok, bytes memory err) {
        if (address(payflowExecutor) == address(0)) return (false, abi.encodeWithSelector(ExecutorNotSet.selector));

        // 1inch path does not support native ETH (ERC20-only adapter)
        // ethValue must be 0 for ROUTE_1INCH items
        try payflowExecutor.executeVia1inch(
            item.intent,
            item.sig,
            item.routeData
        ) {
            ok = true;
        } catch (bytes memory reason) {
            ok  = false;
            err = reason;
        }
    }

    // ── ROUTE_SPLIT ───────────────────────────────────────────────────────────
    function _settleSplit(BatchItem calldata item) internal returns (bool ok, bytes memory err) {
        if (address(splitRouter) == address(0)) return (false, abi.encodeWithSelector(SplitRouterNotSet.selector));

        (
            VenueSplit[]    memory venues,
            SplitPermitData memory permit,
            bool unwrapETH
        ) = abi.decode(item.routeData, (VenueSplit[], SplitPermitData, bool));

        try splitRouter.executeSplit{value: item.ethValue}(
            item.intent,
            item.sig,
            venues,
            permit,
            unwrapETH
        ) {
            ok = true;
        } catch (bytes memory reason) {
            ok  = false;
            err = reason;
        }
    }

    // ── Internal: return leftover ETH to caller ───────────────────────────────
    function _returnExcessETH() internal {
        uint256 bal = address(this).balance;
        if (bal > 0) {
            (bool ok,) = msg.sender.call{value: bal}("");
            if (!ok) revert NativeTransferFailed();
        }
    }

    // ── View: estimate batch gas cost ─────────────────────────────────────────
    /**
     * @notice Dry-run helper for off-chain estimators.
     *         Returns whether each item would likely succeed based on deadline + nonce checks.
     *         Does NOT simulate the full swap — use eth_estimateGas for that.
     */
    function preflightCheck(BatchItem[] calldata items)
        external
        view
        returns (bool[] memory results, string[] memory reasons)
    {
        results = new bool[](items.length);
        reasons = new string[](items.length);

        for (uint256 i; i < items.length; i++) {
            IBestExecIntent.SwapIntent calldata it = items[i].intent;

            if (block.timestamp > it.deadline) {
                results[i] = false; reasons[i] = "expired";
            } else if (it.amountIn == 0 || it.minAmountOut == 0) {
                results[i] = false; reasons[i] = "zero amount";
            } else if (it.tokenIn == it.tokenOut) {
                results[i] = false; reasons[i] = "same token";
            } else if (it.recipient == address(0)) {
                results[i] = false; reasons[i] = "zero recipient";
            } else if (items[i].routeType == ROUTE_SPLIT && address(splitRouter) == address(0)) {
                results[i] = false; reasons[i] = "splitRouter not set";
            } else if (address(payflowExecutor) == address(0) && items[i].routeType != ROUTE_SPLIT) {
                results[i] = false; reasons[i] = "executor not set";
            } else {
                results[i] = true; reasons[i] = "";
            }
        }
    }

    // ── Rescue ────────────────────────────────────────────────────────────────
    // This contract should never hold tokens in steady state, but rescue is
    // included as a safety net for any edge cases.
    function sweep(address token, address to) external onlyOwner {
        require(to != address(0), "to=0");
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) IERC20(token).safeTransfer(to, bal);
        emit Swept(token, to, bal);
    }

    receive() external payable {}

    function sweepNative(address to) external onlyOwner {
        require(to != address(0), "to=0");
        uint256 bal = address(this).balance;
        if (bal > 0) {
            (bool ok,) = to.call{value: bal}("");
            if (!ok) revert NativeTransferFailed();
        }
        emit NativeSwept(to, bal);
    }
}
