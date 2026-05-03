// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockLP {
    string public constant name = "LP";
    string public constant symbol = "LP";
    uint8  public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
        emit Transfer(address(0), to, amt);
    }

    function approve(address, uint256) external pure returns (bool) { return true; }
    function transfer(address to, uint256 amt) external returns (bool) {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        emit Transfer(msg.sender, to, amt);
        return true;
    }
    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        emit Transfer(from, to, amt);
        return true;
    }
}

contract RouterWithLP {
    // key: keccak256(tokenIn, tokenOut) => quoted amountOut to send
    mapping(bytes32 => uint256) public quote;
    MockLP public immutable lp;

    constructor() { lp = new MockLP(); }

    function setQuote(address tokenIn, address tokenOut, uint256 amountOut) external {
        quote[keccak256(abi.encode(tokenIn, tokenOut))] = amountOut;
    }

    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint /*deadline*/
    ) external returns (uint[] memory amounts) {
        require(path.length >= 2, "path");
        address tokenIn  = path[0];
        address tokenOut = path[path.length - 1];

        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);

        uint out = quote[keccak256(abi.encode(tokenIn, tokenOut))];
        require(out >= amountOutMin, "minOut");
        IERC20(tokenOut).transfer(to, out);

        amounts = new uint[](path.length);
        amounts[0] = amountIn;
        amounts[amounts.length - 1] = out;
    }

    function addLiquidity(
        address /*tokenA*/, address /*tokenB*/,
        uint amountADesired, uint amountBDesired,
        uint amountAMin,     uint amountBMin,
        address to, uint /*deadline*/
    ) external returns (uint amountA, uint amountB, uint liquidity) {
        require(amountADesired >= amountAMin && amountBDesired >= amountBMin, "min");
        liquidity = amountADesired < amountBDesired ? amountADesired : amountBDesired;
        lp.mint(to, liquidity);
        return (amountADesired, amountBDesired, liquidity);
    }
}
