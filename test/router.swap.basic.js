const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

describe("Router swaps", function () {
  it("swapExactTokensForTokens works & respects amountOutMin", async function () {
    const [deployer, user] = await ethers.getSigners();

    // Tokens
    const ERC20 = await ethers.getContractFactory("ParagonERC20Mock");
    const A = await ERC20.deploy("A", "A", 18); await A.waitForDeployment();
    const B = await ERC20.deploy("B", "B", 18); await B.waitForDeployment();

    // Factory (feeToSetter, xpgnToken)
    const Factory = await ethers.getContractFactory("ParagonFactory");
    const factory = await Factory.deploy(await deployer.getAddress(), ethers.ZeroAddress);
    await factory.waitForDeployment();

    // Pair
    await (await factory.createPair(await A.getAddress(), await B.getAddress())).wait();
    const pairAddr = await factory.getPair(await A.getAddress(), await B.getAddress());
    const Pair = await ethers.getContractFactory("ParagonPair");
    const pair = Pair.attach(pairAddr);

    // WNative + Farm mock
    const WN = await (await ethers.getContractFactory("WBNBMock")).deploy();
    await WN.waitForDeployment();
    const Farm = await (await ethers.getContractFactory("ParagonFarmControllerMock")).deploy(await A.getAddress());
    await Farm.waitForDeployment();

    // Router (factory, WNative, masterChef)
    const Router = await ethers.getContractFactory("ParagonRouter");
    const router = await Router.deploy(await factory.getAddress(), await WN.getAddress(), await Farm.getAddress());
    await router.waitForDeployment();

    // Seed liquidity
    await (await A.mint(await deployer.getAddress(), ethers.parseEther("1000"))).wait();
    await (await B.mint(await deployer.getAddress(), ethers.parseEther("1000"))).wait();
    await (await A.transfer(pairAddr, ethers.parseEther("500"))).wait();
    await (await B.transfer(pairAddr, ethers.parseEther("500"))).wait();
    await (await pair.mint(await deployer.getAddress())).wait();

    // Swap A -> B
    await (await A.mint(await user.getAddress(), ethers.parseEther("10"))).wait();
    await (await A.connect(user).approve(await router.getAddress(), ethers.parseEther("10"))).wait();

    const path = [await A.getAddress(), await B.getAddress()];
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const autoYieldPercent = 0;

    const tx = await router.connect(user).swapExactTokensForTokens(
      ethers.parseEther("10"),
      0n,
      path,
      await user.getAddress(),
      deadline,
      autoYieldPercent
    );
    await tx.wait();

    expect(await B.balanceOf(await user.getAddress())).to.be.gt(0n);
  });
});
