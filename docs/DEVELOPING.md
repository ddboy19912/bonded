# Developing Bonded

Everything you need to build, test and run Bonded yourself. The project overview is in the [README](../README.md); how the parts fit together is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Run it yourself

Everything below runs on your own machine. Steps 1–3 need no keys, accounts or network access beyond installing dependencies.

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

If you cloned without `--recursive`, run `git submodule update --init --recursive` first; the contracts need their libraries.

### 3. Try it locally (no keys needed)

These run on a local chain (anvil) with its public test accounts. They never touch a real network and never read `.env`.

```bash
pnpm test             # all TypeScript tests (starts local chains for the Arena's tests)
pnpm contracts:test   # all contract tests

pnpm demo             # THE demo, in one command: local chain, API, keeper and worker; rates
                      # Agent A and Agent B, buys cover, plants an address-poisoning attack,
                      # Agent A falls for it, the keeper's claim pays (bond first, then pool),
                      # then serves the web app at http://localhost:5180 (Ctrl-C stops it all)

pnpm arena --list     # the attack library
pnpm arena run        # every attack against vulnerable-agent
pnpm arena rate       # full rating: score, report, attestation, dataset
```

`pnpm arena rate` also takes flags: `--agent`, `--brain`, `--model`, `--enforce`, `--repeats`, `--max-usd` and more (`--help` lists them; the table is in [Settings in `.env`](DEVELOPING-REFERENCE.md#settings-in-env)). Every command for the local demos, including your own agent and a smart account, the Arena's batteries and where its output goes are in [Run it in more detail](DEVELOPING-REFERENCE.md#run-it-in-more-detail).

### Checks before a pull request

```bash
pnpm format:check && pnpm --filter @bondedhq/shared abis:check && pnpm typecheck && pnpm lint && pnpm test
cd contracts/evm && forge fmt --check && forge test
```

The troubleshooting page ([TROUBLESHOOTING.md](TROUBLESHOOTING.md)) is generated from the problem list in `packages/shared/src/problems.ts`: after changing it, run `pnpm docs:troubleshooting`. `pnpm test` fails while the committed page is out of date.

## Going further

The [developer reference](DEVELOPING-REFERENCE.md) has the rest:

- [Run it in more detail](DEVELOPING-REFERENCE.md#run-it-in-more-detail): every local demo and Arena command, the batteries a rating runs, and the testnet runs.
- [Settings in `.env`](DEVELOPING-REFERENCE.md#settings-in-env): language models, Arena flags, deploying contracts to a testnet.
- [Bring your own agent](DEVELOPING-REFERENCE.md#bring-your-own-agent): where the pieces live in the code, and their settings.
- [API, keeper and the Gate 1 loop](DEVELOPING-REFERENCE.md#api-keeper-and-the-gate-1-loop), the [web app](DEVELOPING-REFERENCE.md#web-app), [deploying](DEVELOPING-REFERENCE.md#deploying), [synthetic Sentinel data](DEVELOPING-REFERENCE.md#synthetic-sentinel-data), [Solana programs](DEVELOPING-REFERENCE.md#solana-programs) and [TEE key custody](DEVELOPING-REFERENCE.md#tee-key-custody).

## The documentation site

`apps/docs` is a [Starlight](https://starlight.astro.build) (Astro) site served at `/docs` on the web app. It is generated from the Markdown in this repository (the README, `docs/`, the contracts' READMEs), so edit those files, not the site. Links between docs become links between pages; a link to code, or a path in backticks, becomes a link to that file on GitHub. Evidence files that notes cite are published under `/docs/evidence/`.

```bash
pnpm docs:dev                 # the site on http://localhost:4321/docs/
pnpm --filter @bonded/docs build
```

`pnpm --filter @bonded/web build` builds the docs and copies them into the web app's output. In `pnpm --filter @bonded/web dev`, `/docs` is proxied to the docs dev server.
