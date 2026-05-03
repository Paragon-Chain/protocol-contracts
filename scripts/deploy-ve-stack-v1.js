require("dotenv").config();
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

function req(name) {
  const v = process.env[name];
  if (!v || v === "") throw new Error(`Missing required env var: ${name}`);
  return v;
}

function envStr(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function getOptionalWalletFromEnv(envKey, provider) {
  const pk = process.env[envKey];
  if (!pk || pk === "") return null;
  return new ethers.Wallet(pk, provider);
}

async function saveJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  console.log(`✔ Saved → ${file}`);
}

async function resolveOwnerSigner(ownerAddr, deployer, daoAdmin) {
  const deployerAddr = await deployer.getAddress();
  if (ownerAddr.toLowerCase() === deployerAddr.toLowerCase()) {
    return deployer;
  }

  if (daoAdmin) {
    const daoAdminAddr = await daoAdmin.getAddress();
    if (ownerAddr.toLowerCase() === daoAdminAddr.toLowerCase()) {
      return daoAdmin;
    }
  }

  return null;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();
  const network = await ethers.provider.getNetwork();

  const daoAdmin = getOptionalWalletFromEnv("PRIVATE_KEY_DAO", ethers.provider);
  const daoAdminAddr = daoAdmin ? await daoAdmin.getAddress() : null;

  const DAO_MULTISIG = req("DAO_MULTISIG");

  // Reused contracts
  const XPGN_ADDRESS = req("XPGN_ADDRESS");
  const USDT_ADDRESS = req("USDT_ADDRESS");
  const FARM_ADDRESS = req("NEW_FARM_ADDRESS");
  const PAYFLOW_EXECUTOR_ADDRESS = req("PAYFLOW_EXECUTOR_ADDRESS");
  const TREASURY_ADDRESS = req("TREASURY_ADDRESS");

  // Gauge identifiers (LP only)
  const GAUGE_XPGN_USDT_LP = req("GAUGE_XPGN_USDT_LP");

  // Revenue split
  const FEE_DISTRIBUTOR_BPS = Number(envStr("FEE_DISTRIBUTOR_BPS", "5000"));
  const TREASURY_BPS = Number(envStr("TREASURY_BPS", "2000"));
  const TRADER_REWARDS_BPS = Number(envStr("TRADER_REWARDS_BPS", "3000"));

  // Weekly emission
  const WEEKLY_EMISSION = envStr("WEEKLY_EMISSION", "0");

  // Funding mode
  // true = token.mint(...) from distributor
  // false = treasury-funded
  const USE_MINTING = envStr("USE_MINTING", "false").toLowerCase() === "true";

  if (FEE_DISTRIBUTOR_BPS + TREASURY_BPS + TRADER_REWARDS_BPS !== 10000) {
    throw new Error("Revenue split BPS must sum to 10000");
  }

  console.log("Network:", hre.network.name, `(${network.chainId})`);
  console.log("Deployer:", deployerAddr);
  console.log("DAO Multisig:", DAO_MULTISIG);
  if (daoAdminAddr) {
    console.log("DAO admin signer:", daoAdminAddr);
  }

  // Deploy as deployer, configure, then transfer to DAO multisig

  // 1) VoterEscrow
  const VoterEscrow = await ethers.getContractFactory("VoterEscrow");
  const ve = await VoterEscrow.deploy(XPGN_ADDRESS, deployerAddr);
  await ve.waitForDeployment();
  const veAddr = await ve.getAddress();
  console.log("✅ VoterEscrow:", veAddr);

  // 2) UsagePoints
  const UsagePoints = await ethers.getContractFactory("UsagePoints");
  const usage = await UsagePoints.deploy(deployerAddr);
  await usage.waitForDeployment();
  const usageAddr = await usage.getAddress();
  console.log("✅ UsagePoints:", usageAddr);

  // 3) UsagePointsAdapter
  const UsagePointsAdapter = await ethers.getContractFactory("UsagePointsAdapter");
  const usageAdapter = await UsagePointsAdapter.deploy(deployerAddr, usageAddr);
  await usageAdapter.waitForDeployment();
  const usageAdapterAddr = await usageAdapter.getAddress();
  console.log("✅ UsagePointsAdapter:", usageAdapterAddr);

  // 4) GaugeController
  const GaugeController = await ethers.getContractFactory("GaugeController");
  const gaugeController = await GaugeController.deploy(
    veAddr,
    usageAddr,
    deployerAddr
  );
  await gaugeController.waitForDeployment();
  const gaugeControllerAddr = await gaugeController.getAddress();
  console.log("✅ GaugeController:", gaugeControllerAddr);

  // 5) FeeDistributorERC20
  const FeeDistributorERC20 = await ethers.getContractFactory("FeeDistributorERC20");
  const feeDistributor = await FeeDistributorERC20.deploy(
    USDT_ADDRESS,
    veAddr,
    deployerAddr
  );
  await feeDistributor.waitForDeployment();
  const feeDistributorAddr = await feeDistributor.getAddress();
  console.log("✅ FeeDistributorERC20:", feeDistributorAddr);

  // 6) TraderRewardsLocker
  const TraderRewardsLocker = await ethers.getContractFactory("TraderRewardsLocker");
  const traderRewardsLocker = await TraderRewardsLocker.deploy(
    deployerAddr,
    XPGN_ADDRESS,
    usageAddr,
    veAddr,
    false
  );
  await traderRewardsLocker.waitForDeployment();
  const traderRewardsLockerAddr = await traderRewardsLocker.getAddress();
  console.log("✅ TraderRewardsLocker:", traderRewardsLockerAddr);

  // 7) RevenueRouter
  const RevenueRouter = await ethers.getContractFactory("RevenueRouter");
  const revenueRouter = await RevenueRouter.deploy(
    deployerAddr,
    feeDistributorAddr,
    TREASURY_ADDRESS,
    traderRewardsLockerAddr,
    FEE_DISTRIBUTOR_BPS,
    TREASURY_BPS,
    TRADER_REWARDS_BPS
  );
  await revenueRouter.waitForDeployment();
  const revenueRouterAddr = await revenueRouter.getAddress();
  console.log("✅ RevenueRouter:", revenueRouterAddr);

  // 8) UnifiedEmissionsDistributor
  const UnifiedEmissionsDistributor = await ethers.getContractFactory("UnifiedEmissionsDistributor");
  const emissions = await UnifiedEmissionsDistributor.deploy(
    XPGN_ADDRESS,
    gaugeControllerAddr,
    FARM_ADDRESS,
    deployerAddr
  );
  await emissions.waitForDeployment();
  const emissionsAddr = await emissions.getAddress();
  console.log("✅ UnifiedEmissionsDistributor:", emissionsAddr);

  // 9) Wire permissions: UsagePoints <- Adapter <- Payflow
  await (await usage.setCaller(usageAdapterAddr, true)).wait();
  console.log("→ UsagePoints allows UsagePointsAdapter");

  await (await usageAdapter.setCaller(PAYFLOW_EXECUTOR_ADDRESS, true)).wait();
  console.log("→ UsagePointsAdapter allows PayflowExecutor");

  // 10) Register LP gauge only in GaugeController
  await (await gaugeController.addGauge(GAUGE_XPGN_USDT_LP)).wait();
  console.log("→ GaugeController LP gauge added");

  // 11) Map LP gauge to farm pid1 in emissions distributor
  await (await emissions.mapGauge(GAUGE_XPGN_USDT_LP, 1, false)).wait();
  console.log("→ EmissionsDistributor mapped LP gauge to pid1");

  // 12) Set weekly emission + funding mode
  await (
    await emissions.setWeeklyEmission(ethers.parseUnits(WEEKLY_EMISSION, 18))
  ).wait();

  await (
    await emissions.setFundingMode(USE_MINTING, TREASURY_ADDRESS)
  ).wait();
  console.log("→ EmissionsDistributor funding configured");

  // 13) Connect farm to distributor using the real farm owner signer
  const farmRead = await ethers.getContractAt("ParagonFarmController", FARM_ADDRESS);
  const farmOwner = await farmRead.owner();
  console.log("→ Farm owner:", farmOwner);

  const farmSigner = await resolveOwnerSigner(farmOwner, deployer, daoAdmin);
  if (!farmSigner) {
    throw new Error(
      `No signer matched farm owner ${farmOwner}. ` +
      `Check PRIVATE_KEY_DAO or use the correct owner wallet.`
    );
  }

  const FarmWithSignerFactory = await ethers.getContractFactory(
    "ParagonFarmController",
    farmSigner
  );
  const farm = FarmWithSignerFactory.attach(FARM_ADDRESS);

  await (await farm.setGaugeDistributor(emissionsAddr)).wait();
  console.log("→ Farm setGaugeDistributor complete");

  // 14) Transfer ownership to DAO multisig
  if (deployerAddr.toLowerCase() !== DAO_MULTISIG.toLowerCase()) {
    await (await ve.transferOwnership(DAO_MULTISIG)).wait();
    await (await usage.transferOwnership(DAO_MULTISIG)).wait();
    await (await usageAdapter.transferOwnership(DAO_MULTISIG)).wait();
    await (await gaugeController.transferOwnership(DAO_MULTISIG)).wait();
    await (await feeDistributor.transferOwnership(DAO_MULTISIG)).wait();
    await (await traderRewardsLocker.transferOwnership(DAO_MULTISIG)).wait();
    await (await revenueRouter.transferOwnership(DAO_MULTISIG)).wait();
    await (await emissions.transferOwnership(DAO_MULTISIG)).wait();
    console.log("→ ve stack ownership transferred to DAO multisig");
  }

  const output = {
    network: hre.network.name,
    chainId: Number(network.chainId),
    deployer: deployerAddr,
    daoAdmin: daoAdminAddr,
    daoMultisig: DAO_MULTISIG,
    reused: {
      xpgn: XPGN_ADDRESS,
      usdt: USDT_ADDRESS,
      farm: FARM_ADDRESS,
      payflowExecutor: PAYFLOW_EXECUTOR_ADDRESS,
      treasury: TREASURY_ADDRESS,
    },
    addresses: {
      voterEscrow: veAddr,
      usagePoints: usageAddr,
      usagePointsAdapter: usageAdapterAddr,
      gaugeController: gaugeControllerAddr,
      feeDistributor: feeDistributorAddr,
      traderRewardsLocker: traderRewardsLockerAddr,
      revenueRouter: revenueRouterAddr,
      unifiedEmissionsDistributor: emissionsAddr,
    },
    gauges: {
      xpgnUsdtLp: GAUGE_XPGN_USDT_LP,
    },
    config: {
      weeklyEmission: WEEKLY_EMISSION,
      useMinting: USE_MINTING,
      treasury: TREASURY_ADDRESS,
      revenueSplitBps: {
        feeDistributor: FEE_DISTRIBUTOR_BPS,
        treasury: TREASURY_BPS,
        traderRewards: TRADER_REWARDS_BPS,
      },
      farmMappings: {
        xpgnUsdtLpPid: 1,
      },
      singleStakePid0VeControlled: false,
    },
  };

  const outFile = path.join(
    __dirname,
    "../deployments",
    `${hre.network.name}.ve-stack-v1.json`
  );
  await saveJSON(outFile, output);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });