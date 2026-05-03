// tasks/flash.js
const { task } = require("hardhat/config");

// Fully-qualified name is safest since the file is FlashEvent.sol but the contract is BettingPools
const FQN = "contracts/FlashEvent.sol:BettingPools";

task("flash:addToken", "Allow a betting token")
  .addParam("addr", "BettingPools/FlashEvents address")
  .addParam("token", "ERC20 address")
  .addParam("symbol", "UI symbol")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const c = await ethers.getContractAt(FQN, args.addr);
    const tx = await c.addAllowedToken(args.token, args.symbol);
    const rc = await tx.wait();
    console.log("✅ addAllowedToken tx:", rc.hash);
  });

task("flash:setDefault", "Set default betting token")
  .addParam("addr")
  .addParam("token")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const c = await ethers.getContractAt(FQN, args.addr);
    const tx = await c.setDefaultBettingToken(args.token);
    const rc = await tx.wait();
    console.log("✅ setDefaultBettingToken tx:", rc.hash);
  });

task("flash:create", "Create a pool")
  .addParam("addr")
  .addParam("title")
  .addParam("question")
  .addParam("category")
  .addParam("duration", "Seconds")
  .addOptionalParam("resolver", "Resolver", "0x0000000000000000000000000000000000000000")
  .addOptionalParam("fee", "Fee bps", "400")
  .addOptionalParam("min", "Min bet (raw units)", "1000000")
  .addOptionalParam("max", "Max bet (raw units)", "10000000000")
  .addOptionalParam("token", "Betting token override", "")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const c = await ethers.getContractAt(FQN, args.addr);
    const tx = await c.createPool(
      args.title,
      args.question,
      args.category,
      BigInt(args.duration),
      args.resolver,
      BigInt(args.fee),
      BigInt(args.min),
      BigInt(args.max),
      args.token && args.token !== "" ? args.token : "0x0000000000000000000000000000000000000000"
    );
    const rc = await tx.wait();
    console.log("✅ Pool created in block:", rc.blockNumber);
  });
