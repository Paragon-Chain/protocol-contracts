// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IVoterEscrowMinimal {
    function balanceOf(address account) external view returns (uint256);
    function balanceOfAtTime(address account, uint256 ts) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function totalSupplyAtTime(uint256 ts) external view returns (uint256);
    function token() external view returns (address);
}
