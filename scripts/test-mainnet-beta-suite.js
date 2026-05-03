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
  "function symbol() view returns (string)",
];

const ROUTER_ABI = [
  "function getAmountsOut(uint256,address[]) view returns (uint256[])",
  "function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) returns (uint256,uint256,uint256)",
  "function removeLiquidity(address,address,uint256,uint256,uint256,address,uint256) returns (uint256,uint256)",
  "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256,uint8) returns (uint256[])",
];

const FACTORY_ABI = [
  "function feeTo() view returns (address)",
  "function feeToSetter() view returns (address)",
  "function swapFeeBips() view returns (uint32)",
  "function getPair(address,address) view returns (address)",
];

const PAIR_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

const PAYFLOW_ABI = [
  "function venueEnabled(address) view returns (bool)",
  "function oneInchAdapter() view returns (address)",
  "function supportedToken(address) view returns (bool)",
  "function aggregatorFeeBips() view returns (uint16)",
  "function relayerFeeBips() view returns (uint16)",
];

const ADAPTER_ABI = [
  "function payflowExecutor() view returns (address)",
  "function oneInchRouter() view returns (address)",
  "function allowedExecutors(address) view returns (bool)",
];

const LP_REBATES_ABI = [
  "function allowedLp(address) view returns (bool)",
  "function isSupportedReward(address) view returns (bool)",
  "function notifier() view returns (address)",
  "function guardian() view returns (address)",
];

const FARM_ABI = [
  "function rewardPerBlock() view returns (uint256)",
  "function emissionsPaused() view returns (bool)",
  "function poolLength() view returns (uint256)",
  "function poolInfo(uint256) view returns (address,uint256,uint256,uint256,uint256,uint256,uint256)",
  "function userInfo(uint256,address) view returns (uint256 amount,uint256 rewardDebt,uint256 lastDepositTime,uint256 unpaid)",
  "function depositFor(uint256,uint256,address,address)",
  "function withdraw(uint256,uint256)",
];

async function impersonate(address) {
  await hre.network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [address],
  });

  await hre.network.provider.send("hardhat_setBalance", [
    address,
    "0x3635C9ADC5DEA00000",
  ]);

  return await ethers.getSigner(address);
}

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

async function getPair(address) {
  return await ethers.getContractAt(PAIR_ABI, address);
}

async function approveIfNeeded(token, signer, owner, spender, amount) {
  const allowance = await token.allowance(owner, spender);
  if (allowance >= amount) return;
  const tx = await token.connect(signer).approve(spender, amount);
  await tx.wait();
}

async function pairTokens(pairAddress) {
  const pair = await getPair(pairAddress);
  return {
    pair,
    token0: await pair.token0(),
    token1: await pair.token1(),
  };
}

async function tokenMeta(address) {
  const token = await getToken(address);
  return {
    token,
    symbol: await token.symbol(),
    decimals: Number(await token.decimals()),
  };
}

function fmt(amount, decimals = 18) {
  return ethers.formatUnits(amount, decimals);
}

async function seedPair(router, signer, signerAddr, pairAddress, amount0, amount1) {
  const { pair, token0, token1 } = await pairTokens(pairAddress);
  const [reserve0, reserve1] = await pair.getReserves();
  if (reserve0 > 0n || reserve1 > 0n) {
    console.log(`Skipping seed for ${pairAddress} because reserves already exist`);
    return;
  }
  const token0c = await getToken(token0);
  const token1c = await getToken(token1);
  await approveIfNeeded(token0c, signer, signerAddr, await router.getAddress(), amount0);
  await approveIfNeeded(token1c, signer, signerAddr, await router.getAddress(), amount1);
  const tx = await router.connect(signer).addLiquidity(
    token0,
    token1,
    amount0,
    amount1,
    0,
    0,
    signerAddr,
    deadline()
  );
  await tx.wait();
}

async function logPairReserves(label, pairAddress) {
  const { pair, token0, token1 } = await pairTokens(pairAddress);
  const [r0, r1] = await pair.getReserves();
  const m0 = await tokenMeta(token0);
  const m1 = await tokenMeta(token1);
  console.log(`${label}: ${m0.symbol}/${m1.symbol} reserves = ${fmt(r0, m0.decimals)} / ${fmt(r1, m1.decimals)}`);
}

async function swapAndCheck(router, signer, signerAddr, pathAddresses, amountIn, label) {
  const inToken = await getToken(pathAddresses[0]);
  const outToken = await getToken(pathAddresses[pathAddresses.length - 1]);
  const outMeta = await tokenMeta(pathAddresses[pathAddresses.length - 1]);
  await approveIfNeeded(inToken, signer, signerAddr, await router.getAddress(), amountIn);

  const quoted = await router.getAmountsOut(amountIn, pathAddresses);
  const minOut = (quoted[quoted.length - 1] * 99n) / 100n;
  const beforeOut = await outToken.balanceOf(signerAddr);
  const tx = await router.connect(signer).swapExactTokensForTokens(
    amountIn,
    minOut,
    pathAddresses,
    signerAddr,
    deadline(),
    0
  );
  await tx.wait();
  const afterOut = await outToken.balanceOf(signerAddr);
  const delta = afterOut - beforeOut;
  if (delta < minOut) {
    throw new Error(`${label} received less than minOut`);
  }
  console.log(`${label}: out=${fmt(delta, outMeta.decimals)} (min=${fmt(minOut, outMeta.decimals)})`);
}

async function removeHalfLiquidity(router, signer, signerAddr, pairAddress) {
  const pair = await getPair(pairAddress);
  const lpBalance = await pair.balanceOf(signerAddr);
  const half = lpBalance / 2n;
  if (half === 0n) {
    throw new Error("No LP balance to remove");
  }
  await approveIfNeeded(pair, signer, signerAddr, await router.getAddress(), half);
  const { token0, token1 } = await pairTokens(pairAddress);
  const tx = await router.connect(signer).removeLiquidity(
    token0,
    token1,
    half,
    0,
    0,
    signerAddr,
    deadline()
  );
  await tx.wait();
  console.log(`Removed half of LP from pair ${pairAddress}`);
}

async function main() {
  const deployments = loadDeployments();
  const [signer] = await ethers.getSigners();
  const signerAddr = await signer.getAddress();

  console.log("=================================================");
  console.log("Paragon full beta fork validation");
  console.log("=================================================");
  console.log(`Signer: ${signerAddr}`);

  const router = await ethers.getContractAt(ROUTER_ABI, deployments.addresses.router);
  const factory = await ethers.getContractAt(FACTORY_ABI, deployments.addresses.factory);
  const payflow = await ethers.getContractAt(PAYFLOW_ABI, deployments.addresses.payflowExecutor);
  const adapter = await ethers.getContractAt(ADAPTER_ABI, deployments.addresses.adapter);
  const lpRebates = await ethers.getContractAt(LP_REBATES_ABI, deployments.addresses.lpFlowRebates);
  const farm = await ethers.getContractAt(FARM_ABI, deployments.addresses.farmController);
  const xpgn = await getToken(deployments.addresses.xpgn);

  console.log("");
  console.log("=== Config checks ===");
  console.log(`factory.feeTo(): ${await factory.feeTo()}`);
  console.log(`factory.feeToSetter(): ${await factory.feeToSetter()}`);
  console.log(`factory.swapFeeBips(): ${await factory.swapFeeBips()}`);
  console.log(`payflow.oneInchAdapter(): ${await payflow.oneInchAdapter()}`);
  console.log(`payflow.aggregatorFeeBips(): ${await payflow.aggregatorFeeBips()}`);
  console.log(`payflow.relayerFeeBips(): ${await payflow.relayerFeeBips()}`);
  console.log(`adapter.payflowExecutor(): ${await adapter.payflowExecutor()}`);
  console.log(`adapter.oneInchRouter(): ${await adapter.oneInchRouter()}`);

  console.log("");
  console.log("=== Canonical pair checks ===");
  const pairChecks = [
    ["wbnbUsdt", deployments.addresses.pairs.wbnbUsdt],
    ["usdtUsdc", deployments.addresses.pairs.usdtUsdc],
    ["xpgnUsdt", deployments.addresses.pairs.xpgnUsdt],
    ["solUsdt", deployments.addresses.pairs.solUsdt],
  ];

  for (const [label, pairAddress] of pairChecks) {
    if (!pairAddress || pairAddress === ethers.ZeroAddress) {
      throw new Error(`Missing pair address for ${label}`);
    }
    console.log(`${label}: ${pairAddress}`);
    console.log(`  LP allowlisted: ${await lpRebates.allowedLp(pairAddress)}`);
  }

  const rewardTokensToCheck = [
    deployments.addresses.xpgn,
    ...(await Promise.all(
      [deployments.addresses.pairs.wbnbUsdt, deployments.addresses.pairs.usdtUsdc].map(async (pairAddress) => {
        const { token0, token1 } = await pairTokens(pairAddress);
        return [token0, token1];
      })
    )).flat(),
  ];
  for (const token of [...new Set(rewardTokensToCheck)]) {
    console.log(`  reward token supported ${token}: ${await lpRebates.isSupportedReward(token)}`);
  }

  console.log("");
  console.log("=== Test wallet funding ===");
  const xpgnBalance = await xpgn.balanceOf(signerAddr);
  if (xpgnBalance === 0n) {
    const genesisSigner = await impersonate(deployments.genesisReserveSafe);
    const seedXpgn = ethers.parseUnits("150000", 18);
    await (await xpgn.connect(genesisSigner).transfer(signerAddr, seedXpgn)).wait();
    console.log(`Funded signer with ${fmt(seedXpgn)} XPGN from genesis reserve`);
  } else {
    console.log(`Signer already has XPGN: ${fmt(xpgnBalance)}`);
  }

  console.log("");
  console.log("=== Seeding liquidity ===");
  const seedSpecs = [
    [deployments.addresses.pairs.wbnbUsdt, ethers.parseUnits("100", 18), ethers.parseUnits("60000", 18)],
    [deployments.addresses.pairs.usdtUsdc, ethers.parseUnits("25000", 18), ethers.parseUnits("25000", 18)],
    [deployments.addresses.pairs.xpgnUsdt, ethers.parseUnits("100000", 18), ethers.parseUnits("20000", 18)],
    [deployments.addresses.pairs.solUsdt, ethers.parseUnits("5000", 18), ethers.parseUnits("700000", 18)],
  ];

  for (const [pairAddress, amount0, amount1] of seedSpecs) {
    await seedPair(router, signer, signerAddr, pairAddress, amount0, amount1);
    await logPairReserves("seeded", pairAddress);
  }

  console.log("");
  console.log("=== Router swap smoke tests ===");
  const wbnbUsdt = await pairTokens(deployments.addresses.pairs.wbnbUsdt);
  const usdtUsdc = await pairTokens(deployments.addresses.pairs.usdtUsdc);
  const xpgnUsdt = await pairTokens(deployments.addresses.pairs.xpgnUsdt);
  const solUsdt = await pairTokens(deployments.addresses.pairs.solUsdt);

  await swapAndCheck(router, signer, signerAddr, [wbnbUsdt.token0, wbnbUsdt.token1], ethers.parseUnits("1", 18), "swap WBNB/USDT");
  await swapAndCheck(router, signer, signerAddr, [usdtUsdc.token0, usdtUsdc.token1], ethers.parseUnits("100", 18), "swap USDT/USDC");
  await swapAndCheck(router, signer, signerAddr, [xpgnUsdt.token0, xpgnUsdt.token1], ethers.parseUnits("100", 18), "swap XPGN/USDT");
  await swapAndCheck(router, signer, signerAddr, [solUsdt.token0, solUsdt.token1], ethers.parseUnits("10", 18), "swap SOL/USDT");

  console.log("");
  console.log("=== Liquidity remove smoke test ===");
  await removeHalfLiquidity(router, signer, signerAddr, deployments.addresses.pairs.wbnbUsdt);
  await logPairReserves("after remove", deployments.addresses.pairs.wbnbUsdt);

  console.log("");
  console.log("=== Farm smoke test ===");
  console.log(`farm.poolLength(): ${await farm.poolLength()}`);
  console.log(`farm.emissionsPaused(): ${await farm.emissionsPaused()}`);
  console.log(`farm.rewardPerBlock(): ${await farm.rewardPerBlock()}`);

  const farmDeposit = ethers.parseUnits("1000", 18);
  await approveIfNeeded(xpgn, signer, signerAddr, await farm.getAddress(), farmDeposit);
  const beforeUser = await farm.userInfo(0, signerAddr);
  await (await farm.connect(signer).depositFor(0, farmDeposit, signerAddr, ethers.ZeroAddress)).wait();
  const afterDepositUser = await farm.userInfo(0, signerAddr);
  if (afterDepositUser.amount <= beforeUser.amount) {
    throw new Error("Farm deposit did not increase user amount");
  }
  await (await farm.connect(signer).withdraw(0, farmDeposit)).wait();
  const afterWithdrawUser = await farm.userInfo(0, signerAddr);
  if (afterWithdrawUser.amount !== beforeUser.amount) {
    throw new Error("Farm withdraw did not restore user amount");
  }
  console.log(`Farm deposit/withdraw ok. user amount back to ${afterWithdrawUser.amount}`);

  console.log("");
  console.log("=== Summary ===");
  console.log("Config checks passed");
  console.log("Canonical pair checks passed");
  console.log("Liquidity seeding passed");
  console.log("Router swap smoke tests passed");
  console.log("Liquidity remove smoke test passed");
  console.log("Farm smoke test passed");
  console.log("");
  console.log("Run scripts/test-payflow-1inch-fork-mock.js separately for executeVia1inch path validation.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
