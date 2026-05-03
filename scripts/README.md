# Scripts

This directory contains deployment, upgrade, verification, and operational scripts for the approved protocol modules in this repository.

## Expectations

- Prefer idempotent deployment workflows where possible.
- Keep secrets in environment files, never in source.
- Treat scripts that modify mainnet state as release-sensitive operational code.

