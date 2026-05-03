const { expect } = require("chai");
const { ethers } = require("hardhat");

const BN = (value) => ethers.parseEther(value);

describe("ParagonAgentExecutor", () => {
  async function deployFixture() {
    const [owner, user, relayer, creator, treasury, stranger] = await ethers.getSigners();

    const ERC20 = await ethers.getContractFactory("contracts/mocks/MockERC20.sol:MockERC20");
    const Router = await ethers.getContractFactory("contracts/mocks/MockParagonRouter.sol:MockParagonRouter");
    const Oracle = await ethers.getContractFactory("contracts/mocks/MockAgentOracle.sol:MockAgentOracle");
    const Market = await ethers.getContractFactory("AgentMarket");
    const Registry = await ethers.getContractFactory("ParagonAgentRegistry");
    const Executor = await ethers.getContractFactory("ParagonAgentExecutor");

    const xpgn = await ERC20.deploy("Paragon", "XPGN", 18);
    const tokenIn = await ERC20.deploy("USD Coin", "USDC", 18);
    const tokenOut = await ERC20.deploy("Wrapped BNB", "WBNB", 18);
    const router = await Router.deploy();
    const oracle = await Oracle.deploy();
    const market = await Market.deploy(await xpgn.getAddress(), treasury.address, 500, "ipfs://paragon-agents/");
    const registry = await Registry.deploy(owner.address);
    const executor = await Executor.deploy(owner.address, await registry.getAddress());

    await xpgn.mint(user.address, BN("1000"));
    await tokenIn.mint(user.address, BN("1000"));
    await tokenOut.mint(await router.getAddress(), BN("1000"));

    await oracle.setPrice(await tokenIn.getAddress(), BN("1"));
    await oracle.setPrice(await tokenOut.getAddress(), BN("1"));

    await market.connect(creator).createTemplate(
      ethers.encodeBytes32String("paragon-swap"),
      BN("10"),
      500,
      1
    );
    await xpgn.connect(user).approve(await market.getAddress(), ethers.MaxUint256);
    await market.connect(user).buyTemplate(1, 1);

    await registry.createTemplate();
    await registry.setAllowedRouter(1, await router.getAddress(), true);
    await registry.setAllowedToken(1, await tokenIn.getAddress(), true);
    await registry.setAllowedToken(1, await tokenOut.getAddress(), true);
    await registry.setLimits(1, BN("500"), 5);
    await registry.setOracleConfig(
      1,
      true,
      await oracle.getAddress(),
      await tokenIn.getAddress(),
      await tokenOut.getAddress(),
      500,
      3600
    );
    await registry.connect(user).setUserEnabled(1, true);
    await tokenIn.connect(user).approve(await executor.getAddress(), ethers.MaxUint256);

    return {
      user,
      relayer,
      creator,
      treasury,
      stranger,
      xpgn,
      tokenIn,
      tokenOut,
      router,
      market,
      registry,
      executor,
    };
  }

  async function signSwapIntent(signer, executor, chainId, intent) {
    const domain = {
      name: "ParagonAgentExecutor",
      version: "1",
      chainId,
      verifyingContract: await executor.getAddress(),
    };

    const types = {
      SignedIntent: [
        { name: "user", type: "address" },
        { name: "templateId", type: "uint256" },
        { name: "actionType", type: "uint8" },
        { name: "agentDeadline", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "maxUsd1e18", type: "uint256" },
        { name: "paramsHash", type: "bytes32" },
      ],
    };

    return signer.signTypedData(domain, types, intent);
  }

  function hashSwapParams(params) {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address[]", "uint256", "uint256", "uint256"],
        [params.router, params.path, params.amountIn, params.minOutUser, params.deadline]
      )
    );
  }

  function emptyPermit() {
    return {
      usePermit: false,
      value: 0,
      deadline: 0,
      v: 0,
      r: ethers.ZeroHash,
      s: ethers.ZeroHash,
    };
  }

  it("sells templates and executes signed swaps through the current registry and executor flow", async () => {
    const fixture = await deployFixture();
    const { user, relayer, creator, treasury, xpgn, tokenIn, tokenOut, market, executor, registry, router } = fixture;
    const network = await ethers.provider.getNetwork();

    expect(await market.isLicensed(user.address, 1)).to.equal(true);
    expect(await xpgn.balanceOf(creator.address)).to.equal(BN("9.5"));
    expect(await xpgn.balanceOf(treasury.address)).to.equal(BN("0.5"));

    const latest = await ethers.provider.getBlock("latest");
    const day = BigInt(Math.floor(latest.timestamp / 86400));
    const deadline = BigInt(latest.timestamp + 3600);
    const params = {
      router: await router.getAddress(),
      path: [await tokenIn.getAddress(), await tokenOut.getAddress()],
      amountIn: BN("25"),
      minOutUser: BN("24"),
      deadline,
    };
    const intent = {
      user: user.address,
      templateId: 1n,
      actionType: 0,
      agentDeadline: deadline,
      nonce: 0n,
      maxUsd1e18: BN("30"),
      paramsHash: hashSwapParams(params),
    };
    const signature = await signSwapIntent(user, executor, network.chainId, intent);

    await expect(
      executor.connect(relayer).executeSwapExactIn(intent, params, emptyPermit(), signature)
    ).to.emit(executor, "IntentExecuted");

    expect(await tokenOut.balanceOf(user.address)).to.equal(BN("25"));
    expect(await executor.nonces(user.address, 1)).to.equal(1n);
    expect(await executor.spentUsd1e18(user.address, 1, day)).to.equal(BN("25"));
    expect(await executor.actionsUsed(user.address, 1, day)).to.equal(1n);
    expect(await registry.userEnabled(user.address, 1)).to.equal(true);
  });

  it("rejects invalid signatures and respects the user emergency disable switch", async () => {
    const fixture = await deployFixture();
    const { user, relayer, stranger, tokenIn, tokenOut, router, executor } = fixture;
    const network = await ethers.provider.getNetwork();

    const latest = await ethers.provider.getBlock("latest");
    const deadline = BigInt(latest.timestamp + 3600);
    const params = {
      router: await router.getAddress(),
      path: [await tokenIn.getAddress(), await tokenOut.getAddress()],
      amountIn: BN("10"),
      minOutUser: BN("9"),
      deadline,
    };
    const intent = {
      user: user.address,
      templateId: 1n,
      actionType: 0,
      agentDeadline: deadline,
      nonce: 0n,
      maxUsd1e18: BN("20"),
      paramsHash: hashSwapParams(params),
    };

    const badSignature = await signSwapIntent(stranger, executor, network.chainId, intent);
    await expect(
      executor.connect(relayer).executeSwapExactIn(intent, params, emptyPermit(), badSignature)
    ).to.be.revertedWith("BAD_SIG");

    await executor.connect(user).setEmergencyDisable(1, true);

    const goodSignature = await signSwapIntent(user, executor, network.chainId, intent);
    await expect(
      executor.connect(relayer).executeSwapExactIn(intent, params, emptyPermit(), goodSignature)
    ).to.be.revertedWith("EMERGENCY_DISABLED");
  });
});
