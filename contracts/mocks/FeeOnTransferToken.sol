// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract FeeOnTransferToken is ERC20 {
    uint8 private _customDec;
    uint16 public feeBps; // 100 = 1%

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) { _customDec = d; }
    function decimals() public view override returns (uint8) { return _customDec; }
    function setFee(uint16 bps) external { require(bps <= 2000, "fee too big"); feeBps = bps; }
    function mint(address to, uint256 amt) external { _mint(to, amt); }

    // OZ v5 uses _update hook instead of _transfer
    function _update(address from, address to, uint256 value) internal override {
        if (feeBps > 0 && from != address(0) && to != address(0)) {
            uint256 fee = (value * feeBps) / 10_000;
            uint256 send = value - fee;
            super._update(from, to, send);
            if (fee > 0) super._update(from, address(this), fee);
        } else {
            super._update(from, to, value);
        }
    }
}
