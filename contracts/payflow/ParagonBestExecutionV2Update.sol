// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IEIP1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

/**
 * @title ParagonBestExecutionV2Update
 * @notice Extends ParagonBestExecutionUpdate (V15) with partial fill support.
 *         DO NOT modify ParagonBestExecutionV14 or ParagonBestExecutionUpdate.
 *         Deploy fresh. Point ParagonPayflowExecutorV2Update at this address.
 *
 * Changes over ParagonBestExecutionUpdate (V15):
 *
 *  1. PARTIAL FILLS
 *       SwapIntent.amountIn now represents the MAXIMUM total fill allowed.
 *       Executors call partialConsume(intent, sig, fillAmount) to fill in chunks.
 *       Remaining fill capacity tracked in amountFilled[user][nonce].
 *       Nonce bitmap bit is only set (fully burned) once totalFilled >= amountIn
 *       OR the user explicitly cancels.
 *       Multiple executors can race to fill different portions of the same intent.
 *
 *  2. MINIMUM FILL SIZE
 *       SwapIntent carries a minFillAmount field (new typehash).
 *       Executors cannot fill dust amounts; each fill must be >= minFillAmount.
 *
 *  3. FULL FILL SHORTCUT
 *       consume(intent, sig) still works for a full all-at-once fill (backward
 *       compatible with existing executors pointing here). Internally calls
 *       partialConsume with fillAmount == amountIn.
 *
 *  4. REPORTING
 *       partialConsume emits PartialIntentFilled with cumulative filled amount.
 *       When fully filled, also emits IntentFullyFilled.
 *       reportExecution carries fillAmount for partial accuracy.
 *
 *  All V15 features preserved:
 *    - Bitmap nonces, cancelBatch, isNonceUsed, getNonceBitmapWord
 *    - EIP-1271 + EOA recovery + 3 legacy typehash fallbacks
 *    - reportExecution for accurate BestExecution event
 *    - VERSION bumped to "3" (new domain separator)
 */
contract ParagonBestExecutionV2Update is Ownable {
    using ECDSA for bytes32;

    string  public constant NAME    = "ParagonBestExecution";
    string  public constant VERSION = "3";
    bytes32 public immutable DOMAIN_SEPARATOR;

    // keccak256("SwapIntent(address user,address tokenIn,address tokenOut,uint256 amountIn,
    //             uint256 minAmountOut,uint256 deadline,address recipient,uint256 nonce,
    //             uint256 minFillAmount)")
    // New typehash — adds minFillAmount field.
    bytes32 public constant INTENT_TYPEHASH =
        keccak256(
            "SwapIntent(address user,address tokenIn,address tokenOut,uint256 amountIn,"
            "uint256 minAmountOut,uint256 deadline,address recipient,uint256 nonce,"
            "uint256 minFillAmount)"
        );

    // V15 legacy typehashes — kept for cross-version signature compatibility
    bytes32 private constant INTENT_TYPEHASH_V15 =
        0x3bd37b889cb869efed4995e979017a10e93e3ec031a3d86332421b98ad625cc6;
    bytes32 private constant INTENT_TYPEHASH_SPACES =
        0x05b39d4bdc6b2679a634346bc60b08b95b4ede11751dfbe20c9c1215858ad589;
    bytes32 private constant INTENT_TYPEHASH_OLD =
        0xb4656a9b09580b84789cc96df0bc0eb4137bdccb4c656425f69526f623210534;

    bytes4 private constant EIP1271_MAGIC = 0x1626ba7e;

    // ── Intent struct ─────────────────────────────────────────────────────────
    struct SwapIntent {
        address user;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;       // Maximum total fill (sum of all partials must not exceed this)
        uint256 minAmountOut;   // Minimum per-unit output rate: executor guarantees at least
                                // (fillAmount * minAmountOut / amountIn) per partial fill
        uint256 deadline;
        address recipient;
        uint256 nonce;          // Bitmap-encoded: bits[255..8]=word, bits[7..0]=bit
        uint256 minFillAmount;  // Each individual fill must be >= this. 0 = no minimum.
    }

    /// @dev Legacy V15 intent layout retained for executor ABI compatibility.
    struct LegacySwapIntent {
        address user;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        uint256 deadline;
        address recipient;
        uint256 nonce;
    }

    // ── Storage ───────────────────────────────────────────────────────────────
    // Bitmap: user => word => 256-bit map. Bit SET = nonce fully burned.
    mapping(address => mapping(uint248 => uint256)) public nonceBitmap;

    // Partial fill tracking: user => nonce => total amount filled so far
    mapping(address => mapping(uint256 => uint256)) public amountFilled;

    mapping(address => bool) public authorizedExecutors;

    // ── Events ────────────────────────────────────────────────────────────────
    event IntentConsumed(
        address indexed user, address indexed tokenIn, address indexed tokenOut,
        uint256 amountIn, uint256 fillAmount, address recipient, address executor, uint256 nonce
    );
    event PartialIntentFilled(
        address indexed user, uint256 indexed nonce,
        uint256 fillAmount, uint256 totalFilled, uint256 maxAmount
    );
    event IntentFullyFilled(address indexed user, uint256 indexed nonce, uint256 totalFilled);
    event BestExecution(
        address indexed user, address indexed tokenIn, address indexed tokenOut,
        uint256 amountIn, uint256 amountOut, address recipient, address executor, uint256 nonce
    );
    event IntentCanceled(address indexed user, uint256 nonce);
    event IntentsBatchCanceled(address indexed user, uint248 word, uint256 mask);
    event ExecutorSet(address indexed executor, bool authorized);

    // ── Constructor ───────────────────────────────────────────────────────────
    constructor(address initialOwner) Ownable(initialOwner) {
        uint256 chainId;
        assembly { chainId := chainid() }
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes(NAME)),
            keccak256(bytes(VERSION)),
            chainId,
            address(this)
        ));
    }

    // ── Admin ─────────────────────────────────────────────────────────────────
    function setAuthorizedExecutor(address executor, bool authorized) external onlyOwner {
        require(executor != address(0), "executor=0");
        authorizedExecutors[executor] = authorized;
        emit ExecutorSet(executor, authorized);
    }

    // ── Nonce bitmap helpers ──────────────────────────────────────────────────
    function _wordPos(uint256 nonce) internal pure returns (uint248) { return uint248(nonce >> 8); }
    function _bitPos(uint256 nonce) internal pure returns (uint8)    { return uint8(nonce & 0xFF); }

    function _isFullyBurned(address user, uint256 nonce) internal view returns (bool) {
        return (nonceBitmap[user][_wordPos(nonce)] >> _bitPos(nonce)) & 1 == 1;
    }

    function _burnNonce(address user, uint256 nonce) internal {
        nonceBitmap[user][_wordPos(nonce)] |= (uint256(1) << _bitPos(nonce));
    }

    function isNonceUsed(address user, uint256 nonce) external view returns (bool) {
        return _isFullyBurned(user, nonce);
    }

    function getNonceBitmapWord(address user, uint248 word) external view returns (uint256) {
        return nonceBitmap[user][word];
    }

    /// @notice Remaining fill capacity on a partial intent.
    function remainingFill(address user, uint256 nonce, uint256 maxAmount) external view returns (uint256) {
        if (_isFullyBurned(user, nonce)) return 0;
        uint256 filled = amountFilled[user][nonce];
        return filled >= maxAmount ? 0 : maxAmount - filled;
    }

    // ── EIP-712 hashing ───────────────────────────────────────────────────────
    function _structHash(SwapIntent memory it) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            INTENT_TYPEHASH,
            it.user, it.tokenIn, it.tokenOut,
            it.amountIn, it.minAmountOut, it.deadline,
            it.recipient, it.nonce, it.minFillAmount
        ));
    }

    function _digest(SwapIntent memory it) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, _structHash(it)));
    }

    /// @notice Returns the EIP-712 digest for this intent.
    function hashIntent(SwapIntent calldata it) public view returns (bytes32) {
        return _digest(it);
    }

    /// @notice Legacy V15 digest retained for existing executors and indexers.
    function hashIntent(LegacySwapIntent calldata it) external view returns (bytes32) {
        return _digest(_upgradeLegacyIntent(it));
    }

    // ── Signature verification ────────────────────────────────────────────────
    function _userEIP1271Ok(SwapIntent memory it, bytes calldata sig) internal view returns (bool) {
        if (it.user.code.length == 0) return false;
        (bool ok, bytes memory ret) = it.user.staticcall(
            abi.encodeWithSelector(IEIP1271.isValidSignature.selector, _digest(it), sig)
        );
        return ok && ret.length >= 4 && bytes4(ret) == EIP1271_MAGIC;
    }

    /// @dev Tries current typehash first, then falls back to V15 and legacy hashes
    ///      so existing signed intents can still be consumed.
    function _recoverSigner(SwapIntent memory it, bytes calldata sig) internal view returns (address) {
        // V16 typehash (with minFillAmount)
        {
            (address s, ECDSA.RecoverError e,) = ECDSA.tryRecover(_digest(it), sig);
            if (e == ECDSA.RecoverError.NoError && s != address(0)) return s;
        }
        // V15 typehash fallbacks (minFillAmount field is ignored in legacy hash)
        bytes32 legacyStruct = keccak256(abi.encode(
            INTENT_TYPEHASH_V15,
            it.user, it.tokenIn, it.tokenOut,
            it.amountIn, it.minAmountOut, it.deadline,
            it.recipient, it.nonce
        ));
        bytes32 legacyDigest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, legacyStruct));
        {
            (address s, ECDSA.RecoverError e,) = ECDSA.tryRecover(legacyDigest, sig);
            if (e == ECDSA.RecoverError.NoError && s != address(0)) return s;
        }
        // Spaces + old variant fallbacks
        bytes32 spacesDigest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR,
            keccak256(abi.encode(INTENT_TYPEHASH_SPACES,
                it.user, it.tokenIn, it.tokenOut,
                it.amountIn, it.minAmountOut, it.deadline, it.recipient, it.nonce))));
        {
            (address s, ECDSA.RecoverError e,) = ECDSA.tryRecover(spacesDigest, sig);
            if (e == ECDSA.RecoverError.NoError && s != address(0)) return s;
        }
        bytes32 oldDigest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR,
            keccak256(abi.encode(INTENT_TYPEHASH_OLD,
                it.user, it.tokenIn, it.tokenOut,
                it.amountIn, it.minAmountOut, it.deadline, it.recipient, it.nonce))));
        {
            (address s, ECDSA.RecoverError e,) = ECDSA.tryRecover(oldDigest, sig);
            if (e == ECDSA.RecoverError.NoError && s != address(0)) return s;
        }
        return address(0);
    }

    function _verifySig(SwapIntent memory it, bytes calldata sig) internal view {
        if (it.user.code.length != 0) {
            // Smart wallet — try EIP-1271
            require(_userEIP1271Ok(it, sig), "intent: 1271");
        } else {
            require(_recoverSigner(it, sig) == it.user, "intent: sig");
        }
    }

    // ── Public: verify (read-only) ────────────────────────────────────────────
    function verify(SwapIntent calldata it, bytes calldata sig) public view returns (bool) {
        if (block.timestamp > it.deadline) return false;
        if (_isFullyBurned(it.user, it.nonce)) return false;
        if (amountFilled[it.user][it.nonce] >= it.amountIn) return false;
        if (it.user == address(0) || it.tokenIn == address(0) ||
            it.tokenOut == address(0) || it.recipient == address(0)) return false;
        if (_userEIP1271Ok(it, sig)) return true;
        return _recoverSigner(it, sig) == it.user;
    }

    /// @notice Legacy verifier retained for systems using the V15 tuple layout.
    function verify(LegacySwapIntent calldata it, bytes calldata sig) external view returns (bool) {
        SwapIntent memory upgraded = _upgradeLegacyIntent(it);
        if (block.timestamp > upgraded.deadline) return false;
        if (_isFullyBurned(upgraded.user, upgraded.nonce)) return false;
        if (amountFilled[upgraded.user][upgraded.nonce] >= upgraded.amountIn) return false;
        if (upgraded.user == address(0) || upgraded.tokenIn == address(0) ||
            upgraded.tokenOut == address(0) || upgraded.recipient == address(0)) return false;
        if (_userEIP1271Ok(upgraded, sig)) return true;
        return _recoverSigner(upgraded, sig) == upgraded.user;
    }

    // ── Public: consume (full fill — backward compatible) ─────────────────────
    /// @notice Full fill. Burns the nonce immediately. Backward compatible with V15 interface.
    function consume(SwapIntent calldata it, bytes calldata sig) external {
        _partialConsume(it, sig, it.amountIn);
    }

    /// @notice Legacy full-fill entrypoint retained for executors using the V15 ABI.
    function consume(LegacySwapIntent calldata it, bytes calldata sig) external {
        SwapIntent memory upgraded = _upgradeLegacyIntent(it);
        _partialConsume(upgraded, sig, upgraded.amountIn);
    }

    // ── Public: partialConsume ────────────────────────────────────────────────
    /**
     * @notice Partially fill an intent. Authorized executors only.
     * @param fillAmount Amount of tokenIn to fill in this execution.
     *                   Must be >= it.minFillAmount (if set) and must not exceed
     *                   the remaining unfilled capacity.
     *
     * The executor is responsible for passing the correct proportional minAmountOut
     * to the swap: (fillAmount * it.minAmountOut) / it.amountIn
     */
    function partialConsume(
        SwapIntent calldata it,
        bytes calldata sig,
        uint256 fillAmount
    ) public {
        _partialConsume(it, sig, fillAmount);
    }

    function _partialConsume(
        SwapIntent memory it,
        bytes calldata sig,
        uint256 fillAmount
    ) internal {
        require(authorizedExecutors[msg.sender], "Unauthorized executor");
        require(block.timestamp <= it.deadline, "intent: expired");
        require(!_isFullyBurned(it.user, it.nonce), "intent: burned");
        require(
            it.user != address(0) && it.tokenIn != address(0) &&
            it.tokenOut != address(0) && it.recipient != address(0),
            "intent: zero addr"
        );
        require(fillAmount > 0, "intent: zero fill");
        if (it.minFillAmount > 0) {
            require(fillAmount >= it.minFillAmount, "intent: below minFill");
        }

        uint256 alreadyFilled = amountFilled[it.user][it.nonce];
        require(alreadyFilled < it.amountIn, "intent: fully filled");
        require(fillAmount <= it.amountIn - alreadyFilled, "intent: overfill");

        _verifySig(it, sig);

        uint256 newTotal = alreadyFilled + fillAmount;
        amountFilled[it.user][it.nonce] = newTotal;

        emit IntentConsumed(
            it.user, it.tokenIn, it.tokenOut,
            it.amountIn, fillAmount,
            it.recipient, msg.sender, it.nonce
        );
        emit PartialIntentFilled(it.user, it.nonce, fillAmount, newTotal, it.amountIn);

        // Burn nonce if fully filled
        if (newTotal >= it.amountIn) {
            _burnNonce(it.user, it.nonce);
            emit IntentFullyFilled(it.user, it.nonce, newTotal);
        }
    }

    function _upgradeLegacyIntent(LegacySwapIntent calldata it) internal pure returns (SwapIntent memory upgraded) {
        upgraded = SwapIntent({
            user: it.user,
            tokenIn: it.tokenIn,
            tokenOut: it.tokenOut,
            amountIn: it.amountIn,
            minAmountOut: it.minAmountOut,
            deadline: it.deadline,
            recipient: it.recipient,
            nonce: it.nonce,
            minFillAmount: 0
        });
    }

    // ── Public: reportExecution ───────────────────────────────────────────────
    /**
     * @notice Called by executor after swap settles to emit authoritative BestExecution event.
     * @param fillAmount  The portion of amountIn that was filled in this execution.
     * @param amountOut   Actual tokenOut received by recipient for this fill.
     */
    function reportExecution(
        address user,
        uint256 nonce,
        address tokenIn,
        address tokenOut,
        uint256 fillAmount,
        uint256 amountOut,
        address recipient
    ) external {
        require(authorizedExecutors[msg.sender], "Unauthorized executor");
        // amountFilled must have been updated (nonce either partially or fully consumed)
        require(amountFilled[user][nonce] > 0 || _isFullyBurned(user, nonce), "intent: not consumed");

        emit BestExecution(user, tokenIn, tokenOut, fillAmount, amountOut, recipient, msg.sender, nonce);
    }

    // ── Public: cancel ────────────────────────────────────────────────────────
    /// @notice Cancel a nonce — burns the bitmap bit and clears any partial fill state.
    function cancel(uint256 nonce) external {
        require(!_isFullyBurned(msg.sender, nonce), "already burned");
        _burnNonce(msg.sender, nonce);
        delete amountFilled[msg.sender][nonce];
        emit IntentCanceled(msg.sender, nonce);
    }

    /// @notice Batch cancel up to 256 nonces in one word.
    function cancelBatch(uint248 word, uint256 mask) external {
        nonceBitmap[msg.sender][word] |= mask;
        emit IntentsBatchCanceled(msg.sender, word, mask);
    }
}
