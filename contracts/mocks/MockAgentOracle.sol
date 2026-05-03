// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

/**
 * @dev Test oracle for agent executor coverage.
 * - `price1e18[token]` stores USD price in 1e18 precision
 * - `getAmountsOutUsingTwap` derives a quote from tokenIn/tokenOut prices
 */
contract MockAgentOracle {
    mapping(address => uint256) public price1e18;

    function setPrice(address token, uint256 price) external {
        price1e18[token] = price;
    }

    function priceUsd1e18(address token, address, address) external view returns (uint256) {
        return price1e18[token];
    }

    function getAmountsOutUsingTwap(
        uint256 amountIn,
        address[] memory path,
        uint32
    ) external view returns (uint256[] memory amounts) {
        require(path.length >= 2, "BAD_PATH");

        uint256 priceIn = price1e18[path[0]];
        uint256 priceOut = price1e18[path[path.length - 1]];
        require(priceIn != 0 && priceOut != 0, "NO_PRICE");

        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = (amountIn * priceIn) / priceOut;
    }
}
