require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;

function req(name) {
  const v = process.env[name];
  if (!v || v === "") throw new Error(`Missing env var: ${name}`);
  return v;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();
  const network = await ethers.provider.getNetwork();

  const OWNER = req("DAO_MULTISIG");
  const USAGE_POINTS = req("NEXT_PUBLIC_USAGE_POINTS");

  console.log("========================================");
  console.log("Deploy Usage Adapters");
  console.log("========================================");
  console.log("Network:", hre.network.name, `(${network.chainId})`);
  console.log("Deployer:", deployerAddr);
  console.log("Owner:", OWNER);
  console.log("UsagePoints:", USAGE_POINTS);
  console.log("");

  const Base = await ethers.getContractFactory("LiquidityUsageAdapter");
  const liquidityAdapter = await Base.deploy(OWNER, USAGE_POINTS);
  await liquidityAdapter.waitForDeployment();
  const liquidityAdapterAddr = await liquidityAdapter.getAddress();

  console.log("✅ LiquidityUsageAdapter:", liquidityAdapterAddr);

  const Farm = await ethers.getContractFactory("FarmUsageAdapter");
  const farmAdapter = await Farm.deploy(OWNER, USAGE_POINTS);
  await farmAdapter.waitForDeployment();
  const farmAdapterAddr = await farmAdapter.getAddress();

  console.log("✅ FarmUsageAdapter:", farmAdapterAddr);

  console.log("");
  console.log("Next required setup:");
  console.log(`1) UsagePoints.setCaller(${liquidityAdapterAddr}, true)`);
  console.log(`2) UsagePoints.setCaller(${farmAdapterAddr}, true)`);
  console.log(`3) LiquidityUsageAdapter.setSigner(<backendSigner>, true)`);
  console.log(`4) FarmUsageAdapter.setSigner(<backendSigner>, true)`);
  console.log("");

  const out = {
    network: hre.network.name,
    chainId: Number(network.chainId),
    deployer: deployerAddr,
    owner: OWNER,
    usagePoints: USAGE_POINTS,
    addresses: {
      liquidityUsageAdapter: liquidityAdapterAddr,
      farmUsageAdapter: farmAdapterAddr,
    },
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});