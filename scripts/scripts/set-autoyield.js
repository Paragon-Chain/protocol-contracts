require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  const daoWallet = new ethers.Wallet(
    process.env.PRIVATE_KEY_DAO,
    ethers.provider
  );

  const farmAddr = "0x37DC937870eA5533FF540B9fC4A1FAF704A5EBE8";
  const routerAddr = "0x78FF892574863C9661e49F9D9D37ee94F556784C";
  const xpgnAddr = "0x900137F0CF7dD6933c2fB2245Fd4fAa15c01253A";

  const farm = await ethers.getContractAt("ParagonFarmController", farmAddr, daoWallet);
  const router = await ethers.getContractAt("ParagonRouter", routerAddr, daoWallet);

  const poolLength = await farm.poolLength();
  console.log("Pool length:", poolLength.toString());

  const pool1 = await farm.poolInfo(1);
  const lpTokenPid1 = pool1.lpToken || pool1[0];

  console.log("PID1 lpToken:", lpTokenPid1);
  console.log("Expected XPGN:", xpgnAddr);

  if (lpTokenPid1.toLowerCase() !== xpgnAddr.toLowerCase()) {
    throw new Error("PID1 is not XPGN single stake");
  }

  console.log("Router autoYieldPid before:", (await router.autoYieldPid()).toString());
  console.log("Router autoYieldEnabled before:", await router.autoYieldEnabled());

  const tx = await router.setAutoYieldConfig(1, true);
  await tx.wait();

  console.log("Router autoYieldPid after:", (await router.autoYieldPid()).toString());
  console.log("Router autoYieldEnabled after:", await router.autoYieldEnabled());
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });