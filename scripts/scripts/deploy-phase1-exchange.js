require("dotenv").config();
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const IERC20_ART = "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20";
const IERC20_METADATA_ART =
  "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol:IERC20Metadata";

const ADDR = (name) => {
  const v = process.env[name];
  return v && v !== "" ? v : null;
};

function req(name) {
  const v = ADDR(name);
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function envStr(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function envNum(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : Number(v);
}

async function getDecimals(token) {
  const erc20 = await ethers.getContractAt(IERC20_METADATA_ART, token);
  return Number(await erc20.decimals());
}

async function approveMax(token, signer, spender) {
  const erc20 = await ethers.getContractAt(IERC20_ART, token, signer);
  const owner = await signer.getAddress();
  const allowance = await erc20.allowance(owner, spender);

  if (allowance < ethers.MaxUint256 / 2n) {
    const tx = await erc20.approve(spender, ethers.MaxUint256);
    await tx.wait();
  }
}

function pctDown(x, bps) {
  return (x * BigInt(10000 - bps)) / 10000n;
}

async function saveJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  console.log(`✔ Saved → ${file}`);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createPairIfMissing(factory, tokenA, tokenB, label) {
  let pair = await factory.getPair(tokenA, tokenB);
  if (pair !== ethers.ZeroAddress) {
    console.log(`✅ Pair ${label}: ${pair}`);
    return pair;
  }

  console.log(`→ Creating pair ${label}...`);

  // Preflight: surface revert reason before sending tx
  await factory.createPair.staticCall(tokenA, tokenB);

  const tx = await factory.createPair(tokenA, tokenB);
  const receipt = await tx.wait();

  if (!receipt || receipt.status !== 1) {
    throw new Error(`Pair creation tx failed for ${label}`);
  }

  // Retry reads because public BSC testnet RPC can lag after mined tx
  for (let i = 0; i < 10; i++) {
    pair = await factory.getPair(tokenA, tokenB);
    if (pair !== ethers.ZeroAddress) {
      console.log(`✅ Pair ${label}: ${pair}`);
      return pair;
    }

    pair = await factory.getPair(tokenB, tokenA);
    if (pair !== ethers.ZeroAddress) {
      console.log(`✅ Pair ${label}: ${pair}`);
      return pair;
    }

    await sleep(1500);
  }

  throw new Error(`Pair ${label} was not created or RPC returned stale state`);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();
  const network = await ethers.provider.getNetwork();

  const DAO_MULTISIG = req("DAO_MULTISIG");
  const VALIDATOR_REWARDS_ADDRESS = req("VALIDATOR_REWARDS_ADDRESS");
  const TEAM_VESTING_ADDRESS = req("TEAM_VESTING_ADDRESS");
  const ADVISOR_VESTING_ADDRESS = req("ADVISOR_VESTING_ADDRESS");

  const USDT_ADDRESS = req("USDT_ADDRESS");
  const USDC_ADDRESS = req("USDC_ADDRESS");
  const WNATIVE_ADDRESS = req("WNATIVE_ADDRESS");

  const GENESIS_RECIPIENT = ADDR("GENESIS_RECIPIENT") || deployerAddr;
  const FEE_TO = ADDR("FEE_TO") || DAO_MULTISIG;

  // Farm / Dripper config
  const FARM_REWARD_PER_BLOCK = envStr("FARM_REWARD_PER_BLOCK", "0");
  const FARM_START_BLOCK_OFFSET = envNum("FARM_START_BLOCK_OFFSET", 20);
  const LP_ALLOC_POINT = envStr("LP_ALLOC_POINT", "10000");
  const LP_HARVEST_DELAY = envStr("LP_HARVEST_DELAY", "0");

  const DRIP_START_TIME = envNum("DRIP_START_TIME", Math.floor(Date.now() / 1000));
  const DRIP_RATE_PER_SEC = envStr("DRIP_RATE_PER_SEC", "0");
  const INITIAL_FARMING_MINT = envStr("INITIAL_FARMING_MINT", "0");
  const DRIP_LOW_WATER_DAYS = envStr("DRIP_LOW_WATER_DAYS", "3");
  const DRIP_COOLDOWN_SECS = envStr("DRIP_COOLDOWN_SECS", "3600");
  const DRIP_MIN_AMOUNT = envStr("DRIP_MIN_AMOUNT", "1000");

  // Seed config: only XPGN/USDT
  const SEED_LP = envStr("SEED_LP", "true").toLowerCase() === "true";
  const SEED_XPGN_AMOUNT = envStr("SEED_XPGN_AMOUNT", "404040");
  const SEED_USDT_AMOUNT = envStr("SEED_USDT_AMOUNT", "100000");

  console.log("Network:", hre.network.name, `(${network.chainId})`);
  console.log("Deployer:", deployerAddr);
  console.log("DAO Multisig:", DAO_MULTISIG);
  console.log("Genesis recipient:", GENESIS_RECIPIENT);

  // --------------------------------------------------
  // 1) Deploy XPGN
  // Keep token admin/owner under DAO multisig
  // --------------------------------------------------
  const XPGN = await ethers.getContractFactory("XPGNToken");
  const xpgn = await XPGN.deploy(
    DAO_MULTISIG,
    VALIDATOR_REWARDS_ADDRESS,
    TEAM_VESTING_ADDRESS,
    ADVISOR_VESTING_ADDRESS,
    GENESIS_RECIPIENT
  );
  await xpgn.waitForDeployment();
  const xpgnAddr = await xpgn.getAddress();
  console.log("✅ XPGNToken:", xpgnAddr);

  // --------------------------------------------------
  // 2) Deploy FarmController
  // IMPORTANT: deployer owns it first so script can configure it
  // --------------------------------------------------
  const Farm = await ethers.getContractFactory("ParagonFarmController");
  const currentBlock = await ethers.provider.getBlockNumber();
  const startBlock = currentBlock + FARM_START_BLOCK_OFFSET;

  const farm = await Farm.deploy(
    deployerAddr,
    xpgnAddr,
    ethers.parseUnits(FARM_REWARD_PER_BLOCK, 18),
    startBlock
  );
  await farm.waitForDeployment();
  const farmAddr = await farm.getAddress();
  console.log("✅ ParagonFarmController:", farmAddr);

  // --------------------------------------------------
  // 3) Deploy Factory
  // IMPORTANT: deployer is feeToSetter + owner first so script can configure it
  // --------------------------------------------------
  const Factory = await ethers.getContractFactory("ParagonFactory");
  const factory = await Factory.deploy(deployerAddr, xpgnAddr);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("✅ ParagonFactory:", factoryAddr);

  // --------------------------------------------------
  // 4) Deploy RouterAdmin
  // IMPORTANT: deployer owns it first so script can configure it
  // --------------------------------------------------
  const RouterAdmin = await ethers.getContractFactory("ParagonRouterAdmin");
  const routerAdmin = await RouterAdmin.deploy(deployerAddr);
  await routerAdmin.waitForDeployment();
  const routerAdminAddr = await routerAdmin.getAddress();
  console.log("✅ ParagonRouterAdmin:", routerAdminAddr);

  // --------------------------------------------------
  // 5) Deploy Router
  // IMPORTANT: deployer owns it first so script can wire it
  // --------------------------------------------------
  const Router = await ethers.getContractFactory("ParagonRouter");
  const router = await Router.deploy(factoryAddr, WNATIVE_ADDRESS, farmAddr);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  console.log("✅ ParagonRouter:", routerAddr);

  // --------------------------------------------------
  // 6) Deploy RouterGuard
  // IMPORTANT: deployer owns it first so script can configure it
  // --------------------------------------------------
  const RouterGuard = await ethers.getContractFactory("ParagonRouterGuard");
  const routerGuard = await RouterGuard.deploy(
    deployerAddr,
    factoryAddr,
    routerAdminAddr
  );
  await routerGuard.waitForDeployment();
  const routerGuardAddr = await routerGuard.getAddress();
  console.log("✅ ParagonRouterGuard:", routerGuardAddr);

  // --------------------------------------------------
  // 7) Deploy RewardDripperEscrow
  // IMPORTANT: deployer owns it first so script can configure it
  // --------------------------------------------------
  const Dripper = await ethers.getContractFactory("RewardDripperEscrow");
  const dripper = await Dripper.deploy(
    deployerAddr,
    xpgnAddr,
    farmAddr,
    DRIP_START_TIME,
    ethers.parseUnits(DRIP_RATE_PER_SEC, 18)
  );
  await dripper.waitForDeployment();
  const dripperAddr = await dripper.getAddress();
  console.log("✅ RewardDripperEscrow:", dripperAddr);

  // --------------------------------------------------
  // 8) Configure RouterAdmin / Guard
  // --------------------------------------------------
  await (await routerAdmin.setMaxSlippageBips(50)).wait();          // 0.5%
  await (await routerAdmin.setMaxPriceImpactBips(100)).wait();      // 1.0%
  await (await routerAdmin.setFeeOnTransferTolerance(200)).wait();  // 2.0%
  await (await routerAdmin.configureTwapOracle(ethers.ZeroAddress, false)).wait();
  await (await routerAdmin.setWhitelistEnabled(false)).wait();
  console.log("→ RouterAdmin configured");

  // Guard deployed, but off for launch
  await (await routerGuard.setEnabled(false)).wait();
  await (await routerGuard.setFailOpen(true)).wait();
  await (await routerGuard.setProtectedToken(xpgnAddr, true)).wait();
  console.log("→ RouterGuard configured (disabled at launch)");

  // Wire router to admin + guard
  await (await router.setAdmin(routerAdminAddr)).wait();
  await (await router.setGuard(routerGuardAddr)).wait();
  console.log("→ Router configured");

  // --------------------------------------------------
  // 9) Configure Factory
  // IMPORTANT:
  // - allowlisted launch pairs will use global swapFeeBips
  // - set feeToSetter to DAO multisig before final handoff
  // --------------------------------------------------
  await (
    await factory.setBaseTokens(
      [xpgnAddr, USDT_ADDRESS, USDC_ADDRESS, WNATIVE_ADDRESS],
      [true, true, true, true]
    )
  ).wait();

  await (await factory.setPairAllowlist(xpgnAddr, USDT_ADDRESS, true)).wait();
  await (await factory.setPairAllowlist(xpgnAddr, WNATIVE_ADDRESS, true)).wait();
  await (await factory.setPairAllowlist(xpgnAddr, USDC_ADDRESS, true)).wait();
  await (await factory.setPairAllowlist(WNATIVE_ADDRESS, USDT_ADDRESS, true)).wait();

  // Explicit launch fee policy
  await (await factory.setSwapFee(20)).wait(); // 0.20% global
  await (await factory.setDefaultNonBaseFees(35, 50)).wait(); // 0.35% / 0.50%
  await (await factory.setFeeTo(FEE_TO)).wait();
  await (await factory.setFeeToSetter(DAO_MULTISIG)).wait();

  console.log("→ Factory configured (fees + feeToSetter handed to DAO)");

  // --------------------------------------------------
  // 10) Create required launch pairs
  // --------------------------------------------------
  const pairXpgnUsdt = await createPairIfMissing(
    factory,
    xpgnAddr,
    USDT_ADDRESS,
    "XPGN/USDT"
  );

  const pairXpgnWbnb = await createPairIfMissing(
    factory,
    xpgnAddr,
    WNATIVE_ADDRESS,
    "XPGN/WBNB"
  );

  const pairXpgnUsdc = await createPairIfMissing(
    factory,
    xpgnAddr,
    USDC_ADDRESS,
    "XPGN/USDC"
  );

  const pairWbnbUsdt = await createPairIfMissing(
    factory,
    WNATIVE_ADDRESS,
    USDT_ADDRESS,
    "WBNB/USDT"
  );

  if (pairXpgnUsdt === ethers.ZeroAddress) {
    throw new Error("XPGN/USDT pair is zero address; aborting before addPool");
  }

  // --------------------------------------------------
  // 11) Add LP farm pool for XPGN/USDT only
  // --------------------------------------------------
  await (
    await farm.addPool(
      LP_ALLOC_POINT,
      pairXpgnUsdt,
      LP_HARVEST_DELAY
    )
  ).wait();
  console.log("✅ Farm pool added for XPGN/USDT LP");

  await (
    await farm.setDripperConfig(
      dripperAddr,
      DRIP_LOW_WATER_DAYS,
      DRIP_COOLDOWN_SECS,
      ethers.parseUnits(DRIP_MIN_AMOUNT, 18)
    )
  ).wait();
  console.log("→ Farm dripper configured");

  await (await farm.setEmissionsPaused(true)).wait();
  console.log("→ Farm emissions paused at launch");

  // --------------------------------------------------
  // 12) Optional farming mint into dripper
  // --------------------------------------------------
  if (INITIAL_FARMING_MINT !== "0") {
    const farmingRole = await xpgn.FARMING_MINTER_ROLE();
    const hasRole = await xpgn.hasRole(farmingRole, deployerAddr);

    if (!hasRole) {
      console.log("⚠️ Deployer does not hold FARMING_MINTER_ROLE, skipping initial farming mint");
    } else {
      await (
        await xpgn.mint(
          dripperAddr,
          ethers.parseUnits(INITIAL_FARMING_MINT, 18),
          farmingRole
        )
      ).wait();
      console.log(`✅ Minted ${INITIAL_FARMING_MINT} XPGN to dripper`);
    }
  }

  // --------------------------------------------------
  // 13) Seed only XPGN/USDT
  // IMPORTANT: deployer wallet must hold both mock USDT and seeded XPGN
  // --------------------------------------------------
  const usdtDecimals = await getDecimals(USDT_ADDRESS);

  if (SEED_LP) {
    const seedXpgn = ethers.parseUnits(SEED_XPGN_AMOUNT, 18);
    const seedUsdt = ethers.parseUnits(SEED_USDT_AMOUNT, usdtDecimals);

    const xpgnToken = await ethers.getContractAt(IERC20_ART, xpgnAddr, deployer);
    const usdtToken = await ethers.getContractAt(IERC20_ART, USDT_ADDRESS, deployer);

    const xpgnBal = await xpgnToken.balanceOf(deployerAddr);
    const usdtBal = await usdtToken.balanceOf(deployerAddr);

    if (xpgnBal < seedXpgn) {
      throw new Error(
        `Not enough XPGN on deployer. Need ${SEED_XPGN_AMOUNT} XPGN. ` +
        `Make sure GENESIS_RECIPIENT is the deployer wallet for this launch.`
      );
    }

    if (usdtBal < seedUsdt) {
      throw new Error(`Not enough USDT on deployer. Need ${SEED_USDT_AMOUNT} USDT`);
    }

    await approveMax(xpgnAddr, deployer, routerAddr);
    await approveMax(USDT_ADDRESS, deployer, routerAddr);

    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const minXpgn = pctDown(seedXpgn, 100); // 1%
    const minUsdt = pctDown(seedUsdt, 100); // 1%

    await (
      await router.addLiquidity(
        xpgnAddr,
        USDT_ADDRESS,
        seedXpgn,
        seedUsdt,
        minXpgn,
        minUsdt,
        deployerAddr,
        deadline
      )
    ).wait();

    console.log(`✅ Seeded XPGN/USDT with ${SEED_XPGN_AMOUNT} XPGN + ${SEED_USDT_AMOUNT} USDT`);
  } else {
    console.log("→ LP seeding skipped");
  }

  // --------------------------------------------------
  // 14) Transfer ownership to multisig
  // IMPORTANT:
  // - factory owner transfers here
  // - feeToSetter was already handed to DAO above
  // --------------------------------------------------
  if (deployerAddr.toLowerCase() !== DAO_MULTISIG.toLowerCase()) {
    await (await factory.transferOwnership(DAO_MULTISIG)).wait();
    await (await router.transferOwnership(DAO_MULTISIG)).wait();
    await (await routerAdmin.transferOwnership(DAO_MULTISIG)).wait();
    await (await routerGuard.transferOwnership(DAO_MULTISIG)).wait();
    await (await farm.transferOwnership(DAO_MULTISIG)).wait();
    await (await dripper.transferOwnership(DAO_MULTISIG)).wait();
    console.log("→ Ownership transferred to DAO multisig");
  }

  // --------------------------------------------------
  // 15) Save deployment
  // --------------------------------------------------
  const output = {
    network: hre.network.name,
    chainId: Number(network.chainId),
    deployer: deployerAddr,
    daoMultisig: DAO_MULTISIG,
    genesisRecipient: GENESIS_RECIPIENT,
    feeTo: FEE_TO,
    addresses: {
      xpgn: xpgnAddr,
      farmController: farmAddr,
      factory: factoryAddr,
      routerAdmin: routerAdminAddr,
      router: routerAddr,
      routerGuard: routerGuardAddr,
      rewardDripperEscrow: dripperAddr,
      pairXpgnUsdt,
      pairXpgnWbnb,
      pairXpgnUsdc,
      pairWbnbUsdt,
      usdt: USDT_ADDRESS,
      usdc: USDC_ADDRESS,
      wnative: WNATIVE_ADDRESS,
      validatorRewards: VALIDATOR_REWARDS_ADDRESS,
      teamVesting: TEAM_VESTING_ADDRESS,
      advisorVesting: ADVISOR_VESTING_ADDRESS
    },
    config: {
      farmRewardPerBlock: FARM_REWARD_PER_BLOCK,
      farmStartBlock: startBlock,
      lpAllocPoint: LP_ALLOC_POINT,
      lpHarvestDelay: LP_HARVEST_DELAY,
      dripStartTime: DRIP_START_TIME,
      dripRatePerSec: DRIP_RATE_PER_SEC,
      initialFarmingMint: INITIAL_FARMING_MINT,
      seedLp: SEED_LP,
      seedXpgnAmount: SEED_XPGN_AMOUNT,
      seedUsdtAmount: SEED_USDT_AMOUNT,
      emissionsPausedAtLaunch: true,
      globalSwapFeeBips: 20,
      nonBaseWithBaseFeeBips: 35,
      nonBaseFeeBips: 50,
      feeToSetterTransferredToDao: true,
      guardEnabledAtLaunch: false,
      oracleEnabledAtLaunch: false
    }
  };

  const outFile = path.join(__dirname, "../deployments", `${hre.network.name}.json`);
  await saveJSON(outFile, output);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });