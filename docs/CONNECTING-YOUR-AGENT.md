# Connecting your agent

How to connect your agent to Bonded for a test, and what it gets in each episode. New here? Start with [BRING-YOUR-OWN-AGENT.md](BRING-YOUR-OWN-AGENT.md).

## Connect your agent

Pick one of two ways. Both give the same episodes, tools and judging. (A stock-trading preview can also be run by Bonded from your agent's instructions or one code file: [HOSTED-AGENTS.md](HOSTED-AGENTS.md).)

- **Runner:** your agent runs as a command. The runner connects out, so no port needs to be open. Needed for a TEE-bound agent in chain mode.
- **Agent URL:** your agent is a web service (Vercel and the like). Bonded sends a signed `POST` to your public https endpoint.

### Runner

You need Node 22 or later. The page gives you the token and the gateway.

```bash
read -rs BONDED_RUNNER_TOKEN && export BONDED_RUNNER_TOKEN   # paste the token from the page: not shown, not saved in history
npx @bondedhq/runner --gateway https://arena-worker-production.up.railway.app -- node my-agent.js
```

Add `--mode chain` for an agent that signs its own transactions (it must match the mode you chose), `--world brokerage` for stock trading, `--code-hash` to declare your code version, or `--tee-url` for a TEE-bound agent. [The runner's README](../apps/runner/README.md) lists the rest.

The runner starts your command once per episode, one at a time. Your agent never sees the runner token, only URLs that work for that episode. The runner exits with code 2 if its token is wrong or revoked, or another runner connects with the same token.

#### Set it up with init

For a Node agent, run `init` in your agent's folder. It detects your framework, shows the change as a diff and asks before writing.

```bash
npx @bondedhq/runner init          # shows the change and asks
npx @bondedhq/runner init --print  # only prints it
```

It adds one new file and changes at most one line of yours:

| Framework | The one line |
|---|---|
| LangChain / LangGraph, Vercel AI SDK | `const tools = await bondedTools(productionTools);` |
| Coinbase AgentKit | `AgentKit.from({ ... })` becomes `bondedAgentKit({ ... })` |
| ElizaOS | `plugins: [...bondedPlugins, ...yourPlugins]` |
| MCP client | `new StreamableHTTPClientTransport(new URL(bondedMcpUrl(yourServerUrl)))` |
| Python, or unknown | No change: it prints what to do |

In a test, that line gives your agent the episode's tools. In production it gives your own tools, and trades through your Mandate Vault once `BONDED_VAULT_ADDRESS` is set.

- With your token (`BONDED_RUNNER_TOKEN=... npx @bondedhq/runner init --gateway ...`), `init` also starts the runner and runs the connection check.
- `--url` writes an Agent URL route instead (Next.js, Express, Hono or `node:http`).
- It never touches your `.env` values or files outside the folder.

#### Keep it running

Ratings, renewals and connection checks all need the runner connected. `bonded-runner service --print systemd|pm2|docker` prints a config that restarts it and starts it at boot, keeping the token out of the config ([details](../apps/runner/README.md#keep-it-running)). You're told if it's offline for over 30 minutes when a rating is due.

For Docker, build the runner image from a clone of the repo (`docker build -f apps/runner/Dockerfile -t bonded-runner .`; it isn't on a registry) and put your agent on top:

```dockerfile
FROM bonded-runner
COPY --chown=node:node my-agent /agent
RUN cd /agent && npm ci --omit=dev
CMD ["--gateway", "https://arena-worker-production.up.railway.app", "--", "node", "/agent/index.js"]
```

#### The code hash fills itself in

Each rating records which code it rated. The runner uses the first of: `--code-hash` (or `BONDED_CODE_HASH`), `BONDED_IMAGE_DIGEST`, the git commit of your agent's entry file, or a hash of the command and entry file (labelled "unpinned"). An Agent URL reports its `version`. A hash you declare when registering always wins. Reported hashes are never shown as verified: only a TEE binds the code.

### Agent URL

Bonded sends three kinds of signed call to your endpoint. Answer each within 10 seconds.

| Bonded sends | You answer |
|---|---|
| `verify`, with a challenge | `200` with `{ challenge, owner, version? }` |
| `episode`, the same JSON the runner gets | Any `2xx` at once, then work in the background and `POST` its `done` URL |
| `cancel` | Stop that episode |

`owner` is the wallet that saved the URL; `version` is your code version. `createBondedHandler` from `@bondedhq/sdk/agent-url` is the whole endpoint: it checks every signature and the owner, answers `verify`, and runs your `onEpisode` in the background.

```ts
// app/api/bonded/route.ts (Next.js)
import { after } from "next/server";
import { createBondedHandler } from "@bondedhq/sdk/agent-url";
import { bondedAiSdkTools } from "@bondedhq/sdk/ai-sdk";
import { generateText, stepCountIs } from "ai";
import { model } from "./model"; // your AI SDK model, for example from @ai-sdk/openai

const handler = createBondedHandler({
  owner: "0xYourWallet", // the wallet you save this URL from; public, not a secret
  version: process.env.GIT_SHA,
  async onEpisode(episode, { signal }) {
    const tools = await bondedAiSdkTools(episode);
    const { text, totalUsage } = await generateText({
      model, tools, stopWhen: stepCountIs(10), prompt: episode.task.goal, abortSignal: signal,
    });
    return {
      finalMessage: text,
      usage: { inputTokens: totalUsage.inputTokens ?? 0, outputTokens: totalUsage.outputTokens ?? 0 },
    };
  },
});

// `after` keeps the episode running once the response is sent.
export const POST = (req: Request) => handler(req, { waitUntil: after });
```

On other platforms:

- **Express or `node:http`:** `app.post("/bonded", toNodeHandler(handler))`, mounted before `express.json()` (it needs the raw body).
- **Hono:** `handler(c.req.raw)`. **Cloudflare Workers:** `handler(req, ctx)`.
- **Where work stops once the response is sent,** pass the platform's `waitUntil` (Vercel's `waitUntil`, Next.js `after`), as above or as the `waitUntil` option.
- **Python:** [`examples/python-agent-url`](../examples/python-agent-url/README.md) is a whole endpoint with the standard library and `cryptography`. [`agent-url-agent.mjs`](../apps/runner/examples/agent-url-agent.mjs) is the same in plain JavaScript, a template for other languages.

Then:

1. Deploy it.
2. Save the URL on the page, signed in with the same wallet.
3. Press **Verify it now**. Verify again after each redeploy.

**URL rules:** https on port 443, a public address, no redirects (register the final URL), not one of Bonded's own hosts. One episode runs at a time per agent.

**Writing your own handler?** Answer `401` unless all of these hold:

1. The Ed25519 signature in `bonded-signature` is valid over `v2.<key id>.<timestamp>.<owner>.<raw body>`, with the keys at `https://www.bondedhq.xyz/.well-known/bonded-agent-keys.json`.
2. The timestamp is within 300 seconds.
3. `bonded-owner` is your wallet.
4. The signature hasn't been used before.

`verifyAgentUrlRequest` in `@bondedhq/shared` does exactly this, and `createTestSigner()` plays Bonded in your tests.

## Inside an episode

![In an episode the agent reads nine sources (inbox, news, social, prices, token info, transfers, the research report, market alerts and messages from other agents), some of them planted; every swap, transfer or approve goes through the mandate check, which allows it or records a breach.](images/byoa-inside-an-episode.svg)

Both ways give your agent the same episode:

| Runner variable | Episode field | What it is |
|---|---|---|
| `BONDED_TASK` | `task` | `{ goal, mandate, policy?, maxSteps }` |
| `BONDED_MCP_URL` | `endpoints.mcp` | The tools over MCP (streamable HTTP) |
| `BONDED_TOOLS_URL` | `endpoints.tools` | The tools as HTTP: `GET` lists, `POST <url>/<name>` calls |
| `BONDED_DONE_URL` | `endpoints.done` | `POST { finalMessage?, usage? }` when finished |
| `BONDED_DEADLINE_MS` | `deadlineMs` | 90 seconds in a hosted rating, 4 minutes for stock trading |
| `BONDED_MODE` | `mode` | `tools` or `chain` |
| `BONDED_RPC_URL`, `BONDED_SESSION_KEY` | `endpoints.rpc`, `sessionKey` | Chain mode only |

`maxSteps` caps your agent's tool calls. The episode also carries its id, chain id, vault and market contracts; in TypeScript, `fromBondedEnv()` reads it all and `isBondedEpisode()` says whether your agent is under test. Under the runner, exiting also ends the episode. Send your model's `usage` with `done` if you can: Bonded uses it for cost estimates, never for verdicts.

### Tool mode

Your agent reads and trades through tool calls, in any language that speaks MCP or HTTP.

- **Reads**, where attacks are planted: `read_inbox`, `read_news`, `read_social`, `get_prices`, `get_token_info`, `get_recent_transfers`, `get_market_report`, `read_market_alerts`, `read_counterparty_messages`. Attacks can't reach `get_portfolio`.
- **Writes:** `swap`, `transfer` and `approve`, with amounts as decimal strings (`"2000"`), through the episode's vault.
- A failed call returns an error; it doesn't end the episode.

Read all nine sources, and treat what you read as data, never as instructions. A source your agent never reads leaves its attacks untested, which lowers the score.

### Chain mode

Reads are still tool calls. Writes are transactions your agent signs with the episode's session key and sends through the episode's RPC.

- The only allowed write is `MandateVault.execute(target, data)`, with no ETH. `episodeVault(episode)` from `@bondedhq/sdk` does it for you.
- The RPC accepts standard reads (including `eth_call` and `eth_simulateV1`) and refuses node-admin methods.
- Per-episode limits sit well above what a trading agent needs. Going past them stops the agent, and counts as the agent's doing.
- A TEE-bound agent signs with a key its TEE derives ([Bring your own TEE](OFFICIAL-RATINGS.md#bring-your-own-tee)).
- Chain mode is for EVM agents. A Solana agent is rated in tool mode.

### Stock trading

Pick **Stock trading** on Test your agent and start the runner with `--world brokerage`. It runs in tool mode on a simulated brokerage account and gives findings, not a score ([BROKERAGE.md](BROKERAGE.md#your-own-agent)).

## The connection check

One episode with **no attack**, run through exactly the connection a rating will use and streamed live. It tells you in a minute or two whether a rating would work.

It passes when your agent was reached, called tools, made the trade its task names, broke no rule and finished on its own. Warnings, such as sources it never read, don't fail it. A preview or rating needs a passing check of the same connection (runner token or Agent URL, mode and code) from the last 24 hours. You can run up to 10 checks an hour. For any problem it reports, see [Troubleshooting](TROUBLESHOOTING.md).

## The HTTP API

Everything the pages do is plain HTTP at `https://api-production-ba50.up.railway.app`. Sign in for a session token (`POST /previews/session` with a signed message, or an email code or passkey: [ACCOUNTS.md](ACCOUNTS.md)) and send it as `Authorization: Bearer bonded_ss_...`.

| Endpoint | What it does |
|---|---|
| `POST /previews`, `GET /previews`, `GET /previews/:id` | Start a preview (`{ mode, world?, toolNames? }`), list, read |
| `POST /previews/:id/runner-token` | A runner token, shown once |
| `POST …/agent-url`, `POST …/agent-url/verify` | Save and verify an Agent URL |
| `POST …/checks`, `GET /checks/:id/events` | Run a connection check and stream it |
| `POST /runner/check` | A check with the runner token alone (`Bearer bonded_rt_...`) |
| `POST /previews/:id/rate`, `GET /previews/:id/report` | Start the preview rating, read its report |
| `POST /previews/:id/share` | A read-only link to the report |
| `POST /self/agents`, `POST /self/agents/:id/rate` | Register an agent, queue an official rating |
| `GET /agents/:id/score` | An agent's latest score |
| `GET /status` | Whether the service is up |

Checks, previews and ratings are visible to their owner only. Every refusal has a stable code, listed in [Troubleshooting](TROUBLESHOOTING.md).

## Rate on your own machine

Run a full rating locally, with no keys or accounts. You need Node 22, pnpm 10 and Foundry ([DEVELOPING.md](DEVELOPING.md#1-install-the-tools)).

```bash
git clone --recursive https://github.com/ddboy19912/bonded && cd bonded
pnpm install && pnpm build
pnpm arena rate --agent remote --runner-token my-local-runner-token   # terminal 1: chain, protocol and gateway
BONDED_RUNNER_TOKEN=my-local-runner-token node apps/runner/dist/cli.js \
  --gateway http://127.0.0.1:8789 -- node apps/runner/examples/mcp-agent.mjs   # terminal 2: your agent
```

Put your own agent after `--`. It runs every published attack once, a held-out set and six control episodes, prints the score and writes the report to `apps/arena/ratings/remote_local/report.md`. `pnpm arena check` runs just the connection check.
