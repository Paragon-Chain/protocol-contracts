const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer, user, operator] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("User:", user.address);
  console.log("Operator:", operator.address);

  const MockERC20 = await ethers.getContractFactory("MockERC20");

  // Deploy tokens
  const reward = await MockERC20.deploy("XPGN", "XPGN", 18);
  await reward.waitForDeployment();

  const tokenA = await MockERC20.deploy("TokenA", "TKA", 18);
  await tokenA.waitForDeployment();

  const tokenB = await MockERC20.deploy("TokenB", "TKB", 18);
  await tokenB.waitForDeployment();

  const lp = await MockERC20.deploy("LPToken", "LP", 18);
  await lp.waitForDeployment();

  // Seed user balances BEFORE ownership transfers
  await (await reward.mint(user.address, ethers.parseUnits("100000", 18))).wait();
  await (await lp.mint(user.address, ethers.parseUnits("1000", 18))).wait(); // so deposit() can work in tests

  // ✅ Deploy MockFarmControllerV2 (matches AgentExecutorSimple interface)
  const MockFarm = await ethers.getContractFactory("MockFarmControllerV2");
  const farm = await MockFarm.deploy(await reward.getAddress(), await lp.getAddress());
  await farm.waitForDeployment();

  // Deploy MockRouter (mints tokenOut and LP)
  const MockRouter = await ethers.getContractFactory("MockRouter");
  const router = await MockRouter.deploy(await lp.getAddress());
  await router.waitForDeployment();

  // Transfer ownership so mocks can mint
  // Router must be able to mint tokenA/tokenB/LP
  await (await tokenA.transferOwnership(await router.getAddress())).wait();
  await (await tokenB.transferOwnership(await router.getAddress())).wait();
  await (await lp.transferOwnership(await router.getAddress())).wait();

  // Farm must be able to mint rewardToken
  await (await reward.transferOwnership(await farm.getAddress())).wait();

  // Deploy Agent stack
  const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
  const registry = await AgentRegistry.deploy();
  await registry.waitForDeployment();

  const AgentMarket = await ethers.getContractFactory("AgentMarket");
  const market = await AgentMarket.deploy(
    await reward.getAddress(),       // XPGN token
    deployer.address,               // treasury / fee receiver
    500,                            // 5% fee
    "ipfs://paragon-agent/"
  );
  await market.waitForDeployment();

  const AgentExecutor = await ethers.getContractFactory("AgentExecutorSimple");
  const executor = await AgentExecutor.deploy(
    await registry.getAddress(),
    await market.getAddress(),
    await router.getAddress(),
    await farm.getAddress(),
    await reward.getAddress()
  );
  await executor.waitForDeployment();

  const ADDR = {
    reward: await reward.getAddress(),
    tokenA: await tokenA.getAddress(),
    tokenB: await tokenB.getAddress(),
    lp: await lp.getAddress(),
    farm: await farm.getAddress(),
    router: await router.getAddress(),
    registry: await registry.getAddress(),
    market: await market.getAddress(),
    executor: await executor.getAddress(),
    pid: 0,
    user: user.address,
    operator: operator.address,
    deployer: deployer.address,
  };

  const outDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const outFile = path.join(outDir, "localhost-agent-stack.json");
  fs.writeFileSync(outFile, JSON.stringify(ADDR, null, 2));
  console.log(`\n✅ Saved: ${outFile}`);

  console.log("\n=== DEPLOYED ===");
  console.log(ADDR);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
