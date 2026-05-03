const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

describe("Router – slippage protection", function () {
  it("reverts when amountOutMin is set above expected", async function () {
    const [deployer, user] = await ethers.getSigners();

    // Tokens
    const ERC20 = await ethers.getContractFactory("ParagonERC20Mock");
    const A = await ERC20.deploy("A", "A", 18); await A.waitForDeployment();
    const B = await ERC20.deploy("B", "B", 18); await B.waitForDeployment();

    // Factory (feeToSetter, xpgnToken)
    const Factory = await ethers.getContractFactory("ParagonFactory");
    const factory = await Factory.deploy(await deployer.getAddress(), await A.getAddress());
    await factory.waitForDeployment();

    // Pair + liquidity
    await (await factory.createPair(await A.getAddress(), await B.getAddress())).wait();
    const pairAddr = await factory.getPair(await A.getAddress(), await B.getAddress());
    const Pair = await ethers.getContractFactory("ParagonPair");
    const pair = Pair.attach(pairAddr);

    await (await A.mint(await deployer.getAddress(), ethers.parseEther("1000"))).wait();
    await (await B.mint(await deployer.getAddress(), ethers.parseEther("1000"))).wait();
    await (await A.transfer(pairAddr, ethers.parseEther("500"))).wait();
    await (await B.transfer(pairAddr, ethers.parseEther("500"))).wait();
    await (await pair.mint(await deployer.getAddress())).wait();

    // Infra
    const WN = await (await ethers.getContractFactory("WBNBMock")).deploy(); await WN.waitForDeployment();
    const Farm = await (await ethers.getContractFactory("ParagonFarmControllerMock")).deploy(await A.getAddress());
    await Farm.waitForDeployment();

    const Router = await ethers.getContractFactory("ParagonRouter");
    const router = await Router.deploy(await factory.getAddress(), await WN.getAddress(), await Farm.getAddress());
    await router.waitForDeployment();

    // Inputs
    const path = [await A.getAddress(), await B.getAddress()];
    const amountIn = ethers.parseEther("10");
    const userAddr = await user.getAddress();
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const autoYieldPercent = 0;

    // Fund user
    await (await A.mint(userAddr, amountIn)).wait();
    await (await A.connect(user).approve(await router.getAddress(), amountIn)).wait();

    // Force slippage failure: absurdly high minOut
    const minOut = ethers.parseEther("1000000");

    // Build tx promise
    let txPromise;
    if (typeof router.swapExactTokensForTokensSupportingFeeOnTransferTokens === "function") {
      txPromise = router.connect(user).swapExactTokensForTokensSupportingFeeOnTransferTokens(
        amountIn, minOut, path, userAddr, deadline, autoYieldPercent
      );
    } else {
      txPromise = router.connect(user).swapExactTokensForTokens(
        amountIn, minOut, path, userAddr, deadline, autoYieldPercent
      );
    }

    await expect(txPromise).to.be.reverted;
  });
});
