// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract ReentrantToken is ERC20 {
    uint8 private _customDec;
    address public target;
    bytes public data;
    bool private entered;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _customDec = d;
    }

    function decimals() public view override returns (uint8) { return _customDec; }

    function mint(address to, uint256 amt) external { _mint(to, amt); }

    function setReenterTarget(address _t, bytes calldata _d) external {
        target = _t;
        data = _d;
    }

    // Re-enter on outbound transfer (from != address(0))
    function _update(address from, address to, uint256 value) internal override {
        if (!entered && target != address(0) && from != address(0)) {
            entered = true;

            // ✅ Must bind return values to identifiers (not types or blanks)
            (bool ok, bytes memory ret) = target.call(data);
            // touch them to avoid "unused variable" warnings
            ok; ret;

            entered = false;
        }
        super._update(from, to, value);
    }
}
