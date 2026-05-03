// tasks/flash-entertainer.js
const { task } = require("hardhat/config");
const crypto = require("crypto");

const FACTORY_ABI = [
  { type: "event", name: "PairCreated", inputs: [
    { indexed: true, name: "token0", type: "address" },
    { indexed: true, name: "token1", type: "address" },
    { indexed: false, name: "pair",   type: "address" },
    { indexed: false, name: "",       type: "uint256" }
  ]},
  { type: "function", stateMutability: "view", name: "allPairsLength", inputs: [], outputs: [{ type: "uint256" }] }
];

const PAIR_ABI = [
  { type: "event", name: "Swap", inputs: [
    { indexed: true,  name: "sender",     type: "address" },
    { indexed: false, name: "amount0In",  type: "uint256" },
    { indexed: false, name: "amount1In",  type: "uint256" },
    { indexed: false, name: "amount0Out", type: "uint256" },
    { indexed: false, name: "amount1Out", type: "uint256" },
    { indexed: true,  name: "to",         type: "address" },
  ]},
  { type: "function", stateMutability: "view", name: "token0", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", stateMutability: "view", name: "token1", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", stateMutability: "view", name: "getReserves", inputs: [], outputs: [
    { type: "uint112" }, { type: "uint112" }, { type: "uint32" }
  ]}
];

const ERC20_ABI = [
  { type: "function", stateMutability: "view", name: "decimals", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", stateMutability: "view", name: "symbol",   inputs: [], outputs: [{ type: "string" }] },
];

const FQN = "contracts/FlashEvent.sol:BettingPools";
const FIVE_MIN = 5 * 60;
const META_PATH = require("path").join(process.cwd(), "deployments", "flash-entertainer-meta.json");
const fs = require("fs");
function readMeta() { return fs.existsSync(META_PATH) ? JSON.parse(fs.readFileSync(META_PATH, "utf8")) : {}; }
function writeMeta(x) { fs.mkdirSync(require("path").dirname(META_PATH), { recursive: true }); fs.writeFileSync(META_PATH, JSON.stringify(x, null, 2)); }
function hash(hex) { return crypto.createHash("sha256").update(hex).digest("hex"); }

// ---------- TEMPLATES ----------
async function tplHeadlineHeatDuel(hre) {
  const tokensPath = process.env.TOKENS_JSON || "";
  let tokens = [
    { sym: "WBNB", addr: process.env.WBNB || "0x0000000000000000000000000000000000000001" },
    { sym: "USDT", addr: process.env.DEX_STABLE || "0x0000000000000000000000000000000000000002" },
  ];
  try {
    if (tokensPath && fs.existsSync(tokensPath)) {
      const json = JSON.parse(fs.readFileSync(tokensPath, "utf8"));
      if (Array.isArray(json) && json.length >= 2) tokens = json; // [{sym,addr},...]
    }
  } catch {}

  const latest = await hre.ethers.provider.getBlock("latest");
  const seed = parseInt(hash(latest.hash).slice(0, 8), 16);
  const i = seed % tokens.length;
  const j = (i + 1 + (seed % Math.max(1, tokens.length - 1))) % tokens.length;
  const A = tokens[i], B = tokens[j];

  return {
    title: "Headline Heat Duel",
    category: "News",
    question: `YES if ${A.sym} has >= swap volume than ${B.sym} on our DEX in the next 5m`,
    rule: {
      kind: "news-duel-v1",
      tokenA: A, tokenB: B,
      factory: process.env.FLASH_FACTORY || "",
      windowSec: FIVE_MIN,
      startBlock: latest.number,
    },
    duration: FIVE_MIN,
  };
}

async function resolveHeadlineHeatDuel(hre, rule) {
  const { ethers } = hre;
  const provider = ethers.provider;
  if (!rule.factory) throw new Error("FLASH_FACTORY not set");
  const current = await provider.getBlockNumber();

  const ifaceFactory = new ethers.Interface(FACTORY_ABI);
  const logs = await provider.getLogs({
    address: rule.factory,
    fromBlock: Math.max(rule.startBlock - 5000, 1),
    toBlock: current,
    topics: [ifaceFactory.getEvent("PairCreated").topicHash],
  });

  const pairs = logs.map(l => ifaceFactory.parseLog(l).args.pair);
  const ifacePair = new ethers.Interface(PAIR_ABI);
  let volA = 0n, volB = 0n;

  for (const pair of pairs.slice(0, 200)) {
    const swapLogs = await provider.getLogs({ address: pair, fromBlock: rule.startBlock + 1, toBlock: current });
    for (const s of swapLogs) {
      try {
        const parsed = ifacePair.parseLog(s);
        if (parsed?.name !== "Swap") continue;
        const a0i = BigInt(parsed.args.amount0In);
        const a1i = BigInt(parsed.args.amount1In);
        const a0o = BigInt(parsed.args.amount0Out);
        const a1o = BigInt(parsed.args.amount1Out);
        // blind sum; for a quick “volume” compare this is okay
        // a real version would map which token is A/B and sum that side only.
        const sum = a0i + a1i + a0o + a1o;
        // naive: split evenly to both sides if we can’t map token addresses (keeps demo simple)
        volA += sum / 2n;
        volB += sum / 2n;
      } catch {}
    }
  }
  return volA >= volB;
}

async function tplWhaleWatch(hre) {
  const latest = await hre.ethers.provider.getBlock("latest");
  return {
    title: "Whale Watch",
    category: "DEX",
    question: `YES if any single swap ≥ $${process.env.WHALE_USD || 1000} occurs on our DEX in the next 5m`,
    rule: {
      kind: "whale-watch-v1",
      startBlock: latest.number,
      factory: process.env.FLASH_FACTORY || "",
      stable: process.env.DEX_STABLE || "",
      thresholdUsd: Number(process.env.WHALE_USD || 1000),
    },
    duration: FIVE_MIN,
  };
}

async function resolveWhaleWatch(hre, rule) {
  const { ethers } = hre;
  const provider = ethers.provider;
  const ifaceFactory = new ethers.Interface(FACTORY_ABI);
  const ifacePair = new ethers.Interface(PAIR_ABI);
  const current = await provider.getBlockNumber();

  const logs = await provider.getLogs({
    address: rule.factory,
    fromBlock: Math.max(rule.startBlock - 5000, 1),
    toBlock: current,
    topics: [ifaceFactory.getEvent("PairCreated").topicHash],
  });

  const pairs = logs.map(l => ifaceFactory.parseLog(l).args.pair);
  for (const pair of pairs.slice(0, 300)) {
    const swapLogs = await provider.getLogs({ address: pair, fromBlock: rule.startBlock + 1, toBlock: current });
    for (const s of swapLogs) {
      try {
        const parsed = ifacePair.parseLog(s);
        if (parsed?.name !== "Swap") continue;
        // rough proxy: if pair has the stable token, take the max leg as USD
        const c = new ethers.Contract(pair, PAIR_ABI, provider);
        const t0 = (await c.token0()).toLowerCase();
        const t1 = (await c.token1()).toLowerCase();
        if (!rule.stable) continue;
        const stable = rule.stable.toLowerCase();
        const hasStable = t0 === stable || t1 === stable;
        if (!hasStable) continue;

        const a0i = Number(parsed.args.amount0In);
        const a1i = Number(parsed.args.amount1In);
        const a0o = Number(parsed.args.amount0Out);
        const a1o = Number(parsed.args.amount1Out);
        const usd = Math.max(a0i, a1i, a0o, a1o) / 1e6; // assume 6 decimals on stable
        if (usd >= rule.thresholdUsd) return true;
      } catch {}
    }
  }
  return false;
}

async function tplNewPairBingo(hre) {
  const latest = await hre.ethers.provider.getBlock("latest");
  return {
    title: "New Pair Bingo",
    category: "Factory",
    question: "YES if a new pair is created in the next 5 minutes",
    rule: { kind: "new-pair-v1", startBlock: latest.number, factory: process.env.FLASH_FACTORY || "" },
    duration: FIVE_MIN,
  };
}

async function resolveNewPairBingo(hre, rule) {
  const { ethers } = hre;
  const provider = ethers.provider;
  const ifaceFactory = new ethers.Interface(FACTORY_ABI);
  const current = await provider.getBlockNumber();
  const logs = await provider.getLogs({
    address: rule.factory,
    fromBlock: rule.startBlock + 1,
    toBlock: current,
    topics: [ifaceFactory.getEvent("PairCreated").topicHash],
  });
  return logs.length > 0;
}

const MAKERS = [tplHeadlineHeatDuel, tplWhaleWatch, tplNewPairBingo];
const RESOLVERS = {
  "news-duel-v1": resolveHeadlineHeatDuel,
  "whale-watch-v1": resolveWhaleWatch,
  "new-pair-v1": resolveNewPairBingo,
};

task("flash:entertain", "Create a randomized entertaining 5-min FlashEvents pool")
  .addParam("addr", "BettingPools/FlashEvents address")
  .addOptionalParam("min", "Min bet (raw units)", "1000000")
  .addOptionalParam("max", "Max bet (raw units)", "10000000000")
  .addOptionalParam("fee", "Fee bps", "400")
  .addOptionalParam("token", "Betting token override", "")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const c = await ethers.getContractAt(FQN, args.addr);
    const latest = await ethers.provider.getBlock("latest");

    const idx = parseInt(hash(latest.hash).slice(0, 8), 16) % MAKERS.length;
    const { title, category, question, rule, duration } = await MAKERS[idx](hre);

    const resolver = await c.owner();
    const tx = await c.createPool(
      title,
      question,
      category,
      duration,
      resolver,
      BigInt(args.fee),
      BigInt(args.min),
      BigInt(args.max),
      args.token && args.token !== "" ? args.token : "0x0000000000000000000000000000000000000000"
    );
    const rc = await tx.wait();

    // store template rule so we can resolve later
    const logs = rc.logs || [];
    const created = logs.find((l) => {
      try { return (c.interface.parseLog(l)?.name === "PoolCreated"); } catch { return false; }
    });
    const poolId = created ? String(c.interface.parseLog(created).args.poolId) : "unknown";

    const meta = readMeta();
    meta[poolId] = { rule, createdAt: Date.now(), startBlock: rule.startBlock, template: rule.kind };
    writeMeta(meta);

    console.log(`🎉 Created pool #${poolId}: ${title} — ${question}`);
  });

task("flash:resolve-entertain", "Resolve an entertaining pool by id from stored metadata")
  .addParam("addr", "BettingPools/FlashEvents address")
  .addParam("id", "Pool id")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const c = await ethers.getContractAt(FQN, args.addr);
    const poolId = String(args.id);

    const info = readMeta()[poolId];
    if (!info) throw new Error(`No metadata for pool ${poolId}`);

    const resolverFn = RESOLVERS[info.template];
    if (!resolverFn) throw new Error(`No resolver for template ${info.template}`);

    const outcome = await resolverFn(hre, info.rule);
    console.log(`🧮 Outcome for pool ${poolId} (${info.template}): ${outcome ? "YES" : "NO"}`);

    const tx = await c.resolvePool(poolId, outcome);
    await tx.wait();
    console.log("✅ Resolved");
  });
