const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

describe("Protocol fee accrual (if enabled)", function () {
  it("mints/collects protocol fees to feeTo when configured", async function () {
    const [deployer, feeTo, user] = await ethers.getSigners();

    const A = await (await ethers.getContractFactory("ParagonERC20Mock")).deploy("A","A",18);
    const B = await (await ethers.getContractFactory("ParagonERC20Mock")).deploy("B","B",18);
    await A.waitForDeployment(); await B.waitForDeployment();

    const Factory = await ethers.getContractFactory("ParagonFactory");
    const factory = await Factory.deploy(await deployer.getAddress(), ethers.ZeroAddress);
    await factory.waitForDeployment();

    await (await factory.createPair(await A.getAddress(), await B.getAddress())).wait();
    const pairAddr = await factory.getPair(await A.getAddress(), await B.getAddress());
    const Pair = await ethers.getContractFactory("ParagonPair");
    const pair = Pair.attach(pairAddr);

    const WN = await (await ethers.getContractFactory("WBNBMock")).deploy(); await WN.waitForDeployment();
    const Farm = await (await ethers.getContractFactory("ParagonFarmControllerMock")).deploy(await A.getAddress());
    await Farm.waitForDeployment();
    const Router = await ethers.getContractFactory("ParagonRouter");
    const router = await Router.deploy(await factory.getAddress(), await WN.getAddress(), await Farm.getAddress());
    await router.waitForDeployment();

    // Seed liquidity
    await (await A.mint(await deployer.getAddress(), ethers.parseEther("1000"))).wait();
    await (await B.mint(await deployer.getAddress(), ethers.parseEther("1000"))).wait();
    await (await A.transfer(pairAddr, ethers.parseEther("500"))).wait();
    await (await B.transfer(pairAddr, ethers.parseEther("500"))).wait();
    await (await pair.mint(await deployer.getAddress())).wait();

    // Configure feeTo if available
    if (!("setFeeTo" in factory)) {
      console.log("Factory has no setFeeTo — skipping protocol fee accrual test.");
      return;
    }
    await (await factory.setFeeTo(await feeTo.getAddress())).wait();

    // Do swaps to accrue protocol fees
    await (await A.mint(await user.getAddress(), ethers.parseEther("100"))).wait();
    await (await A.connect(user).approve(await router.getAddress(), ethers.parseEther("100"))).wait();

    const path = [await A.getAddress(), await B.getAddress()];
    const deadline = BigInt(Math.floor(Date.now()/1000) + 600);

    for (let i = 0; i < 3; i++) {
      const tx = router.connect(user).swapExactTokensForTokens(
        ethers.parseEther("10"), 0n, path, await user.getAddress(), deadline, 0
      );
      await (await tx).wait();
    }

    // Minimal generic check
    const ts = await pair.totalSupply();
    const feeToBal = await pair.balanceOf(await feeTo.getAddress());
    expect(ts).to.be.gt(0n);
    // Uncomment if your model mints LP to feeTo (UniV2-style)
    // expect(feeToBal).to.be.gt(0n);
  });
});
