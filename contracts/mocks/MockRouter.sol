// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

contract MockRouter is Ownable {
    using SafeERC20 for IERC20;

    address public immutable lpToken;

    constructor(address _lpToken) Ownable(msg.sender) {
        lpToken = _lpToken;
    }

    // 1:1 output per hop
    function getAmountsOut(uint amountIn, address[] calldata path)
        external
        pure
        returns (uint[] memory amounts)
    {
        require(path.length >= 2, "bad path");
        amounts = new uint[](path.length);
        for (uint i = 0; i < path.length; i++) {
            amounts[i] = amountIn;
        }
    }

    function getAmountsIn(uint amountOut, address[] calldata path)
        external
        pure
        returns (uint[] memory amounts)
    {
        require(path.length >= 2, "bad path");
        amounts = new uint[](path.length);
        for (uint i = 0; i < path.length; i++) {
            amounts[i] = amountOut;
        }
    }

    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts) {
        require(path.length >= 2, "bad path");
        require(block.timestamp <= deadline, "expired");

        address tokenIn = path[0];
        address tokenOut = path[path.length - 1];

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        // mint 1:1 output
        IMintable(tokenOut).mint(to, amountIn);

        amounts = new uint[](path.length);
        for (uint i = 0; i < path.length; i++) {
            amounts[i] = amountIn;
        }

        require(amounts[path.length - 1] >= amountOutMin, "minOut");
    }

    function addLiquidity(
        address tokenA, address tokenB,
        uint amountADesired, uint amountBDesired,
        uint amountAMin, uint amountBMin,
        address to, uint deadline
    ) external returns (uint amountA, uint amountB, uint liquidity) {
        require(block.timestamp <= deadline, "expired");

        IERC20(tokenA).safeTransferFrom(msg.sender, address(this), amountADesired);
        IERC20(tokenB).safeTransferFrom(msg.sender, address(this), amountBDesired);

        amountA = amountADesired;
        amountB = amountBDesired;
        require(amountA >= amountAMin && amountB >= amountBMin, "min");

        liquidity = (amountA + amountB) / 2;
        require(liquidity > 0, "no liq");

        IMintable(lpToken).mint(to, liquidity);
    }
}
