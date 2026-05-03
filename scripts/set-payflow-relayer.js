require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;

function req(name) {
  const v = process.env[name];
  if (!v || v === "") throw new Error(`Missing env var: ${name}`);
  return v;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const PAYFLOW_EXECUTOR = req("PAYFLOW_EXECUTOR");
  const RELAYER_ADDRESS = req("RELAYER_ADDRESS");
  const DAO_MULTISIG = req("DAO_MULTISIG");
  const PRIVATE_KEY_DAO = req("PRIVATE_KEY_DAO");

  const signer = new ethers.Wallet(PRIVATE_KEY_DAO, ethers.provider);
  const signerAddr = await signer.getAddress();

  console.log("Signer:", signerAddr);

  const payflow = await ethers.getContractAt(
    "ParagonPayflowExecutorV2",
    PAYFLOW_EXECUTOR,
    signer
  );

  console.log("Owner:", await payflow.owner());
  console.log("Before:", await payflow.isRelayer(RELAYER_ADDRESS));

  const tx = await payflow.setRelayer(RELAYER_ADDRESS, true);
  console.log("Tx submitted:", tx.hash);

  const receipt = await tx.wait();
  console.log("Receipt status:", receipt.status);
  console.log("Block:", receipt.blockNumber);

  for (let i = 0; i < 8; i++) {
    const allowed = await payflow.isRelayer(RELAYER_ADDRESS);
    console.log(`Check ${i + 1}:`, allowed);
    if (allowed) {
      console.log("✅ Relayer allowed: true");
      return;
    }
    await sleep(2000);
  }

  console.log("⚠️ Still reading false after retries. Likely stale RPC or wrong contract/env.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });