// scripts/farm.smoke.js
require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;
const { loadDeployment, fmt, ensureTestnet } = require("./_utils");

/**
 * Minimal farm smoke test:
 *  - Reads poolLength
 *  - For pid=0 (by default), prints pool token and pending reward for caller
 *  - If AUTO_DEPOSIT=1 and token is mintable mock, deposits tiny amount and harvests
 *
 * Usage:
 *  PID=0 AUTO_DEPOSIT=0 npx hardhat run scripts/farm.smoke.js --network bscTestnet
 */
async function main() {
  await ensureTestnet();
  const [you] = await ethers.getSigners();
  const rec = loadDeployment();

  if (!rec.farms || !rec.farms.controller) {
    console.log("ℹ️ Farm not configured in deployments JSON; skipping.");
    return;
  }
  const farmAddr = rec.farms.controller;
  const farm = (await ethers.getContractFactory("ParagonFarmController")).attach(farmAddr);
  const pid = Number(process.env.PID || "0");

  const length = await farm.poolLength();
  console.log("poolLength:", length.toString());
  if (pid >= Number(length)) throw new Error(`PID ${pid} >= poolLength ${length}`);

  // Try poolLpToken(pid) first; fallback to pools(pid) struct
  let lpToken;
  try {
    lpToken = await farm.poolLpToken(pid);
  } catch {
    console.log("poolLpToken(pid) not exposed; attempting pools mapping…");
    const poolInfo = await farm.pools(pid);
    lpToken = poolInfo.lpToken || poolInfo.stakeToken || ethers.ZeroAddress;
  }
  console.log(`PID ${pid} LP/stake token:`, lpToken);

  const pending = await farm.pendingReward(pid, await you.getAddress()).catch(() => 0n);
  console.log("pendingReward:", fmt(pending));

  if (process.env.AUTO_DEPOSIT === "1" && lpToken !== ethers.ZeroAddress) {
    const lp = await ethers.getContractAt("IParagonERC20", lpToken);
    const bal = await lp.balanceOf(you);
    if (bal === 0n) {
      console.log("No LP balance. Skipping deposit.");
      return;
    }
    const amt = bal / 1000n; // 0.1% of balance
    await (await lp.approve(farmAddr, amt)).wait();
    await (await farm.deposit(pid, amt)).wait();
    console.log("✅ Deposited tiny LP amount.");
    await (await farm.harvest(pid)).wait().catch(() => {});
    console.log("✅ Harvest attempted.");
  }
}

main().catch((e) => {
  console.error("❌ farm.smoke failed:", e);
  process.exit(1);
});
