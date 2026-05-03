# DAO

The DAO module contains Paragon's governance and incentive infrastructure.

## Why this module exists

Liquidity, emissions, rewards, and protocol governance all need explicit on-chain coordination. This module groups the contracts that govern voting power, emissions, fee distribution, usage incentives, and protocol reputation systems.

## What is here

- `VoterEscrow.sol`: vote-locking and governance weight primitive
- `GaugeController.sol` and `SimpleGauge.sol`: gauge weighting and rewards allocation
- `EmissionsMinter.sol` and `UnifiedEmissionsDistributor.sol`: emissions issuance and distribution
- `FeeDistributorERC20.sol` and `RevenueRouter.sol`: revenue routing and rewards distribution
- `UsagePoints*.sol` and adapters: usage-driven incentive primitives
- `ParagonReputation.sol` and `ReputationOperator.sol`: protocol reputation and action accounting

## Trust model

- Ownership and pauser roles carry major economic power.
- Emissions and fee-routing contracts should be reviewed as one system, not one file at a time.
- Integrators should check voting escrow and gauge assumptions before relying on emissions flows.

