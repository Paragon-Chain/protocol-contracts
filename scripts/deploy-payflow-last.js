require("dotenv").config();
const fs = require("fs");
const path = require("path");
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

async function saveJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  console.log(`✔ Saved -> ${file}`);
}

async function transferOwnershipIfPossible(contract, newOwner, label) {
  if (!contract || typeof contract.transferOwnership !== "function") {
    console.log(`ℹ︎ ${label}: no transferOwnership(), skipped`);
    return;
  }

  try {
    const owner = await contract.owner();
    if (owner.toLowerCase() === newOwner.toLowerCase()) {
      console.log(`ℹ︎ ${label}: ownership already set to DAO`);
      return;
    }
  } catch {
    // continue
  }

  const tx = await contract.transferOwnership(newOwner);
  console.log(`→ ${label}.transferOwnership(${newOwner}): ${tx.hash}`);
  await tx.wait();
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();
  const network = await ethers.provider.getNetwork();

  const DAO_MULTISIG = req("DAO_MULTISIG");
  const TREASURY = req("TREASURY");

  const CORE_DEPLOY_FILE = opt(
    "CORE_DEPLOY_FILE",
    path.join(__dirname, "../deployments/bscTestnet-core-relaunch-v2.json")
  );

  if (!fs.existsSync(CORE_DEPLOY_FILE)) {
    throw new Error(`Core deploy file not found: ${CORE_DEPLOY_FILE}`);
  }

  const CORE = JSON.parse(fs.readFileSync(CORE_DEPLOY_FILE, "utf8"));

  const XPGN = CORE.addresses.xpgn;
  const ROUTER = CORE.addresses.router;
  const FACTORY = CORE.addresses.factory;

  const USDT = CORE.addresses.mocks.usdt;
  const USDC = CORE.addresses.mocks.usdc;
  const WBNB = CORE.addresses.mocks.wbnb;

  const PAIR_XPGN_USDT = CORE.addresses.pairs.xpgnUsdt;
  const PAIR_XPGN_WBNB = CORE.addresses.pairs.xpgnWbnb;
  const PAIR_WBNB_USDT = CORE.addresses.pairs.wbnbUsdt;
  const PAIR_USDT_USDC = CORE.addresses.pairs.usdtUsdc;

  const INCLUDE_USDT_USDC_REBATES = ["1", "true", "yes", "y", "on"].includes(
    String(opt("INCLUDE_USDT_USDC_REBATES", "true")).toLowerCase()
  );

  console.log("======================================================");
  console.log("Paragon Payflow Relaunch V2");
  console.log("======================================================");
  console.log("Network:", hre.network.name, `(${network.chainId})`);
  console.log("Deployer:", deployerAddr);
  console.log("DAO_MULTISIG:", DAO_MULTISIG);
  console.log("TREASURY:", TREASURY);
  console.log("Core deploy file:", CORE_DEPLOY_FILE);
  console.log("");
  console.log("Using core:");
  console.log("XPGN:", XPGN);
  console.log("Router:", ROUTER);
  console.log("Factory:", FACTORY);
  console.log("USDT:", USDT);
  console.log("USDC:", USDC);
  console.log("WBNB:", WBNB);
  console.log("");
  console.log("Pairs:");
  console.log("XPGN/USDT:", PAIR_XPGN_USDT);
  console.log("XPGN/WBNB:", PAIR_XPGN_WBNB);
  console.log("WBNB/USDT:", PAIR_WBNB_USDT);
  console.log("USDT/USDC:", PAIR_USDT_USDC);
  console.log("");

  // 1) BestExecution
  const BestExec = await ethers.getContractFactory("ParagonBestExecutionV14");
  const bestExec = await BestExec.deploy(deployerAddr);
  await bestExec.waitForDeployment();
  const bestExecAddr = await bestExec.getAddress();
  console.log("✅ ParagonBestExecutionV14:", bestExecAddr);

  // 2) LPFlowRebates
  const LPFlowRebates = await ethers.getContractFactory("LPFlowRebates");
  const lpRebates = await LPFlowRebates.deploy(
    FACTORY,
    ethers.ZeroAddress, // notifier set after executor deploy
    deployerAddr
  );
  await lpRebates.waitForDeployment();
  const lpRebatesAddr = await lpRebates.getAddress();
  console.log("✅ LPFlowRebates:", lpRebatesAddr);

  // 3) PayflowExecutor
  const Payflow = await ethers.getContractFactory(
      "contracts/payflow/ParagonPayflowExecutorv2.sol:ParagonPayflowExecutorV2"
  );
  const payflow = await Payflow.deploy(
    deployerAddr,
    ROUTER,
    bestExecAddr,
    TREASURY,      // daoVault
    lpRebatesAddr, // lp rebates sink
    TREASURY       // lockerVault for now
  );
  await payflow.waitForDeployment();
  const payflowAddr = await payflow.getAddress();
  console.log("✅ ParagonPayflowExecutorV2:", payflowAddr);

  // --------------------------------------------------
  // POST DEPLOY CONFIG
  // --------------------------------------------------

  // A) wire executor permissions
  await (await bestExec.setAuthorizedExecutor(payflowAddr, true)).wait();
  console.log("→ BestExecution authorized executor set");

  // B) wire LP rebates notifier
  await (await lpRebates.setNotifier(payflowAddr)).wait();
  console.log("→ LPFlowRebates notifier set");

  // C) reward tokens
  await (await lpRebates.addSupportedReward(XPGN)).wait();
  await (await lpRebates.addSupportedReward(USDT)).wait();
  await (await lpRebates.addSupportedReward(USDC)).wait();
  await (await lpRebates.addSupportedReward(WBNB)).wait();
  console.log("→ LP reward tokens added");

  // D) allowed LPs (new curated set)
  await (await lpRebates.setAllowedLp(PAIR_XPGN_USDT, true)).wait();
  await (await lpRebates.setAllowedLp(PAIR_XPGN_WBNB, true)).wait();
  await (await lpRebates.setAllowedLp(PAIR_WBNB_USDT, true)).wait();

  if (INCLUDE_USDT_USDC_REBATES) {
    await (await lpRebates.setAllowedLp(PAIR_USDT_USDC, true)).wait();
  }
  console.log("→ LP allowlist configured");

  // E) supported Shield tokens
  await (await payflow.setSupportedToken(XPGN, true)).wait();
  await (await payflow.setSupportedToken(USDT, true)).wait();
  await (await payflow.setSupportedToken(USDC, true)).wait();
  await (await payflow.setSupportedToken(WBNB, true)).wait();
  console.log("→ Shield supported tokens configured");

  // F) launch-safe fee settings
  await (await payflow.setSplitBips(6000, 3000)).wait(); // 60% trader, 30% LP, 10% locker
  await (await payflow.setRelayerFeeBips(0)).wait();     // keep 0 at launch
  console.log("→ Payflow split configured");

  // G) optional relayer setup
  const RELAYER_ADDRESS = opt("RELAYER_ADDRESS", "");
  if (RELAYER_ADDRESS) {
    await (await payflow.setRelayer(RELAYER_ADDRESS, true)).wait();
    console.log(`→ Relayer allowed: ${RELAYER_ADDRESS}`);
  }

  // --------------------------------------------------
  // OWNERSHIP HANDOFF
  // --------------------------------------------------
  if (deployerAddr.toLowerCase() !== DAO_MULTISIG.toLowerCase()) {
    await transferOwnershipIfPossible(bestExec, DAO_MULTISIG, "BestExecution");
    await transferOwnershipIfPossible(lpRebates, DAO_MULTISIG, "LPFlowRebates");
    await transferOwnershipIfPossible(payflow, DAO_MULTISIG, "PayflowExecutor");
    console.log("→ Ownership transferred to DAO_MULTISIG");
  }

  const allowedLPs = [
    PAIR_XPGN_USDT,
    PAIR_XPGN_WBNB,
    PAIR_WBNB_USDT,
    ...(INCLUDE_USDT_USDC_REBATES ? [PAIR_USDT_USDC] : []),
  ];

  const out = {
    network: hre.network.name,
    chainId: Number(network.chainId),
    deployer: deployerAddr,
    daoMultisig: DAO_MULTISIG,
    treasury: TREASURY,
    coreDeployFile: CORE_DEPLOY_FILE,
    addresses: {
      bestExecution: bestExecAddr,
      lpFlowRebates: lpRebatesAddr,
      payflowExecutor: payflowAddr,

      router: ROUTER,
      factory: FACTORY,
      xpgn: XPGN,
      usdt: USDT,
      usdc: USDC,
      wbnb: WBNB,

      pairXpgnUsdt: PAIR_XPGN_USDT,
      pairXpgnWbnb: PAIR_XPGN_WBNB,
      pairWbnbUsdt: PAIR_WBNB_USDT,
      pairUsdtUsdc: PAIR_USDT_USDC,
    },
    config: {
      daoVault: TREASURY,
      lockerVault: TREASURY,
      traderBips: 6000,
      lpBips: 3000,
      lockerBips: 1000,
      relayerFeeBips: 0,
      supportedShieldTokens: [XPGN, USDT, USDC, WBNB],
      allowedLPs,
      supportedRewardTokens: [XPGN, USDT, USDC, WBNB],
      includeUsdtUsdcRebates: INCLUDE_USDT_USDC_REBATES,
      relayerAddress: RELAYER_ADDRESS || null,
    },
  };

  await saveJSON(
    path.join(__dirname, "../deployments/payflow-bscTestnet-relaunch-v2.json"),
    out
  );

  console.log("");
  console.log("======================================================");
  console.log("Payflow relaunch complete");
  console.log("======================================================");
  console.log("BestExecution:", bestExecAddr);
  console.log("LPFlowRebates:", lpRebatesAddr);
  console.log("PayflowExecutor:", payflowAddr);
}
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
