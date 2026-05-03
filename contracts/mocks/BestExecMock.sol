// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

contract BestExecMock {
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

    mapping(address => uint256) public nonces;

    function nonceOf(address u) external view returns (uint256) { return nonces[u]; }

    function consume(SwapIntent memory it, bytes calldata /*sig*/) external {
        require(it.nonce == nonces[it.user], "bad nonce");
        nonces[it.user] = it.nonce + 1;
        // no sig check for tests
    }

    function hashIntent(SwapIntent memory it) external pure returns (bytes32) {
        return keccak256(abi.encode(
            it.user, it.tokenIn, it.tokenOut, it.amountIn, it.minAmountOut, it.deadline, it.recipient, it.nonce
        ));
    }
}
