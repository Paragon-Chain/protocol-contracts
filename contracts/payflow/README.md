# Payflow

The payflow module is the execution and settlement layer for routed swap intents.

## Why this module exists

Basic swapping is not enough for higher-level product flows. Payflow adds intent execution, relayer coordination, best-execution logic, rebate handling, treasury splits, and user-centric surplus distribution so Paragon can support programmable payment and trading experiences.

## What is here

- best-execution contracts for signed intent flows
- payflow executor variants for routed settlement
- `LPFlowRebates.sol` for LP incentive distribution
- `TreasurySplitter.sol` and locker components for value routing
- valuation interfaces and helpers such as `ChainlinkUsdValuer.sol`

## Trust model

- Relayer permissions, signer validation, and pause/admin controls are critical.
- Valuation and rebate sinks influence protocol accounting and should be reviewed together.
- Update-oriented contracts should be treated as operational tooling, not automatically as canonical release targets.

