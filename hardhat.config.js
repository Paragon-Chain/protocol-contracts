require("dotenv").config();
const fs = require("fs");
const path = require("path");

const deployEnvFile = process.env.DEPLOY_ENV_FILE || "";
if (deployEnvFile) {
  const deployEnvPath = path.resolve(__dirname, deployEnvFile);
  if (fs.existsSync(deployEnvPath)) {
    require("dotenv").config({ path: deployEnvPath, override: true });
  }
}

require("@nomicfoundation/hardhat-toolbox");
require("@nomicfoundation/hardhat-verify");
require("solidity-coverage");
require("hardhat-abi-exporter");

const tasksDir = path.join(__dirname, "scripts", "tasks");

for (const f of ["flash.js", "flash-entertainer.js"]) {
  const p = path.join(tasksDir, f);
  if (fs.existsSync(p)) {
    require(p);
  } else {
    console.warn(`Optional task not found: ${p}`);
  }
}

const {
  BSC_MAINNET_RPC_URL,
  BSC_TESTNET_RPC_URL,
  PRIVATE_KEY,
  BSCSCAN_API_KEY,
  FORK,
  FORK_URL,
  USE_IR,
  OPTIMIZER_ENABLED,
  OPTIMIZER_RUNS,
} = process.env;

const truthy = (v) =>
  !!v && !["0", "false", "False", "FALSE", ""].includes(String(v).trim());

const useIR = USE_IR ? truthy(USE_IR) : true;
const optimizerEnabled = OPTIMIZER_ENABLED ? truthy(OPTIMIZER_ENABLED) : true;
const optimizerRuns = Number(OPTIMIZER_RUNS || 200);
const resolvedForkUrl = (FORK_URL || BSC_MAINNET_RPC_URL || "").trim();
const enableFork = truthy(FORK) && !!resolvedForkUrl;

/** @type {import("hardhat/config").HardhatUserConfig} */
module.exports = {
  solidity: {
    compilers: [
      {
        version: "0.8.25",
        settings: {
          optimizer: {
            enabled: optimizerEnabled,
            runs: optimizerRuns,
          },
          viaIR: useIR,
        },
      },
      {
        version: "0.8.27",
        settings: {
          optimizer: {
            enabled: optimizerEnabled,
            runs: optimizerRuns,
          },
          viaIR: useIR,
        },
      },
    ],
    overrides: {},
  },

  networks: {
    hardhat: {
      chainId: 31337,
      ...(enableFork
        ? {
            forking: {
              url: resolvedForkUrl,
            },
          }
        : {}),
    },

    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },

    bsc: {
      url: BSC_MAINNET_RPC_URL || "",
      chainId: 56,
      gasPrice: 3000000000,
      ...(PRIVATE_KEY ? { accounts: [PRIVATE_KEY] } : {}),
    },

    bscTestnet: {
      url: BSC_TESTNET_RPC_URL || "",
      chainId: 97,
      gasPrice: 1000000000,
      ...(PRIVATE_KEY ? { accounts: [PRIVATE_KEY] } : {}),
    },
  },

  paths: {
    sources: "contracts",
    tests: "test",
    cache: "cache",
    artifacts: "artifacts",
  },

  etherscan: {
    apiKey: BSCSCAN_API_KEY || process.env.ETHERSCAN_API_KEY || "",
  },

  abiExporter: {
    path: "./abis",
    runOnCompile: true,
    clear: true,
    flat: false,
    format: "json",
    spacing: 2,
    only: [
      ":(Paragon.*)$",
      ":(LPFlowRebates)$",
      ":(ParagonLockerCollector)$",
      ":(TreasurySplitter)$",
      ":(ChainlinkUsdValuer)$",
      ":(ReputationOperator)$",
      ":(ParagonReputation)$",
      ":(XPGNToken)$",
      ":(RewardDripperEscrow)$",
      ":(VoterEscrow)$",
      ":(GaugeController)$",
      ":(GaugeEmitter)$",
      ":(SimpleGauge)$",
      ":(EmissionsMinter)$",
      ":(FeeDistributorERC20)$",
      ":(TraderRewardsLocker)$",
      ":(RevenueRouter)$",
      ":(UsagePoints)$",
      ":(UsagePointsAdapter)$",
      ":(UnifiedEmissionsDistributor)$",
      ":(FarmUsageAdapter)$",
      ":(LiquidityUsageAdapter)$",
      ":(SignedUsageAdapterBase)$",
      ":(AgentMarket)$",
      ":(ParagonAgentExecutor)$",
      ":(ParagonAgentRegistry)$",
      ":(ParagonAgentGuardBasic)$",
    ],
  },

  gasReporter: {
    enabled: true,
    currency: "USD",
  },

  mocha: {
    timeout: 120000,
  },
};
