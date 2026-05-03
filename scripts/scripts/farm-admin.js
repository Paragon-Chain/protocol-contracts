const hre = require("hardhat");
const { ethers } = hre;

async function main() {

  const daoWallet = new ethers.Wallet(
    process.env.PRIVATE_KEY_DAO,
    ethers.provider
  );

  console.log("DAO signer:", daoWallet.address);

  const farmAddr = "0x37DC937870eA5533FF540B9fC4A1FAF704A5EBE8";
  const routerAddr = "0x78FF892574863C9661e49F9D9D37ee94F556784C";
  const xpgnAddr = "0x900137F0CF7dD6933c2fB2245Fd4fAa15c01253A";

  const farm = await ethers.getContractAt(
    "ParagonFarmController",
    farmAddr,
    daoWallet
  );

  const router = await ethers.getContractAt(
    "ParagonRouter",
    routerAddr,
    daoWallet
  );

  const beforeLen = await farm.poolLength();
  console.log("Pool length before:", beforeLen.toString());

  // add XPGN pool
  await (await farm.addPool(1000, xpgnAddr, 0)).wait();

  const afterLen = await farm.poolLength();
  const pid = Number(afterLen) - 1;

  console.log("Added XPGN pool PID:", pid);

  // allow router auto-yield
  await (await farm.setAutoYieldCaller(routerAddr, true)).wait();
  console.log("Router allowed for auto yield");

  // configure router
  await (await router.setAutoYieldConfig(pid, true)).wait();
  console.log("Router auto yield configured");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });