# Deployments

This directory is the public registry for approved ParagonChain contract deployments.

It exists to make the live protocol surface easy to understand for:

- users
- integrators
- auditors
- ecosystem partners
- internal contributors working across modules

## What Belongs Here

Only publish deployment data that is safe and intended for disclosure.

That includes:

- canonical live contract addresses
- network-by-network deployment registries
- verification links
- status notes such as `active`, `legacy`, `paused`, or `pending migration`
- release references for major deployment milestones

## What Should Not Be Committed

Do not commit:

- private deployment logs
- undisclosed addresses
- secrets
- scratch outputs from local testing
- environment-specific operational notes that are not meant for publication

## Registry Files

- [Mainnet Registry](./MAINNET.md)

As additional approved networks go live, add separate registry files here using the same format.
