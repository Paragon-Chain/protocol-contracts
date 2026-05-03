const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function shellArg(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

function main() {
  const inputArg =
    process.argv[2] || "deployments/bscMainnet-paragon-clean.verify.json";
  const inputPath = path.resolve(process.cwd(), inputArg);

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Verification bundle not found: ${inputPath}`);
  }

  const raw = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const verification = raw.verification;

  if (!verification || typeof verification !== "object") {
    throw new Error(`Missing verification object in: ${inputPath}`);
  }

  if (!process.env.BSCSCAN_API_KEY) {
    throw new Error("BSCSCAN_API_KEY is not set in the environment.");
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

  for (const key of orderedKeys) {
    const entry = verification[key];
    if (!entry) continue;

    const args = [
      "hardhat",
      "verify",
      "--network",
      raw.network || "bsc",
      "--contract",
      entry.fullyQualifiedName,
      entry.address,
      ...(entry.constructorArgs || []).map(shellArg),
    ];

    console.log(`\n=== Verifying ${key} @ ${entry.address} ===`);
    const result = spawnSync("npx", args, {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: true,
      env: process.env,
    });

    if (result.status !== 0) {
      throw new Error(`Verification failed for ${key} (${entry.address}).`);
    }
  }

  console.log("\nAll verification commands completed.");
}

try {
  main();
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
