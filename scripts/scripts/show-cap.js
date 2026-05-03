const hre = require("hardhat");
const { ethers } = hre;
const CAP = "0x2C11a10ccEa57BD86B9655445D8c426dd3218bCd";

async function main() {
  const [me] = await ethers.getSigners();
  const cap = await ethers.getContractAt("GlobalCapController", CAP);
  const [idx, start, end, capAmt, allowlistOnly] = await cap.currentPhase();
  const rem = await cap.remaining(me.address);
  console.log({ idx: idx.toString(), start: start.toString(), end: end.toString(), cap: capAmt.toString(), allowlistOnly, remaining: rem.toString() });
}
main().catch((e)=>{ console.error(e); process.exit(1); });
