require("dotenv").config();
const hre = require("hardhat");
const { ethers } = hre;

const FACTORY = process.env.FACTORY; // 0x2e93...
const XPGN    = process.env.XPGN;
const USDT    = process.env.USDT;
const WBNB    = process.env.WBNB;

const factoryAbi = [
  "function getPair(address,address) view returns (address)"
];
const pairAbi = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)"
];
const erc20Abi = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)"
];

async function readPrice(tokenA, tokenB, label) {
  const [sA, sB] = await Promise.all([
    ethers.getContractAt(erc20Abi, tokenA),
    ethers.getContractAt(erc20Abi, tokenB),
  ]);
  const [symA, decA, symB, decB] = await Promise.all([
    sA.symbol(), sA.decimals(), sB.symbol(), sB.decimals()
  ]);

  const factory = await ethers.getContractAt(factoryAbi, FACTORY);
  const pair = await factory.getPair(tokenA, tokenB);
  if (pair === ethers.ZeroAddress) {
    console.log(`${label}: pair does not exist`);
    return;
  }
  const p = await ethers.getContractAt(pairAbi, pair);
  const [t0, t1] = await Promise.all([p.token0(), p.token1()]);
  const [r0, r1] = await p.getReserves();

  // map reserves to A/B order
  let rA, rB;
  if (t0.toLowerCase() === tokenA.toLowerCase()) { rA = r0; rB = r1; }
  else { rA = r1; rB = r0; }

  const qA = Number(ethers.formatUnits(rA, decA));
  const qB = Number(ethers.formatUnits(rB, decB));
  const priceAinB = qA > 0 ? (qB / qA) : 0;

  console.log(`${label}: 1 ${symA} = ${priceAinB} ${symB}  (pair ${pair})`);
}

async function main() {
  await readPrice(XPGN, WBNB, "XPGN/WBNB");
  await readPrice(XPGN, USDT, "XPGN/USDT");
}

main().catch((e) => { console.error(e); process.exit(1); });
