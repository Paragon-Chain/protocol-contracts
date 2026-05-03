// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract RouterMock {
    // key: keccak256(tokenIn, tokenOut) => quoted amountOut to send
    mapping(bytes32 => uint256) public quote;

    function setQuote(address tokenIn, address tokenOut, uint256 amountOut) external {
        quote[keccak256(abi.encode(tokenIn, tokenOut))] = amountOut;
    }

    function _swap(uint amountIn, uint amountOutMin, address[] memory path, address to)
        internal
        returns (uint[] memory amounts)
    {
        require(path.length >= 2, "path");
        address tokenIn  = path[0];
        address tokenOut = path[path.length - 1];

        // pull input from msg.sender (executor approved us)
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);

        // push pre-set quote
        uint out = quote[keccak256(abi.encode(tokenIn, tokenOut))];
        require(out >= amountOutMin, "minOut");
        IERC20(tokenOut).transfer(to, out);

        amounts = new uint[](path.length);
        amounts[0] = amountIn;
        amounts[amounts.length - 1] = out;
    }

    // 1) supporting fee-on-transfer
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint /*deadline*/,
        uint8 /*autoYieldPercent*/
    ) external {
        _swap(amountIn, amountOutMin, path, to);
        // no return
    }

    // 2) overload with autoYield
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint /*deadline*/,
        uint8 /*autoYieldPercent*/
    ) external returns (uint[] memory amounts) {
        amounts = _swap(amountIn, amountOutMin, path, to);
    }

    // 3) classic overload
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint /*deadline*/
    ) external returns (uint[] memory amounts) {
        amounts = _swap(amountIn, amountOutMin, path, to);
    }
}
