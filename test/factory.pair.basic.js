const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

describe("Factory/Pair basic", function () {
  it("creates pair & mints initial liquidity", async function () {
    const [owner] = await ethers.getSigners();

    // Tokens
    const ERC20 = await ethers.getContractFactory("ParagonERC20Mock");
    const t0 = await ERC20.deploy("T0", "T0", 18); await t0.waitForDeployment();
    const t1 = await ERC20.deploy("T1", "T1", 18); await t1.waitForDeployment();

    // Factory (feeToSetter, xpgnToken)  <-- matches your ParagonFactory.sol
    const Factory = await ethers.getContractFactory("ParagonFactory");
    const factory = await Factory.deploy(await owner.getAddress(), await t0.getAddress());
    await factory.waitForDeployment();

    // Create pair
    await (await factory.createPair(await t0.getAddress(), await t1.getAddress())).wait();
    const pairAddr = await factory.getPair(await t0.getAddress(), await t1.getAddress());
    const Pair = await ethers.getContractFactory("ParagonPair");
    const pair = Pair.attach(pairAddr);

    // Seed liquidity
    await (await t0.mint(await owner.getAddress(), ethers.parseEther("1000"))).wait();
    await (await t1.mint(await owner.getAddress(), ethers.parseEther("1000"))).wait();
    await (await t0.transfer(pairAddr, ethers.parseEther("100"))).wait();
    await (await t1.transfer(pairAddr, ethers.parseEther("100"))).wait();
    await (await pair.mint(await owner.getAddress())).wait();

    // Assertions
    const [r0, r1] = await pair.getReserves();     // <-- use getReserves()
    expect(await pair.totalSupply()).to.be.gt(0n);
    expect(r0).to.be.gt(0n);
    expect(r1).to.be.gt(0n);
  });
});
