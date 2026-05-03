// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IERC20 { function transfer(address,uint256) external returns (bool); function transferFrom(address,address,uint256) external returns (bool); }
interface IGC {
  function n_gauges() external view returns (uint256);
  function gaugesAt(uint256) external view returns (address);
  function gaugeWeight(address) external view returns (uint256);
  function totalWeight() external view returns (uint256);
}

contract GaugeEmitterToFarmBps is Ownable {
  IERC20 public immutable reward;       // XPGN
  IGC    public immutable controller;   // GaugeController (BPS)
  address public farm;                  // FarmController
  mapping(address => uint256) public poolIdOf; // gauge -> farm poolId

  event FarmSet(address farm);
  event GaugeMapped(address gauge, uint256 poolId);
  event Notified(uint256 weekTs, uint256 amount);

  constructor(address _reward, address _controller, address _farm, address _owner) Ownable(_owner) {
    reward = IERC20(_reward);
    controller = IGC(_controller);
    farm = _farm;
  }

  function setFarm(address f) external onlyOwner { farm = f; emit FarmSet(f); }
  function setPoolId(address gauge, uint256 pid) external onlyOwner { poolIdOf[gauge] = pid; emit GaugeMapped(gauge, pid); }

  // Treasury/owner calls this weekly after giving allowance to this contract
  function notifyRewardAmount(uint256 weekTs, uint256 amount) external onlyOwner {
    require(reward.transferFrom(msg.sender, address(this), amount), "xferFrom");

    uint256 tot = controller.totalWeight();
    require(tot > 0, "no weights");
    uint256 n = controller.n_gauges();

    for (uint256 i = 0; i < n; i++) {
      address g = controller.gaugesAt(i);
      uint256 w = controller.gaugeWeight(g);
      if (w == 0) continue;

      uint256 pid = poolIdOf[g];
      if (pid == 0 && poolIdOf[g] == 0) continue; // require mapping

      uint256 share = amount * w / tot;
      if (share == 0) continue;

      // send tokens to farm then notify
      require(reward.transfer(farm, share), "xfer->farm");

      (bool ok, ) = farm.call(abi.encodeWithSignature("notifyRewardAmount(uint256,uint256)", pid, share));
      if (!ok) {
        (ok, ) = farm.call(abi.encodeWithSignature("notifyRewardAmount(uint256,address,uint256)", pid, address(reward), share));
        require(ok, "farm notify failed");
      }
    }
    emit Notified(weekTs, amount);
  }
}
