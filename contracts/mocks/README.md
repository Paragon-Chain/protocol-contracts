# Mocks

This directory contains non-production contracts used for local testing and regression coverage.

## Why this module exists

Complex protocol systems are much easier to test when routers, farms, fee-on-transfer tokens, relayers, reward sinks, and reentrancy conditions can be simulated directly.

## Usage

- Safe for local tests
- Not intended for deployment to production environments
- Should be reviewed only as test infrastructure, not as protocol release targets

