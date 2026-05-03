// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

interface IExecSweep {
    function sweep(address token, address to) external;
}

contract LPRebatesReentrant {
    address public target;
    bool private entered;

    event Notified(address tokenIn, address tokenOut, address reward, uint256 amount);

    function setTarget(address t) external { target = t; }

    function notify(address tokenIn, address tokenOut, address rewardToken, uint256 amount) external {
        emit Notified(tokenIn, tokenOut, rewardToken, amount);

        // Attempt a re-entrancy (safely wrapped)
        if (!entered && target != address(0)) {
            entered = true;
            try IExecSweep(target).sweep(rewardToken, msg.sender) {
                // ignore success
            } catch {
                // swallow revert to keep outer tx alive
            }
            entered = false;
        }
    }
}
