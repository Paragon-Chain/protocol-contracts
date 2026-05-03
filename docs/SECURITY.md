# Security Notes

This repository is designed to hold approved protocol contracts, not every draft or experiment produced during development.

## Security posture

- Audit workspaces remain outside this repository.
- Sensitive deployment credentials must never be committed.
- Test mocks live in `contracts/mocks/` and are not production contracts.
- Admin, relayer, pauser, treasury, and minting powers should be documented before any public release.

## Review expectations

Before publishing or deploying a module from this repository:

- confirm the included contracts match the intended release set
- verify imported scripts do not expose secrets or operational shortcuts
- confirm deployment outputs are safe to publish
- tag audited or reviewed commits explicitly

## Public repo hygiene

- Keep unreleased ideas in private repos.
- Do not store raw audit notes here.
- Avoid mixing frozen snapshots with active product code.

