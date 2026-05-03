// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IParagonPairLike {
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

contract MaliciousReentrantToken is ERC20 {
    address public router;
    address public pair;
    bool public attackOn;

    constructor(string memory n, string memory s) ERC20(n, s) {}

    function setTargets(address _router, address _pair) external {
        router = _router;
        pair = _pair;
    }

    function setAttack(bool v) external { attackOn = v; }

    function mint(address to, uint256 amount) external { _mint(to, amount); }

    // Hook into ERC20 transfers; when router is moving tokens into the pair, reenter the pair
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (attackOn && msg.sender == router && to == pair) {
            attackOn = false; // one-shot, avoid infinite loop
            // Try to reenter (should be blocked by pair/lock)
            try IParagonPairLike(pair).swap(0, 1, address(this), "") {
                // if it didn't revert, that's a problem — test will catch by state mismatch
            } catch {
                // expected: reentrancy / invariant guard should stop this
            }
        }
    }
}
