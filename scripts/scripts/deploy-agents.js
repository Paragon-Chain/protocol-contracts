// scripts/deploy-agents.js
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);

  // REQUIRED: set these in your .env or edit directly here
  const XPGN = process.env.XPGN_ADDRESS;
  const TREASURY = process.env.TREASURY_ADDRESS;
  const PROTOCOL_FEE_BPS = Number(process.env.PROTOCOL_FEE_BPS || "300"); // 3% default
  const BASE_URI = process.env.AGENT_BASE_URI || "ipfs://agent-templates/{id}.json";

  const ROUTER = process.env.ROUTER_ADDRESS;
  const FARM = process.env.FARM_ADDRESS;
  const REWARD = process.env.REWARD_TOKEN_ADDRESS; // XPGN usually

  if (!XPGN || !TREASURY) throw new Error("Missing XPGN_ADDRESS or TREASURY_ADDRESS");
  if (!ROUTER || !FARM || !REWARD) throw new Error("Missing ROUTER_ADDRESS / FARM_ADDRESS / REWARD_TOKEN_ADDRESS");

  // 1) Registry
  const Registry = await hre.ethers.getContractFactory("AgentRegistry");
  const registry = await Registry.deploy();
  await registry.waitForDeployment();
  console.log("AgentRegistry:", await registry.getAddress());

  // 2) Market
  const Market = await hre.ethers.getContractFactory("AgentMarket");
  const market = await Market.deploy(XPGN, TREASURY, PROTOCOL_FEE_BPS, BASE_URI);
  await market.waitForDeployment();
  console.log("AgentMarket:", await market.getAddress());

  // 3) Executor
  const Exec = await hre.ethers.getContractFactory("AgentExecutorSimple");
  const exec = await Exec.deploy(
    await registry.getAddress(),
    await market.getAddress(),
    ROUTER,
    FARM,
    REWARD
  );
  await exec.waitForDeployment();
  console.log("AgentExecutorSimple:", await exec.getAddress());

  console.log("\nDone ✅");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
