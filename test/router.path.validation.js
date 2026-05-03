const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

describe("Router – path validation", function () {
  it("reverts on duplicate token path or unsupported pair", async function () {
    const [deployer, user] = await ethers.getSigners();

    const ERC20 = await ethers.getContractFactory("ParagonERC20Mock");
    const A = await ERC20.deploy("A","A",18); await A.waitForDeployment();
    const B = await ERC20.deploy("B","B",18); await B.waitForDeployment();
    const C = await ERC20.deploy("C","C",18); await C.waitForDeployment(); // no pair with B

    const Factory = await ethers.getContractFactory("ParagonFactory");
    const factory = await Factory.deploy(await deployer.getAddress(), await A.getAddress());
    await factory.waitForDeployment();

    // Create only A-B pair
    await (await factory.createPair(await A.getAddress(), await B.getAddress())).wait();

    const WN = await (await ethers.getContractFactory("WBNBMock")).deploy(); await WN.waitForDeployment();
    const Farm = await (await ethers.getContractFactory("ParagonFarmControllerMock")).deploy(await A.getAddress());
    await Farm.waitForDeployment();

    const Router = await ethers.getContractFactory("ParagonRouter");
    const router = await Router.deploy(await factory.getAddress(), await WN.getAddress(), await Farm.getAddress());
    await router.waitForDeployment();

    // Fund + approve
    await (await A.mint(await user.getAddress(), ethers.parseEther("1"))).wait();
    await (await A.connect(user).approve(await router.getAddress(), ethers.parseEther("1"))).wait();
    const deadline = BigInt(Math.floor(Date.now()/1000) + 600);
    const autoYieldPercent = 0;

    // Duplicate token path
    await expect(
      router.connect(user).swapExactTokensForTokensSupportingFeeOnTransferTokens(
        ethers.parseEther("1"), 0n, [await A.getAddress(), await A.getAddress()],
        await user.getAddress(), deadline, autoYieldPercent
      )
    ).to.be.reverted;

    // Unsupported middle hop (A -> C but no pair A-C)
    await expect(
      router.connect(user).swapExactTokensForTokensSupportingFeeOnTransferTokens(
        ethers.parseEther("1"), 0n, [await A.getAddress(), await C.getAddress()],
        await user.getAddress(), deadline, autoYieldPercent
      )
    ).to.be.reverted;
  });
});
