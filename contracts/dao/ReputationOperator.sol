// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

interface IParagonReputationV1 {
  function addPoints(address user, uint256 amount) external;
}

contract ReputationOperator is Ownable {
  address public rep;

  mapping(address => bool) public callers;
  bool public enabled = true;

  uint16  public pointsPer1kUsdVolume = 10;
  uint16  public pointsPer1UsdSaved   = 1;
  uint256 public dailyCapPerUser      = 500;

  mapping(address => mapping(uint256 => uint256)) public dailyAccrued;

  event CallerSet(address caller, bool allowed);
  event KnobsSet(uint16 per1kUsdVolume, uint16 per1UsdSaved, uint256 dailyCapPerUser);
  event Enabled(bool enabled);
  event RepAward(address indexed user, uint256 points, uint256 usdVolume1e18, uint256 usdSaved1e18, bytes32 ref, uint256 dayKey);
  event RepSet(address indexed rep);
  // NEW: optional signal when both v2 and v1 calls fail (purely observability)
  event RepPushFailed(address indexed user, uint256 amount, bytes32 ref);

  constructor(address _rep, address _owner) Ownable(_owner) {
    require(_rep != address(0), "rep=0");
    rep = _rep;
    emit RepSet(_rep);
  }

  modifier onlyCaller() {
    require(callers[msg.sender], "not-authorized");
    _;
  }

  function setCaller(address c, bool allowed) external onlyOwner {
    callers[c] = allowed;
    emit CallerSet(c, allowed);
  }

  function setKnobs(uint16 per1kUsd, uint16 perUsdSaved, uint256 cap) external onlyOwner {
    pointsPer1kUsdVolume = per1kUsd;
    pointsPer1UsdSaved   = perUsdSaved;
    dailyCapPerUser      = cap;
    emit KnobsSet(per1kUsd, perUsdSaved, cap);
  }

  function setEnabled(bool e) external onlyOwner { enabled = e; emit Enabled(e); }

  function setRep(address _rep) external onlyOwner {
    require(_rep != address(0), "rep=0");
    rep = _rep;
    emit RepSet(_rep);
  }

  function previewPoints(uint256 usdVolume1e18, uint256 usdSaved1e18) public view returns (uint256) {
    uint256 pts = 0;
    if (pointsPer1kUsdVolume > 0 && usdVolume1e18 > 0) {
      pts += (usdVolume1e18 * pointsPer1kUsdVolume) / 1_000e18;
    }
    if (pointsPer1UsdSaved > 0 && usdSaved1e18 > 0) {
      pts += (usdSaved1e18 * pointsPer1UsdSaved) / 1e18;
    }
    return pts;
  }

  function onPayflowExecuted(
    address user,
    uint256 usdVolume1e18,
    uint256 usdSaved1e18,
    bytes32 ref
  ) external onlyCaller {
    if (!enabled || user == address(0)) return;

    uint256 pts = previewPoints(usdVolume1e18, usdSaved1e18);
    if (pts == 0) return;

    uint256 dayKey = block.timestamp / 1 days;
    uint256 cur = dailyAccrued[user][dayKey];
    if (cur >= dailyCapPerUser) return;

    uint256 grant = pts;
    if (cur + grant > dailyCapPerUser) grant = dailyCapPerUser - cur;

    dailyAccrued[user][dayKey] = cur + grant;

    _pushRep(user, grant, ref);

    emit RepAward(user, grant, usdVolume1e18, usdSaved1e18, ref, dayKey);
  }

  // FIXED: use & branch on low-level call results to satisfy the linter.
  function _pushRep(address user, uint256 amount, bytes32 ref) internal {
    if (rep == address(0) || amount == 0) return;

    // Try v2: addPoints(address,uint256,bytes32)
    (bool okV2, bytes memory retV2) =
      rep.call(abi.encodeWithSignature("addPoints(address,uint256,bytes32)", user, amount, ref));
    if (okV2) {
      // (optional) you could decode/inspect retV2 here if the function returns anything
      retV2; // silence struct-not-used in some linters
      return;
    }

    // Fallback to v1: addPoints(address,uint256)
    (bool okV1, bytes memory retV1) =
      rep.call(abi.encodeWithSignature("addPoints(address,uint256)", user, amount));
    // Intentionally do not revert; just signal if both attempts failed
    if (!okV1) {
      emit RepPushFailed(user, amount, ref);
    }
    retV1; // silence potential “unused” warning
  }
}
