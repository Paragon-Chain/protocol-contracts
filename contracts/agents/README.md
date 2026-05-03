# Agents

The agents module provides infrastructure for agent-native products inside the Paragon ecosystem.

## Why this module exists

Agent products need their own execution and permission model. This module keeps agent registry, execution approvals, and marketplace logic separate from the exchange and DAO cores so that agent risk can be reasoned about independently.

## What is here

- `ParagonAgentRegistry.sol`: registry of agent identities or permissions
- `ParagonAgentExecutor.sol`: controlled execution path for agent actions
- `ParagonAgentGuardBasic.sol`: baseline policy enforcement
- `AgentMarket.sol`: marketplace-oriented monetization primitive

## Trust model

- Executor permissions and signature validation are the primary risk surface.
- Guard logic determines what agents are allowed to do.
- Marketplace settlement should be reviewed alongside registry and execution assumptions.

