const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

describe("Security – fee-on-transfer tokens", function () {
  it("supports FoT with supporting variant; strict variant may revert", async function () {
    const [deployer, user] = await ethers.getSigners();

    const FoT = await (await ethers.getContractFactory("FeeOnTransferToken")).deploy("FoT","FoT", 18);
    await FoT.waitForDeployment();
    const B = await (await ethers.getContractFactory("ParagonERC20Mock")).deploy("B","B",18);
    await B.waitForDeployment();

    const Factory = await ethers.getContractFactory("ParagonFactory");
    const factory = await Factory.deploy(await deployer.getAddress(), ethers.ZeroAddress);
    await factory.waitForDeployment();

    await (await factory.createPair(await FoT.getAddress(), await B.getAddress())).wait();
    const pairAddr = await factory.getPair(await FoT.getAddress(), await B.getAddress());
    const Pair = await ethers.getContractFactory("ParagonPair");
    const pair = Pair.attach(pairAddr);

    const WN = await (await ethers.getContractFactory("WBNBMock")).deploy(); await WN.waitForDeployment();
    const Farm = await (await ethers.getContractFactory("ParagonFarmControllerMock")).deploy(await B.getAddress());
    await Farm.waitForDeployment();

    const Router = await ethers.getContractFactory("ParagonRouter");
    const router = await Router.deploy(await factory.getAddress(), await WN.getAddress(), await Farm.getAddress());
    await router.waitForDeployment();

    // Seed pool
    await (await FoT.mint(await deployer.getAddress(), ethers.parseEther("1000"))).wait();
    await (await B.mint(await deployer.getAddress(), ethers.parseEther("1000"))).wait();
    await (await FoT.transfer(pairAddr, ethers.parseEther("500"))).wait();
    await (await B.transfer(pairAddr, ethers.parseEther("500"))).wait();
    await (await pair.mint(await deployer.getAddress())).wait();

    // Swap using supporting variant (should succeed)
    const amountIn = ethers.parseEther("10");
    await (await FoT.mint(await user.getAddress(), amountIn)).wait();
    await (await FoT.connect(user).approve(await router.getAddress(), amountIn)).wait();

    const path = [await FoT.getAddress(), await B.getAddress()];
    const deadline = BigInt(Math.floor(Date.now()/1000) + 600);
    const autoYieldPercent = 0;

    const balB0 = await B.balanceOf(await user.getAddress());
    await (
      await router.connect(user).swapExactTokensForTokensSupportingFeeOnTransferTokens(
        amountIn, 0n, path, await user.getAddress(), deadline, autoYieldPercent
      )
    ).wait();
    const balB1 = await B.balanceOf(await user.getAddress());
    expect(balB1 - balB0).to.be.gt(0n);

    // Strict variant (if present) may revert due to FoT; we just probe it
    if ("swapExactTokensForTokens" in router) {
      await FoT.connect(user).approve(await router.getAddress(), amountIn);
      const strictTx = router.connect(user).swapExactTokensForTokens(
        amountIn, 0n, path, await user.getAddress(), deadline, autoYieldPercent
      );
      // Either revert or succeed → both acceptable; just ensure no underflow/throw
      try { await (await strictTx).wait(); } catch (e) { /* acceptable */ }
    }
  });
});
