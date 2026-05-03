// scripts/_utils.js
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

// ---------- deployment loader (auto-picks deployments/<network>.json) ----------
function loadDeployment() {
  const netName = process.env.DEPLOY_JSON || hre.network.name; // e.g., "hardhat", "bscTestnet"
  const p = path.resolve(__dirname, `../deployments/${netName}.json`);
  if (!fs.existsSync(p)) throw new Error(`Missing deployments file at ${p}`);
  const rec = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!rec.core) throw new Error("deployments JSON missing .core section");
  return rec;
}

// ---------- helpers ----------
const fmt = (x, d = 18) => Number(ethers.formatUnits(x, d)).toFixed(6);

function sort(a, b) {
  return a.toLowerCase() < b.toLowerCase()
    ? { token0: a, token1: b }
    : { token0: b, token1: a };
}

// Generic Uniswap v2-style quote with arbitrary fee bips (default 30 bips = 0.3%)
function quoteOut(amountIn, reserveIn, reserveOut, feeBips = 30n) {
  const FEE_DEN = 1000n;
  const feeNum = FEE_DEN - feeBips;
  const amountInWithFee = amountIn * feeNum;
  return (amountInWithFee * reserveOut) / (reserveIn * FEE_DEN + amountInWithFee);
}

async function getPair(factory, a, b) {
  const pa = await factory.getPair(a, b);
  if (pa === ethers.ZeroAddress) throw new Error("Pair does not exist");
  return pa;
}

function nowPlus(seconds = 600) {
  return BigInt(Math.floor(Date.now() / 1000) + seconds);
}

function chooseSwapFn(router) {
  return typeof router.swapExactTokensForTokensSupportingFeeOnTransferTokens === "function"
    ? (aIn, mOut, p, to, dl, ay) =>
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(aIn, mOut, p, to, dl, ay)
    : (aIn, mOut, p, to, dl, ay) => {
        try {
          return router.swapExactTokensForTokens(aIn, mOut, p, to, dl, ay);
        } catch {
          return router.swapExactTokensForTokens(aIn, mOut, p, to, dl);
        }
      };
}

// On local we don't want to block on chainId; allow override with EXPECT_CHAIN_ID=""
async function ensureTestnet(expected = 97n) {
  const net = await ethers.provider.getNetwork();
  if (process.env.EXPECT_CHAIN_ID === "") return net; // skip guard for local
  const want = process.env.EXPECT_CHAIN_ID ? BigInt(process.env.EXPECT_CHAIN_ID) : expected;
  if (net.chainId !== want) {
    throw new Error(`Refusing to run on chainId ${net.chainId} (expected ${want})`);
  }
  return net;
}

module.exports = {
  loadDeployment,
  fmt,
  sort,
  quoteOut,
  getPair,
  nowPlus,
  chooseSwapFn,
  ensureTestnet,
};
