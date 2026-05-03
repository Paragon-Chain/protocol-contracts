const { ethers } = require("hardhat");

// === fill in exactly these addresses ===
const REP_OP   = "0xfbb28c1e74ec70b1525f1f58a8533560bca8322d"; // ReputationOperator
const EXECUTOR = "0xdF6E3aE41f5Aa4f3Ca4b4781d7D23a583e0Ad965"; // ParagonPayflowExecutorV2

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("Using signer:", signer.address);

  const op = await ethers.getContractAt("ReputationOperator", REP_OP, signer);
  const owner = await op.owner();
  console.log("RepOperator.owner:", owner);

  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error("This signer is NOT the owner. Use the owner wallet or submit via your multisig.");
  }

  const before = await op.callers(EXECUTOR);
  console.log("Before callers[EXECUTOR]:", before);

  if (!before) {
    const tx = await op.setCaller(EXECUTOR, true);
    console.log("tx:", tx.hash);
    await tx.wait();
  }

  const after = await op.callers(EXECUTOR);
  console.log("After callers[EXECUTOR]:", after);
}

main().catch((e) => { console.error(e); process.exit(1); });
