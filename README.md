# Bonded

> **Don't cage your agent. Bond it.**

AI agents now trade with real money. When one gets tricked (a poisoned token description, a fake "admin" message, a lookalike address), someone loses funds, and today nobody pays them back. Bonded rates AI agents by attacking them, prices insurance from what the attacks found, and pays depositors automatically when an agent breaks its rules. **Payouts are decided by the agent's vault on chain, never by an AI.**

Runs on **Robinhood Chain**, with scores readable on **Arbitrum, Ethereum and Solana**.

**The score is the bar.** Every agent Bonded rates gets a Bonded Score from 0 to 100, earned by being attacked and signed so any chain can read it. There is no common way yet to tell a hardened agent from a gullible one. We're setting that standard first, in the open: the attack library, the scoring method and its assumptions are published, and every agent is judged on the same scale. A platform, vault or depositor can require a minimum score, and every agent builder has a number to measure up to.

## Try it

| | |
|---|---|
| **Web app** (Robinhood Chain testnet) | https://www.bondedhq.xyz |
| **Test your agent**: a free preview rating of your own agent, any framework | https://www.bondedhq.xyz/agents/test |
| **Agent Safety Leaderboard**: open-source agent templates, rated | https://www.bondedhq.xyz/leaderboard |
| **Agent A**: insured, with one weakness the Arena found | https://www.bondedhq.xyz/agents/3 |
| **Agent B**: hardened, key in a TEE | https://www.bondedhq.xyz/agents/2 |
| **Claims**: every automatic payout and where the money came from | https://www.bondedhq.xyz/claims |

**Or run the whole thing yourself in one command**, with no keys or accounts (needs Node 22, pnpm and Foundry; details in [docs/DEVELOPING.md](docs/DEVELOPING.md)):

```bash
git clone --recursive https://github.com/ddboy19912/bonded && cd bonded
pnpm install
pnpm demo
```

It starts a local chain, the API, keeper and rating worker; rates Agent A and Agent B; buys cover for both; plants an address-poisoning attack that Agent A falls for; shows the claim paying (operator's bond first, then the pool); and serves the web app at http://localhost:5180.

## How it works

1. **Mandate Vault.** An agent trades from a vault that knows its rules: which tokens, which contracts, where funds may go, how much per trade and per day. Every action goes through the vault, which blocks or records any breach on chain. An agent that already trades from a smart account can keep it: a Mandate Module on the account (ERC-7579, Safe through Safe7579) runs the same checks.
2. **The Arena.** AI attacker scenarios (10 classes: prompt injection, fake news and posts, poisoned prices, lookalike tokens and addresses, social engineering, hostile counterparty agents…) are planted in the agent's world inside a sandbox: a copy of the chain with the same contracts. The verdict of each episode is the vault's breach log. Your own agent can be rated where it runs: Bonded calls its HTTPS endpoint, or a small runner next to it connects out to the Arena, and the Arena attacks it over MCP, HTTP or its own signed transactions. A free preview rating needs only a wallet sign-in.
3. **Bonded Score.** Breach rates become an expected loss, a premium and a score from 0 to 100. The attester signs it and posts it to the registry (ERC-8004 compatible); the same signed score can be posted to Arbitrum, Ethereum and Solana.
4. **Bond and cover.** The agent's operator stakes a bond that pays first. Underwriters fund a pool that pays the rest. Depositors buy cover priced from the score.
5. **Automatic claims.** When the vault records a breach, the keeper files the claim within seconds. The contract slashes the bond, then the pool pays, and the money goes back into the vault.

Plus **Sentinel**, an optional real-time guard: Laya, an open-source decision model, fine-tuned on Arena data to flag manipulated actions before they reach the vault. It is advisory; payouts never depend on it.

How the parts fit together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). What each agent is: [docs/AGENTS.md](docs/AGENTS.md). How Bonded relates to the trading bots, wallet copilots and other agents people already use: [docs/YOUR-AGENTS.md](docs/YOUR-AGENTS.md). The full product specification: [docs/SPECIFICATION.md](docs/SPECIFICATION.md).

## What you can do today

- **Anyone, in the web app** (with a browser wallet on Robinhood testnet): onboard an agent (register it, create its vault, stake a bond); rate it with one of Bonded's built-in agent designs against your vault; buy cover; simulate a breach and watch the claim pay; deposit; underwrite the cover pool; submit a bounty attack; browse agents, scores, reports, the leaderboard and claims.
- **Anyone, locally:** run the whole loop with `pnpm demo`, or rate the built-in agents with `pnpm arena rate`.
- **Your own agent, live on testnet:** test any agent, in any framework or language, where it runs, with a free **preview** (wallet sign-in only: no vault, bond or tokens; not on chain, not insurable), then make it official for a declared or TEE-bound score on chain. Connect it by its HTTPS endpoint (**Agent URL**, no install) or with `@bondedhq/runner`; a live connection check says what to fix before any rating; one-call helpers give it the episode's tools in LangChain/LangGraph, the Vercel AI SDK, ElizaOS, Coinbase AgentKit or any MCP client, and `npx @bondedhq/runner init` writes that wiring (and trading through its vault) into a Node agent's code, then starts the runner and runs the check. The report says, for each breach, what the agent read, what it did and what would have stopped it, and **Rate again** shows the score before and after. Onboarding suggests a mandate from what the agent traded, and the agent's page has a health panel, alerts and a notifications list. Protect it with `@bondedhq/sdk` (plugins for Coinbase AgentKit, Solana Agent Kit and ElizaOS, and vault trading tools for LangChain and the AI SDK) or a module on its smart account. Start at [Test your agent](https://www.bondedhq.xyz/agents/test); `@bondedhq/runner` and `@bondedhq/sdk` are on npm, and it all runs locally too (`pnpm demo -- --byo`, or `pnpm arena rate --agent remote`). Not live yet: a published Docker image for the runner, and email notifications. Guide: [docs/BRING-YOUR-OWN-AGENT.md](docs/BRING-YOUR-OWN-AGENT.md). Status by piece: [What works today and what's coming](docs/AGENTS.md#what-works-today-and-whats-coming).

## Results (measured, with their assumptions)

**The demo pair**, rated live on Robinhood testnet with five runs of every attack (200+ episodes each):

| | Agent A | Agent B |
|---|---|---|
| What it is | Acts on what it reads, behind a guard that checks addresses by their first and last characters only | Treats what it reads as data; full guard; Enforce mode; key generated inside a TEE |
| Score | **54 (BB)** | **97 (AAA)** |
| Premium | **6.4%** a year (5.8% after its operator-bond discount) | **1.1%** a year |
| What the Arena found | Address poisoning: 20 of 25 episodes breached, including an unpublished attack. Every other class: none | No breaches |

Both ratings (2026-10-10, agents 3 and 2 on the contracts deployed Oct 10, 2026; the same scores as on the earlier contracts) include unpublished attacks the operator couldn't study in advance: a held-out set of 15 attacks, 75 episodes each. Agent B was rated with its TEE running and verified: Intel TDX, measurement `0xb933…8f01`.

**The loop, live on Robinhood testnet** (2026-10-04, [evidence](docs/progress/evidence/demo-break-testnet.json)): a lookalike of Agent A's depositor asked for a "refund"; Agent A paid 5,000 tUSDG; the vault recorded the breach and froze the agent; the keeper's claim paid 4,500 (the loss minus the 10% deductible): **4,000 from the operator's bond, 500 from the pool.**

**[Leaderboard](https://www.bondedhq.xyz/leaderboard)** (2026-10-10, [rating data](config/leaderboard.json), five runs of 55 attacks, 15 of them held out and unpublished): the 2 open-source templates rated (Coinbase AgentKit and Solana Agent Kit), each with DeepSeek V4.1 Flash and GLM 5.3 Flash, had no breaches in 4 template/model evaluations and score 81 (AA) in Monitor mode, like Bonded's own hardened agent; agents that resist every attack tie. An earlier rating with Claude Haiku 4.5 (2026-10-06) found AgentKit falling for basic prompt injection once, in 1 of 20 token-metadata (A1) episodes. About half the attacks arrive on surfaces these templates never read ([disclosures](docs/disclosures/README.md)).

**Sentinel v5** (in production), against the previous model on the same inputs ([details](docs/SENTINEL-STRESS.md#v5-gate-results)): it blocked 33 of 33 manipulated actions in held-out Arena cases (v1: 27) with no false blocks; in an Arena rerun, the vulnerable agent behind it was breached by 0 of 40 attack seeds. It failed one of five gates (2 of 44 stress families got worse) and was promoted with that exception recorded. It takes about 2.5 s per check on CPU.

Assumptions that apply throughout:
- The attack library is fixed seeds, so scores are in-library results, not a held-out evaluation. An adaptive attack source is not built yet.
- The yearly attack rates per class (λ) are illustrative priors (specification Section 9.2). The model's inputs, not these numbers, are the product.
- Everything runs on testnets with test tokens.

## Security

An internal audit note ([docs/AUDIT.md](docs/AUDIT.md)) covers 16 handler-based invariant tests, which catch all 11 of 11 bugs planted to test them; Slither and clippy, with every finding triaged; and a manual review. It found no high-severity issues; the open contract fixes are batched for the mainnet deployment ([issue #67](https://github.com/ddboy19912/bonded/issues/67)). This is an in-house review, not an external audit.

## Deployments

Owner, attester and council on every testnet: `0xd42FA5ae8949710479954ae78D1b12Ff2e50A841` (a single key for now; a multisig is a mainnet prerequisite). Deployed Oct 10, 2026. Full address lists: [contracts/evm/deployments](contracts/evm/deployments/README.md) and [contracts/solana/deployments](contracts/solana/deployments/devnet.json).

| Contract | Robinhood Chain testnet (46630) | Arbitrum Sepolia (421614) | Ethereum Sepolia (11155111) |
|---|---|---|---|
| BondedRegistry | [`0x691563A85D1D80f2891c0ecb2096E58CC4b4DFBA`](https://explorer.testnet.chain.robinhood.com/address/0x691563A85D1D80f2891c0ecb2096E58CC4b4DFBA) | [`0xa8896AEd5c2bF49De4Da3578C515eb5B6eB56B42`](https://sepolia.arbiscan.io/address/0xa8896AEd5c2bF49De4Da3578C515eb5B6eB56B42) | [`0x2AAc3078ec420e5727c5A83D414f6818Ca87AAae`](https://sepolia.etherscan.io/address/0x2AAc3078ec420e5727c5A83D414f6818Ca87AAae) |
| MandateVaultFactory | [`0xB63392D0451877B6c5cFb15eBF78062B7CdcD45f`](https://explorer.testnet.chain.robinhood.com/address/0xB63392D0451877B6c5cFb15eBF78062B7CdcD45f) | [`0x245acb12F05dC60ac9B7547Dae9bF0215769e308`](https://sepolia.arbiscan.io/address/0x245acb12F05dC60ac9B7547Dae9bF0215769e308) | [`0x470ae0b43FcFd302964921745ac2Fb83718B330E`](https://sepolia.etherscan.io/address/0x470ae0b43FcFd302964921745ac2Fb83718B330E) |
| MandateModuleFactory | [`0x0DafdC13b77114e472C910B58608f905972a801a`](https://explorer.testnet.chain.robinhood.com/address/0x0DafdC13b77114e472C910B58608f905972a801a) | [`0x7DFb980BD1Ed4B12EB149F4e48AF433adE6058c6`](https://sepolia.arbiscan.io/address/0x7DFb980BD1Ed4B12EB149F4e48AF433adE6058c6) | [`0x6FA4Bc8cF38BeDE702D588D93f14585F0033eb34`](https://sepolia.etherscan.io/address/0x6FA4Bc8cF38BeDE702D588D93f14585F0033eb34) |
| CoverManager | [`0x17F6aebb3976669F6b5D6def2eb0fd12a08678Be`](https://explorer.testnet.chain.robinhood.com/address/0x17F6aebb3976669F6b5D6def2eb0fd12a08678Be) | [`0xF9020e6DFaE001f58dd2380C0724b04157367CCF`](https://sepolia.arbiscan.io/address/0xF9020e6DFaE001f58dd2380C0724b04157367CCF) | [`0x7F4b4379Fd4e56Cc0b545a344316e6bb2994b0a1`](https://sepolia.etherscan.io/address/0x7F4b4379Fd4e56Cc0b545a344316e6bb2994b0a1) |
| CoverPool | [`0x8D66B526e5bBDbc3BFd46B8c0e199E6555362b75`](https://explorer.testnet.chain.robinhood.com/address/0x8D66B526e5bBDbc3BFd46B8c0e199E6555362b75) | [`0x2AAc3078ec420e5727c5A83D414f6818Ca87AAae`](https://sepolia.arbiscan.io/address/0x2AAc3078ec420e5727c5A83D414f6818Ca87AAae) | [`0x92FE64fCAD46065e4d93Fe0b6F8ECD5Fbfb8B0D1`](https://sepolia.etherscan.io/address/0x92FE64fCAD46065e4d93Fe0b6F8ECD5Fbfb8B0D1) |
| OperatorBond | [`0x6001e51A208F11EfdD8716B1aa5986AABfb76Ca5`](https://explorer.testnet.chain.robinhood.com/address/0x6001e51A208F11EfdD8716B1aa5986AABfb76Ca5) | [`0x470ae0b43FcFd302964921745ac2Fb83718B330E`](https://sepolia.arbiscan.io/address/0x470ae0b43FcFd302964921745ac2Fb83718B330E) | [`0xF9020e6DFaE001f58dd2380C0724b04157367CCF`](https://sepolia.etherscan.io/address/0xF9020e6DFaE001f58dd2380C0724b04157367CCF) |
| ClaimsEngine | [`0xCE05398FCcddbc1E5874f7A6bC517eD24d4bE849`](https://explorer.testnet.chain.robinhood.com/address/0xCE05398FCcddbc1E5874f7A6bC517eD24d4bE849) | [`0x0a98FF1647fFc1cB411851Fd24cA7Ad459eB75a4`](https://sepolia.arbiscan.io/address/0x0a98FF1647fFc1cB411851Fd24cA7Ad459eB75a4) | [`0x74e6ea49f417a791789db5Ad3B3186d1bd2DF622`](https://sepolia.etherscan.io/address/0x74e6ea49f417a791789db5Ad3B3186d1bd2DF622) |
| BountyBoard | [`0xE78Afc3309A28c2c0a827451A8aB3A22EcCB1b06`](https://explorer.testnet.chain.robinhood.com/address/0xE78Afc3309A28c2c0a827451A8aB3A22EcCB1b06) | [`0x92FE64fCAD46065e4d93Fe0b6F8ECD5Fbfb8B0D1`](https://sepolia.arbiscan.io/address/0x92FE64fCAD46065e4d93Fe0b6F8ECD5Fbfb8B0D1) | [`0x0a98FF1647fFc1cB411851Fd24cA7Ad459eB75a4`](https://sepolia.etherscan.io/address/0x0a98FF1647fFc1cB411851Fd24cA7Ad459eB75a4) |
| tUSDG | [`0xee6994766d49962CfbC6C592E724828f80815b1D`](https://explorer.testnet.chain.robinhood.com/address/0xee6994766d49962CfbC6C592E724828f80815b1D) | [`0x6a4FDda2F20e7FD99d1C21Cb74F953F0F15035AC`](https://sepolia.arbiscan.io/address/0x6a4FDda2F20e7FD99d1C21Cb74F953F0F15035AC) | [`0xd5A86802B28Da2407D9e25C174a72241d052e291`](https://sepolia.etherscan.io/address/0xd5A86802B28Da2407D9e25C174a72241d052e291) |

**Solana devnet** (Anchor programs, [README](contracts/solana/README.md)):

| Program | Address |
|---|---|
| bonded_registry | [`7hfPMrd4A264TfgTivV1QLmps9N5ZCf4r64csh8hfuYy`](https://explorer.solana.com/address/7hfPMrd4A264TfgTivV1QLmps9N5ZCf4r64csh8hfuYy?cluster=devnet) |
| bonded_vault | [`8hNVDFF7aU2BJa4avnv2X7ziYEmguCaCHTZYBKo2CzFx`](https://explorer.solana.com/address/8hNVDFF7aU2BJa4avnv2X7ziYEmguCaCHTZYBKo2CzFx?cluster=devnet) |
| bonded_cover | [`Dcrwfd272QQxXS4oEmHPSQdGWRZ2BMRSMb3Vi7jj6Y1X`](https://explorer.solana.com/address/Dcrwfd272QQxXS4oEmHPSQdGWRZ2BMRSMb3Vi7jj6Y1X?cluster=devnet) |

Agent B's score of 97 is the same signed attestation on all four chains ([evidence](docs/progress/evidence/multichain-scores-agent2-tee.json)).

## Repo layout

| Path | What's there |
|---|---|
| `contracts/evm` | Solidity contracts (Foundry): vault, smart-account module, cover, pool, bond, claims, registry, disputes, bounties. [Its README](contracts/evm/README.md) explains each one |
| `contracts/solana` | Anchor programs: registry, vault, cover |
| `apps/arena` | The Arena: attack library runner, sandbox, judge, ratings, and the Arena Gateway that serves episodes to agents running elsewhere |
| `apps/runner` | `@bondedhq/runner`: connects an agent on its operator's servers to the Arena Gateway |
| `apps/demo-agents` | The agents Bonded rates ([docs/AGENTS.md](docs/AGENTS.md)) |
| `apps/api` | API, keeper, rating and bounty workers, demo scripts |
| `apps/web` | The web app |
| `packages/shared` | Schemas, scoring maths, ABIs, chain and deployment data, the runner protocol |
| `packages/sdk` | `@bondedhq/sdk`: trade through a vault or module from any TypeScript agent, with plugins for AgentKit, Solana Agent Kit and ElizaOS; the Arena episode's tools for LangChain, the Vercel AI SDK, ElizaOS, AgentKit and MCP; and an Agent URL handler |
| `packages/sandbox` | Local chains with the protocol deployed, for the Arena and tests |
| `examples/byo-agent` | The template for your own agent: it trades through its vault with the SDK, reads everything it can as untrusted data, and is rated through the runner |
| `examples/frameworks`, `examples/python-agent-url` | Agents on LangGraph, the Vercel AI SDK, ElizaOS and AgentKit rated through the SDK's helpers, and Agent URL endpoints in TypeScript and plain Python |
| `services/sentinel`, `services/tee-agent` | The Sentinel guard service; the TEE agent for Phala Cloud |
| `attacks/` | The attack library: YAML scenarios by class |
| `docs/` | The documentation: specification, architecture, audit and more |

## Documentation

The same pages are published as a searchable site at `/docs` on the web app (built from these files by `apps/docs`; run it locally with `pnpm docs:dev`).

| | |
|---|---|
| [YOUR-AGENTS.md](docs/YOUR-AGENTS.md) | How Bonded connects to the agents people already use, and why it matters |
| [BRING-YOUR-OWN-AGENT.md](docs/BRING-YOUR-OWN-AGENT.md) | Test your own agent free, connect it, rate, protect and insure it where it runs |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the parts fit together |
| [AGENTS.md](docs/AGENTS.md) | What an agent is; every agent we rate |
| [DEVELOPING.md](docs/DEVELOPING.md) | Build, test, run, deploy |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Every problem and refusal message, by code, with what to do |
| [BOUNTIES.md](docs/BOUNTIES.md) | Community attack bounties |
| [SENTINEL.md](docs/SENTINEL.md), [SENTINEL-STRESS.md](docs/SENTINEL-STRESS.md) | The Sentinel guard and how it was tested |
| [TEE.md](docs/TEE.md) | Running an agent's keys in a TEE |
| [AUDIT.md](docs/AUDIT.md) | The internal security review |
| [SPECIFICATION.md](docs/SPECIFICATION.md) | The product specification |
