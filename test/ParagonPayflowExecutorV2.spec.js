const { expect } = require("chai");
const { ethers } = require("hardhat");

// ---------- helpers (ethers v6 + bigint) ----------
const BN = (n) => ethers.parseUnits(String(n), 18);     // -> bigint
const NOW = () => Math.floor(Date.now() / 1000);        // number
const ZERO = 0n;

const EMPTY_PERMIT = {
  value: ZERO,
  deadline: ZERO,
  v: 0,
  r: ethers.ZeroHash,
  s: ethers.ZeroHash,
};

describe("ParagonPayflowExecutorV2 — adversarial (.js)", function () {
  let owner, user, relayer, other;
  let exec;

  let tokenIn;
  let tokenOut;
  let foTIn;
  let foTOut;
  let rTokenOut;

  let router;
  let routerM;
  let rebatesR;

  let bestExec;
  let valuer;
  let repOp;

  let daoVault;
  let locker;

  beforeEach(async function () {
    [owner, user, relayer, other] = await ethers.getSigners();

    // *** FULLY QUALIFIED NAMES ***
    const MockERC20          = await ethers.getContractFactory("contracts/mocks/MockERC20.sol:MockERC20");
    const FeeOnTransferToken = await ethers.getContractFactory("contracts/mocks/FeeOnTransferToken.sol:FeeOnTransferToken");
    const ReentrantToken     = await ethers.getContractFactory("contracts/mocks/ReentrantToken.sol:ReentrantToken");
    const RouterMock         = await ethers.getContractFactory("contracts/mocks/RouterMock.sol:RouterMock");
    const RouterMalicious    = await ethers.getContractFactory("contracts/mocks/RouterMalicious.sol:RouterMalicious");
    const LPRebatesReentrant = await ethers.getContractFactory("contracts/mocks/LPRebatesReentrant.sol:LPRebatesReentrant");
    const BestExecMock       = await ethers.getContractFactory("contracts/mocks/BestExecMock.sol:BestExecMock");
    const ValuerMock         = await ethers.getContractFactory("contracts/mocks/ValuerMock.sol:ValuerMock");
    const RepOpMock          = await ethers.getContractFactory("contracts/mocks/RepOpMock.sol:RepOpMock");

    tokenIn   = await MockERC20.deploy("IN","IN",18);        await tokenIn.waitForDeployment();
    tokenOut  = await MockERC20.deploy("OUT","OUT",18);      await tokenOut.waitForDeployment();
    foTIn     = await FeeOnTransferToken.deploy("FIN","FIN",18);   await foTIn.waitForDeployment();
    foTOut    = await FeeOnTransferToken.deploy("FOUT","FOUT",18); await foTOut.waitForDeployment();
    rTokenOut = await ReentrantToken.deploy("R","R",18);     await rTokenOut.waitForDeployment();

    router    = await RouterMock.deploy();                   await router.waitForDeployment();
    routerM   = await RouterMalicious.deploy();              await routerM.waitForDeployment();
    rebatesR  = await LPRebatesReentrant.deploy();           await rebatesR.waitForDeployment();

    bestExec  = await BestExecMock.deploy();                 await bestExec.waitForDeployment();
    valuer    = await ValuerMock.deploy();                   await valuer.waitForDeployment();
    repOp     = await RepOpMock.deploy();                    await repOp.waitForDeployment();

    const tokenOutAddr  = await tokenOut.getAddress();
    const foTOutAddr    = await foTOut.getAddress();
    const rTokenOutAddr = await rTokenOut.getAddress();
    const routerAddr    = await router.getAddress();

    // Seed router with a huge balance of potential output tokens
    const huge = BN("1000000000000"); // 1e12
    await tokenOut.mint(routerAddr, huge);
    await foTOut.mint(routerAddr, huge);
    await rTokenOut.mint(routerAddr, huge);

    // Deploy executor
    daoVault = ethers.Wallet.createRandom().address;
    locker   = ethers.Wallet.createRandom().address;

    const Exec = await ethers.getContractFactory("contracts/payflow/ParagonPayflowExecutorv2.sol:ParagonPayflowExecutorV2");
    exec = await Exec.deploy(
      owner.address,
      routerAddr,
      await bestExec.getAddress(),
      daoVault,
      ethers.ZeroAddress,
      locker
    );
    await exec.waitForDeployment();

    await exec.setReputationOperator(await repOp.getAddress());
    await exec.setUsdValuer(await valuer.getAddress());
    await exec.setRelayerFeeBips(10); // 10 bps (0.10%)
    await exec.setRelayer(relayer.address, true);
    await exec.setSupportedToken(await tokenIn.getAddress(), true);
    await exec.setSupportedToken(await tokenOut.getAddress(), true);
    await exec.setSupportedToken(await foTIn.getAddress(), true);
    await exec.setSupportedToken(await foTOut.getAddress(), true);
    await exec.setSupportedToken(await rTokenOut.getAddress(), true);
  });

  async function addr(of) { return await of.getAddress(); }

  function buildIntent(u, tin, tout, amtIn, minOut, recipient, nonce) {
    return {
      user: u,
      tokenIn: tin,
      tokenOut: tout,
      amountIn: amtIn,
      minAmountOut: minOut,
      deadline: BigInt(NOW() + 3600),
      recipient,
      nonce,
    };
  }

  it("basic flow + relayer nibble + DAO fallback for LP share", async function () {
    const amtIn  = BN(1000);
    const minOut = BN(900);
    const actual = BN(940);

    await tokenIn.mint(user.address, amtIn);
    await tokenIn.connect(user).approve(await exec.getAddress(), amtIn);

    await router.setQuote(await addr(tokenIn), await addr(tokenOut), actual);

    const nonce = await bestExec.nonceOf(user.address);
    const it = buildIntent(user.address, await addr(tokenIn), await addr(tokenOut), amtIn, minOut, user.address, nonce);

    await exec.connect(relayer).execute(it, "0x1234", EMPTY_PERMIT, { gasLimit: 12_000_000 });

    const surplus = actual - minOut;              // 40
    const dist = surplus;                         // protocol = 0
    const traderShare = (dist * 6000n) / 10_000n; // 24
    const lpShare     = (dist * 3000n) / 10_000n; // 12
    const lockerShare = dist - traderShare - lpShare; // 4
    const relayerFeeBps = await exec.relayerFeeBips();
    const relayerFee  = (surplus * BigInt(relayerFeeBps)) / 10_000n;

    expect(await tokenOut.balanceOf(relayer.address)).to.eq(relayerFee);
    expect(await tokenOut.balanceOf(user.address)).to.eq(minOut + traderShare);
    expect(await tokenOut.balanceOf(locker)).to.eq(lockerShare);

    const daoBal = await tokenOut.balanceOf(daoVault);
    expect(daoBal).to.eq(lpShare - relayerFee);

    expect(await tokenIn.allowance(await exec.getAddress(), await router.getAddress())).to.eq(0n);
  });

  it("reverts when hopShareBips length mismatches", async function () {
    await exec.setParams(
      await router.getAddress(),
      await bestExec.getAddress(),
      daoVault,
      await rebatesR.getAddress(),
      locker,
      0
    );

    await tokenIn.mint(user.address, BN(1));
    await tokenIn.connect(user).approve(await exec.getAddress(), BN(1));
    await router.setQuote(await addr(tokenIn), await addr(tokenOut), BN(2));

    const X = await (await ethers.getContractFactory("contracts/mocks/MockERC20.sol:MockERC20")).deploy("X","X",18);
    await X.waitForDeployment();
    await exec.setSupportedToken(await X.getAddress(), true);

    const path = [await addr(tokenIn), await addr(X), await addr(tokenOut)];
    const wrongLen = [10_000];

    const nonce = await bestExec.nonceOf(user.address);
    const it = buildIntent(user.address, await addr(tokenIn), await addr(tokenOut), BN(1), BN(1), user.address, nonce);

    await expect(exec.connect(relayer).executeWithPath(it, "0x1234", path, wrongLen, EMPTY_PERMIT))
      .to.be.revertedWithCustomError(exec, "InvalidHopShares");
  });

  it("reverts when hopShareBips sum != 10000", async function () {
    await exec.setParams(
      await router.getAddress(),
      await bestExec.getAddress(),
      daoVault,
      await rebatesR.getAddress(),
      locker,
      0
    );

    await tokenIn.mint(user.address, BN(1));
    await tokenIn.connect(user).approve(await exec.getAddress(), BN(1));
    await router.setQuote(await addr(tokenIn), await addr(tokenOut), BN(2));

    const Y = await (await ethers.getContractFactory("contracts/mocks/MockERC20.sol:MockERC20")).deploy("Y","Y",18);
    await Y.waitForDeployment();
    await exec.setSupportedToken(await Y.getAddress(), true);

    const path = [await addr(tokenIn), await addr(Y), await addr(tokenOut)];
    const badSum = [9998, 1];

    const nonce = await bestExec.nonceOf(user.address);
    const it = buildIntent(user.address, await addr(tokenIn), await addr(tokenOut), BN(1), BN(1), user.address, nonce);

    await expect(exec.connect(relayer).executeWithPath(it, "0x1234", path, badSum, EMPTY_PERMIT))
      .to.be.revertedWithCustomError(exec, "BadSplit");
  });

  it("reverts when path too long", async function () {
    await tokenIn.mint(user.address, BN(1));
    await tokenIn.connect(user).approve(await exec.getAddress(), BN(1));

    const path = Array(6).fill(await addr(tokenOut)); path[0] = await addr(tokenIn);
    const nonce = await bestExec.nonceOf(user.address);
    const it = buildIntent(user.address, await addr(tokenIn), await addr(tokenOut), BN(1), BN(1), user.address, nonce);

    await expect(exec.connect(relayer).executeWithPath(it, "0x1234", path, [], EMPTY_PERMIT))
      .to.be.revertedWithCustomError(exec, "PathTooLong");
  });

  it("reverts when tokenIn == tokenOut", async function () {
    await tokenIn.mint(user.address, BN(1));
    await tokenIn.connect(user).approve(await exec.getAddress(), BN(1));

    const nonce = await bestExec.nonceOf(user.address);
    const it = buildIntent(user.address, await addr(tokenIn), await addr(tokenIn), BN(1), BN(1), user.address, nonce);

    await expect(exec.connect(relayer).execute(it, "0x1234", EMPTY_PERMIT))
      .to.be.revertedWithCustomError(exec, "InvalidSwap");
  });

  it("handles fee-on-transfer input and output", async function () {
    await exec.setParams(
      await router.getAddress(),
      await bestExec.getAddress(),
      daoVault,
      ethers.ZeroAddress,
      locker,
      0
    );

    await foTIn.setFee(1000);
    await foTOut.setFee(500);

    const amtIn  = BN(100);
    const minOut = BN(50);
    const actual = BN(60);

    await foTIn.mint(user.address, amtIn);
    await foTIn.connect(user).approve(await exec.getAddress(), amtIn);
    await router.setQuote(await addr(foTIn), await addr(foTOut), actual);

    const nonce = await bestExec.nonceOf(user.address);
    const it = buildIntent(user.address, await addr(foTIn), await addr(foTOut), amtIn, minOut, user.address, nonce);

    await expect(exec.connect(relayer).execute(it, "0x1234", EMPTY_PERMIT)).to.not.be.reverted;
    expect(await foTOut.balanceOf(user.address)).to.gt(0n);
  });

  it("rebates.notify reentrancy attempt is contained", async function () {
    await exec.setParams(
      await router.getAddress(),
      await bestExec.getAddress(),
      daoVault,
      await rebatesR.getAddress(),
      locker,
      0
    );
    await rebatesR.setTarget(await exec.getAddress());

    await tokenIn.mint(user.address, BN(1000));
    await tokenIn.connect(user).approve(await exec.getAddress(), BN(1000));
    await router.setQuote(await addr(tokenIn), await addr(tokenOut), BN(900));

    const nonce = await bestExec.nonceOf(user.address);
    const it = buildIntent(user.address, await addr(tokenIn), await addr(tokenOut), BN(1000), BN(800), user.address, nonce);

    await expect(exec.connect(relayer).execute(it, "0x1234", EMPTY_PERMIT)).to.not.be.reverted;

    const surplus = BN(100);
    const relayerFee = (surplus * BigInt(await exec.relayerFeeBips())) / 10_000n;
    const lpShare = (surplus * 3000n) / 10_000n;
    expect(await tokenOut.balanceOf(await exec.getAddress())).to.eq(lpShare - relayerFee);
  });

  it("reentrancy from tokenOut transfer does not break state", async function () {
    await exec.setParams(
      await router.getAddress(),
      await bestExec.getAddress(),
      daoVault,
      ethers.ZeroAddress,
      locker,
      0
    );

    const sweepCalldata = exec.interface.encodeFunctionData("sweep", [ await rTokenOut.getAddress(), relayer.address ]);
    await rTokenOut.setReenterTarget(await exec.getAddress(), sweepCalldata);

    await tokenIn.mint(user.address, BN(1000));
    await tokenIn.connect(user).approve(await exec.getAddress(), BN(1000));
    await router.setQuote(await addr(tokenIn), await addr(rTokenOut), BN(900));

    const nonce = await bestExec.nonceOf(user.address);
    const it = buildIntent(user.address, await addr(tokenIn), await addr(rTokenOut), BN(1000), BN(800), user.address, nonce);

    await expect(exec.connect(relayer).execute(it, "0x1234", EMPTY_PERMIT)).to.not.be.reverted;
    expect(await rTokenOut.balanceOf(await exec.getAddress())).to.eq(0n);
  });

  it("malicious router can’t drain and causes RouterSwapFailed", async function () {
    await exec.setParams(
      await routerM.getAddress(),
      await bestExec.getAddress(),
      daoVault,
      ethers.ZeroAddress,
      locker,
      0
    );

    await tokenIn.mint(user.address, BN(1000));
    await tokenIn.connect(user).approve(await exec.getAddress(), BN(1000));

    const nonce = await bestExec.nonceOf(user.address);
    const it = buildIntent(user.address, await addr(tokenIn), await addr(tokenOut), BN(1000), BN(1), user.address, nonce);

    await expect(exec.connect(relayer).execute(it, "0x1234", EMPTY_PERMIT))
      .to.be.revertedWithCustomError(exec, "RouterSwapFailed");

    expect(await tokenOut.balanceOf(await exec.getAddress())).to.eq(0n);
    expect(await tokenIn.balanceOf(await exec.getAddress())).to.eq(0n);
  });

  it("permit failure => PermitFailed", async function () {
    await tokenIn.mint(user.address, BN(1));

    const nonce = await bestExec.nonceOf(user.address);
    const it = buildIntent(user.address, await addr(tokenIn), await addr(tokenOut), BN(1), BN(1), user.address, nonce);

    const badPermit = {
      value: BN(1),
      deadline: BigInt(NOW() + 60),
      v: 27,
      r: ethers.ZeroHash,
      s: ethers.ZeroHash,
    };

    await expect(exec.connect(relayer).execute(it, "0x1234", badPermit))
      .to.be.revertedWithCustomError(exec, "PermitFailed");
  });

  it("exact distribution: sum of recipient deltas == router output", async function () {
    const out   = BN(960);
    const amtIn = BN(1000);
    const minOut = BN(900);

    await tokenIn.mint(user.address, amtIn);
    await tokenIn.connect(user).approve(await exec.getAddress(), amtIn);
    await router.setQuote(await addr(tokenIn), await addr(tokenOut), out);
    await exec.setParams(
      await router.getAddress(),
      await bestExec.getAddress(),
      daoVault,
      ethers.ZeroAddress,
      locker,
      50 // 0.5% protocol cut
    );

    const nonce = await bestExec.nonceOf(user.address);
    const it = buildIntent(user.address, await addr(tokenIn), await addr(tokenOut), amtIn, minOut, user.address, nonce);

    const pre =
      (await tokenOut.balanceOf(daoVault)) +
      (await tokenOut.balanceOf(locker)) +
      (await tokenOut.balanceOf(user.address)) +
      (await tokenOut.balanceOf(relayer.address));

    await exec.connect(relayer).execute(it, "0x1234", EMPTY_PERMIT);

    const post =
      (await tokenOut.balanceOf(daoVault)) +
      (await tokenOut.balanceOf(locker)) +
      (await tokenOut.balanceOf(user.address)) +
      (await tokenOut.balanceOf(relayer.address));

    expect(post - pre).to.eq(out);
    expect(await tokenOut.balanceOf(await exec.getAddress())).to.eq(0n);
    expect(await tokenIn.allowance(await exec.getAddress(), await router.getAddress())).to.eq(0n);
  });

  it("setSplitBips cannot exceed 10000", async function () {
    await expect(exec.setSplitBips(7000, 4001)).to.be.revertedWithCustomError(exec, "BadSplit");
  });

  it("expired swap deadline => RouterSwapFailed", async function () {
    await tokenIn.mint(user.address, BN(100));
    await tokenIn.connect(user).approve(await exec.getAddress(), BN(100));

    const nonce = await bestExec.nonceOf(user.address);
    const it = {
      user: user.address,
      tokenIn: await tokenIn.getAddress(),
      tokenOut: await tokenOut.getAddress(),
      amountIn: BN(100),
      minAmountOut: BN(1),
      deadline: BigInt(NOW() - 1),
      recipient: user.address,
      nonce,
    };

    await expect(exec.connect(relayer).execute(it, "0x1234", EMPTY_PERMIT))
      .to.be.revertedWithCustomError(exec, "InvalidSwap");
  });

  it("never pays trader below minOut (sampled)", async function () {
    for (let i = 0; i < 8; i++) {
      const amtIn  = BN(1000 + i * 100);
      const minOut = BN(800 + i * 10);
      const out    = minOut + BN(50);

      await tokenIn.mint(user.address, amtIn);
      await tokenIn.connect(user).approve(await exec.getAddress(), amtIn);
      await router.setQuote(await tokenIn.getAddress(), await tokenOut.getAddress(), out);

      const nonce = await bestExec.nonceOf(user.address);
      const it = buildIntent(user.address, await tokenIn.getAddress(), await tokenOut.getAddress(), amtIn, minOut, user.address, nonce);

      const pre = await tokenOut.balanceOf(user.address);
      await exec.connect(relayer).execute(it, "0x1234", EMPTY_PERMIT);
      const got = (await tokenOut.balanceOf(user.address)) - pre;

      expect(got >= minOut).to.equal(true);
    }
  });
});
