const { task } = require("hardhat/config");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ===== CONFIG (envs) =====
const FIVE_MIN = 5 * 60;
const META_PATH = path.join(process.cwd(), "deployments", "flash-events-meta.json");

// Optional DEX pair for TWAP (UniswapV2-style)
const DEX_PAIR = process.env.DEX_PAIR || "";   // e.g., XPGN/USDT pair
const DEX_DEC0 = Number(process.env.DEX_DEC0 || "18");
const DEX_DEC1 = Number(process.env.DEX_DEC1 || "6");
const TWAP_THRESHOLD_BPS = Number(process.env.TWAP_THRESHOLD_BPS || "30"); // 0.30%

// Minimal UniswapV2 pair ABI
const PAIR_ABI = [
  { type: "function", stateMutability: "view", name: "getReserves", inputs: [], outputs: [
    {name: "reserve0", type: "uint112"}, {name: "reserve1", type: "uint112"}, {name: "blockTimestampLast", type: "uint32"}
  ]},
  { type: "function", stateMutability: "view", name: "token0", inputs: [], outputs: [{type: "address"}] },
  { type: "function", stateMutability: "view", name: "token1", inputs: [], outputs: [{type: "address"}] },
];

// Helpers
function readMeta() {
  if (!fs.existsSync(META_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(META_PATH, "utf8")); } catch { return {}; }
}
function writeMeta(obj) {
  if (!fs.existsSync(path.dirname(META_PATH))) fs.mkdirSync(path.dirname(META_PATH), { recursive: true });
  fs.writeFileSync(META_PATH, JSON.stringify(obj, null, 2));
}
function keccakHex(buf) {
  return crypto.createHash("sha3-256").update(buf).digest("hex");
}
function bn(n) { return BigInt(n); }
function toPct(bps) { return (bps / 100).toFixed(2) + "%"; }

// Compute price from reserves (token1 per token0)
function priceFromReserves(r0, r1, dec0, dec1) {
  const num = Number(r1) / 10 ** dec1;
  const den = Number(r0) / 10 ** dec0;
  return num / Math.max(den, 1e-18);
}

// ========== TEMPLATE A: Block Gas Surge ==========
async function templateGasSurge(hre, baseBlock, window = 20) {
  const title = "Block Gas Surge";
  const category = "Chain";
  const question = `YES if sum(gasUsed) of blocks (${baseBlock + 1}..${baseBlock + window}) > (${baseBlock - window + 1}..${baseBlock}) [rule:v1-gas;win=${window};base=${baseBlock}]`;
  const rule = {
    kind: "gas-surge-v1",
    baseBlock,
    window,
  };
  return { title, category, question, rule };
}
async function resolveGasSurge(hre, rule) {
  const { ethers } = hre;
  const provider = ethers.provider;
  const { baseBlock, window } = rule;

  let prev = 0n, next = 0n;
  for (let i = baseBlock - window + 1; i <= baseBlock; i++) {
    const b = await provider.getBlock(i);
    prev += bn(b.gasUsed);
  }
  for (let i = baseBlock + 1; i <= baseBlock + window; i++) {
    const b = await provider.getBlock(i);
    next += bn(b.gasUsed);
  }
  return next > prev; // YES if next window used more gas
}

// ========== TEMPLATE B: DEX TWAP Nudge (pair reserves) ==========
async function templateDexTwap(hre, baseBlock, thresholdBps = TWAP_THRESHOLD_BPS) {
  if (!DEX_PAIR) throw new Error("DEX_PAIR env not set");
  const { ethers } = hre;
  const pair = await ethers.getContractAt(PAIR_ABI, DEX_PAIR);

  // snapshot start price (at creation time)
  const [r0, r1] = await pair.getReserves();
  const startPrice = priceFromReserves(Number(r0), Number(r1), DEX_DEC0, DEX_DEC1);

  const title = "DEX TWAP Nudge";
  const category = "DEX";
  const question = `YES if price(pair) increases by ≥ ${toPct(thresholdBps)} from creation to resolution [rule:v1-twap;pair=${DEX_PAIR};base=${baseBlock};thr_bps=${thresholdBps};p0=${startPrice.toFixed(8)}]`;

  const rule = {
    kind: "dex-twap-v1",
    baseBlock,
    pair: DEX_PAIR,
    dec0: DEX_DEC0,
    dec1: DEX_DEC1,
    thresholdBps,
    startPrice, // stored for reference
  };
  return { title, category, question, rule };
}
async function resolveDexTwap(hre, rule) {
  const { ethers } = hre;
  const pair = await ethers.getContractAt(PAIR_ABI, rule.pair);
  const [r0, r1] = await pair.getReserves();
  const endPrice = priceFromReserves(Number(r0), Number(r1), rule.dec0, rule.dec1);

  const upPct = ((endPrice - rule.startPrice) / Math.max(rule.startPrice, 1e-18)) * 100;
  return (upPct >= rule.thresholdBps / 100); // YES if moved up >= threshold
}

// Registry of templates
const TEMPLATES = [
  { key: "gas-surge-v1", make: templateGasSurge, resolve: resolveGasSurge },
  { key: "dex-twap-v1",  make: templateDexTwap, resolve: resolveDexTwap  },
];

// ======= TASK: flash:tick (create a random 5-min pool) =======
task("flash:tick", "Create a randomized 5-min FlashEvents pool")
  .addParam("addr", "FlashEvents address")
  .addOptionalParam("min", "Min bet (raw units)", "1000000")
  .addOptionalParam("max", "Max bet (raw units)", "10000000000")
  .addOptionalParam("fee", "Fee bps", "400")
  .addOptionalParam("token", "Betting token override", "")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const c = await ethers.getContractAt("FlashEvents", args.addr);
    const provider = ethers.provider;
    const latest = await provider.getBlock("latest");

    // Seed selection from latest blockhash so operator can't cherry-pick
    const seedHex = keccakHex(Buffer.from(latest.hash.slice(2), "hex"));
    const seed = parseInt(seedHex.slice(0, 8), 16);
    const pick = seed % TEMPLATES.length;

    const baseBlock = latest.number; // anchor
    const tpl = TEMPLATES[pick];

    // Build the template
    const { title, category, question, rule } = await tpl.make(hre, baseBlock);

    const duration = FIVE_MIN; // 5 minutes
    const resolver = (await c.owner()); // default to owner; change if you have a keeper
    const feeBps = BigInt(args.fee);
    const minBet = BigInt(args.min);
    const maxBet = BigInt(args.max);
    const token = args.token && args.token !== "" ? args.token : "0x0000000000000000000000000000000000000000";

    const tx = await c.createPool(title, question, category, duration, resolver, feeBps, minBet, maxBet, token);
    const rc = await tx.wait();

    // Extract poolId from PoolCreated event
    const evt = rc.logs?.find((l) => l.fragment && l.fragment.name === "PoolCreated");
    const poolId = evt?.args?.poolId?.toString();

    console.log(`🎲 Template: ${tpl.key}`);
    console.log(`🆕 Pool ${poolId}: ${title}`);
    console.log(`   ${question}`);

    // Persist metadata for resolution
    const meta = readMeta();
    meta[poolId] = { template: tpl.key, rule, createdAtBlock: baseBlock, createdAt: Date.now() };
    writeMeta(meta);
    console.log("💾 Stored metadata:", META_PATH);
  });

// ======= TASK: flash:resolve (resolve a pool by id) =======
task("flash:resolve", "Resolve a specific FlashEvents pool using stored metadata")
  .addParam("addr", "FlashEvents address")
  .addParam("id", "Pool id")
  .setAction(async (args, hre) => {
    const { ethers } = hre;
    const c = await ethers.getContractAt("FlashEvents", args.addr);
    const poolId = String(args.id);

    const meta = readMeta();
    const info = meta[poolId];
    if (!info) throw new Error(`No metadata for pool ${poolId} in ${META_PATH}`);

    const tpl = TEMPLATES.find((t) => t.key === info.template);
    if (!tpl) throw new Error(`Unknown template key: ${info.template}`);

    // Compute outcome
    const outcome = await tpl.resolve(hre, info.rule); // true = YES, false = NO
    console.log(`🧮 Outcome for pool ${poolId} (${info.template}): ${outcome ? "YES" : "NO"}`);

    // Resolve on-chain
    const tx = await c.resolvePool(poolId, outcome);
    await tx.wait();
    console.log("✅ Resolved on-chain");
  });
