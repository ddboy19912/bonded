# Developing Bonded

How to build, test and run Bonded on your own machine. The project overview is in the [README](../README.md), and how the parts fit together is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Quick start

Steps 1 to 3 need no keys, accounts or network access beyond installing dependencies.

### 1. Install the tools

| Tool | Version | Install |
|---|---|---|
| Node.js | 22.12 or newer | [nodejs.org](https://nodejs.org) |
| pnpm | 10 | `corepack enable` (ships with Node) |
| Foundry (`forge`, `anvil`, `cast`) | latest | `curl -L https://foundry.paradigm.xyz \| bash`, then `foundryup` |

### 2. Get the code and build it

```bash
git clone --recursive https://github.com/ddboy19912/bonded
cd bonded
pnpm install
pnpm build            # TypeScript packages
pnpm contracts:build  # Solidity contracts
```

If you cloned without `--recursive`, run `git submodule update --init --recursive` first. The contracts need their libraries.

### 3. Run it locally

These commands use a local chain (anvil) and its public test accounts. They never touch a real network and never read `.env`.

```bash
pnpm test             # all TypeScript tests
pnpm contracts:test   # all contract tests
pnpm demo             # the full demo on a local chain, then the web app on http://localhost:5180
pnpm arena --list     # the attack library
pnpm arena run        # every attack against vulnerable-agent
pnpm arena rate       # a full rating: score, report, attestation, dataset
```

`pnpm demo` starts a local chain, the API, the keeper and the worker. It rates Agent A and Agent B, buys cover, and plants an address-poisoning attack. Agent A falls for it and the keeper's claim pays out, from the bond first and then the pool. Ctrl-C stops everything.

`pnpm arena rate --help` lists its flags, such as `--agent`, `--model`, `--enforce` and `--repeats`.

## Checks before a pull request

```bash
pnpm format:check && pnpm --filter @bondedhq/shared abis:check && pnpm typecheck && pnpm lint && pnpm test
cd contracts/evm && forge fmt --check && forge test
```

The troubleshooting page ([TROUBLESHOOTING.md](TROUBLESHOOTING.md)) is generated from `packages/shared/src/problems.ts`. After changing that file, run `pnpm docs:troubleshooting`. `pnpm test` fails while the committed page is out of date.

## Going further

The full [developer reference](DEVELOPING-REFERENCE.md) is in the repository: every local demo and Arena command, settings in `.env`, testnet runs, the API and keeper, the web app, deploying, Solana programs and TEE key custody.

## The documentation site

`apps/docs` is a [Starlight](https://starlight.astro.build) (Astro) site, published at docs.bondedhq.xyz. It is generated from the Markdown in this repository (the README, `docs/` and the contracts' READMEs), so edit those files, not the site. Links between docs become links between pages. A link to code, or a path in backticks, becomes a link to that file on GitHub.

```bash
pnpm docs:dev                 # the site on http://localhost:4321
pnpm --filter @bonded/docs build
```

To make a local web app link to a local docs site, set `VITE_DOCS_URL=http://localhost:4321`.
