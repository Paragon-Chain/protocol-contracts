# Architecture Overview

ParagonChain organizes smart contracts by protocol domain so each product area has a clear responsibility boundary while still fitting into one coherent release process.

## Exchange

The exchange module contains the core AMM stack:

- factory and pair creation
- router execution paths
- oracle and guard rails
- zap-style liquidity helpers

This is the liquidity and swap backbone for user-facing trading flows.

## Payflow

The payflow module is the protocol's execution and settlement layer for routed intents and surplus-aware swaps. It handles:

- best-execution style intent validation
- relayer-assisted execution
- surplus and rebate splitting
- value accounting through USD valuation helpers

## DAO

The DAO module covers governance and long-tail protocol incentives:

- voting escrow
- gauge and emissions systems
- fee distribution
- usage points and reward routing
- reputation and governance power components

## Agents

The agents module provides rails for agent registry, execution permissions, and commercial interaction patterns. It is meant to support agent-native product expansion without mixing those responsibilities into the exchange or DAO core.

## Treasury

The treasury module contains custody-adjacent reward distribution primitives, especially components that stage or drip value into the rest of the system under explicit ownership and access controls.

## XPGN token

The XPGN token sits as a shared protocol dependency. It is separated from exchange and DAO source folders because it supports both trading and governance use cases.

