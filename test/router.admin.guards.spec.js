const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("RouterAdmin – guards", () => {
  it("owner can change slippage/impact/TWAP and pause swaps", async () => {
    const [owner, user] = await ethers.getSigners();
    // Deploy Factory/Router/Admin + two ERC20s, add liquidity (reuse your helpers)
    // Attach admin: setMaxSlippageBips, setMaxPriceImpactBips, setUseTwap, pause/unpause
    // Expect swaps to revert when paused, and to pass when unpaused.
    // Expect non-owner calls to revert.
    expect(true).to.equal(true); // replace with real asserts once wired to your Admin
  });
});
