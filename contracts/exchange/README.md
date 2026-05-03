# Exchange

The exchange module contains the core Paragon DEX building blocks.

## Why this module exists

Paragon needs a dedicated liquidity and swapping layer that can support product flows across the wider ecosystem. The exchange contracts define the AMM primitives, trading path validation, admin controls, and oracle integrations used by the protocol.

## What is here

- `ParagonFactory.sol`: pair creation and factory-level controls
- `ParagonPair.sol`: AMM pair logic and reserve accounting
- `ParagonRouter.sol`: user-facing swap and liquidity routing
- `ParagonRouterAdmin.sol`: administrative router controls
- `ParagonRouterGuard.sol`: policy and guardrail layer
- `ParagonOracle.sol`: on-chain pricing and oracle-related helpers
- `ParagonZapV2.sol`: convenience flows for entering liquidity positions
- `interfaces/` and `libraries/`: shared exchange abstractions and math

## Trust model

- Factory and router ownership should be reviewed carefully before each release.
- Guard and admin contracts define important operational powers.
- Integrators should treat oracle and router controls as privileged surfaces.

