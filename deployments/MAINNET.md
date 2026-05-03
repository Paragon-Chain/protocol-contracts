# ParagonChain Mainnet Contract Registry

This file is the canonical public registry for **approved mainnet ParagonChain contracts**.

Use it to publish the verified live addresses that users, integrators, and reviewers should rely on.

## Network

- **Primary network:** BNB Smart Chain Mainnet
- **Status:** Active published deployment set

## Exchange

| Contract | Address | Status | Notes |
| --- | --- | --- | --- |
| ParagonFactory | `0x620532B3b0924b8F1159406EaAeF9bC40C7a4dcB` | Active | Canonical exchange factory |
| ParagonRouterAdmin | `0xFA0a83B7b1228498138c6886911699C86E5dB9BC` | Active | Router admin control surface |
| ParagonRouter | `0x67099552a0DA05581c87fdFBf440dfD00aBAf42C` | Active | Canonical exchange router |
| ParagonRouterGuard | `0xcfA053e89ffd1722684a6da260470B215Cc0bD3F` | Active | Router policy and guardrail layer |
| ParagonZapV2 | `0x1C86195BdB6bb5093a71872142d2070275502627` | Active | Liquidity helper and zap surface |

## Payflow

| Contract | Address | Status | Notes |
| --- | --- | --- | --- |
| ParagonBestExecutionV14 | `0xe90C4603c77F81cD532d5DE6060925aa5653d7b2` | Active | Best execution and routing layer |
| LPFlowRebates | `0x492390DdAF86c7492204F0403908c7013cD8EDAd` | Active | Rebate distribution component |
| ParagonPayflowExecutorV2 | `0x467Fe2D7E620A7842cbc1305fa932ce73E0F8dA7` | Active | Canonical payflow executor |

## DAO And Incentives

| Contract | Address | Status | Notes |
| --- | --- | --- | --- |
| ParagonFarmController | `0x54D6f77Cf2F03508a56a40c182a3a5FB403Dd7C2` | Active | Pool `0` created for XPGN; emissions paused; guardian granted |

## Treasury And Vesting

| Contract | Address | Status | Notes |
| --- | --- | --- | --- |
| TreasurySplitter | `0x55539349F07F9d680517aA01dec8db99fcce915A` | Active | Treasury distribution splitter |
| RewardDripperEscrow | `0x4DC07BB6cd804341D0B22Ac9c5087D81844eC827` | Active | Deployed with dripper rate set to `0` at publication time |
| TeamVesting | `0xc15Ec7880cf3b238e37c7f1f6cBEB2caa580AEa1` | Active | Vesting initialized; ownership retained by deployer |
| AdvisorVesting | `0xAC609E8D3eB7142482460cd7FFCEB588B0846392` | Active | Vesting initialized; ownership retained by deployer |

## Shared Infrastructure

| Contract | Address | Status | Notes |
| --- | --- | --- | --- |
| XPGN | `0x130A2eB49C8143EfA4547a10EbEA48BCf10a729A` | Active | Canonical protocol token |

## Release Notes

| Date | Network | Summary |
| --- | --- | --- |
| `2026-05-03` | BNB Smart Chain Mainnet | First published public mainnet registry for approved ParagonChain live contracts |
