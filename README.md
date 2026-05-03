# ParagonChain Protocol Contracts

Clean source-of-truth repository for ParagonChain live smart contracts, deployment scripts, and tests.

This repository is intentionally separate from any audit workspace. Audit snapshots, sensitive review material, and experimental work should remain in private repositories or local workspaces until they are approved for release.

## Planned structure

- `contracts/`: production-ready Solidity contracts grouped by product area
- `scripts/`: deployment, upgrade, verification, and smoke-test scripts
- `test/`: local and fork-based test suites
- `deployments/`: deployment outputs and verification bundles approved for this repo
- `docs/`: architecture notes, addresses, and product-specific references safe for publication

## Product layout

The first recommended layout inside `contracts/` is:

- `exchange/`
- `payflow/`
- `dao/`
- `agents/`
- `treasury/`
- `ifo/`
- `shared/`

Keep unfinished or confidential products out of this repo until they are approved for inclusion.

