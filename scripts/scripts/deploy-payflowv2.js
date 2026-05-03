/* scripts/deploy-payflow.js */
const { ethers } = require("hardhat");

// ---------- CORE ON BSC TESTNET ----------
const FACTORY  = "0x30001867632d8cb2b4657cea583ef61d11728e1d";
const ROUTER   = "0x699628d2bd86c53843db5eecf2b9b666cfcced95";
const XPGN     = "0x71e8af3248a35c8fff534b3790e6060f6fe1899e";
const STXPGN   = "0x80f80be842edc7c0f0f51f5384b574b9eb3dbc06";

// tokens allowed for LockerCollector
const USDT     = "0x6ef1f996008b0ef1f29aa1bf67c59747713f760d";
const USDC     = "0xd786fe32daf619fb772daedce24eb66a8e48b3c2";
const WBNB     = "0xd81437b6f0f9b7de37bf8092f68b550a39594801";

// ---------- DAO / TREASURY / REPUTATION ----------
const DAO_MSIG            = "0x2a8599025329e46410F79fc9ca6bdCdF91625532";
const TREASURY            = "0xbcC8F34b881685e37B0ceC19351D69635b49df4a";
const REPUTATION          = "0xf3e320ff44e17bf26728ba46874bfd11712cbc70";
const REPUTATION_OPERATOR = "0xfbb28c1e74ec70b1525f1f58a8533560bca8322d";

// TreasurySplitter sinks (60 / 35 / 5)
const SINK_60 = TREASURY;
const SINK_35 = TREASURY;
const SINK_05 = DAO_MSIG;

const ZERO = "0x0000000000000000000000000000000000000000";

// ---------- OPTIONAL TOGGLES ----------
const SET_RELAYER_FEE_BPS = 0; // e.g. 5 = 0.05% (kept 0)
const USD_VALUER = ZERO;       // plug valuer address if you have one, else ZERO

// ---------- REDEPLOY OR REUSE? ----------
// Put ZERO to deploy fresh. Put an address to reuse an existing one.
let BESTEXEC   = ZERO; // ParagonBestExecutionV14
let EXECUTOR   = ZERO; // ParagonPayflowExecutorV2
let LPREBATES  = ZERO; // LPFlowRebates
let LOCKER     = ZERO; // ParagonLockerCollector
let SPLITTER   = ZERO; // TreasurySplitter

const NAMES = {
  LPREBATES: "LPFlowRebates",
  LOCKER: "ParagonLockerCollector",
  SPLITTER: "TreasurySplitter",
  BESTEXEC: "ParagonBestExecutionV14",  // <- keep this consistent
  EXECUTOR: "ParagonPayflowExecutorV2",
};

async function waitDeployed(c) {
  if (c.waitForDeployment) { await c.waitForDeployment(); return await c.getAddress(); } // ethers v6
  await c.deployed(); return c.address; // ethers v5
}

async function maybeDeploy(name, args, existing) {
  if (existing && existing.toLowerCase() !== ZERO) {
    console.log(`✓ ${name} exists @ ${existing}`);
    return existing;
  }
  const F = await ethers.getContractFactory(name);
  const c = await F.deploy(...args);
  const addr = await waitDeployed(c);
  console.log(`+ Deployed ${name} @ ${addr}`);
  return addr;
}

async function transferIfNeeded(name, addr, deployer, label = name) {
  try {
    const C = await ethers.getContractAt(name, addr);
    // Check if owner() exists in ABI (vague ABIs would still throw in call)
    if (!C.interface || !C.interface.getFunction) throw new Error("No interface");
    try { C.interface.getFunction("owner"); } catch { return; } // not Ownable

    const owner = await C.owner();
    if (owner.toLowerCase() !== DAO_MSIG.toLowerCase()) {
      const tx = await C.connect(deployer).transferOwnership(DAO_MSIG);
      await tx.wait();
      console.log(`✓ ${label}.transferOwnership(${DAO_MSIG})`);
      console.log(`  👉 If it's Ownable2Step, DAO must call acceptOwnership()`);
    }
  } catch (e) {
    console.log(`ℹ︎ ${label} ownership transfer skipped: ${e.message || e}`);
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);

  // 1) LPFlowRebates — TEMP OWNER = DEPLOYER (so we can set notifier)
  // constructor(address _factory, address _notifier, address _owner)
  LPREBATES = await maybeDeploy(NAMES.LPREBATES, [FACTORY, ZERO, deployer.address], LPREBATES);

  // 2) LockerCollector — TEMP OWNER = DEPLOYER (so we can set allowedTokens now)
  // constructor(address _router, address _stxpgnVault, address _receiver, address initialOwner)
  LOCKER = await maybeDeploy(NAMES.LOCKER, [ROUTER, STXPGN, SINK_60, deployer.address], LOCKER);

  // Allow harvest tokens
  {
    const L = await ethers.getContractAt(NAMES.LOCKER, LOCKER);
    const allow = async (token) => {
      try {
        const ok = await L.allowedToken(token);
        if (!ok) { const tx = await L.connect(deployer).setAllowedToken(token, true); await tx.wait(); }
        console.log(`✓ Locker: allowed ${token}`);
      } catch (e) {
        console.log(`ℹ︎ Locker.allow(${token}) skipped: ${e.message || e}`);
      }
    };
    await allow(XPGN); await allow(USDT); await allow(USDC); await allow(WBNB);
  }

  // 3) TreasurySplitter — TEMP OWNER = DEPLOYER
  // constructor(address _owner, address _sink60, address _sink35, address _sink05)
  SPLITTER = await maybeDeploy(NAMES.SPLITTER, [deployer.address, SINK_60, SINK_35, SINK_05], SPLITTER);

  // 4) BestExec v14 — TEMP OWNER = DEPLOYER
  BESTEXEC = await maybeDeploy(NAMES.BESTEXEC, [deployer.address], BESTEXEC);

  // 5) Payflow Executor V2 — TEMP OWNER = DEPLOYER
  // constructor(address initialOwner, address _router, address _bestExec, address _daoVault, address _lpRebates, address _lockerVault)
  EXECUTOR = await maybeDeploy(
    NAMES.EXECUTOR,
    [deployer.address, ROUTER, BESTEXEC, SPLITTER, LPREBATES, LOCKER],
    EXECUTOR
  );

  // ---------- Post-deploy wiring (OWNER = DEPLOYER during setup) ----------

  // LPFlowRebates: notifier = EXECUTOR
  try {
    const R = await ethers.getContractAt(NAMES.LPREBATES, LPREBATES);
    const tx = await R.connect(deployer).setNotifier(EXECUTOR);
    await tx.wait();
    console.log(`✓ LPFlowRebates.setNotifier(${EXECUTOR})`);
  } catch (e) {
    console.log(`ℹ︎ setNotifier skipped: ${e.message || e}`);
  }

  // (Optional) addSupportedReward(XPGN) if present
  try {
    const R = await ethers.getContractAt(NAMES.LPREBATES, LPREBATES);
    try {
      const current = await R.getSupportedRewardTokens();
      const hasX = (current || []).map((a) => a.toLowerCase()).includes(XPGN.toLowerCase());
      if (!hasX) {
        const tx = await R.connect(deployer).addSupportedReward(XPGN);
        await tx.wait();
        console.log(`✓ LPFlowRebates: XPGN supported reward`);
      } else {
        console.log(`✓ LPFlowRebates: XPGN already supported`);
      }
    } catch {
      console.log(`ℹ︎ LPFlowRebates version has no reward-list (skipped)`);
    }
  } catch (e) {
    console.log(`ℹ︎ addSupportedReward skipped: ${e.message || e}`);
  }

  // Executor: split bips (trader 60%, LP 30%), params (protocolFeeBips=0)
  try {
    const E = await ethers.getContractAt(NAMES.EXECUTOR, EXECUTOR);
    let tx = await E.connect(deployer).setSplitBips(6000, 3000); await tx.wait();
    console.log(`✓ Executor.setSplitBips(6000, 3000)`);
    tx = await E.connect(deployer).setParams(ROUTER, BESTEXEC, SPLITTER, LPREBATES, LOCKER, 0); await tx.wait();
    console.log(`✓ Executor.setParams(router,bestexec,splitter,lpRebates,locker,0)`);
    if (SET_RELAYER_FEE_BPS > 0) {
      tx = await E.connect(deployer).setRelayerFeeBips(SET_RELAYER_FEE_BPS); await tx.wait();
      console.log(`✓ Executor.setRelayerFeeBips(${SET_RELAYER_FEE_BPS})`);
    }
    if (USD_VALUER !== ZERO) {
      tx = await E.connect(deployer).setUsdValuer(USD_VALUER); await tx.wait();
      console.log(`✓ Executor.setUsdValuer(${USD_VALUER})`);
    }
  } catch (e) {
    console.log(`ℹ︎ executor param wiring skipped: ${e.message || e}`);
  }

  // Executor: wire ReputationOperator (optional but recommended)
  try {
    const E = await ethers.getContractAt(NAMES.EXECUTOR, EXECUTOR);
    const tx = await E.connect(deployer).setReputationOperator(REPUTATION_OPERATOR);
    await tx.wait();
    console.log(`✓ Executor.setReputationOperator(${REPUTATION_OPERATOR})`);
  } catch (e) {
    console.log(`ℹ︎ setReputationOperator skipped: ${e.message || e}`);
  }

  // Reputation: grant operator to ReputationOperator (owner of Reputation must do this)
  try {
    const Rep = await ethers.getContractAt("ParagonReputation", REPUTATION);
    const tx = await Rep.connect(deployer).setOperator(REPUTATION_OPERATOR, true);
    await tx.wait();
    console.log(`✓ ParagonReputation.setOperator(REPUTATION_OPERATOR,true)`);
  } catch (e) {
    console.log(`ℹ︎ Reputation operator grant skipped (maybe already set or deployer not owner): ${e.message || e}`);
  }

  // ---------- Hand over ownership to DAO ----------
  await transferIfNeeded(NAMES.LPREBATES, LPREBATES, deployer);
  await transferIfNeeded(NAMES.LOCKER,    LOCKER,    deployer, "Locker");
  await transferIfNeeded(NAMES.SPLITTER,  SPLITTER,  deployer);
  await transferIfNeeded(NAMES.BESTEXEC,  BESTEXEC,  deployer, "BestExec");
  await transferIfNeeded(NAMES.EXECUTOR,  EXECUTOR,  deployer, "Executor");

  console.log("\n=== Deployed / Wired ===");
  console.log(`LPFlowRebates     : ${LPREBATES}`);
  console.log(`LockerCollector   : ${LOCKER}`);
  console.log(`TreasurySplitter  : ${SPLITTER}`);
  console.log(`BestExec          : ${BESTEXEC}`);
  console.log(`PayflowExecutorV2 : ${EXECUTOR}`);
  console.log(`Reputation        : ${REPUTATION}`);
  console.log(`RepOperator       : ${REPUTATION_OPERATOR}`);
  if (SET_RELAYER_FEE_BPS > 0) console.log(`RelayerFeeBps     : ${SET_RELAYER_FEE_BPS}`);
  if (USD_VALUER !== ZERO)     console.log(`UsdValuer         : ${USD_VALUER}`);
  console.log("\n✅ Done. If any contract uses Ownable2Step, have the DAO call acceptOwnership().");
}

main().catch((e) => { console.error(e); process.exit(1); });
