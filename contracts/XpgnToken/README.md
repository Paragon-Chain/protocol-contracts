# XPGN Token

This directory holds the protocol token contract used across exchange, governance, and incentive systems.

## Why this module exists

XPGN is a shared protocol dependency rather than an exchange-only or DAO-only contract. Keeping it isolated makes tokenomics review cleaner and avoids hiding token-level privileges inside unrelated product folders.

## What is here

- `XPGNToken.sol`: capped governance token with role-based mint buckets, permit support, voting extensions, and pause controls

## Trust model

- Role assignment and bucket mint controls define the token's economic security model.
- Vesting recipients, treasury roles, and validator minting controls should be reviewed before each production release.

