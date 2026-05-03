/* eslint-disable no-console */
require("dotenv").config();
const { writeFileSync, mkdirSync, existsSync, readFileSync } = require("fs");
const { join } = require("path");
const { ethers, network, run } = require("hardhat");

const ABI_ROUTER_MIN = [
  "function factory() view returns (address)",
  "function WNative() view returns (address)",
  "function protocolFeeBps() view returns (uint256)",
  "function feeRecipient() view returns (address)",
];

function isAddr(a) { return !!a && /^0x[a-fA-F0-9]{40}$/.test(a); }
function needAddr(a, name) {
  if (!isAddr(a)) throw new Error(`Missing/invalid ${name}`);
  return a;
}
const gwei = (x) => (x ? ethers.parseUnits(String(x), "gwei") : undefined);

async function main() {
  const ROUTER = needAddr(process.env.ROUTER_ADDR, "ROUTER_ADDR");
  const FARM   = needAddr(process.env.FARM_ADDR, "FARM_ADDR");
  const FALLBACK_FEE_RECIPIENT = needAddr(process.env.FALLBACK_FEE_RECIPIENT, "FALLBACK_FEE_RECIPIENT");

  const [deployer] = await ethers.getSigners();
  const chain = await ethers.provider.getNetwork();

  console.log(`\n▶ Deploying ParagonZapV2`);
  console.log(`Network     : ${network.name} (chainId ${chain.chainId})`);
  console.log(`Deployer    : ${deployer.address}`);
  console.log(`Router      : ${ROUTER}`);
  console.log(`Farm        : ${FARM}`);
  console.log(`FallbackFee : ${FALLBACK_FEE_RECIPIENT}\n`);

  // Basic code checks
  const [routerCode, farmCode, feeCode] = await Promise.all([
    ethers.provider.getCode(ROUTER),
    ethers.provider.getCode(FARM),
    ethers.provider.getCode(FALLBACK_FEE_RECIPIENT),
  ]);
  if (routerCode === "0x") throw new Error("ROUTER_ADDR has no code.");
  if (farmCode === "0x") console.warn("⚠️  FARM_ADDR has no code (ok only if it will be deployed soon).");
  if (feeCode && feeCode !== "0x") throw new Error("FALLBACK_FEE_RECIPIENT must be an EOA.");

  // Router sanity reads (must succeed for WNative & factory)
  const router = new ethers.Contract(ROUTER, ABI_ROUTER_MIN, ethers.provider);
  try {
    const [factory, wnative, rBps, rSink] = await Promise.all([
      router.factory(),
      router.WNative(),
      router.protocolFeeBps().catch(() => null),
      router.feeRecipient().catch(() => null),
    ]);
    console.log(`Factory     : ${factory}`);
    console.log(`WNative     : ${wnative}`);
    if (rBps !== null)  console.log(`Router Fee  : ${rBps} bps`);
    if (rSink !== null) console.log(`Router Sink : ${rSink}`);
    console.log("");
  } catch (e) {
    console.error("❌ Router preflight failed (WNative/factory call):", e?.shortMessage || e?.message || e);
    process.exit(1);
  }

  const overrides = {};
  if (process.env.GAS_PRICE_GWEI) overrides.gasPrice = gwei(process.env.GAS_PRICE_GWEI);

  console.log("Deploying…");
  const Zap = await ethers.getContractFactory("ParagonZapV2");
  const zap = await Zap.deploy(ROUTER, FARM, FALLBACK_FEE_RECIPIENT, overrides);
  await zap.waitForDeployment();
  const zapAddr = await zap.getAddress();
  console.log(`\n✅ ParagonZapV2 deployed at: ${zapAddr}`);

  // Save deployment info
  const outDir = join(process.cwd(), "deployments");
  const file = join(outDir, `${network.name}.json`);
  mkdirSync(outDir, { recursive: true });
  const prev = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  prev.ParagonZapV2 = {
    address: zapAddr,
    constructorArgs: [ROUTER, FARM, FALLBACK_FEE_RECIPIENT],
    chainId: Number(chain.chainId),
    deployedAt: new Date().toISOString(),
  };
  writeFileSync(file, JSON.stringify(prev, null, 2));
  console.log(`Saved deployment to: ${file}`);

  // Optional verify
  if (process.env.BSCSCAN_API_KEY) {
    console.log("\nVerifying on BscScan…");
    try {
      await run("verify:verify", {
        address: zapAddr,
        constructorArguments: [ROUTER, FARM, FALLBACK_FEE_RECIPIENT],
        // contract: "contracts/ParagonZapV2.sol:ParagonZapV2",
      });
      console.log("Verification submitted.");
    } catch (e) {
      console.warn("Verification skipped/failed:", e?.message || e);
    }
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
