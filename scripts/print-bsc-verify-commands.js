const fs = require("fs");
const path = require("path");

function shellEscape(value) {
  const s = String(value);
  if (/^[A-Za-z0-9_./:-]+$/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

function main() {
  const inputArg =
    process.argv[2] || "deployments/bscMainnet-paragon-beta-staging.verify.json";
  const inputPath = path.resolve(process.cwd(), inputArg);

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Verification bundle not found: ${inputPath}`);
  }

  const raw = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const verification = raw.verification;

  if (!verification || typeof verification !== "object") {
    throw new Error(`Missing verification object in: ${inputPath}`);
  }

  const orderedKeys = [
    "teamVesting",
    "advisorVesting",
    "xpgn",
    "farmController",
    "rewardDripperEscrow",
    "factory",
    "routerAdmin",
    "router",
    "routerGuard",
    "bestExecution",
    "lpFlowRebates",
    "treasurySplitter",
    "payflowExecutor",
    "adapter",
    "zapV2",
  ];

  console.log(`# Verification bundle: ${inputPath}`);
  console.log(`# Network: ${raw.network} (${raw.chainId})`);
  console.log("");
  console.log('$env:BSCSCAN_API_KEY="YOUR_BSCSCAN_API_KEY"');
  console.log("");

  for (const key of orderedKeys) {
    const entry = verification[key];
    if (!entry) continue;

    const parts = [
      "npx",
      "hardhat",
      "verify",
      "--network",
      raw.network || "bsc",
      "--contract",
      shellEscape(entry.fullyQualifiedName),
      entry.address,
      ...(entry.constructorArgs || []).map(shellEscape),
    ];

    console.log(`# ${key}`);
    console.log(parts.join(" "));
    console.log("");
  }
}

main();
