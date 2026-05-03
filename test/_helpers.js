const hre = require("hardhat");
const { ethers } = hre;

// Try multiple constructor arg sets until one works
async function deployWithFallback(factoryName, argLists) {
  const CF = await ethers.getContractFactory(factoryName);
  for (const args of argLists) {
    try {
      const c = await CF.deploy(...args);
      await c.waitForDeployment();
      return c;
    } catch {}
  }
  throw new Error(`No matching constructor for ${factoryName}`);
}

// Try a list of router swap fn names until one works
async function tryRouterSwap(router, user, amountIn, amountOutMin, path, to, deadline) {
  const fns = [
    "swapExactTokensForTokens",
    "swapExactTokensForTokensSupportingFeeOnTransferTokens",
    "swapExactTokensForTokensWithAutoYield", // if your router names it like this
  ];

  let lastErr;
  for (const fn of fns) {
    if (typeof router[fn] !== "function") continue;
    try {
      return await router.connect(user)[fn](amountIn, amountOutMin, path, to, deadline);
    } catch (e) {
      lastErr = e;
    }
  }

  // Helpful debug: list function names on the router
  const names = (router.interface.fragments || [])
    .filter(f => f.type === "function")
    .map(f => f.name);
  throw new Error(
    `No matching swap function. Tried ${fns.join(", ")}. Available: ${[...new Set(names)].join(", ")}\nLast error: ${lastErr}`
  );
}

module.exports = { deployWithFallback, tryRouterSwap };
