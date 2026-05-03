const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

dotenv.config();

const deployEnvFile = process.env.DEPLOY_ENV_FILE || ".env.mainnet";
const deployEnvPath = path.join(__dirname, "..", deployEnvFile);
if (fs.existsSync(deployEnvPath)) {
  dotenv.config({ path: deployEnvPath, override: true });
}

const hre = require("hardhat");
const { ethers } = hre;

const DEFAULTS = {
  NETWORK_NAME: "bsc",
  CHAIN_ID: 56,
  FACTORY_ADDRESS: "0x20c7838d1010d1766778DC74d3703EbD4Da21d8A",
  ROUTER_ADMIN_ADDRESS: "0x9c525FF7D0E41695CD1e942B0A85088b3C382859",
  ROUTER_GUARD_ADDRESS: "0xE4685fb1fba78A9d8e23e009f3336674F1ec6be6",
  DEPLOYER_ADDRESS: "0x8e227a39c88D870Bdc4Ce962B83Cf11B5Df9D0D3",
  TIMELOCK_ADDRESS: "0xcc88881ee4F0fb3477B02979a325eDD91d306F72",
  WNATIVE_ADDRESS: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  USDT_ADDRESS: "0x55d398326f99059ff775485246999027b3197955",
  USDC_ADDRESS: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
  FDUSD_ADDRESS: "0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409",
  BTCB_ADDRESS: "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c",
  ETH_ADDRESS: "0x2170ed0880ac9a755fd29b2688956bd959f933f8",
  CAKE_ADDRESS: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82",
  SOL_ADDRESS: "0x570a5d26f7765ecb712c0924e4de545b89fd43df",
  DOGE_ADDRESS: "0xba2ae424d960c26247dd6c32edc70b295c744c43",
  ADA_ADDRESS: "0x3ee2200efb3400fabb9aacf31297cbdd1d435d47",
  TRX_ADDRESS: "0xce7de646e7208a4ef112cb6ed5038fa6cc6b12e3",
  LINK_ADDRESS: "0xf8a0bf9cf54bb92f17374d9e9a321e6a111a51bd",
  XRP_ADDRESS: "0x1d2f0da169ceb9fc7b3144628db156f3f6c60dbe",
  SHIB_ADDRESS: "0x2859e4544c4bb03966803b044a93563bd2d0dd4d",
  ORACLE_ENABLE_TWAP: "false",
  ORACLE_CONFIGURE_ROUTER_ADMIN: "true",
  ORACLE_SET_BASE_TOKENS: "true",
  ORACLE_DEFAULT_STALENESS: "86400",
  ORACLE_DEFAULT_TWAP_WINDOW: "600",
  ORACLE_MIN_OBSERVATION_PERIOD: "60",
  ORACLE_TRANSFER_OWNERSHIP_TO: "",
  ORACLE_PROTECTED_TOKENS: "",
  ORACLE_SET_PROTECTED_FROM_FEEDS: "true",
  ORACLE_UPDATERS: "",
  ORACLE_WARM_PAIRS: "",
  CONFIRM_MAINNET_DEPLOY: "",
};

const TOKEN_CONFIG = [
  { symbol: "WBNB", tokenEnv: "WNATIVE_ADDRESS", feedEnv: "FEED_WBNB", staleEnv: "STALE_WBNB" },
  { symbol: "USDT", tokenEnv: "USDT_ADDRESS", feedEnv: "FEED_USDT", staleEnv: "STALE_USDT" },
  { symbol: "USDC", tokenEnv: "USDC_ADDRESS", feedEnv: "FEED_USDC", staleEnv: "STALE_USDC" },
  { symbol: "FDUSD", tokenEnv: "FDUSD_ADDRESS", feedEnv: "FEED_FDUSD", staleEnv: "STALE_FDUSD" },
  { symbol: "BTCB", tokenEnv: "BTCB_ADDRESS", feedEnv: "FEED_BTCB", staleEnv: "STALE_BTCB" },
  { symbol: "ETH", tokenEnv: "ETH_ADDRESS", feedEnv: "FEED_ETH", staleEnv: "STALE_ETH" },
  { symbol: "CAKE", tokenEnv: "CAKE_ADDRESS", feedEnv: "FEED_CAKE", staleEnv: "STALE_CAKE" },
  { symbol: "SOL", tokenEnv: "SOL_ADDRESS", feedEnv: "FEED_SOL", staleEnv: "STALE_SOL" },
  { symbol: "DOGE", tokenEnv: "DOGE_ADDRESS", feedEnv: "FEED_DOGE", staleEnv: "STALE_DOGE" },
  { symbol: "ADA", tokenEnv: "ADA_ADDRESS", feedEnv: "FEED_ADA", staleEnv: "STALE_ADA" },
  { symbol: "TRX", tokenEnv: "TRX_ADDRESS", feedEnv: "FEED_TRX", staleEnv: "STALE_TRX" },
  { symbol: "LINK", tokenEnv: "LINK_ADDRESS", feedEnv: "FEED_LINK", staleEnv: "STALE_LINK" },
  { symbol: "XRP", tokenEnv: "XRP_ADDRESS", feedEnv: "FEED_XRP", staleEnv: "STALE_XRP" },
  { symbol: "SHIB", tokenEnv: "SHIB_ADDRESS", feedEnv: "FEED_SHIB", staleEnv: "STALE_SHIB" },
];

const DEFAULT_PAIR_MATRIX = [
  ["WBNB", "USDT"],
  ["WBNB", "USDC"],
  ["WBNB", "FDUSD"],
  ["USDT", "USDC"],
  ["USDT", "FDUSD"],
  ["USDC", "FDUSD"],
  ["BTCB", "WBNB"],
  ["BTCB", "USDT"],
  ["BTCB", "USDC"],
  ["BTCB", "FDUSD"],
  ["ETH", "WBNB"],
  ["ETH", "USDT"],
  ["ETH", "USDC"],
  ["ETH", "FDUSD"],
  ["CAKE", "WBNB"],
  ["CAKE", "USDT"],
  ["CAKE", "USDC"],
  ["CAKE", "FDUSD"],
  ["XPGN", "WBNB"],
  ["XPGN", "USDT"],
  ["XPGN", "USDC"],
  ["XPGN", "FDUSD"],
  ["SOL", "USDT"],
  ["DOGE", "USDT"],
  ["ADA", "USDT"],
  ["TRX", "USDT"],
  ["LINK", "USDT"],
  ["XRP", "USDT"],
  ["SHIB", "USDT"],
  ["SOL", "WBNB"],
  ["DOGE", "WBNB"],
  ["ADA", "WBNB"],
  ["TRX", "WBNB"],
  ["LINK", "WBNB"],
  ["XRP", "WBNB"],
  ["SHIB", "WBNB"],
];

function env(name, fallback = "") {
  const value = process.env[name];
  if (value !== undefined && String(value).trim() !== "") return String(value).trim();
  if (fallback !== undefined) return String(fallback);
  return "";
}

function req(name, fallback = undefined) {
  const value = env(name, fallback);
  if (!value) throw new Error(`Missing env var: ${name}`);
  return value;
}

function boolEnv(name, fallback = "false") {
  return ["1", "true", "yes", "on"].includes(env(name, fallback).toLowerCase());
}

function intEnv(name, fallback) {
  const raw = env(name, fallback);
  if (!/^\d+$/.test(String(raw))) {
    throw new Error(`Env ${name} must be an integer string`);
  }
  return Number(raw);
}

function addr(name, fallback = undefined, allowZero = false) {
  const raw = req(name, fallback);
  let parsed;
  try {
    parsed = ethers.getAddress(raw);
  } catch {
    throw new Error(`Env ${name} must be a valid address: ${raw}`);
  }
  if (!allowZero && parsed === ethers.ZeroAddress) {
    throw new Error(`Env ${name} must be a non-zero address`);
  }
  return parsed;
}

function addrList(name, fallback = "") {
  const raw = env(name, fallback);
  if (!raw) return [];
  const seen = new Set();
  const result = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const parsed = ethers.getAddress(trimmed);
    const key = parsed.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(parsed);
    }
  }
  return result;
}

function parsePairList(name, fallback = "") {
  const raw = env(name, fallback);
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [left, right] = part.split("/").map((x) => x.trim().toUpperCase());
      if (!left || !right) {
        throw new Error(`Env ${name} contains invalid pair entry: ${part}`);
      }
      return [left, right];
    });
}

async function saveJSON(file, obj) {
  const normalized = JSON.parse(
    JSON.stringify(obj, (_, value) => (typeof value === "bigint" ? value.toString() : value))
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(normalized, null, 2));
  console.log(`Saved -> ${file}`);
}

async function buildVerificationEntry(factoryRef, addressValue, constructorArgs) {
  const artifact = await hre.artifacts.readArtifact(factoryRef);
  const fullyQualifiedName = `${artifact.sourceName}:${artifact.contractName}`;
  const buildInfo = await hre.artifacts.getBuildInfo(fullyQualifiedName);
  const compiledContract =
    buildInfo?.output?.contracts?.[artifact.sourceName]?.[artifact.contractName];

  return {
    address: addressValue,
    contractName: artifact.contractName,
    sourceName: artifact.sourceName,
    fullyQualifiedName,
    constructorArgs,
    compiler: {
      solcVersion: buildInfo?.solcVersion || null,
      optimizer: buildInfo?.input?.settings?.optimizer || null,
      viaIR:
        typeof buildInfo?.input?.settings?.viaIR === "boolean"
          ? buildInfo.input.settings.viaIR
          : null,
      evmVersion: buildInfo?.input?.settings?.evmVersion || null,
    },
    metadata: compiledContract?.metadata || null,
  };
}

async function maybeWait(txPromise, label) {
  const tx = await txPromise;
  console.log(`-> ${label}: ${tx.hash}`);
  await tx.wait();
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);

  if (chainId !== DEFAULTS.CHAIN_ID) {
    throw new Error(`Wrong chain. Expected ${DEFAULTS.CHAIN_ID}, got ${chainId}`);
  }

  const confirm = env("CONFIRM_MAINNET_DEPLOY", DEFAULTS.CONFIRM_MAINNET_DEPLOY);
  if (confirm !== "DEPLOY_PARAGON_ORACLE") {
    throw new Error(
      'Set CONFIRM_MAINNET_DEPLOY=DEPLOY_PARAGON_ORACLE before running this script on mainnet'
    );
  }

  const expectedDeployer = addr("EXPECTED_DEPLOYER", DEFAULTS.DEPLOYER_ADDRESS);
  if (deployerAddr.toLowerCase() !== expectedDeployer.toLowerCase()) {
    throw new Error(`Unexpected deployer ${deployerAddr}. Expected ${expectedDeployer}`);
  }

  const factoryAddr = addr("FACTORY_ADDRESS", DEFAULTS.FACTORY_ADDRESS);
  const routerAdminAddr = addr("ROUTER_ADMIN_ADDRESS", DEFAULTS.ROUTER_ADMIN_ADDRESS);
  const routerGuardAddr = addr("ROUTER_GUARD_ADDRESS", DEFAULTS.ROUTER_GUARD_ADDRESS);
  const usdtAddr = addr("USDT_ADDRESS", DEFAULTS.USDT_ADDRESS);
  const wbnbAddr = addr("WNATIVE_ADDRESS", DEFAULTS.WNATIVE_ADDRESS);
  const enableTwap = boolEnv("ORACLE_ENABLE_TWAP", DEFAULTS.ORACLE_ENABLE_TWAP);
  const configureRouterAdmin = boolEnv(
    "ORACLE_CONFIGURE_ROUTER_ADMIN",
    DEFAULTS.ORACLE_CONFIGURE_ROUTER_ADMIN
  );
  const setProtectedFromFeeds = boolEnv(
    "ORACLE_SET_PROTECTED_FROM_FEEDS",
    DEFAULTS.ORACLE_SET_PROTECTED_FROM_FEEDS
  );
  const setBaseTokens = boolEnv("ORACLE_SET_BASE_TOKENS", DEFAULTS.ORACLE_SET_BASE_TOKENS);
  const defaultStaleness = intEnv("ORACLE_DEFAULT_STALENESS", DEFAULTS.ORACLE_DEFAULT_STALENESS);
  const defaultTwapWindow = intEnv(
    "ORACLE_DEFAULT_TWAP_WINDOW",
    DEFAULTS.ORACLE_DEFAULT_TWAP_WINDOW
  );
  const minObservationPeriod = intEnv(
    "ORACLE_MIN_OBSERVATION_PERIOD",
    DEFAULTS.ORACLE_MIN_OBSERVATION_PERIOD
  );
  const protectedTokens = addrList("ORACLE_PROTECTED_TOKENS", DEFAULTS.ORACLE_PROTECTED_TOKENS);
  const updaterAddrs = addrList("ORACLE_UPDATERS", DEFAULTS.ORACLE_UPDATERS);
  const warmPairs = parsePairList("ORACLE_WARM_PAIRS", DEFAULTS.ORACLE_WARM_PAIRS);
  const transferOwnershipTo = env(
    "ORACLE_TRANSFER_OWNERSHIP_TO",
    DEFAULTS.ORACLE_TRANSFER_OWNERSHIP_TO
  );
  const tokenAddressBySymbol = Object.fromEntries(
    TOKEN_CONFIG.map((token) => [token.symbol, addr(token.tokenEnv, DEFAULTS[token.tokenEnv])])
  );

  console.log(`Network: ${DEFAULTS.NETWORK_NAME} (${chainId})`);
  console.log(`Deployer: ${deployerAddr}`);
  console.log(`Factory: ${factoryAddr}`);
  console.log(`RouterAdmin: ${routerAdminAddr}`);
  console.log(`RouterGuard: ${routerGuardAddr}`);
  console.log(`Canonical bases: USDT=${usdtAddr}, WBNB=${wbnbAddr}`);
  console.log(`Current pair universe tracked: ${DEFAULT_PAIR_MATRIX.length} pairs`);

  const routerAdmin = await ethers.getContractAt("ParagonRouterAdmin", routerAdminAddr, deployer);
  const routerGuard = await ethers.getContractAt("ParagonRouterGuard", routerGuardAddr, deployer);

  const oracleLibFactory = await ethers.getContractFactory("ParagonOracleLibrary");
  const oracleLib = await oracleLibFactory.deploy();
  await oracleLib.waitForDeployment();
  const oracleLibAddr = await oracleLib.getAddress();
  console.log(`✅ ParagonOracleLibrary: ${oracleLibAddr}`);

  const oracleFactory = await ethers.getContractFactory("ParagonOracle", {
    libraries: { ParagonOracleLibrary: oracleLibAddr },
  });
  const oracle = await oracleFactory.deploy(factoryAddr);
  await oracle.waitForDeployment();
  const oracleAddr = await oracle.getAddress();
  console.log(`✅ ParagonOracle: ${oracleAddr}`);

  if (setBaseTokens) {
    await maybeWait(oracle.setBaseTokens(usdtAddr, wbnbAddr), "oracle.setBaseTokens");
  }

  if (defaultTwapWindow !== 600) {
    await maybeWait(
      oracle.setDefaultTwapTimeWindow(defaultTwapWindow),
      "oracle.setDefaultTwapTimeWindow"
    );
  }

  if (minObservationPeriod !== 60) {
    await maybeWait(
      oracle.setMinObservationPeriod(minObservationPeriod),
      "oracle.setMinObservationPeriod"
    );
  }

  const configuredFeeds = [];
  const autoProtected = new Set();
  for (const token of TOKEN_CONFIG) {
    const tokenAddr = tokenAddressBySymbol[token.symbol];
    const feedRaw = env(token.feedEnv, "");
    if (!feedRaw) continue;

    const feedAddr = ethers.getAddress(feedRaw);
    const staleness = intEnv(token.staleEnv, String(defaultStaleness));
    await maybeWait(
      oracle.setChainlinkFeed(tokenAddr, feedAddr, staleness),
      `oracle.setChainlinkFeed(${token.symbol})`
    );
    configuredFeeds.push({
      symbol: token.symbol,
      token: tokenAddr,
      feed: feedAddr,
      staleness,
    });
    if (setProtectedFromFeeds) autoProtected.add(tokenAddr.toLowerCase());
  }

  for (const updater of updaterAddrs) {
    await maybeWait(oracle.setUpdater(updater, true), `oracle.setUpdater(${updater})`);
  }

  if (configureRouterAdmin) {
    await maybeWait(
      routerAdmin.configureTwapOracle(oracleAddr, enableTwap),
      `routerAdmin.configureTwapOracle(enabled=${enableTwap})`
    );
  }

  const protectedSet = new Set(protectedTokens.map((tokenAddr) => tokenAddr.toLowerCase()));
  for (const tokenAddrLower of autoProtected) protectedSet.add(tokenAddrLower);

  for (const tokenAddrLower of protectedSet) {
    const tokenAddr = ethers.getAddress(tokenAddrLower);
    await maybeWait(
      routerGuard.setProtectedToken(tokenAddr, true),
      `routerGuard.setProtectedToken(${tokenAddr})`
    );
  }

  const warmedPairs = [];
  for (const [left, right] of warmPairs) {
    const leftAddr = tokenAddressBySymbol[left];
    const rightAddr = tokenAddressBySymbol[right];
    if (!leftAddr || !rightAddr) {
      throw new Error(`Unknown warm pair symbol: ${left}/${right}`);
    }
    try {
      await maybeWait(
        oracle.updateObservation(leftAddr, rightAddr),
        `oracle.updateObservation(${left}/${right})`
      );
      warmedPairs.push([left, right]);
    } catch (error) {
      console.log(`-> warm pair skipped for ${left}/${right}: ${error?.shortMessage || error?.message}`);
    }
  }

  if (transferOwnershipTo) {
    const newOwner = ethers.getAddress(transferOwnershipTo);
    if (newOwner !== ethers.ZeroAddress && newOwner.toLowerCase() !== deployerAddr.toLowerCase()) {
      await maybeWait(oracle.transferOwnership(newOwner), `oracle.transferOwnership(${newOwner})`);
    }
  }

  const deployment = {
    network: DEFAULTS.NETWORK_NAME,
    chainId: DEFAULTS.CHAIN_ID,
    generatedAt: new Date().toISOString(),
    deployEnvFile,
    deployer: deployerAddr,
    defaultsConfirmedAgainst: {
      betaDeploymentFile: "deployments/bscMainnet-paragon-beta-staging.json",
      factory: DEFAULTS.FACTORY_ADDRESS,
      routerAdmin: DEFAULTS.ROUTER_ADMIN_ADDRESS,
      routerGuard: DEFAULTS.ROUTER_GUARD_ADDRESS,
      timelock: DEFAULTS.TIMELOCK_ADDRESS,
    },
    addresses: {
      oracleLibrary: oracleLibAddr,
      oracle: oracleAddr,
      factory: factoryAddr,
      routerAdmin: routerAdminAddr,
      routerGuard: routerGuardAddr,
      usdt: usdtAddr,
      wbnb: wbnbAddr,
    },
    config: {
      baseTokensSet: setBaseTokens,
      routerAdminConfigured: configureRouterAdmin,
      enableTwap,
      setProtectedFromFeeds,
      defaultTwapWindow,
      minObservationPeriod,
      defaultStaleness,
      updaters: updaterAddrs,
      protectedTokens: Array.from(protectedSet).map((tokenAddr) => ethers.getAddress(tokenAddr)),
      feeds: configuredFeeds,
      warmedPairs,
      trackedPairs: DEFAULT_PAIR_MATRIX,
    },
    notes: {
      pythSupport:
        "Use Pyth wrapper or mux adapter addresses here, not the raw Pyth core contract. ParagonOracle expects AggregatorV3Interface-compatible feeds.",
    },
  };

  const verification = {
    network: DEFAULTS.NETWORK_NAME,
    chainId: DEFAULTS.CHAIN_ID,
    generatedAt: new Date().toISOString(),
    deployEnvFile,
    verification: {
      oracleLibrary: await buildVerificationEntry("ParagonOracleLibrary", oracleLibAddr, []),
      oracle: await buildVerificationEntry("ParagonOracle", oracleAddr, [factoryAddr]),
    },
  };

  const deploymentFile = path.join(__dirname, "..", "deployments", "bscMainnet-paragon-oracle.json");
  const verifyFile = path.join(
    __dirname,
    "..",
    "deployments",
    "bscMainnet-paragon-oracle.verify.json"
  );

  await saveJSON(deploymentFile, deployment);
  await saveJSON(verifyFile, verification);

  console.log("");
  console.log("Oracle deployment complete.");
  console.log(`Deployment file: ${deploymentFile}`);
  console.log(`Verification file: ${verifyFile}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
