# Bring your own agent

Test your AI agent against Bonded's attacks where it already runs, in any framework or language. A preview is free, private and needs no wallet, tokens or vault: start at [www.bondedhq.xyz/agents/test](https://www.bondedhq.xyz/agents/test).

This page is the short version. The details live on their own pages, linked at the end.

## Test your agent for free

1. **Sign in** on [Test your agent](https://www.bondedhq.xyz/agents/test) with an email code, a passkey or a browser wallet. Nothing is sent on chain.
2. **Pick what your agent does:** trade crypto from a vault, or trade stocks at a broker ([BROKERAGE.md](BROKERAGE.md)). Then answer two questions: which framework it's built on, and where it runs.
3. **Connect it**, one of three ways ([Connect your agent](#connect-your-agent)).
4. **Run the connection check:** one episode with no attack, streamed live, ending with what to fix if anything failed.
5. **Start the preview.** Bonded runs its attacks against your agent: a crypto preview is up to 72 episodes, a stock-trading preview 20, and either finishes within 45 minutes.
6. **Read the report:** which attacks worked, what your agent read and did, what was at risk, and **Fix these first**, the three changes that cover the most of them. Change your agent and press **Rate again** to see before and after.

Want a score on chain and cover? **Make it official** from the report ([PREVIEWS-AND-RATINGS.md](PREVIEWS-AND-RATINGS.md#official-ratings)).

Stuck? Every refusal and failed check has an entry on the [troubleshooting page](TROUBLESHOOTING.md). Service status: https://www.bondedhq.xyz/status.

### No agent yet?

Try the whole flow with the example agent in the runner package. It reads every source an attack can be planted in, makes the one trade its task names, and never acts on what it reads. You need Node 22 or later.

```sh
mkdir bonded-test && cd bonded-test && npm init -y
npm install @bondedhq/runner @modelcontextprotocol/sdk
cp node_modules/@bondedhq/runner/examples/mcp-agent.mjs .
BONDED_RUNNER_TOKEN=<the token the page shows> npx bonded-runner --gateway https://arena-worker-production.up.railway.app --mode tools -- node mcp-agent.mjs
```

On the page, choose **Something else (MCP or HTTP)** and **On my computer or server**, take the token from the command it shows, and leave the runner running while you run the connection check. With your own agent, put its start command after `--` instead.

## Connect your agent

Your agent keeps running where it runs. During a test it reads and trades through the episode's tools instead of your live ones, so nothing touches a real account.

| | When to use it | How |
|---|---|---|
| **Runner** (the default) | Your agent runs as a command: on your laptop, a server, or a host that keeps a process running | Start it through the runner: `BONDED_RUNNER_TOKEN=... npx @bondedhq/runner --gateway https://arena-worker-production.up.railway.app --mode tools -- <your agent command>`. For a Node agent, `npx @bondedhq/runner init` writes the wiring for you, shows it as a diff and asks before saving. The runner only connects out, so no port needs to be open. |
| **Agent URL** | Your agent is a web service, for example on Vercel | Add one endpoint that Bonded calls once per episode: `npx @bondedhq/runner init --url` writes it for Next.js, Express, Hono or `node:http`, or mount `createBondedHandler` from `@bondedhq/sdk` yourself. Python has a standard-library example. Save the URL on the page and verify it. |
| **Bonded runs it** | Stock trading only, when you'd rather not deploy anything for a test | Paste your agent's instructions or one code file and pick a model; Bonded runs it and pays for the model ([HOSTED-AGENTS.md](HOSTED-AGENTS.md)). |

In each episode your agent gets the tools at an MCP address or as plain HTTP, and `isBondedEpisode()` from `@bondedhq/sdk` tells it that it's under test. Setup, the episode protocol, chain mode and the HTTP API: [CONNECTING-YOUR-AGENT.md](CONNECTING-YOUR-AGENT.md).

## Use your framework

ElizaOS, Coinbase AgentKit, LangChain and LangGraph, the Vercel AI SDK, any MCP client and Python each have a short recipe for using the episode's tools: [AGENT-FRAMEWORKS.md](AGENT-FRAMEWORKS.md).

## What you get

| | What it means |
|---|---|
| **Preview** | A full report on how your agent does under attack: free and private, with no vault, bond, tokens or on-chain registration. |
| **Official rating** | The same attacks, run more times, with a signed score posted on chain ([PREVIEWS-AND-RATINGS.md](PREVIEWS-AND-RATINGS.md#official-ratings)). |
| **Protection** | Your agent's real trades go through a Mandate Vault, or a module on the smart account it already uses, which checks every action against your rules ([Protect your agent](#protect-your-agent)). |
| **Cover** | Once rated and protected, the vault can be insured, and a recorded breach pays out on chain. |

Pass or fail is decided by code: on chain by the episode vault's breach log, at a broker by a sandboxed ledger. Nothing your agent, the runner or an AI says changes a verdict. How Bonded keeps the sandbox honest, and what can still tell it apart from production: [SANDBOX-SECURITY.md](SANDBOX-SECURITY.md).

## Protect your agent

To protect your agent's real trades, send them through a Mandate Vault in production, or install `MandateModule` on the ERC-7579 smart account it already uses. `@bondedhq/sdk` and its plugins for Coinbase AgentKit, Solana Agent Kit and ElizaOS do the wiring, and Sentinel can check each action before it's sent: [PROTECT-YOUR-AGENT.md](PROTECT-YOUR-AGENT.md).

## All the details

| Page | What's in it |
|---|---|
| [CONNECTING-YOUR-AGENT.md](CONNECTING-YOUR-AGENT.md) | Agent URL and runner setup, what's inside an episode, the runner protocol, the connection check, the HTTP API, rating on your own machine |
| [AGENT-FRAMEWORKS.md](AGENT-FRAMEWORKS.md) | Recipes for each framework |
| [PREVIEWS-AND-RATINGS.md](PREVIEWS-AND-RATINGS.md) | The preview step by step, official ratings, binding levels, bringing your own TEE, the report, the Task score, staying rated, progress and notifications |
| [PROTECT-YOUR-AGENT.md](PROTECT-YOUR-AGENT.md) | Mandate Vaults, modules on a smart account, framework plugins, Sentinel |
| [SANDBOX-SECURITY.md](SANDBOX-SECURITY.md) | The security model, and the limits of the sandbox |
| [BROKERAGE.md](BROKERAGE.md) | The stock-trading test |
| [APPROVAL-IN-TESTS.md](APPROVAL-IN-TESTS.md) | What happens when your agent asks a person to approve a trade |
| [DATA-HANDLING.md](DATA-HANDLING.md) | What Bonded keeps from a test, and for how long |
