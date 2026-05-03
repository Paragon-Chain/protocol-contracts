/* scripts/deploy-usage-rewards.js */
require("dotenv").config();
const { ethers } = require("hardhat");

const ZERO = "0x0000000000000000000000000000000000000000";

// ────────────────────────────────────────────────────────────────────────────────
// Config (env is optional; sane defaults below)
// ────────────────────────────────────────────────────────────────────────────────
const XPGN         = (process.env.XPGN || "0x71e8af3248a35c8fff534b3790e6060f6fe1899e").trim();
let   VEXPGN       = (process.env.VEXPGN || "").trim();           // leave blank to auto-deploy
const EXECUTOR_V2  = (process.env.EXECUTOR_V2 || "0x03e35a58cDf97c59dbD845E18b2a7c044667151B").trim();

// If your ve supports Solidly-style create_lock_for(uint256,uint256,address)
const USE_SOLIDLY_ORDER = String(process.env.USE_SOLIDLY_ORDER || "false").toLowerCase() === "true";

// Gas controls for BSC-style RPCs (legacy gas to avoid EIP-1559 issues)
const GAS_STRATEGY = String(process.env.GAS_STRATEGY || "legacy").toLowerCase(); // "legacy" | "eip1559"
const MIN_GWEI     = Number(process.env.MIN_GWEI || "3"); // floor 3 gwei by default
const TX_OVERRIDES = GAS_STRATEGY === "legacy"
  ? { gasPrice: BigInt(Math.max(1, MIN_GWEI)) * 10n ** 9n }
  : {}; // if you ever switch to EIP-1559, add { maxFeePerGas, maxPriorityFeePerGas }

// ────────────────────────────────────────────────────────────────────────────────

async function waitDeployed(c) {
  if (c.waitForDeployment) {
    await c.waitForDeployment();
    return await c.getAddress();
  }
  await c.deployed();
  return c.address;
}

async function deployVeIfMissing(xpgnAddr, ownerAddr) {
  if (VEXPGN && VEXPGN !== ZERO) {
    console.log(`Using existing veXPGN @ ${VEXPGN}`);
    return VEXPGN;
  }
  console.log("~ Deploying VoterEscrow (owner = deployer)...");
  const VoterEscrow = await ethers.getContractFactory("VoterEscrow");
  // constructor(address _token, address initialOwner)
  const ve = await VoterEscrow.deploy(xpgnAddr, ownerAddr, TX_OVERRIDES);
  VEXPGN = await waitDeployed(ve);
  console.log(`+ veXPGN @ ${VEXPGN}`);
  return VEXPGN;
}

async function wireExecutorIfProvided(execAddr, usageAddr, lockerAddr) {
  if (!execAddr || execAddr === ZERO) {
    console.log("No EXECUTOR_V2 provided — skipping executor wiring.");
    return;
  }

  console.log(`~ Wiring ExecutorV2 @ ${execAddr}`);
  const exec = await ethers.getContractAt("ParagonPayflowExecutorV2", execAddr);

  // 1) set reputation operator -> UsagePoints (this overwrites prior operator)
  try {
    const tx = await exec.setReputationOperator(usageAddr, TX_OVERRIDES);
    console.log("setReputationOperator tx:", tx.hash);
    await tx.wait();
    console.log(`✓ ExecutorV2.setReputationOperator(${usageAddr})`);
  } catch (e) {
    console.log("ℹ︎ setReputationOperator skipped:", e.message || e);
  }

  // 2) allow executor to push usage
  try {
    const U = await ethers.getContractAt("UsagePoints", usageAddr);
    const tx = await U.setCaller(execAddr, true, TX_OVERRIDES);
    console.log("UsagePoints.setCaller tx:", tx.hash);
    await tx.wait();
    console.log(`✓ UsagePoints.setCaller(${execAddr}, true)`);
  } catch (e) {
    console.log("ℹ︎ UsagePoints.setCaller skipped:", e.message || e);
  }

  // 3) ensure lockerVault points to our new locker
  try {
    const currentLocker = await exec.lockerVault();
    if (currentLocker.toLowerCase() !== lockerAddr.toLowerCase()) {
      const params = {
        router:           await exec.router(),
        bestExec:         await exec.bestExec(),
        daoVault:         await exec.daoVault(),
        lpRebates:        await exec.lpRebates(),
        protocolFeeBips:  await exec.protocolFeeBips(),
      };
      const tx = await exec.setParams(
        params.router,
        params.bestExec,
        params.daoVault,
        params.lpRebates,
        lockerAddr,
        params.protocolFeeBips,
        TX_OVERRIDES
      );
      console.log("ExecutorV2.setParams (lockerVault) tx:", tx.hash);
      await tx.wait();
      console.log(`✓ ExecutorV2.setParams(..., lockerVault=${lockerAddr}, ...)`);
    } else {
      console.log("• Executor lockerVault already set — no change.");
    }
  } catch (e) {
    console.log("ℹ︎ Executor.setParams (locker) skipped:", e.message || e);
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  if (!XPGN || XPGN === ZERO) {
    throw new Error("❌ XPGN must be set (existing token address).");
  }

  // Owner is the deployer (no DAO multisig yet)
  const OWNER = deployer.address;

  // 0) veXPGN
  const veAddr = await deployVeIfMissing(XPGN, OWNER);

  // 1) UsagePoints (owner = deployer)
  console.log("~ Deploying UsagePoints (owner = deployer)...");
  const UsagePoints = await ethers.getContractFactory("UsagePoints");
  const usage = await UsagePoints.deploy(OWNER, TX_OVERRIDES);
  const USAGE_ADDR = await waitDeployed(usage);
  console.log(`+ UsagePoints @ ${USAGE_ADDR}`);

  // 2) TraderRewardsLocker (owner = deployer)
  console.log("~ Deploying TraderRewardsLocker (owner = deployer)...");
  const TraderRewardsLocker = await ethers.getContractFactory("TraderRewardsLocker");
  // constructor(address initialOwner, address _rewardToken, address _usagePoints, address _ve, bool solidlyOrder)
  const locker = await TraderRewardsLocker.deploy(
    OWNER,
    XPGN,
    USAGE_ADDR,
    veAddr,
    USE_SOLIDLY_ORDER,
    TX_OVERRIDES
  );
  const LOCKER_ADDR = await waitDeployed(locker);
  console.log(`+ TraderRewardsLocker @ ${LOCKER_ADDR}`);

  // 3) Wire executor (if provided)
  await wireExecutorIfProvided(EXECUTOR_V2, USAGE_ADDR, LOCKER_ADDR);

  // 4) Optional: set knobs on UsagePoints (owner = deployer)
  // Example: weightVolBips=100%, weightSavedBips=200%, dailyCap=100k points
  try {
    const U = await ethers.getContractAt("UsagePoints", USAGE_ADDR);
    let tx = await U.setWeights(10_000, 20_000, TX_OVERRIDES);
    console.log("UsagePoints.setWeights tx:", tx.hash);
    await tx.wait();
    tx = await U.setDailyCap(100_000n * 10n ** 18n, TX_OVERRIDES);
    console.log("UsagePoints.setDailyCap tx:", tx.hash);
    await tx.wait();
    console.log("✓ UsagePoints knobs set (weights + dailyCap)");
  } catch (e) {
    console.log("ℹ︎ set knobs skipped:", e.message || e);
  }

  console.log("\n=== Deployed / Wired (owner = deployer) ===");
  console.log(`XPGN               : ${XPGN}`);
  console.log(`veXPGN             : ${veAddr}`);
  console.log(`UsagePoints        : ${USAGE_ADDR}`);
  console.log(`TraderRewardsLocker: ${LOCKER_ADDR}`);
  console.log(`ExecutorV2         : ${EXECUTOR_V2 || "(none)"}`);
  console.log("\nNext:");
  console.log("• Fund weekly budgets via TraderRewardsLocker.notifyRewardAmount(epochWeekTs, amount)");
  console.log("• Frontend can read UsagePoints + veXPGN to visualize usage/locks.");
}

main().catch((e) => { console.error(e); process.exit(1); });
