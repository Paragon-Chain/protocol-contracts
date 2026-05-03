const dotenv = require("dotenv");
dotenv.config();
const fs = require("fs");
const path = require("path");

const deployEnvFile = process.env.DEPLOY_ENV_FILE || ".env.mainnet";
const deployEnvPath = path.join(__dirname, "..", deployEnvFile);
if (fs.existsSync(deployEnvPath)) {
  dotenv.config({ path: deployEnvPath, override: true });
}

const hre = require("hardhat");
const { ethers } = hre;

function req(name) {
  const v = process.env[name];
  if (!v || v.trim() === "") throw new Error(`Missing env var: ${name}`);
  return v.trim();
}

function opt(name, fallback = "") {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

function reqAddr(name) {
  const v = req(name);
  try {
    const addr = ethers.getAddress(v);
    if (addr === ethers.ZeroAddress) throw new Error("zero address");
    return addr;
  } catch {
    throw new Error(`Env ${name} must be a valid non-zero address: ${v}`);
  }
}

function reqNum(name) {
  const v = req(name);
  if (!/^\d+$/.test(v)) throw new Error(`Env ${name} must be an integer string`);
  return BigInt(v);
}

function reqNumJs(name) {
  const v = req(name);
  if (!/^\d+$/.test(v)) throw new Error(`Env ${name} must be an integer string`);
  return Number(v);
}

function optNumJs(name, fallback) {
  const v = opt(name, String(fallback));
  if (!/^\d+$/.test(v)) throw new Error(`Env ${name} must be an integer string`);
  return Number(v);
}

function optAddrList(name) {
  const raw = opt(name, "");
  if (!raw) return [];

  const out = [];
  const seen = new Set();
  for (const part of raw.split(",")) {
    const value = part.trim();
    if (!value) continue;
    const addr = ethers.getAddress(value);
    if (addr === ethers.ZeroAddress) throw new Error(`Env ${name} must not include zero address`);
    const key = addr.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(addr);
    }
  }
  return out;
}

function uniqueAddresses(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const addr = ethers.getAddress(value);
    const key = addr.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(addr);
    }
  }
  return out;
}

function validateVestingWindow(label, start, cliff, end) {
  if (!(start <= cliff && cliff < end)) {
    throw new Error(`${label} vesting timestamps must satisfy start <= cliff < end`);
  }
}

async function saveJSON(file, obj) {
  const normalized = JSON.parse(
    JSON.stringify(obj, (_, value) => (typeof value === "bigint" ? value.toString() : value))
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(normalized, null, 2));
  console.log(`Saved -> ${file}`);
}

async function buildVerificationEntry(factoryRef, address, constructorArgs) {
  const artifact = await hre.artifacts.readArtifact(factoryRef);
  const fullyQualifiedName = `${artifact.sourceName}:${artifact.contractName}`;
  const buildInfo = await hre.artifacts.getBuildInfo(fullyQualifiedName);
  const compiledContract =
    buildInfo?.output?.contracts?.[artifact.sourceName]?.[artifact.contractName];

  return {
    address,
    contractName: artifact.contractName,
    sourceName: artifact.sourceName,
    fullyQualifiedName,
    constructorArgs,
    compiler: {
      solcVersion: buildInfo?.solcVersion || null,
      optimizer: buildInfo?.input?.settings?.optimizer || null,
      viaIR:
        typeof buildInfo?.input?.settings?.viaIR === "boolean"
          ? buildInfo.input.settings.viaIR
          : null,
      evmVersion: buildInfo?.input?.settings?.evmVersion || null,
    },
    metadata: compiledContract?.metadata || null,
  };
}

async function createPairIfMissing(factory, tokenA, tokenB, label) {
  let pair = await factory.getPair(tokenA, tokenB);
  if (pair !== ethers.ZeroAddress) {
    console.log(`↪ Reusing pair ${label}: ${pair}`);
    return pair;
  }

  pair = await factory.getPair(tokenB, tokenA);
  if (pair !== ethers.ZeroAddress) {
    console.log(`↪ Reusing pair ${label}: ${pair}`);
    return pair;
  }

  await factory.createPair.staticCall(tokenA, tokenB);
  const tx = await factory.createPair(tokenA, tokenB);
  console.log(`→ Creating pair ${label}: ${tx.hash}`);
  await tx.wait();

  pair = await factory.getPair(tokenA, tokenB);
  if (pair === ethers.ZeroAddress) pair = await factory.getPair(tokenB, tokenA);
  if (pair === ethers.ZeroAddress) throw new Error(`Failed to create pair ${label}`);

  console.log(`✅ Pair ${label}: ${pair}`);
  return pair;
}

async function deployLocalMockToken(name, symbol, decimals, recipient) {
  const MockERC20 = await ethers.getContractFactory(
      "contracts/exchange/MockERC20.sol:MockERC20"
  );
  const token = await MockERC20.deploy(name, symbol, decimals);
  await token.waitForDeployment();
  const addr = await token.getAddress();
  await (await token.mint(recipient, ethers.parseUnits("1000000", decimals))).wait();
  console.log(`-> Local mock ${symbol}: ${addr}`);
  return addr;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const verification = {};

  const EXPECT_REAL_MAINNET = opt("EXPECT_REAL_MAINNET", "false") === "true";
  const CONFIRM_MAINNET_DEPLOY = opt("CONFIRM_MAINNET_DEPLOY", "");
  const isLocalFork = hre.network.name === "localhost" || hre.network.name === "hardhat";

  if (!isLocalFork) {
    if (chainId !== 56) throw new Error(`Wrong chain. Expected BNB Chain mainnet (56), got ${chainId}`);
    if (!EXPECT_REAL_MAINNET) throw new Error("Set EXPECT_REAL_MAINNET=true to deploy outside a local fork");
    if (CONFIRM_MAINNET_DEPLOY !== "DEPLOY_PARAGON_MAINNET_CLEAN") {
      throw new Error("Set CONFIRM_MAINNET_DEPLOY=DEPLOY_PARAGON_MAINNET_CLEAN for the real mainnet deploy");
    }
  }

  const TIMELOCK = reqAddr("TIMELOCK_ADDRESS");
  const ADMIN_SAFE = reqAddr("ADMIN_SAFE_ADDRESS");
  const TREASURY_SAFE = reqAddr("TREASURY_SAFE_ADDRESS");
  const SECURITY_COUNCIL_SAFE = reqAddr("SECURITY_COUNCIL_SAFE_ADDRESS");
  const GENESIS_RESERVE_SAFE = reqAddr("GENESIS_RESERVE_SAFE_ADDRESS");
  const VALIDATOR_REWARDS = reqAddr("VALIDATOR_REWARDS_ADDRESS");
  const TEAM_DISTRIBUTION_SAFE = reqAddr("TEAM_DISTRIBUTION_SAFE_ADDRESS");
  const ADVISOR_DISTRIBUTION_SAFE = reqAddr("ADVISOR_DISTRIBUTION_SAFE_ADDRESS");

  let WNATIVE = reqAddr("WNATIVE_ADDRESS");
  let USDT = reqAddr("USDT_ADDRESS");
  let USDC = reqAddr("USDC_ADDRESS");
  let FDUSD = reqAddr("FDUSD_ADDRESS");
  let BTCB = reqAddr("BTCB_ADDRESS");
  let ETH = reqAddr("ETH_ADDRESS");
  let CAKE = reqAddr("CAKE_ADDRESS");
  let SOL = reqAddr("SOL_ADDRESS");
  let DOGE = reqAddr("DOGE_ADDRESS");
  let ADA = reqAddr("ADA_ADDRESS");
  let TRX = reqAddr("TRX_ADDRESS");
  let LINK = reqAddr("LINK_ADDRESS");
  let XRP = reqAddr("XRP_ADDRESS");
  let SHIB = reqAddr("SHIB_ADDRESS");

  const RELAYER_ADDRESSES = optAddrList("PAYFLOW_RELAYER_ADDRESSES");

  const useLocalTokenMocks =
    isLocalFork && chainId !== 56 && opt("USE_MAINNET_TOKEN_ADDRESSES_ON_LOCAL", "false") !== "true";
  if (useLocalTokenMocks) {
    console.log("Local non-mainnet dry-run detected: deploying mock external tokens for pair creation");
    WNATIVE = await deployLocalMockToken("Wrapped BNB", "WBNB", 18, deployerAddr);
    USDT = await deployLocalMockToken("Tether USD", "USDT", 18, deployerAddr);
    USDC = await deployLocalMockToken("USD Coin", "USDC", 18, deployerAddr);
    FDUSD = await deployLocalMockToken("First Digital USD", "FDUSD", 18, deployerAddr);
    BTCB = await deployLocalMockToken("Bitcoin BEP2", "BTCB", 18, deployerAddr);
    ETH = await deployLocalMockToken("Ethereum Token", "ETH", 18, deployerAddr);
    CAKE = await deployLocalMockToken("PancakeSwap Token", "CAKE", 18, deployerAddr);
    SOL = await deployLocalMockToken("Solana Token", "SOL", 18, deployerAddr);
    DOGE = await deployLocalMockToken("Dogecoin Token", "DOGE", 18, deployerAddr);
    ADA = await deployLocalMockToken("Cardano Token", "ADA", 18, deployerAddr);
    TRX = await deployLocalMockToken("TRON Token", "TRX", 18, deployerAddr);
    LINK = await deployLocalMockToken("Chainlink Token", "LINK", 18, deployerAddr);
    XRP = await deployLocalMockToken("XRP Token", "XRP", 18, deployerAddr);
    SHIB = await deployLocalMockToken("Shiba Inu Token", "SHIB", 18, deployerAddr);
  }

  const TEAM_START_TS = reqNumJs("TEAM_START_TS");
  const TEAM_CLIFF_TS = reqNumJs("TEAM_CLIFF_TS");
  const TEAM_END_TS = reqNumJs("TEAM_END_TS");
  const ADVISOR_START_TS = reqNumJs("ADVISOR_START_TS");
  const ADVISOR_CLIFF_TS = reqNumJs("ADVISOR_CLIFF_TS");
  const ADVISOR_END_TS = reqNumJs("ADVISOR_END_TS");

  validateVestingWindow("Team", TEAM_START_TS, TEAM_CLIFF_TS, TEAM_END_TS);
  validateVestingWindow("Advisor", ADVISOR_START_TS, ADVISOR_CLIFF_TS, ADVISOR_END_TS);

  const FARM_REWARD_PER_BLOCK = reqNum("FARM_REWARD_PER_BLOCK");
  const FARM_START_BLOCK_OFFSET = reqNumJs("FARM_START_BLOCK_OFFSET");
  const FARM_HARVEST_DELAY = reqNum("FARM_HARVEST_DELAY");
  const DRIPPER_START_TIME = reqNumJs("DRIPPER_START_TIME");
  const DRIPPER_RATE_PER_SEC = reqNum("DRIPPER_RATE_PER_SEC");
  const DRIPPER_LOW_WATER_DAYS = reqNum("DRIPPER_LOW_WATER_DAYS");
  const DRIPPER_COOLDOWN_SECS = reqNumJs("DRIPPER_COOLDOWN_SECS");
  const DRIPPER_MIN_DRIP_AMOUNT = reqNum("DRIPPER_MIN_DRIP_AMOUNT");
  const FARM_PERFORMANCE_FEE_BIPS = optNumJs("FARM_PERFORMANCE_FEE_BIPS", 300);
  const PAYFLOW_PROTOCOL_FEE_BIPS = optNumJs("PAYFLOW_PROTOCOL_FEE_BIPS", 0);
  const PAYFLOW_RELAYER_FEE_BIPS = optNumJs("PAYFLOW_RELAYER_FEE_BIPS", 0);

  const payflowSupportedTokens = uniqueAddresses([
    WNATIVE,
    USDT,
    USDC,
    FDUSD,
    BTCB,
    ETH,
    CAKE,
    SOL,
    DOGE,
    ADA,
    TRX,
    LINK,
    XRP,
    SHIB,
  ]);

  console.log("======================================================");
  console.log("Paragon Mainnet Clean Deploy (Router-only Payflow)");
  console.log("======================================================");
  console.log("Network:", hre.network.name, `(${chainId})`);
  console.log("Deployer:", deployerAddr);
  console.log("Timelock (unused for now):", TIMELOCK);
  console.log("");

  const Vesting = await ethers.getContractFactory("LinearTokenVesting");

  const teamVesting = await Vesting.deploy(
    deployerAddr,
    TEAM_DISTRIBUTION_SAFE,
    TEAM_START_TS,
    TEAM_CLIFF_TS,
    TEAM_END_TS
  );
  await teamVesting.waitForDeployment();
  const teamVestingAddr = await teamVesting.getAddress();
  verification.teamVesting = await buildVerificationEntry("LinearTokenVesting", teamVestingAddr, [
    deployerAddr,
    TEAM_DISTRIBUTION_SAFE,
    TEAM_START_TS,
    TEAM_CLIFF_TS,
    TEAM_END_TS,
  ]);
  console.log("✅ TeamVesting:", teamVestingAddr);

  const advisorVesting = await Vesting.deploy(
    deployerAddr,
    ADVISOR_DISTRIBUTION_SAFE,
    ADVISOR_START_TS,
    ADVISOR_CLIFF_TS,
    ADVISOR_END_TS
  );
  await advisorVesting.waitForDeployment();
  const advisorVestingAddr = await advisorVesting.getAddress();
  verification.advisorVesting = await buildVerificationEntry("LinearTokenVesting", advisorVestingAddr, [
    deployerAddr,
    ADVISOR_DISTRIBUTION_SAFE,
    ADVISOR_START_TS,
    ADVISOR_CLIFF_TS,
    ADVISOR_END_TS,
  ]);
  console.log("✅ AdvisorVesting:", advisorVestingAddr);

  const XPGN = await ethers.getContractFactory("XPGNToken");
  const xpgn = await XPGN.deploy(
    deployerAddr,
    VALIDATOR_REWARDS,
    teamVestingAddr,
    advisorVestingAddr,
    GENESIS_RESERVE_SAFE
  );
  await xpgn.waitForDeployment();
  const xpgnAddr = await xpgn.getAddress();
  verification.xpgn = await buildVerificationEntry("XPGNToken", xpgnAddr, [
    deployerAddr,
    VALIDATOR_REWARDS,
    teamVestingAddr,
    advisorVestingAddr,
    GENESIS_RESERVE_SAFE,
  ]);
  console.log("✅ XPGN:", xpgnAddr);

  await (await teamVesting.initializeToken(xpgnAddr)).wait();
  await (await advisorVesting.initializeToken(xpgnAddr)).wait();
  console.log("→ Vestings initialized (ownership kept with deployer)");

  const currentBlock = await ethers.provider.getBlockNumber();
  const farmStartBlock = currentBlock + FARM_START_BLOCK_OFFSET;

  const Farm = await ethers.getContractFactory("ParagonFarmController");
  const farm = await Farm.deploy(deployerAddr, xpgnAddr, FARM_REWARD_PER_BLOCK, farmStartBlock);
  await farm.waitForDeployment();
  const farmAddr = await farm.getAddress();
  verification.farmController = await buildVerificationEntry("ParagonFarmController", farmAddr, [
    deployerAddr,
    xpgnAddr,
    FARM_REWARD_PER_BLOCK,
    farmStartBlock,
  ]);
  console.log("✅ ParagonFarmController:", farmAddr);

  await (await farm.addPool(0, xpgnAddr, FARM_HARVEST_DELAY)).wait();
  await (await farm.setEmissionsPaused(true)).wait();
  const GUARDIAN_ROLE = ethers.id("GUARDIAN_ROLE");
  await (await farm.grantRole(GUARDIAN_ROLE, SECURITY_COUNCIL_SAFE)).wait();
  console.log("→ Farm pool 0 created for XPGN, emissions paused, guardian granted");

  const Dripper = await ethers.getContractFactory("RewardDripperEscrow");
  const dripper = await Dripper.deploy(
    deployerAddr,
    xpgnAddr,
    farmAddr,
    DRIPPER_START_TIME,
    DRIPPER_RATE_PER_SEC
  );
  await dripper.waitForDeployment();
  const dripperAddr = await dripper.getAddress();
  verification.rewardDripperEscrow = await buildVerificationEntry("RewardDripperEscrow", dripperAddr, [
    deployerAddr,
    xpgnAddr,
    farmAddr,
    DRIPPER_START_TIME,
    DRIPPER_RATE_PER_SEC,
  ]);
  console.log("✅ RewardDripperEscrow:", dripperAddr);

  if (DRIPPER_RATE_PER_SEC > 0n) {
    if (DRIPPER_MIN_DRIP_AMOUNT <= 0n) {
      throw new Error("DRIPPER_MIN_DRIP_AMOUNT must be > 0 when DRIPPER_RATE_PER_SEC > 0");
    }
    await (
      await farm.setDripperConfig(
        dripperAddr,
        DRIPPER_LOW_WATER_DAYS,
        DRIPPER_COOLDOWN_SECS,
        DRIPPER_MIN_DRIP_AMOUNT
      )
    ).wait();
    console.log("→ Farm wired to dripper");
  } else {
    console.log("→ Skipping dripper config because DRIPPER_RATE_PER_SEC = 0");
  }

  const Factory = await ethers.getContractFactory("ParagonFactory");
  const factory = await Factory.deploy(deployerAddr, xpgnAddr);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  verification.factory = await buildVerificationEntry("ParagonFactory", factoryAddr, [
    deployerAddr,
    xpgnAddr,
  ]);
  console.log("✅ ParagonFactory:", factoryAddr);

  const RouterAdmin = await ethers.getContractFactory("ParagonRouterAdmin");
  const routerAdmin = await RouterAdmin.deploy(deployerAddr);
  await routerAdmin.waitForDeployment();
  const routerAdminAddr = await routerAdmin.getAddress();
  verification.routerAdmin = await buildVerificationEntry("ParagonRouterAdmin", routerAdminAddr, [
    deployerAddr,
  ]);
  console.log("✅ ParagonRouterAdmin:", routerAdminAddr);

  const Router = await ethers.getContractFactory("ParagonRouter");
  const router = await Router.deploy(factoryAddr, WNATIVE, farmAddr);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  verification.router = await buildVerificationEntry("ParagonRouter", routerAddr, [
    factoryAddr,
    WNATIVE,
    farmAddr,
  ]);
  console.log("✅ ParagonRouter:", routerAddr);

  const RouterGuard = await ethers.getContractFactory("ParagonRouterGuard");
  const routerGuard = await RouterGuard.deploy(deployerAddr, factoryAddr, routerAdminAddr);
  await routerGuard.waitForDeployment();
  const routerGuardAddr = await routerGuard.getAddress();
  verification.routerGuard = await buildVerificationEntry("ParagonRouterGuard", routerGuardAddr, [
    deployerAddr,
    factoryAddr,
    routerAdminAddr,
  ]);
  console.log("✅ ParagonRouterGuard:", routerGuardAddr);

  const BestExec = await ethers.getContractFactory("ParagonBestExecutionV14");
  const bestExec = await BestExec.deploy(deployerAddr);
  await bestExec.waitForDeployment();
  const bestExecAddr = await bestExec.getAddress();
  verification.bestExecution = await buildVerificationEntry("ParagonBestExecutionV14", bestExecAddr, [
    deployerAddr,
  ]);
  console.log("✅ ParagonBestExecutionV14:", bestExecAddr);

  const LPFlowRebates = await ethers.getContractFactory("LPFlowRebates");
  const lpRebates = await LPFlowRebates.deploy(factoryAddr, ethers.ZeroAddress, deployerAddr);
  await lpRebates.waitForDeployment();
  const lpRebatesAddr = await lpRebates.getAddress();
  verification.lpFlowRebates = await buildVerificationEntry("LPFlowRebates", lpRebatesAddr, [
    factoryAddr,
    ethers.ZeroAddress,
    deployerAddr,
  ]);
  console.log("✅ LPFlowRebates:", lpRebatesAddr);

  const TreasurySplitter = await ethers.getContractFactory("TreasurySplitter");
  const splitter = await TreasurySplitter.deploy(
    deployerAddr,
    TREASURY_SAFE,
    TREASURY_SAFE,
    TREASURY_SAFE
  );
  await splitter.waitForDeployment();
  const splitterAddr = await splitter.getAddress();
  verification.treasurySplitter = await buildVerificationEntry("TreasurySplitter", splitterAddr, [
    deployerAddr,
    TREASURY_SAFE,
    TREASURY_SAFE,
    TREASURY_SAFE,
  ]);
  console.log("✅ TreasurySplitter:", splitterAddr);

  const Payflow = await ethers.getContractFactory(
      "contracts/payflow/ParagonPayflowExecutorv2.sol:ParagonPayflowExecutorV2"
  );
  const payflow = await Payflow.deploy(
    deployerAddr,
    routerAddr,
    bestExecAddr,
    TREASURY_SAFE,
    lpRebatesAddr,
    TREASURY_SAFE
  );
  await payflow.waitForDeployment();
  const payflowAddr = await payflow.getAddress();
  verification.payflowExecutor = await buildVerificationEntry(
      "contracts/payflow/ParagonPayflowExecutorv2.sol:ParagonPayflowExecutorV2",
    payflowAddr,
    [deployerAddr, routerAddr, bestExecAddr, TREASURY_SAFE, lpRebatesAddr, TREASURY_SAFE]
  );
  console.log("✅ ParagonPayflowExecutorV2:", payflowAddr);

  const Zap = await ethers.getContractFactory("ParagonZapV2");
  const zap = await Zap.deploy(routerAddr, farmAddr, TREASURY_SAFE);
  await zap.waitForDeployment();
  const zapAddr = await zap.getAddress();
  verification.zapV2 = await buildVerificationEntry("ParagonZapV2", zapAddr, [
    routerAddr,
    farmAddr,
    TREASURY_SAFE,
  ]);
  console.log("✅ ParagonZapV2:", zapAddr);

  await (await routerAdmin.setMaxSlippageBips(50)).wait();
  await (await routerAdmin.setMaxPriceImpactBips(100)).wait();
  await (await routerAdmin.setFeeOnTransferTolerance(200)).wait();
  await (await routerAdmin.configureTwapOracle(ethers.ZeroAddress, false)).wait();
  await (await routerAdmin.setWhitelistEnabled(false)).wait();
  console.log("→ RouterAdmin configured");

  await (await routerGuard.setEnabled(false)).wait();
  await (await routerGuard.setFailOpen(true)).wait();
  await (await routerGuard.setProtectedToken(xpgnAddr, true)).wait();
  console.log("→ RouterGuard configured");

  await (await router.setAdmin(routerAdminAddr)).wait();
  await (await router.setGuard(routerGuardAddr)).wait();
  await (await router.setAutoYieldConfig(0, false)).wait();
  console.log("→ Router wired and auto-yield disabled");

  await (await farm.setAutoYieldCaller(routerAddr, true)).wait();
  await (await farm.setPerformanceFee(TREASURY_SAFE, FARM_PERFORMANCE_FEE_BIPS)).wait();
  console.log("→ Farm auto-yield caller set + performance fee configured");

  await (await bestExec.setAuthorizedExecutor(payflowAddr, true)).wait();
  console.log("→ BestExecution authorized executor set");

  await (await lpRebates.setGuardian(SECURITY_COUNCIL_SAFE)).wait();
  await (await lpRebates.setNotifier(payflowAddr)).wait();
  for (const rewardToken of uniqueAddresses([...payflowSupportedTokens, xpgnAddr])) {
    await (await lpRebates.addSupportedReward(rewardToken)).wait();
  }
  console.log("→ LPFlowRebates configured");

  await (await splitter.setGuardian(SECURITY_COUNCIL_SAFE)).wait();
  console.log("→ TreasurySplitter guardian set");

  await (await payflow.setGuardian(SECURITY_COUNCIL_SAFE)).wait();
  for (const token of uniqueAddresses([...payflowSupportedTokens, xpgnAddr])) {
    await (await payflow.setSupportedToken(token, true)).wait();
  }
  await (await payflow.setSplitBips(6000, 3000)).wait();
  await (await payflow.setRelayerFeeBips(PAYFLOW_RELAYER_FEE_BIPS)).wait();
  if (PAYFLOW_PROTOCOL_FEE_BIPS > 0) {
    await (
      await payflow.setParams(
        routerAddr,
        bestExecAddr,
        TREASURY_SAFE,
        lpRebatesAddr,
        TREASURY_SAFE,
        PAYFLOW_PROTOCOL_FEE_BIPS
      )
    ).wait();
  }
  await (await payflow.setVenueEnabled(bestExecAddr, true)).wait();
  await (await payflow.setVenueEnabled(routerAddr, true)).wait();
  for (const relayer of RELAYER_ADDRESSES) {
    await (await payflow.setRelayer(relayer, true)).wait();
  }
  console.log("→ Payflow configured (Paragon router only)");

  await (
    await factory.setBaseTokens(
      [USDT, USDC, WNATIVE, FDUSD, BTCB, ETH, CAKE, xpgnAddr],
      [true, true, true, true, true, true, true, true]
    )
  ).wait();
  await (await factory.setSwapFee(20)).wait();
  // Keep the global default at 0.20% for core/base pairs, but force
  // unknown user-created pairs to 0.50% whether they are base+nonbase
  // or nonbase+nonbase. Approved retail majors get explicit per-pair
  // overrides after canonical pair creation below.
  await (await factory.setDefaultNonBaseFees(50, 50)).wait();
  await (await factory.setFeeTo(TREASURY_SAFE)).wait();
  await (await factory.setFeeToSetter(deployerAddr)).wait();
  console.log("→ Factory configured (feeToSetter kept with deployer)");

  const pairs = {};
  const pairSpecs = [
    ["wbnbUsdt", WNATIVE, USDT, "WBNB/USDT"],
    ["wbnbUsdc", WNATIVE, USDC, "WBNB/USDC"],
    ["wbnbFdusd", WNATIVE, FDUSD, "WBNB/FDUSD"],
    ["usdtUsdc", USDT, USDC, "USDT/USDC"],
    ["usdtFdusd", USDT, FDUSD, "USDT/FDUSD"],
    ["usdcFdusd", USDC, FDUSD, "USDC/FDUSD"],
    ["btcbWbnb", BTCB, WNATIVE, "BTCB/WBNB"],
    ["btcbUsdt", BTCB, USDT, "BTCB/USDT"],
    ["btcbUsdc", BTCB, USDC, "BTCB/USDC"],
    ["btcbFdusd", BTCB, FDUSD, "BTCB/FDUSD"],
    ["ethWbnb", ETH, WNATIVE, "ETH/WBNB"],
    ["ethUsdt", ETH, USDT, "ETH/USDT"],
    ["ethUsdc", ETH, USDC, "ETH/USDC"],
    ["ethFdusd", ETH, FDUSD, "ETH/FDUSD"],
    ["cakeWbnb", CAKE, WNATIVE, "CAKE/WBNB"],
    ["cakeUsdt", CAKE, USDT, "CAKE/USDT"],
    ["cakeUsdc", CAKE, USDC, "CAKE/USDC"],
    ["cakeFdusd", CAKE, FDUSD, "CAKE/FDUSD"],
    ["xpgnWbnb", xpgnAddr, WNATIVE, "XPGN/WBNB"],
    ["xpgnUsdt", xpgnAddr, USDT, "XPGN/USDT"],
    ["xpgnUsdc", xpgnAddr, USDC, "XPGN/USDC"],
    ["xpgnFdusd", xpgnAddr, FDUSD, "XPGN/FDUSD"],
    ["solUsdt", SOL, USDT, "SOL/USDT"],
    ["dogeUsdt", DOGE, USDT, "DOGE/USDT"],
    ["adaUsdt", ADA, USDT, "ADA/USDT"],
    ["trxUsdt", TRX, USDT, "TRX/USDT"],
    ["linkUsdt", LINK, USDT, "LINK/USDT"],
    ["xrpUsdt", XRP, USDT, "XRP/USDT"],
    ["shibUsdt", SHIB, USDT, "SHIB/USDT"],
    ["solWbnb", SOL, WNATIVE, "SOL/WBNB"],
    ["dogeWbnb", DOGE, WNATIVE, "DOGE/WBNB"],
    ["adaWbnb", ADA, WNATIVE, "ADA/WBNB"],
    ["trxWbnb", TRX, WNATIVE, "TRX/WBNB"],
    ["linkWbnb", LINK, WNATIVE, "LINK/WBNB"],
    ["xrpWbnb", XRP, WNATIVE, "XRP/WBNB"],
    ["shibWbnb", SHIB, WNATIVE, "SHIB/WBNB"],
  ];

  for (const [key, tokenA, tokenB, label] of pairSpecs) {
    pairs[key] = await createPairIfMissing(factory, tokenA, tokenB, label);
  }

  // Pair-specific launch fee overrides:
  // - Stable/stable pairs: 0.01%
  // - Approved retail major pairs: 0.30%
  const pairFeeOverrides = {
    usdtUsdc: 1,
    usdtFdusd: 1,
    usdcFdusd: 1,
    solUsdt: 30,
    dogeUsdt: 30,
    adaUsdt: 30,
    trxUsdt: 30,
    linkUsdt: 30,
    xrpUsdt: 30,
    shibUsdt: 30,
    solWbnb: 30,
    dogeWbnb: 30,
    adaWbnb: 30,
    trxWbnb: 30,
    linkWbnb: 30,
    xrpWbnb: 30,
    shibWbnb: 30,
  };

  for (const [key, bips] of Object.entries(pairFeeOverrides)) {
    await (await factory.setPairSwapFee(pairs[key], bips)).wait();
  }

  for (const pair of Object.values(pairs)) {
    await (await lpRebates.setAllowedLp(pair, true)).wait();
  }
  console.log("→ Canonical pairs reserved + LPFlowRebates allowlist set");

  const out = {
    network: hre.network.name,
    chainId,
    deployer: deployerAddr,
    timelock: TIMELOCK,
    adminSafe: ADMIN_SAFE,
    treasurySafe: TREASURY_SAFE,
    securityCouncilSafe: SECURITY_COUNCIL_SAFE,
    genesisReserveSafe: GENESIS_RESERVE_SAFE,
    validatorRewardsAddress: VALIDATOR_REWARDS,
    launchConfig: {
      ammCoreSwapFeeBips: 20,
      stablePairSwapFeeBips: 1,
      approvedRetailMajorPairSwapFeeBips: 30,
      unknownPairSwapFeeBips: 50,
      payflowProtocolFeeBips: PAYFLOW_PROTOCOL_FEE_BIPS,
      payflowRelayerFeeBips: PAYFLOW_RELAYER_FEE_BIPS,
      farmPerformanceFeeBips: FARM_PERFORMANCE_FEE_BIPS,
      routerAutoYieldEnabled: false,
      farmEmissionsPaused: true,
      oneInchIntegrated: false,
      adapterDeployed: false,
    },
    ownershipMode: "deployer_staging_before_timelock",
    addresses: {
      teamVesting: teamVestingAddr,
      advisorVesting: advisorVestingAddr,
      xpgn: xpgnAddr,
      farmController: farmAddr,
      rewardDripperEscrow: dripperAddr,
      factory: factoryAddr,
      routerAdmin: routerAdminAddr,
      router: routerAddr,
      routerGuard: routerGuardAddr,
      bestExecution: bestExecAddr,
      lpFlowRebates: lpRebatesAddr,
      treasurySplitter: splitterAddr,
      payflowExecutor: payflowAddr,
      adapter: null,
      zapV2: zapAddr,
      pairs,
    },
    postDeployRequired: {
      transferToTimelockLater: true,
      requiredBeforeTimelock: [
        "mainnet-fork swap test on Paragon router",
        "mainnet-fork Payflow router path test",
        "farm multi-pool reward accounting test",
        "oracle / RouterGuard activation plan review",
      ],
    },
    verification,
  };

  const outFile = path.join(__dirname, "..", "deployments", "bscMainnet-paragon-clean.json");
  const verifyFile = path.join(__dirname, "..", "deployments", "bscMainnet-paragon-clean.verify.json");
  await saveJSON(outFile, out);
  await saveJSON(verifyFile, { network: hre.network.name, chainId, generatedAt: new Date().toISOString(), verification });

  console.log("");
  console.log("Clean deployment complete.");
  console.log("Deployment file:", outFile);
  console.log("Verification file:", verifyFile);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
