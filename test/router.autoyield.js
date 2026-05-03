const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

describe("Router – auto-yield", function () {
  it("sends a portion to the farm when autoYieldPercent > 0 and output == xpgnToken", async function () {
    const [deployer, user] = await ethers.getSigners();

    const ERC20 = await ethers.getContractFactory("ParagonERC20Mock");
    const XPGN = await ethers.getContractFactory("XPGNToken");
    const B = await ERC20.deploy("B","B",18); await B.waitForDeployment();
    const teamVesting = ethers.Wallet.createRandom().address;
    const advisorVesting = ethers.Wallet.createRandom().address;
    const validatorRewards = ethers.Wallet.createRandom().address;
    const A = await XPGN.deploy(
      await deployer.getAddress(),
      validatorRewards,
      teamVesting,
      advisorVesting,
      await deployer.getAddress()
    );
    await A.waitForDeployment();

    // Factory (feeToSetter, xpgnToken = A)
    const Factory = await ethers.getContractFactory("ParagonFactory");
    const factory = await Factory.deploy(await deployer.getAddress(), await A.getAddress());
    await factory.waitForDeployment();

    // Pair + reserves
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

    // Swap B -> A with auto-yield so farm receives a cut in A (xpgnToken)
    const amountIn = ethers.parseEther("10");
    const userAddr = await user.getAddress();
    await (await B.mint(userAddr, amountIn)).wait();
    await (await B.connect(user).approve(await router.getAddress(), amountIn)).wait();

    const path = [await B.getAddress(), await A.getAddress()]; // output == xpgnToken (A)
    const deadline = BigInt(Math.floor(Date.now()/1000) + 600);
    const autoYieldPercent = 10; // uint8, 10%

    const farmA0 = await A.balanceOf(await Farm.getAddress());
    const userA0 = await A.balanceOf(userAddr);

    const tx = router.connect(user).swapExactTokensForTokens(
      amountIn, 0n, path, userAddr, deadline, autoYieldPercent
    );
    await (await tx).wait();

    const farmA1 = await A.balanceOf(await Farm.getAddress());
    const userA1 = await A.balanceOf(userAddr);

    expect(farmA1 - farmA0).to.be.gt(0n);  // farm got A
    expect(userA1 - userA0).to.be.gt(0n);  // user still got A
  });
});
