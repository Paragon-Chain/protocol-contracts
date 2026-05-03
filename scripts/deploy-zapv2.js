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

async function saveJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
  console.log(`✔ Saved → ${file}`);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();
  const network = await ethers.provider.getNetwork();

  const ROUTER = req("ROUTER_ADDR");
  const FARM = req("FARM_ADDR");
  const FEE_TO = req("FEE_TO");
  const DAO_MULTISIG = req("DAO_MULTISIG");

  console.log("Network:", hre.network.name, `(${network.chainId})`);
  console.log("Deployer:", deployerAddr);
  console.log("Router:", ROUTER);
  console.log("Farm:", FARM);
  console.log("Fee recipient:", FEE_TO);
  console.log("DAO Multisig:", DAO_MULTISIG);

  const Zap = await ethers.getContractFactory("ParagonZapV2");
  const zap = await Zap.deploy(ROUTER, FARM, FEE_TO);
  await zap.waitForDeployment();

  const zapAddr = await zap.getAddress();
  console.log("✅ ParagonZapV2:", zapAddr);

  // Optional: transfer ownership to DAO after deploy
  if (deployerAddr.toLowerCase() !== DAO_MULTISIG.toLowerCase()) {
    await (await zap.transferOwnership(DAO_MULTISIG)).wait();
    console.log("→ Zap ownership transferred to DAO multisig");
  }

  const outFile = path.join(__dirname, "../deployments", `${hre.network.name}-zap.json`);
  await saveJSON(outFile, {
    network: hre.network.name,
    chainId: Number(network.chainId),
    deployer: deployerAddr,
    daoMultisig: DAO_MULTISIG,
    addresses: {
      zapV2: zapAddr,
      router: ROUTER,
      farm: FARM,
      feeRecipient: FEE_TO
    }
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });