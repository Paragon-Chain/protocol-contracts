// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

contract RouterMalicious {
    // All functions exist and succeed but do NOT transfer anything.
    // Your executor will see the call succeed, then detect 0 output and revert RouterSwapFailed.

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint, uint, address[] calldata, address, uint, uint8
    ) external {
        // do nothing, succeed
    }

    function swapExactTokensForTokens(
        uint /*amountIn*/,
        uint /*amountOutMin*/,
        address[] calldata path,
        address /*to*/,
        uint /*deadline*/,
        uint8 /*autoYieldPercent*/
    ) external returns (uint[] memory amounts) {
        amounts = new uint[](path.length);
    }

    function swapExactTokensForTokens(
        uint /*amountIn*/,
        uint /*amountOutMin*/,
        address[] calldata path,
        address /*to*/,
        uint /*deadline*/
    ) external returns (uint[] memory amounts) {
        amounts = new uint[](path.length);
    }
}
