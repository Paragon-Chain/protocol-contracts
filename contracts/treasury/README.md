# Treasury

The treasury module contains custody-adjacent value handling primitives.

## Why this module exists

Protocol rewards and treasury-directed emissions often need a staging layer instead of direct mint-or-transfer flows. This module isolates those mechanics so treasury logic can evolve without being tangled into unrelated products.

## What is here

- `RewardDripperEscrow.sol`: escrow contract for staged reward distribution

## Trust model

- Treasury ownership and release permissions matter more than code size here.
- Integrators should review how the escrow connects to emissions, gauges, or downstream reward systems.

