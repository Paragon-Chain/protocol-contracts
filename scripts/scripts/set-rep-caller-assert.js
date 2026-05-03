const { ethers } = require("hardhat");

const REP_OP = "0xfbb28c1e74ec70b1525f1f58a8533560bca8322d";
const EXEC   = "0xdF6E3aE41f5Aa4f3Ca4b4781d7D23a583e0Ad965";

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("Signer:", signer.address);

  const op = await ethers.getContractAt("ReputationOperator", REP_OP, signer);
  const owner = await op.owner();
  console.log("Owner:", owner);
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error("Signer is NOT the owner.");
  }

  console.log("Before:", await op.callers(EXEC));
  await op.callStatic.setCaller(EXEC, true); // will throw if would revert

  const tx = await op.setCaller(EXEC, true);
  console.log("tx:", tx.hash);
  const rcpt = await tx.wait();
  if (rcpt.status !== 1) throw new Error("Transaction reverted.");

  const after = await op.callers(EXEC);
  console.log("After:", after);
  if (!after) throw new Error("State not updated; check address/network.");
}

main().catch((e) => { console.error(e); process.exit(1); });
