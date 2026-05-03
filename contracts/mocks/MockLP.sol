// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
contract MockLP is ERC20 { constructor() ERC20("LP","LP"){} function mint(address to,uint amt) external { _mint(to,amt);} }
