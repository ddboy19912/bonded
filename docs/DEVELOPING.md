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
pnpm demo -- --byo    # also: your own agent (examples/byo-agent) connected through @bondedhq/runner
                      # and a local Arena Gateway, rated with a held-out set of its own; and a
                      # smart account (ERC-7579 reference account) protected by an Enforce-mode
                      # mandate module, rated and covered. Prints both agents' pages, and keeps
                      # running connection checks and previews asked for in the web app
                      # (Agent URLs may be plain http on this machine).

pnpm demo:local       # contracts only: deploy everything to a local chain, then run
                      # register → vault → bond → cover → breach → claim (the claim pays 4,500)

pnpm arena --list                           # the attack library
pnpm arena run                              # every attack against vulnerable-agent
pnpm arena rate                             # full rating: score, report, attestation, dataset
pnpm arena rate --agent hardened --enforce  # the guarded agent, for comparison
pnpm arena rate --agent partial              # the demo's Agent A: one gap, address poisoning
pnpm arena rate --agent remote               # your own agent, through a local Arena Gateway
                                             # and the runner (docs/BRING-YOUR-OWN-AGENT.md)
pnpm arena rate --agent remote --profile hosted   # the same, with a hosted rating's settings
                                             # (it refuses --repeats, --controls,
                                             # --episode-timeout and --held-out-fresh)
```

Arena output goes to `apps/arena/traces/` and `apps/arena/ratings/<agent>/`; `report.md` there is the human-readable rating. A sandbox's throwaway deployment files go to `contracts/evm/deployments/sandbox/` (git-ignored; the deploy scripts take `DEPLOYMENTS_DIR`), never beside the committed ones.

**The same break-it run on Robinhood testnet** (needs `DEPLOYER_PRIVATE_KEY`, `DEMO_AGENT_KEY` and `API_TOKEN` in `.env`): `pnpm demo:break` plants the attack for Agent A (agent 3), waits for the hosted keeper's claim and prints the waterfall with explorer links; `pnpm demo:break -- --reset` re-arms Agent A for another take. A recorded run: [docs/progress/evidence/demo-break-testnet.json](progress/evidence/demo-break-testnet.json).

**The self-serve loop on the hosted app** (needs `DEPLOYER_PRIVATE_KEY` in `.env`, only to send a new wallet a little test ETH): `pnpm check:self-serve` makes a brand-new wallet do what a tester does in the web app, with no operator token. It onboards an agent (register, vault, 4,000 tUSDG bond, 50,000 deposit), registers it for ratings and asks for one by signing, waits for the hosted worker's rating, buys 20,000 of cover with a tokenless quote, simulates a breach as the agent key and waits for the hosted keeper's claim. Each run creates a new agent on testnet and uses one of the day's 40 self-serve ratings. A recorded run (agent 11: score 49, 6.70% a year, claim of 4,500 = 4,000 from the bond + 500 from the pool): [docs/progress/evidence/self-serve-testnet.json](progress/evidence/self-serve-testnet.json).

### 4. Optional: settings in `.env`

You only need a `.env` to use language models or real testnets:

```bash
cp .env.example .env   # then fill in what you need; the file explains every setting
```

- **Precedence:** values already set in your shell win over `.env`.
- **Git:** `.env` is git-ignored, so it never gets committed.
- **Local runs:** step 3's commands ignore `.env` completely.

**Language models.** Set `OPENROUTER_API_KEY` (one key reaches hundreds of models), or point `LLM_BASE_URL` at any OpenAI-compatible endpoint, such as a local Ollama. Then:

```bash
pnpm arena rate --brain llm --model deepseek/deepseek-v4.1-flash --max-usd 2
```

| Flag | What it does |
|---|---|
| `--agent vulnerable\|hardened\|partial\|decision\|remote` | Picks the demo agent (see [AGENTS.md](AGENTS.md)), or `remote` for your own agent through the runner |
| `--brain scripted\|llm` and `--model <id>` | Picks its brain; the model is any OpenRouter model id |
| `--sentinel-model <id>` | Adds a Sentinel guard to hardened-agent |
| `--enforce` | Runs the vault in Enforce mode |
| `--repeats <n>` | Runs every attack n times |
| `--max-usd <n>` | Caps model spend for the run |
| `--fork robinhood\|arbitrum` | Runs against a copy of a live testnet instead of a fresh chain |
| `--help` | Lists everything |

**Testnets.** Bonded is already deployed on Robinhood Chain testnet and Arbitrum Sepolia; the addresses are in [`contracts/evm/deployments/`](../contracts/evm/deployments/README.md). To deploy your own copy or run the demo loop there:

1. Create a **testnet-only** wallet (for example `cast wallet new`). Never use a wallet that holds real funds.
2. Get test ETH from the chain's faucet. For Arbitrum Sepolia you can also bridge Sepolia ETH.
3. Put the key in `.env` as `DEPLOYER_PRIVATE_KEY`.
4. Run:

```bash
pnpm contracts:deploy robinhood   # or: arbitrum, or any RPC URL
pnpm contracts:smoke robinhood    # the demo loop on that chain (see .env.example for per-role keys)
```

A deploy writes `contracts/evm/deployments/<chainId>.json` only after checking everything on-chain.

### Checks before a pull request

```bash
pnpm format:check && pnpm --filter @bondedhq/shared abis:check && pnpm typecheck && pnpm lint && pnpm test
cd contracts/evm && forge fmt --check && forge test
```

The troubleshooting page ([TROUBLESHOOTING.md](TROUBLESHOOTING.md)) is generated from the problem list in `packages/shared/src/problems.ts`: after changing it, run `pnpm docs:troubleshooting`. `pnpm test` fails while the committed page is out of date.

## Bring your own agent

How an agent that runs on its operator's servers is protected and rated: [BRING-YOUR-OWN-AGENT.md](BRING-YOUR-OWN-AGENT.md). The pieces:

| Path | Package | What it is |
|---|---|---|
| `apps/arena/src/gateway` | part of `@bonded/arena` | The Arena Gateway (MCP, HTTP, chain-mode RPC, the runner's WebSocket) and `RemoteAgent` |
| `apps/runner` | `@bondedhq/runner` (publishable, with a `bonded-runner` bin and a Dockerfile) | Connects an agent to the gateway and starts it per episode, and works out its code hash (`src/code-hash.ts`). `examples/mcp-agent.mjs` is the smallest tool-mode agent, over MCP; `examples/agent-url-agent.mjs` the same for Agent URL mode |
| `apps/arena/src/gateway/agent-url.ts`, `apps/arena/src/check.ts`, `apps/arena/src/safe-fetch.ts` | part of `@bonded/arena` | Agent URL calls (signed, rate-limited, public https only), the connection check, and the fetch rules for URLs an operator chose |
| `apps/api/src/{previews,sessions,connections,check-worker,preview-worker,notifications,secrets,remote-policy}.ts` | part of `@bonded/api` | Owner sessions, previews, Agent URL registration, checks and their lane, estimates, progress streams, notifications, secret encryption, and the caps |
| `packages/sdk` | `@bondedhq/sdk` (publishable) | The vault and module client, dry runs, the guard, the Sentinel client, the mandate builder, the AgentKit, Solana Agent Kit and ElizaOS plugins, the episode's tools for LangChain, the AI SDK, ElizaOS, AgentKit and MCP (with the `bonded-mcp-config` bin), and the Agent URL handler |
| `packages/sandbox` | `@bonded/sandbox` (private) | Local chains with the protocol deployed by the production scripts, shared by the Arena's and the SDK's tests |
| `packages/shared/src/runner.ts`, `agent-url.ts` | `@bondedhq/shared` (publishable) | The runner protocol's messages, as zod schemas both sides parse with, and the Agent URL protocol (signing, verifying, the verify proof; also published alone as `@bondedhq/shared/agent-url`) |
| `examples/byo-agent` | `@bonded/example-byo-agent` (private) | The full example, and the template to copy: an agent on its own server that trades through its vault with the SDK. When the runner starts it, it runs an episode in either mode: it reads all nine attack surfaces, treats them as untrusted data, and makes only the trade its task names (guarded by the SDK's dry run in chain mode). The Arena's runner end-to-end test rates it through the real gateway and runner |
| `examples/frameworks` | `@bonded/example-frameworks` (private) | LangGraph, AI SDK, ElizaOS and AgentKit agents and an Agent URL server, each rated through a real gateway with a scripted model |
| `examples/python-agent-url` | | An Agent URL endpoint in plain Python (standard library only), with `selfcheck.py` |
| `contracts/evm/src/Mandate{Base,Module,ModuleFactory}.sol` | | The mandate checks shared by vaults and modules, and the ERC-7579 module |

Their tests run with `pnpm test` (the contracts' with `forge test`). To run one part:

```bash
pnpm --filter @bondedhq/runner test                 # the runner against a fake gateway
pnpm --filter @bondedhq/sdk test                    # vault, module and plugins on anvil
pnpm --filter @bonded/example-byo-agent test      # the example, both modes
pnpm --filter @bonded/example-frameworks test     # every framework helper and both Agent URL
                                                  # examples against a real gateway (the Python
                                                  # one is skipped without python3)
pnpm --filter @bonded/arena test                  # includes the gateway, a real runner end to end,
                                                  # and parity on the first seed of each class
pnpm --filter @bonded/arena test:parity           # parity over the whole published library
cd contracts/evm && forge test --match-path 'test/module/*'   # the module, differential tests,
                                                              # Safe7579
```

The parity tests run Bonded's scripted vulnerable, hardened and partial agents through the gateway over MCP, over HTTP and in chain mode, and require the same verdict as in-process, episode by episode. The SDK's Solana tests need the programs built (`pnpm solana:build`) and `solana-test-validator`; without them they skip.

`pnpm demo -- --byo` runs the whole hosted flow on your machine: the gateway, a runner token made through the API, the real runner with `examples/byo-agent`, a connection check, and a rating; and an Enforce-mode module on the ERC-7579 reference account, rated and insured. It also runs the connection-check and preview lanes, with an ephemeral `AGENT_URL_SECRET_KEY` and plain-http Agent URLs allowed on this machine (loopback, e.g. `http://127.0.0.1:8080/`), so the **Test your agent** page works against it, through a runner or an Agent URL, at http://localhost:5180/agents/test.

To run a local API outside the demo with Agent URLs pointing at this machine, set `AGENT_URL_SECRET_KEY` (`openssl rand -hex 32`) and `AGENT_URL_ALLOW_LOOPBACK=1`. Never set the second on a hosted service.

To run the rating service's gateway yourself, start the API in the `arena-worker` (or `all`) role with `GATEWAY_PORT` set; `GATEWAY_PUBLIC_URL` is the address runners and agents reach it at, and the API puts it in the runner command it shows owners.

| Setting (rating service) | Default | What it does |
|---|---|---|
| `GATEWAY_PORT` | unset (no gateway: remote ratings fail at once) | Port the Arena Gateway listens on, in the arena-worker |
| `GATEWAY_PUBLIC_URL` | unset | The gateway's public URL (a bare host is taken as https); set on the API and the arena-worker |
| `DECLARED_COVER_CAP_USD`, `TEE_COVER_CAP_USD` | 5000, 20000 | Underwriting policy's total cover cap for an operator-run agent, by binding |
| `HELD_OUT_FRESH_PER_CLASS` | 1 | Held-out variants per attack class made for each remote rating (0 to 5); part of the remote policy |
| `HELD_OUT_MODEL`, `HELD_OUT_MAX_USD` | `deepseek/deepseek-v4.1-flash`, 0.25 | Model that drafts them when `OPENROUTER_API_KEY` or `LLM_API_KEY` is set (otherwise deterministic rewrites), and its cap per rating |
| `GATEWAY_TRUST_PROXY` | 0 | How many proxies in front of the gateway to trust for `X-Forwarded-For` (Railway: 1). Per-address connection limits use the client address that many hops from the right |
| `REMOTE_REPEATS` | 3 | Runs of each attack in a remote rating (built-in designs: 5) |
| `REMOTE_EPISODE_TIMEOUT_MS` | 90000 | One remote episode's time limit |
| `REMOTE_EPISODE_BUDGET_MS`, `REMOTE_RATING_MAX_MS` | 40000, 10800000 | A remote rating's time budget: this much per episode, never more than the ceiling (3 hours) |
| `REMOTE_RATINGS_PER_AGENT_DAILY`, `REMOTE_RATINGS_PER_OWNER_DAILY`, `REMOTE_RATINGS_DAILY` | 2, 3, 20 | Remote ratings per agent, per owner and for the whole chain, per 24 hours. Renewals and re-ratings count |
| `REMOTE_RATING_INTERVAL_MS` | 3600000 | The least time between two ratings of one operator-run agent; also how often a TEE change may re-rate it |
| `RENEW_CHECK_MS` | 600000 | How often the arena-worker looks for connected agents whose scores expire within 3 days |
| `AGENT_URL_SECRET_KEY` | unset (Agent URL mode and webhooks are refused) | 32 bytes (64 hex characters, or base64) that encrypt Agent URL secrets and webhook secrets at rest (AES-256-GCM). The same value on the API and the arena-worker. Make one with `openssl rand -hex 32` |
| `PREVIEW_PER_WALLET_DAILY`, `PREVIEW_DAILY` | 1, 20 | Preview ratings per wallet and for the whole chain, per 24 hours (0 turns previews off). Previews run one at a time, after official remote ratings |
| `PREVIEW_CREATES_PER_WALLET_DAILY` | 5 | Previews a wallet may create per 24 hours |
| `PREVIEW_RATING_MAX_MS` | 2700000 | A preview's time budget ceiling (45 minutes; 40 s an episode below it) |
| `CHECKS_PER_WALLET_HOURLY`, `CHECKS_HOURLY` | 10, 30 | Connection checks per wallet and for the whole chain, per hour |
| `AGENT_URL_VERIFIES_PER_WALLET_HOURLY`, `AGENT_URL_VERIFIES_HOURLY` | 10, 100 | Agent URL registrations and re-verifications (each one calls the URL) per wallet and in all, per hour; also at most 10 an hour per URL host |
| `RESEND_API_KEY`, `EMAIL_FROM` | unset (no email) | Notification email through Resend, only when both are set (arena-worker sends; the API accepts addresses only then) |
| `AGENT_URL_ALLOW_LOOPBACK` | unset | `1` lets Agent URLs and webhooks be plain http on this machine (`localhost`, `127.0.0.1`): local runs only, never hosted. `pnpm demo -- --byo` sets up the same itself, with an ephemeral secret key |
| `BONDED_OWN_HOSTS` | unset | Extra hosts (comma-separated) an Agent URL or webhook may not use, beyond Bonded's deployed hosts, the web origins, the gateway and the service's own Railway domain |
| `OWNER_ALERTS_MS` | 60000 | How often the keeper sweeps owners' agents for alerts (score expiring, runner offline, breach, claim filed or paid, cover lapsing, low gas); at least 10000 |
| `BONDED_VERSION` | unset (the deploy's commit, `RAILWAY_GIT_COMMIT_SHA`, first 12 characters) | The version `GET /status` reports, on the API |

With the gateway on, the arena-worker runs two rating lanes, each with its own lock, so Bonded's own ratings never wait behind an operator's agent. The remote policy is read once (`remotePolicyFromEnv` in `apps/api/src/remote-policy.ts`) and used by the API, the worker, renewals and re-ratings alike. Its rating defaults come from `HOSTED_REMOTE_PROFILE` in `apps/arena/src/rate.ts`, which `pnpm arena rate --agent remote --profile hosted` also uses, so a local run with that profile predicts a hosted rating. Accepted bounties re-rate Bonded's own agents only: bounty attacks are never run against operator-run agents.

## API, keeper and the Gate 1 loop

`pnpm test:services` runs real Postgres and Anvil tests without Docker. `pnpm gate:local` runs the complete rating → attestation → quote → cover → injected breach → automatic payout loop, using embedded Postgres and a fresh Anvil deployment. Results go to `artifacts/gate-1-local.json`.

`pnpm gate:testnet` broadcasts the same demo on Robinhood Chain testnet using `DEPLOYER_PRIVATE_KEY` from `.env`. It spends test ETH and faucet tokens, creates a new demo agent and vault, and requires the existing deployment to have a zero waiting period. Review the command before running it. Results go to `artifacts/gate-1-testnet.json`; partial results are saved if a step fails.

## Web app

`apps/web` is a Vite + React app for the demo flow on Robinhood Chain testnet: the live Arena feed, agent profiles, vaults (deposit, withdraw, buy cover), underwriting (pool deposit, withdrawal, test tUSDG) and the claims feed.

```bash
pnpm --filter @bonded/web dev
```

It reads the chain directly and talks to the hosted API by default. Point it at a local API with `VITE_API_URL` (see `apps/web/.env.example`), and add the app's origin to the API's `WEB_ORIGINS`. Wallet actions need a browser wallet such as MetaMask on Robinhood Chain testnet. Starting a rating or getting a quote needs the operator token, which the page keeps in memory only.

Wallet selection, connection, account management, disconnection and network switching use RainbowKit's standard UI. Phantom, Rabby and detected EIP-6963 browser wallets such as MetaMask work without service credentials. In Phantom, enable testnet mode to use Robinhood Chain Testnet.

To enable WalletConnect QR/mobile connections, create a project at [Reown Dashboard](https://dashboard.reown.com), allow the app's deployment origins, and set `VITE_WALLETCONNECT_PROJECT_ID` in `apps/web/.env.local` and the hosting environment. Restart the dev server or rebuild the deployment after setting it; Vite embeds this public project ID at build time. Without a project ID, the app offers browser wallets and omits WalletConnect options.

## Deploying

The hosted services run on Railway, from `.railway/railway.ts`; contracts deploy with `pnpm contracts:deploy` ([deployments](../contracts/evm/deployments/README.md#deploying)). Secrets are set on the services directly and never committed (`preserve()` in the configuration keeps the value already stored on Railway). What bringing your own agent needs on the hosted service. As of 2026-10-10, steps 1, 3 and 4 are done (the packages are on npm, and the API, gateway and migrations through 0022 are deployed with `AGENT_URL_SECRET_KEY` set; the protocol was redeployed on Oct 10, see [After a redeployment](#after-a-redeployment)); step 2 is still to do. The steps stay here for the next release and the next environment:

1. **Publish the packages to npm** (done for 0.1.0; 0.1.1 carries the Oct 10 deployment; 0.1.2 the fixes from the first-time-user test: init for TypeScript and already-wired agents, and the example agent reading every surface). `pnpm release:packages` publishes `@bondedhq/shared`, `@bondedhq/solana`, `@bondedhq/sdk` and `@bondedhq/runner`, in that order (each depends only on those before it; `workspace:` ranges become versions), with public access. It refuses unless the tree is clean and on `main`, level with `origin/main`. It runs `pnpm install --frozen-lockfile` (so the workspace links match the lockfile), builds the packages fresh, runs their tests with `--force` (never from Turborepo's cache), packs them and smoke-tests the tarballs, then publishes each one whose version isn't on npm yet (pnpm asks for your one-time password). `pnpm release:packages -- --dry-run` does everything except publish, on any branch. `pnpm release:check` on its own packs the packages, installs the tarballs into an empty project as a user would, and checks `bonded-runner --version`, `bonded-mcp-config`, the SDK's entry points without any optional framework installed, and an Agent URL verify round trip; `--keep` leaves the project, `--no-build` uses the existing builds; it needs the npm registry for third-party dependencies. npm never takes the same version twice, so before the next publish bump the version in each changed package's `package.json` in a reviewed PR; a package whose version is already on npm is skipped. The README on each package's npm page is the one published with that version, so a README change reaches npmjs.com only with the next version.
2. **Push the runner's image** (not done yet): build `apps/runner/Dockerfile` from the repository root and push it to a public registry, so builders can put their agent `FROM` it instead of building it themselves.
3. **Set the secret key, then apply the Railway configuration** (done), in this order:
   1. Set `AGENT_URL_SECRET_KEY` on the **api** service in Railway: 32 bytes, `openssl rand -hex 32`. The configuration keeps it with `preserve()` and gives the arena-worker the same value (`api.env.AGENT_URL_SECRET_KEY`). Without it Agent URL mode and webhooks are refused, with a message saying so; previews and checks through the runner still work. Changing it later makes every stored Agent URL and webhook secret unusable (owners set them again).
   2. Merge and let the new image deploy (the migrations run on start: 0020 and 0021 for this work, and 0022 for the launch round: `vault_trades`, the keeper's index of each vault's `Executed` events for its trading status and gas estimate; `owner_notifications`, the in-app list; `muted` in `notification_settings`; `claim_filed_at` in `handled_events`; and `funnel_daily`, counts per day with nothing about who). The keeper starts indexing trades from its existing cursor, so trades before the deploy aren't in the trading status.
   3. `railway config plan` (it must show nothing to destroy), then `railway config apply`. The configuration spells out `PREVIEW_PER_WALLET_DAILY=3` (raised from the default 1 while builders test, so a fix can be rated again the same day) and `PREVIEW_DAILY=20` on the API and the arena-worker, gives the arena-worker its public domain on port 8080 (`GATEWAY_PORT`), sets `GATEWAY_TRUST_PROXY=1` on it (Railway's edge is one proxy hop), and sets `GATEWAY_PUBLIC_URL` on both.
   4. Optional settings, on both the API and the arena-worker, all with safe defaults: `PREVIEW_CREATES_PER_WALLET_DAILY`, `PREVIEW_RATING_MAX_MS`, `CHECKS_PER_WALLET_HOURLY`, `CHECKS_HOURLY`, `AGENT_URL_VERIFIES_PER_WALLET_HOURLY`, `AGENT_URL_VERIFIES_HOURLY`, `BONDED_OWN_HOSTS` (table above). Email stays off unless you set both `RESEND_API_KEY` and `EMAIL_FROM` (the configuration sets neither). Never set `AGENT_URL_ALLOW_LOOPBACK` on Railway.
   5. Check `GET /healthz` on the gateway's domain and `GET /health` on the API.
4. **Redeploy the protocol on the testnets for smart-account modules** (done, Oct 10, 2026). The CoverManager, ClaimsEngine and DisputeModule deployed on Sep 27 predated `MandateModule`, so module cover needed a full redeployment of the protocol (new addresses for every contract), which added `MandateModuleFactory` and pointed CoverManager at it. Agents, vaults, bonds and cover on the old deployment stay where they are. The `<chainId>.json` files carry `moduleFactory`, so the web app offers module protection.

### After a redeployment

A redeployment numbers agents, policies, claims and bounties from 1 again, and the database keys them by chain and on-chain id only. So the services won't run on the old deployment's state: each records the registry its database holds state for (the `deployments` table), and when the deployment file names another registry they wait, and log:

> Chain 46630 was redeployed: the database holds state for the registry 0x35f6…, and the deployment file names 0x6915…. Waiting. …

Moving the database onto the new deployment clears that chain's on-chain state from the old one: agents and their ratings, attestations, quotes, runner tokens and Agent URLs, connection checks, the keeper's cursor, vaults, policies and claims, recorded trades, Sentinel check counts, bounty submissions and agents' notifications. Previews (with their ratings and tokens), sign-ins, notification settings, held-out attacks and funnel counts stay. It is a deliberate step, never automatic:

1. Commit the new `<chainId>.json` and empty `config/agents.46630.json` (its agents were registered on the old contracts), clear `onchain` in `config/leaderboard.json` and the links in `config/agent-links.json`, and merge. The api's health check fails while it waits, so Railway keeps the previous api running; the keeper and arena-worker wait.
2. In Railway, set `ADOPT_DEPLOYMENT` on the **api** service to the new registry address, exactly as in the deployment file (`0x691563A85D1D80f2891c0ecb2096E58CC4b4DFBA` for the Oct 10 deployment on Robinhood Chain testnet). A different value, or a wrong deployment file, changes nothing.
3. The api clears the old state in one transaction and logs what it removed ("Moved chain 46630 from the registry … Cleared: …"). The keeper and arena-worker go on within 30 seconds; the keeper starts at the new `deployedAtBlock`.
4. Remove `ADOPT_DEPLOYMENT` (it does nothing once the new deployment is recorded), check `GET /status`, and check that Vercel rebuilt the web app (it bundles `46630.json`).
5. Seed the demo agents again on the new contracts (`pnpm demo:seed-agent -- --write-config`, `pnpm tee:seed -- … --write-config` and the Gate 1 agent), post the leaderboard entries again (`pnpm leaderboard add --rating <folder> --post`) and cross-post the scores (`pnpm scores crosspost`; without `ATTESTER_KEY` in `.env`, add `--attester-env DEPLOYER_PRIVATE_KEY --owner-env DEPLOYER_PRIVATE_KEY`), then commit the config they write. Check that each leaderboard rating folder is the one the leaderboard shows (its report hash), not an older run.
6. Fund the new bounty pool. The new BountyBoard starts empty and fills only with 5% of premiums, so accepted bounties couldn't be paid; the old board's balance stays on the old contract (it has no withdrawal, and it holds the old test dollar). Mint test tUSDG straight to it: `mint(<bountyBoard>, <amount>)` on the deployment's `usdg` (6 decimals), signed with the deployer key. The Oct 10 deployment got 10,000 tUSDG this way.
7. Publish the packages with a new version, so builders get the new addresses' docs. Owners of their own agents register them again on the new contracts.

Deploy with `WAITING_PERIOD=0` in `.env` for the demo loop (the deploy script's default is 1 day; `setTerms(2592000, 0)` on CoverManager changes it afterwards), and see the Sepolia note in [Deploying](../contracts/evm/deployments/README.md#deploying).

## Synthetic Sentinel data

`pnpm sentinel:synth` writes synthetic training rows for Sentinel (specification Section 10.3), seeded from the `sentinel-dataset.jsonl` a rating writes. Labels are chosen by the generator, never by the model. It needs `OPENROUTER_API_KEY` in `.env` and a spending cap:

```bash
pnpm sentinel:synth --seeds ratings/vulnerable-agent_scripted/sentinel-dataset.jsonl --count 300 --max-usd 0.5
```

Paths are relative to `apps/arena`. Output goes to `apps/arena/datasets/sentinel-synthetic.jsonl` (gitignored); rerun the same command to resume. By default it keeps the held-out attack classes out of the data, so the evaluation tests classes Sentinel never trained on; `--exclude-classes none` turns that off.

Fine-tuning Laya on it: `pnpm sentinel:dataset` turns real and synthetic rows into Laya's typed-decision format, with a held-out test split.

## Solana programs

`contracts/solana` is an Anchor workspace with the Solana versions of the registry, mandate vault and cover (specification Section 7). It needs Rust, the Solana CLI 3.x and Anchor 1.x.

```bash
pnpm solana:test
```

This builds the three programs and their IDLs, then runs the LiteSVM tests against them: signed scores, the vault's breach checks, and the cover flow from bond to paid claim.

## TEE key custody

The hardened agent can run in a Phala Cloud confidential VM. Its keys are made inside the VM, and an Intel TDX quote proves which code holds them. The Arena verifies the quote, puts the measurement in the score (`arena rate --tee-url …`), and the agent profile shows a "TEE" badge. Why and how: [TEE.md](TEE.md). Deploying it yourself: [docs/TEE.md](TEE.md).

## The documentation site

`apps/docs` is a [Starlight](https://starlight.astro.build) (Astro) site served at `/docs` on the web app. It is generated from the Markdown in this repository (the README, `docs/`, the contracts' READMEs), so edit those files, not the site. Links between docs become links between pages; a link to code, or a path in backticks, becomes a link to that file on GitHub. Evidence files that notes cite are published under `/docs/evidence/`.

```bash
pnpm docs:dev                 # the site on http://localhost:4321/docs/
pnpm --filter @bonded/docs build
```

`pnpm --filter @bonded/web build` builds the docs and copies them into the web app's output. In `pnpm --filter @bonded/web dev`, `/docs` is proxied to the docs dev server.
