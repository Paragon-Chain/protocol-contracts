require("dotenv").config();
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
];

const ROUTER_ABI = [
  "function getAmountsOut(uint256,address[]) view returns (uint256[])",
  "function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) returns (uint256,uint256,uint256)",
];

const PAIR_ABI = [
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

function loadDeployments() {
  const file = path.join(__dirname, "..", "deployments", "localhost-paragon-testing.json");
  if (!fs.existsSync(file)) {
    throw new Error(`Missing deployment file: ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function deadline() {
  return BigInt(Math.floor(Date.now() / 1000) + 3600);
}

async function getToken(address) {
  return await ethers.getContractAt(ERC20_ABI, address);
}

async function approveIfNeeded(token, signer, owner, spender, amount) {
  const allowance = await token.allowance(owner, spender);
  if (allowance >= amount) return;
  await (await token.connect(signer).approve(spender, amount)).wait();
}

function fmt(amount, decimals = 18) {
  return ethers.formatUnits(amount, decimals);
}

async function ensureXpgnUsdtLiquidity(router, signer, signerAddr, deployments) {
  const pair = await ethers.getContractAt(PAIR_ABI, deployments.addresses.pairs.xpgnUsdt);
  const [r0, r1] = await pair.getReserves();
  if (r0 > 0n || r1 > 0n) {
    return;
  }

  const usdt = await getToken("0x2Db5a0aE0444521244087e3571e4C3911173084C");
  const xpgn = await getToken(deployments.addresses.xpgn);
  const amountUsdt = ethers.parseUnits("20000", 18);
  const amountXpgn = ethers.parseUnits("100000", 18);

  await approveIfNeeded(usdt, signer, signerAddr, await router.getAddress(), amountUsdt);
  await approveIfNeeded(xpgn, signer, signerAddr, await router.getAddress(), amountXpgn);

  await (
    await router.connect(signer).addLiquidity(
      await pair.token0(),
      await pair.token1(),
      amountXpgn,
      amountUsdt,
      0,
      0,
      signerAddr,
      deadline()
    )
  ).wait();
}

async function main() {
  const deployments = loadDeployments();
  const [userSigner] = await ethers.getSigners();
  const userAddr = await userSigner.getAddress();

  console.log("=================================================");
  console.log("Payflow execute via Paragon router fork test");
  console.log("=================================================");
  console.log(`User: ${userAddr}`);
  console.log(`Payflow: ${deployments.addresses.payflowExecutor}`);
  console.log(`BestExecution: ${deployments.addresses.bestExecution}`);
  console.log(`Router: ${deployments.addresses.router}`);

  const payflow = await ethers.getContractAt(
    "ParagonPayflowExecutorV2",
    deployments.addresses.payflowExecutor
  );
  const bestExec = await ethers.getContractAt(
    "ParagonBestExecutionV14",
    deployments.addresses.bestExecution
  );
  const router = await ethers.getContractAt(ROUTER_ABI, deployments.addresses.router);

  const usdt = await getToken("0x2Db5a0aE0444521244087e3571e4C3911173084C");
  const xpgn = await getToken(deployments.addresses.xpgn);

  await ensureXpgnUsdtLiquidity(router, userSigner, userAddr, deployments);

  const amountIn = ethers.parseUnits("100", 18);
  await approveIfNeeded(usdt, userSigner, userAddr, await payflow.getAddress(), amountIn);

  const route = ["0x2Db5a0aE0444521244087e3571e4C3911173084C", deployments.addresses.xpgn];
  const quoted = await router.getAmountsOut(amountIn, route);
  const quotedOut = quoted[quoted.length - 1];
  const minAmountOut = (quotedOut * 99n) / 100n;
  const nonce = await bestExec.nonces(userAddr);

  const intent = {
    user: userAddr,
    tokenIn: route[0],
    tokenOut: route[1],
    amountIn,
    minAmountOut,
    deadline: deadline(),
    recipient: userAddr,
    nonce,
  };

  const domain = {
    name: "ParagonBestExecution",
    version: "1",
    chainId: 31337,
    verifyingContract: await bestExec.getAddress(),
  };

  const types = {
    SwapIntent: [
      { name: "user", type: "address" },
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "minAmountOut", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "nonce", type: "uint256" },
    ],
  };

  const sig = await userSigner.signTypedData(domain, types, intent);
  const emptyPermit = {
    value: 0n,
    deadline: 0n,
    v: 0,
    r: ethers.ZeroHash,
    s: ethers.ZeroHash,
  };

  const beforeUserUsdt = await usdt.balanceOf(userAddr);
  const beforeUserXpgn = await xpgn.balanceOf(userAddr);
  const beforePayflowUsdt = await usdt.balanceOf(await payflow.getAddress());
  const beforePayflowXpgn = await xpgn.balanceOf(await payflow.getAddress());

  const tx = await payflow.connect(userSigner).execute(intent, sig, emptyPermit);
  const receipt = await tx.wait();

  const afterUserUsdt = await usdt.balanceOf(userAddr);
  const afterUserXpgn = await xpgn.balanceOf(userAddr);
  const afterPayflowUsdt = await usdt.balanceOf(await payflow.getAddress());
  const afterPayflowXpgn = await xpgn.balanceOf(await payflow.getAddress());

  const spent = beforeUserUsdt - afterUserUsdt;
  const received = afterUserXpgn - beforeUserXpgn;

  console.log("");
  console.log("=== Execution summary ===");
  console.log(`tx hash: ${receipt.hash}`);
  console.log(`status: ${receipt.status}`);
  console.log(`USDT spent: ${fmt(spent)}`);
  console.log(`XPGN received: ${fmt(received)}`);
  console.log(`Quoted out: ${fmt(quotedOut)}`);
  console.log(`Min out: ${fmt(minAmountOut)}`);
  console.log(`Payflow USDT leftover: ${fmt(afterPayflowUsdt)}`);
  console.log(`Payflow XPGN leftover: ${fmt(afterPayflowXpgn)}`);

  if (received < minAmountOut) {
    throw new Error("Recipient received less than minAmountOut");
  }
  if (afterPayflowUsdt !== beforePayflowUsdt || afterPayflowXpgn !== beforePayflowXpgn) {
    throw new Error("Payflow retained unexpected balances after execute");
  }

  console.log("");
  console.log("execute via Paragon router fork test passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
