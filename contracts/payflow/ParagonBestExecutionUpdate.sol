// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IEIP1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

/**
 * @title ParagonBestExecutionUpdate
 * @notice Drop-in replacement for ParagonBestExecutionV14. Deploy fresh and point
 *         PayflowExecutorUpdate at this address.
 *         DO NOT modify the audited ParagonBestExecutionV14.
 *
 * Changes over V14:
 *  1. BITMAP NONCES (Permit2-style)
 *       nonce encoding: bits[255..8] = word position, bits[7..0] = bit position within word.
 *       Users can hold unlimited concurrent intents. Canceling one never blocks another.
 *       `nonceBitmap[user][word]` — bit set = used/cancelled.
 *
 *  2. PROPER amountOut IN EVENT
 *       `consume` still fires before the swap (correct security order) and emits
 *       `IntentConsumed` with nonce only.
 *       Executor calls `reportExecution(user, nonce, amountOut)` after the swap is settled,
 *       emitting `BestExecution` with the real fill amount. Gated to authorized executors.
 *
 *  3. BATCH CANCEL
 *       `cancelBatch(word, mask)` invalidates up to 256 nonces in one call.
 *
 *  4. All V14 signature paths preserved (primary typehash + two legacy variants, EIP-1271,
 *     EOA ECDSA recovery). Domain VERSION bumped to "2" (new address, new domain).
 */
contract ParagonBestExecutionUpdate is Ownable {
    using ECDSA for bytes32;

    string  public constant NAME    = "ParagonBestExecution";
    string  public constant VERSION = "2";
    bytes32 public immutable DOMAIN_SEPARATOR;

    // keccak256("SwapIntent(address user,address tokenIn,address tokenOut,uint256 amountIn,
    //            uint256 minAmountOut,uint256 deadline,address recipient,uint256 nonce)")
    // Struct layout identical to V14 — only nonce interpretation changes.
    bytes32 public constant INTENT_TYPEHASH =
        0x3bd37b889cb869efed4995e979017a10e93e3ec031a3d86332421b98ad625cc6;

    // Legacy typehash variants from V14 — preserved for sig compatibility
    bytes32 private constant INTENT_TYPEHASH_SPACES =
        0x05b39d4bdc6b2679a634346bc60b08b95b4ede11751dfbe20c9c1215858ad589;
    bytes32 private constant INTENT_TYPEHASH_OLD =
        0xb4656a9b09580b84789cc96df0bc0eb4137bdccb4c656425f69526f623210534;

    bytes4 private constant EIP1271_MAGIC = 0x1626ba7e;

    struct SwapIntent {
        address user;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        uint256 deadline;
        address recipient;
        // Bitmap-encoded nonce: bits[255..8] = word, bits[7..0] = bit position within word.
        // Off-chain: pick any unused (word, bit) pair. Use isNonceUsed() to check.
        uint256 nonce;
    }

    // ── Storage ───────────────────────────────────────────────────────────────
    // user => word => 256-bit bitmap. Bit set = nonce consumed or cancelled.
    mapping(address => mapping(uint248 => uint256)) public nonceBitmap;
    mapping(address => bool) public authorizedExecutors;

    // ── Events ────────────────────────────────────────────────────────────────
    /// @dev Emitted by consume() — before swap executes. amountOut not yet known.
    event IntentConsumed(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        address executor,
        uint256 nonce
    );

    /// @dev Emitted by reportExecution() — after swap settles. Contains real amountOut.
    event BestExecution(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address recipient,
        address executor,
        uint256 nonce
    );

    event IntentCanceled(address indexed user, uint256 nonce);
    event IntentsBatchCanceled(address indexed user, uint248 word, uint256 mask);
    event ExecutorSet(address indexed executor, bool authorized);

    // ── Constructor ──────────────────────────────────────────────────────────
    constructor(address initialOwner) Ownable(initialOwner) {
        uint256 chainId;
        assembly { chainId := chainid() }
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(NAME)),
                keccak256(bytes(VERSION)),
                chainId,
                address(this)
            )
        );
    }

    // ── Admin ─────────────────────────────────────────────────────────────────
    function setAuthorizedExecutor(address executor, bool authorized) external onlyOwner {
        require(executor != address(0), "executor=0");
        authorizedExecutors[executor] = authorized;
        emit ExecutorSet(executor, authorized);
    }

    // ── Nonce helpers ─────────────────────────────────────────────────────────
    function _wordPos(uint256 nonce) internal pure returns (uint248) {
        return uint248(nonce >> 8);
    }

    function _bitPos(uint256 nonce) internal pure returns (uint8) {
        return uint8(nonce & 0xFF);
    }

    function _isUsed(address user, uint256 nonce) internal view returns (bool) {
        return (nonceBitmap[user][_wordPos(nonce)] >> _bitPos(nonce)) & 1 == 1;
    }

    function _markUsed(address user, uint256 nonce) internal {
        nonceBitmap[user][_wordPos(nonce)] |= (uint256(1) << _bitPos(nonce));
    }

    /// @notice Returns true if the given nonce has been used or cancelled for this user.
    function isNonceUsed(address user, uint256 nonce) external view returns (bool) {
        return _isUsed(user, nonce);
    }

    /// @notice Returns the full 256-bit bitmap word for a given user and word position.
    ///         Off-chain: scan words to find available bit positions.
    function getNonceBitmapWord(address user, uint248 word) external view returns (uint256) {
        return nonceBitmap[user][word];
    }

    // ── EIP-712 hashing ───────────────────────────────────────────────────────
    function _structHash(bytes32 typehash, SwapIntent calldata it) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            typehash,
            it.user,
            it.tokenIn,
            it.tokenOut,
            it.amountIn,
            it.minAmountOut,
            it.deadline,
            it.recipient,
            it.nonce
        ));
    }

    function _digest(bytes32 typehash, SwapIntent calldata it) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, _structHash(typehash, it)));
    }

    function hashIntent(SwapIntent calldata it) public view returns (bytes32) {
        return _digest(INTENT_TYPEHASH, it);
    }

    // ── Signature verification ────────────────────────────────────────────────
    function _userEIP1271Ok(SwapIntent calldata it, bytes calldata sig) internal view returns (bool) {
        if (it.user.code.length == 0) return false;
        (bool ok, bytes memory ret) = it.user.staticcall(
            abi.encodeWithSelector(IEIP1271.isValidSignature.selector, hashIntent(it), sig)
        );
        return ok && ret.length >= 4 && bytes4(ret) == EIP1271_MAGIC;
    }

    function _recoverEOA(SwapIntent calldata it, bytes calldata sig) internal view returns (address) {
        (address s, ECDSA.RecoverError e,) = ECDSA.tryRecover(_digest(INTENT_TYPEHASH, it), sig);
        if (e == ECDSA.RecoverError.NoError && s != address(0)) return s;
        (s, e,) = ECDSA.tryRecover(_digest(INTENT_TYPEHASH_SPACES, it), sig);
        if (e == ECDSA.RecoverError.NoError && s != address(0)) return s;
        (s, e,) = ECDSA.tryRecover(_digest(INTENT_TYPEHASH_OLD, it), sig);
        return (e == ECDSA.RecoverError.NoError) ? s : address(0);
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /// @notice Read-only verification — does not modify state.
    function verify(SwapIntent calldata it, bytes calldata sig) public view returns (bool) {
        if (block.timestamp > it.deadline) return false;
        if (_isUsed(it.user, it.nonce)) return false;
        if (it.user == address(0) || it.tokenIn == address(0) ||
            it.tokenOut == address(0) || it.recipient == address(0)) return false;
        if (_userEIP1271Ok(it, sig)) return true;
        return _recoverEOA(it, sig) == it.user;
    }

    /**
     * @notice Consume an intent. Called by an authorized executor BEFORE the swap executes.
     *         Marks the nonce used and emits IntentConsumed. The executor then calls
     *         reportExecution() after the swap to emit BestExecution with real amountOut.
     */
    function consume(SwapIntent calldata it, bytes calldata sig) external {
        require(authorizedExecutors[msg.sender], "Unauthorized executor");
        require(block.timestamp <= it.deadline, "intent: expired");
        require(!_isUsed(it.user, it.nonce), "intent: used");
        require(
            it.user != address(0) && it.tokenIn != address(0) &&
            it.tokenOut != address(0) && it.recipient != address(0),
            "intent: zero addr"
        );

        if (it.user.code.length != 0) {
            (bool ok, bytes memory ret) = it.user.staticcall(
                abi.encodeWithSelector(IEIP1271.isValidSignature.selector, hashIntent(it), sig)
            );
            require(ok && ret.length >= 4 && bytes4(ret) == EIP1271_MAGIC, "intent: 1271");
        } else {
            require(_recoverEOA(it, sig) == it.user, "intent: sig");
        }

        _markUsed(it.user, it.nonce);

        emit IntentConsumed(
            it.user, it.tokenIn, it.tokenOut,
            it.amountIn, it.minAmountOut,
            it.recipient, msg.sender, it.nonce
        );
    }

    /**
     * @notice Called by the authorized executor AFTER the swap settles to record the real amountOut.
     *         Emits BestExecution with actual fill data — the authoritative event for indexers.
     * @param user      Intent signer.
     * @param nonce     The nonce from the SwapIntent (must already be marked used).
     * @param tokenIn   tokenIn from the SwapIntent.
     * @param tokenOut  tokenOut from the SwapIntent.
     * @param amountIn  amountIn from the SwapIntent.
     * @param amountOut Actual tokens received by recipient after surplus split.
     * @param recipient recipient from the SwapIntent.
     */
    function reportExecution(
        address user,
        uint256 nonce,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address recipient
    ) external {
        require(authorizedExecutors[msg.sender], "Unauthorized executor");
        // Nonce must already be consumed — guards against fake reports.
        require(_isUsed(user, nonce), "intent: not consumed");

        emit BestExecution(user, tokenIn, tokenOut, amountIn, amountOut, recipient, msg.sender, nonce);
    }

    /**
     * @notice Cancel a single nonce. Can be called by the user at any time.
     */
    function cancel(uint256 nonce) external {
        require(!_isUsed(msg.sender, nonce), "already used");
        _markUsed(msg.sender, nonce);
        emit IntentCanceled(msg.sender, nonce);
    }

    /**
     * @notice Cancel up to 256 nonces in a single word with a bitmask. Efficient bulk cancel.
     * @param word  The word position (intent.nonce >> 8).
     * @param mask  Bitmask of bit positions to cancel within this word.
     *              Already-used bits are silently kept; no double-cancel risk.
     */
    function cancelBatch(uint248 word, uint256 mask) external {
        nonceBitmap[msg.sender][word] |= mask;
        emit IntentsBatchCanceled(msg.sender, word, mask);
    }
}
