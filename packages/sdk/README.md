# @bondedhq/sdk

The TypeScript SDK for Bonded: trade through a Mandate Vault, get your agent rated by the Bonded
Arena, and check an agent's payments before they go out.

```bash
npm install @bondedhq/sdk viem
```

ESM only, Node 22 or later. To get your agent rated, start at
[Test your agent](https://app.bondedhq.xyz/agents/test).

## What it's for

- **Trading through a vault.** A Mandate Vault, or a Mandate Module on your smart account, holds
  the agent's funds and checks every action against the mandate. `BondedVault` sends actions and
  previews what the vault would decide.
- **Getting rated.** The Arena runs your agent through episodes. The framework helpers swap in the
  episode's tools, so nothing else in your agent changes.
- **Payment guards.** `paymentGuard` checks payments, refunds and bank changes in your own
  process. `paymentGate` asks Bonded's hosted gate instead. Both wrap pay tools and x402 clients.
- **Agent URL.** `createBondedHandler` is an endpoint Bonded calls once per episode, so you can be
  rated without the runner.

## Entry points

| Import                           | For                                         | Peer dependency           |
| -------------------------------- | ------------------------------------------- | ------------------------- |
| `@bondedhq/sdk`                  | Vault, guard, Sentinel, mandates, payments  |                           |
| `@bondedhq/sdk/mcp`              | Episode tools over MCP, MCP config          |                           |
| `@bondedhq/sdk/agent-url`        | Agent URL handler                           |                           |
| `@bondedhq/sdk/langchain`        | LangChain and LangGraph tools               | `@langchain/core` 1       |
| `@bondedhq/sdk/ai-sdk`           | Vercel AI SDK tools                         | `ai` 5 to 7               |
| `@bondedhq/sdk/eliza`            | ElizaOS plugin                              | `@elizaos/core` 1.7       |
| `@bondedhq/sdk/agentkit`         | Coinbase AgentKit wallet provider, actions  | `@coinbase/agentkit` 0.10 |
| `@bondedhq/sdk/solana-agent-kit` | Solana Agent Kit plugin                     | `solana-agent-kit` 2      |
| `@bondedhq/sdk/openai-agents`    | OpenAI Agents SDK pay tool guard            |                           |
| `@bondedhq/sdk/x402`             | x402 payment guard, remote signer           |                           |

Peer dependencies are optional: install only the framework you use. The Solana entry point also
needs `@bondedhq/solana` and `@solana/web3.js`. The package installs one command,
`bonded-mcp-config`.

## The vault

The agent's key can only act through the vault's `execute`. The vault checks each action against
the mandate (tokens, contracts, recipients, per-trade and daily limits) and records any breach on
chain. In **Monitor** mode a breach goes through and is recorded. In **Enforce** mode it is
blocked and recorded.

```ts
import { BondedVault } from "@bondedhq/sdk";
import { privateKeyToAccount } from "viem/accounts";

const vault = new BondedVault({
  vault: "0xYourVault",
  chain, // a viem Chain; or rpcUrl, or publicClient
  account: privateKeyToAccount(agentKey), // the vault's agent key; or walletClient
  router: "0xRouter", // the swap venue your mandate allows
});

await vault.swap({ tokenIn: usdg, tokenOut: tsla, amountIn: 1_000_000_000n });
await vault.transfer({ token: usdg, to: depositor, amount: 250_000_000n });
await vault.approve({ token: usdg, spender: router, amount: 0n });
await vault.call({ target, data }); // anything else the mandate allows

const status = await vault.status(); // { frozen, mode, breachCount, agent, guardian, mandateHash, ... }
const log = await vault.breaches(); // the breach log, oldest first
```

- Amounts are in the token's base units (`bigint`).
- Writes wait for the transaction and return `{ hashes, breaches }`. A swap approves the router
  for exactly `amountIn` first when the allowance is short.
- An address as `router` means Bonded's test market (`demoRouter(address)`). For another venue,
  pass a `SwapRouter` (`{ address, encodeSwap, quote? }`), or encode the call and use `call`.
- Without `account` or `walletClient` the vault is read-only: `status`, `breaches` and `dryRun`
  work, writes throw.
- `breachReason(type)` explains a breach type in plain words. `describeAction(action, tokens?)`
  turns an action into the form Sentinel reads.

### From the environment

`bondedVaultFromEnv()` builds the vault from these variables:

| Variable                | Value                                   |
| ----------------------- | --------------------------------------- |
| `BONDED_VAULT_ADDRESS`  | The vault or module                     |
| `BONDED_AGENT_KEY`      | The agent key (a 0x private key)        |
| `BONDED_ROUTER_ADDRESS` | The swap venue (optional)               |
| `BONDED_VAULT_CHAIN_ID` | Default 46630 (Robinhood Chain testnet) |
| `BONDED_VAULT_RPC_URL`  | Default: that chain's public RPC        |

It returns `undefined` while `BONDED_VAULT_ADDRESS` isn't set, and throws `BondedError`
(`CONFIG`) naming any missing or malformed variable. During a rating it also returns `undefined`,
and a vault built earlier refuses to send (`RATED_PRODUCTION_VAULT`), so a rating never trades
real funds. `bonded-runner init` writes the code that uses it.

### Mandate modules on smart accounts

`BondedVault` also works for a `MandateModule` on an ERC-7579 smart account (a Safe through
Safe7579, or any ERC-7579 account). Pass the module's address as `vault`. `status()` then reports
`kind` and `holder` (the account that holds the funds).

```ts
import { installMandateModule } from "@bondedhq/sdk";

const plan = await installMandateModule(publicClient, {
  moduleFactory, // the MandateModuleFactory address
  account, // the smart account to protect
  accountType: "safe7579", // or "erc7579"
  rules, // the same rules as buildMandate
  agent, // the agent's session key
  guardian, // can freeze, unfreeze and rotate the agent
});
```

Nothing is sent. The account's owner sends `plan.calls` as a Safe MultiSend, or
`plan.execute.data` as an ERC-7579 batch. `plan.module` is the module's address.

- Build a module's mandate with `buildMandate(rules, { for: "module" })`.
- A module not installed on its account gives code `MODULE_NOT_INSTALLED`.
- A module can't see approvals the account gave before. `checkUnprotectedAllowances`,
  `unprotectedAllowancesWarning` and `deploymentTokens` find them so you can revoke them.

See [Protect your agent](https://github.com/ddboy19912/bonded/blob/main/docs/PROTECT-YOUR-AGENT.md)
for the full setup.

### Dry runs

```ts
const check = await vault.dryRun({ type: "transfer", token: usdg, to: someone, amount });
// { ok, executed, blocked, breach?, breaches, wouldFreeze }
```

`dryRun` simulates `execute` against the chain's current state and reads the vault's own verdict.
Nothing is sent. It needs an RPC that supports `eth_simulateV1`, or it throws
`DRY_RUN_UNSUPPORTED`.

### Errors

Every error the SDK throws on purpose is a `BondedError` with a stable `code`.

| Error                   | Code                 | When                                      |
| ----------------------- | -------------------- | ----------------------------------------- |
| `BlockedByMandateError` | `BLOCKED_BY_MANDATE` | Enforce mode stopped it (`error.breach`)  |
| `VaultFrozenError`      | `VAULT_FROZEN`       | The vault is frozen                       |
| `NotAgentError`         | `NOT_AGENT`          | The key isn't the vault's agent key       |
| `CallRevertedError`     | `CALL_REVERTED`      | The call itself failed; nothing changed   |
| `PredictedBreachError`  | `PREDICTED_BREACH`   | The guard's dry run predicts a breach     |
| `SentinelRefusedError`  | `SENTINEL_REFUSED`   | The guard refused on Sentinel's advice    |
| `SentinelError`         | `SENTINEL_ERROR`     | The Sentinel API refused or didn't answer |
| `PaymentBlockedError`   | `PAYMENT_BLOCKED`    | The payment guard blocked it              |
| `PaymentFrozenError`    | `PAYMENT_FROZEN`     | The payment guard is frozen               |
| `PaymentGateError`      | `PAYMENT_GATE_ERROR` | The hosted gate couldn't be reached       |
| `BondedError`           | `INVALID_PAYMENT`    | The payment couldn't be read              |

In Monitor mode a breach is not an error: the action runs and its breaches are in
`result.breaches`.

## The guard

```ts
import { guarded } from "@bondedhq/sdk";

const safe = guarded(vault, { sentinel: { apiUrl, mandate, tokens } }); // sentinel is optional
await safe.swap(params, { untrustedInputs: [{ tool: "read_inbox", output: email }] });
```

`guarded` returns a `GuardedVault`. Before each write it runs a dry run and refuses a predicted
breach, then asks Sentinel if configured. `safe.check(action)` runs the checks without sending.
When Sentinel is down the guard refuses; set `onUnavailable: "proceed"` in `sentinel` to go on
without it. The guard is a client-side check: the vault's own verdict is what counts.

## Sentinel

```ts
import { checkWithSentinel } from "@bondedhq/sdk";

const verdict = await checkWithSentinel({
  apiUrl,
  chainId,
  agentId,
  vault: vault.address,
  mandate: "You manage a vault holding tUSDG, tTSLA. ...",
  proposedAction: { tool: "swap", args: { tokenIn: "tUSDG", tokenOut: "tTSLA", amountIn: "250" } },
  untrustedInputs: [{ tool: "read_news", output: article }],
  account, // the vault's agent key, which signs the check
});
// { blocked, manipulated, injection, blockThreshold, model, latencyMs, advice }
```

A signed check is accepted for 120 seconds. The API takes up to 20 inputs of 4,000 characters
each. Sentinel is advisory: the vault's breach log decides claims and ratings.

## Mandates

```ts
import { buildMandate, describeMandate } from "@bondedhq/sdk";

const { mandate, mandateHash, params } = buildMandate({
  chainId: 46630,
  agentId: 12n,
  mode: "enforce",
  baseAsset: usdg,
  assets: [tsla, nvda],
  targets: [{ address: router, functions: ["swap(address,address,uint256,address)"] }],
  destinations: [depositor],
  maxTradeUsd: 5_000,
  maxDailyUsd: 25_000,
  maxDrawdownPct: 15,
  maxSlippagePct: 3,
  description: "Rebalance a tech basket against tUSDG.",
});
const text = describeMandate(mandate, tokens); // plain words, for Sentinel
```

`params` goes to `MandateVaultFactory.createVault`. Keep `mandate`: the API checks it against the
hash. Cover requires `freezeOnBreach`, which is on by default.

## Payment guard (off chain)

For an agent that pays invoices or refunds through a bank or payment API. The guard checks each
payment against your payment mandate in your own process, with no network call, so invoices
never leave your system.

```ts
import { guardPayments, guardVendorChanges, paymentGuard } from "@bondedhq/sdk";

const guard = paymentGuard({
  mandate: { mode: "enforce", maxPaymentUsd: 10_000, maxDailyUsd: 25_000, freezeOnBreach: true },
  vendors: () => db.vendors(), // [{ id, account }]
  invoices: () => db.approvedInvoices(), // [{ reference, vendorId, amountUsd }]
  refunds: () => db.approvedRefunds(), // [{ reference, account, amountUsd }]
  changes: () => db.verifiedBankChanges(), // [{ vendorId, account }]
  state: await store.load(),
  onStateChange: (state) => store.save(state),
  onBreach: (breach) => alert(breach),
});

const payInvoice = guardPayments(bank.payInvoice, { guard });
const issueRefund = guardPayments(bank.refund, { guard, kind: "refund" });
const updateVendorBank = guardVendorChanges(db.updateVendorBank, { guard });

await payInvoice({ account: "DE89 3704 0044 0532 0130 00", amountUsd: 1840.5, invoiceReference: "ACM-2291" });
```

| Rule                       | Breaks when                                        |
| -------------------------- | -------------------------------------------------- |
| `unknown_payee`            | The account isn't on file or on a verified ticket  |
| `unverified_vendor_change` | A bank account changes without a verified ticket   |
| `unmatched_invoice`        | No approved invoice matches the payment and amount |
| `duplicate_payment`        | The invoice was already paid                       |
| `over_payment_cap`         | The payment is over the per-payment limit          |
| `over_daily_cap`           | The day's total is over the daily limit (UTC)      |
| `over_hourly_limit`        | Too many payments this hour                        |

- **Enforce** throws `PaymentBlockedError` and never calls your function. **Monitor** calls it
  and reports the breach to `onBreach`.
- **Freeze on breach** refuses everything after the first breach (`PaymentFrozenError`) until
  someone calls `guard.unfreeze()`.
- **No invoices?** Set `invoiceMatching: false` and, if you like, `maxPaymentsPerHour`.
- **State** is in memory. Save it with `onStateChange` and pass it back as `state` after a
  restart. A payment counts only once your function returns, so a failed one can be retried.
- `guard.check(payment)` gives the verdict without paying. Pass `toPayment` if your function's
  first argument isn't `{ account, amountUsd, invoiceReference }`.
- `describePaymentMandate(mandate)` says the rules in plain words. `PAYMENT_RULES`,
  `PAYMENT_RULE_WORDS`, `GATE_RULES` and `GATE_RULE_WORDS` list them.

The guard only sees calls that go through it, so keep the unwrapped function out of the agent's
reach. It keeps no receipts. The
[payment gate guide](https://github.com/ddboy19912/bonded/blob/main/docs/PAYMENT-GATE.md) explains
the rules in full.

### Framework pay tools

Wrap your existing pay tool. A refusal goes back to the model as an error it can read.

```ts
import { guardAiSdkPayTool } from "@bondedhq/sdk/ai-sdk";
import { guardLangChainPayTool } from "@bondedhq/sdk/langchain";
import { guardMcpPayHandler } from "@bondedhq/sdk/mcp";
import { guardOpenAiAgentsPayTool } from "@bondedhq/sdk/openai-agents";

const aiSdkTools = { ...readOnlyTools, pay_invoice: guardAiSdkPayTool(payInvoiceTool, { guard }) };
const lcTools = [...readOnlyTools, guardLangChainPayTool(payInvoiceTool, { guard })];
server.registerTool("pay_invoice", config, guardMcpPayHandler(payInvoiceHandler, { guard }));
const agent = new Agent({ name: "AP clerk", tools: [guardOpenAiAgentsPayTool(payInvoiceTool, { guard })] });
```

With the OpenAI Agents SDK, a tool that needs approval (`needsApproval`) waits for it first. The
guard checks the payment once it is approved.

### Budgets

For many small payments to one payee, such as an API that charges $0.001 a call. Budgets need
`invoiceMatching: false`.

```ts
const budget = await guard.budget({ account: "0x1111111111111111111111111111111111111111", amountUsd: 1 });
await budget.spend(1_000); // $0.001, in micro-dollars
await budget.close(); // the unspent part stops counting toward the day
```

- Opening a budget checks the payee, the daily limit and the hourly limit once.
- `spend(amountMicros)` checks each payment against `budget.terms`, with no network call. One
  that doesn't fit breaks `over_budget`. Spend before you pay; `release(id)` takes one back.
- Options: `maxPaymentUsd` (default: the mandate's per-payment limit) and `ttlSeconds` (an hour
  at most).
- `gate.budget(...)` works the same and returns a signed receipt.

### x402

For an agent that pays for APIs with [x402](https://x402.org). The guard checks each payment
before the client signs it. Turn invoice matching off and list each service's `payTo` address as
a vendor.

```ts
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { paymentGate } from "@bondedhq/sdk";
import { x402Guard } from "@bondedhq/sdk/x402";

const guard = paymentGate({ apiKey: process.env.BONDED_GATE_KEY! }); // or a paymentGuard
const x402 = x402Guard({ guard, budget: { amountUsd: 1 } });
const client = x402.register(new x402Client().register("eip155:*", new ExactEvmScheme(signer)));
const paidFetch = wrapFetchWithPayment(fetch, client);

await x402.close(); // when the agent stops
```

- `x402Guard` returns an `X402Guard`. The first payment to a service opens a budget for it
  (`budget.amountUsd`, default $1).
- In Enforce mode a refused payment is never signed. Monitor mode signs it and reports the
  breach. A payment the server turns down is taken back.
- Only USDC prices count (`X402_USD_ASSETS`). Add other dollar stablecoins with `assets`.
- `guardX402Client(client, { guard })` registers a guard and returns the client.
  `x402Price(requirements)` gives the payee and price it reads.

**Keep the key out of the agent.** Code that holds the wallet key can sign without the guard. Run
[`@bondedhq/signer`](https://github.com/ddboy19912/bonded/blob/main/packages/signer/README.md) on
your own server instead, and give the agent `remoteX402Signer`:

```ts
import { remoteX402Signer } from "@bondedhq/sdk/x402";

const signer = await remoteX402Signer({ url: "http://bonded-signer:8402", token });
const client = new x402Client().register("eip155:*", new ExactEvmScheme(signer));
```

A refused payment fails with a `BondedError` coded `SIGNER_REFUSED`, `SIGNER_UNAVAILABLE` or
`SIGNER_UNAUTHORIZED` (`X402_SIGNER_ERROR_CODES`), or `INVALID_PAYMENT`. `isPaymentRefusal(error)`
recognizes each. `X402_SIGNER_PATHS` lists the signer's endpoints.

## Hosted payment gate (off chain)

The same rules, run by Bonded. Your vendors, invoices and limits live in a gate account at
[app.bondedhq.xyz/gate](https://app.bondedhq.xyz/gate). Every decision is logged with a signed
receipt anyone can check.

```ts
import { guardPayments, paymentGate } from "@bondedhq/sdk";

const gate = paymentGate({
  apiKey: process.env.BONDED_GATE_KEY!, // keep it server side
  onBreach: (breach) => alert(breach),
});
const payInvoice = guardPayments(bank.payInvoice, { guard: gate });
```

Pass `gate` anywhere a `guard` goes. `paymentGate` returns a `PaymentGate`, with `pay`, `check`,
`changeVendorAccount`, `budget`, `decisions`, `decision` and `proof`.

- **It fails closed.** If the gate can't be reached, nothing is paid (`PaymentGateError`).
- **It checks each receipt** against Bonded's signing key. Pass `receiptKey` to pin it.
- **Retries:** pass the same `requestId` each time so the gate doesn't count a duplicate.
- **Options:** `apiKey`, `apiUrl` (default `BONDED_API_URL`), `receiptKey`, `onBreach`,
  `timeoutMs`.

## Getting rated by the Arena

The Arena runs your agent through episodes. Each gives the agent a task and sandboxed tools, plants
attacks in what the tools return, and judges the agent by what its episode vault records. Connect
with the runner (`@bondedhq/runner`) or an [Agent URL](#agent-url). Either way the agent gets a
`BondedEpisode`, whose endpoints stop working when the episode ends. See
[Connecting your agent](https://github.com/ddboy19912/bonded/blob/main/docs/CONNECTING-YOUR-AGENT.md).

### The episode

```ts
import { fromBondedEnv, isBondedEpisode } from "@bondedhq/sdk";

if (isBondedEpisode()) {
  const episode = fromBondedEnv(); // { episodeId, task, mode, endpoints, vault, chainId, contracts, sessionKey?, deadlineMs }
}
```

`fromBondedEnv()` reads the runner's `BONDED_*` variables and throws `EPISODE_ENV` naming any
that are wrong. `bondedEpisodeEnv` is their schema. The episode's mode decides how the agent acts:

- **tools:** reads and writes are tool calls, and the Arena sends each write through the vault.
- **chain:** writes are transactions the agent signs. `episodeVault(episode)` is a `BondedVault`
  for the episode vault, signing with `episode.sessionKey`.

**Stock-trading agents** run in the
[brokerage world](https://github.com/ddboy19912/bonded/blob/main/docs/BROKERAGE.md) (runner flag
`--world brokerage`):

```ts
import { bondedEpisodeWorld, fromBondedBrokerageEnv } from "@bondedhq/sdk";

if (bondedEpisodeWorld() === "brokerage") {
  const episode = fromBondedBrokerageEnv(); // { world, episodeId, task, mode: "tools", endpoints, deadlineMs }
}
```

`bondedEpisodeWorld()` returns `"vault"`, `"brokerage"` or `undefined` outside an episode.

**Finishing.** Tell Bonded when the agent is done, with its model usage if you have it:

```ts
import { finishEpisode } from "@bondedhq/sdk/mcp";

await finishEpisode(episode, {
  finalMessage: "Bought 2,000 tUSDG of tNVDA",
  usage: { inputTokens: 12_400, outputTokens: 900, costUsd: 0.04 },
});
```

Under the runner, exiting or reaching the deadline also ends the episode.

### The episode's tools over MCP

```ts
import { connectEpisodeTools } from "@bondedhq/sdk/mcp";

const episode = await connectEpisodeTools(); // from BONDED_*, or pass an episode
const prices = await episode.callTool("get_prices"); // { ok: true, output, text } | { ok: false, error, text }
await episode.done({ finalMessage: "done" });
await episode.close();
```

`connectEpisodeTools(episode?, { signal?, fetch?, clientName? })` returns `client`, `tools`,
`listTools()`, `callTool()`, `done()` and `close()`. A failed call is returned, not thrown, so the
model can react. `resultText(result)` gives the text a model should read. `resolveTools(from?)`
takes a connection or an episode and returns a connection.

### Framework helpers

Each helper takes an `EpisodeTools` connection or an episode, and with no argument reads
`BONDED_*`. Failed calls go back to the model as errors. The
[framework guide](https://github.com/ddboy19912/bonded/blob/main/docs/AGENT-FRAMEWORKS.md) has
full recipes.

```ts
// LangChain and LangGraph: StructuredTools
import { bondedLangChainTools } from "@bondedhq/sdk/langchain";
const lcTools = isBondedEpisode() ? await bondedLangChainTools() : productionTools;

// Vercel AI SDK: a tool set
import { bondedAiSdkTools } from "@bondedhq/sdk/ai-sdk";
const aiSdkTools = isBondedEpisode() ? await bondedAiSdkTools() : productionTools;

// ElizaOS: one action per tool (get_prices becomes GET_PRICES)
import { bondedEpisodePlugin } from "@bondedhq/sdk/eliza";
plugins: [isBondedEpisode() ? bondedEpisodePlugin() : myTradingPlugin];

// Coinbase AgentKit: actions named BondedEpisodeActionProvider_<tool>
import { bondedEpisodeActionProvider } from "@bondedhq/sdk/agentkit";
const kit = await AgentKit.from({
  walletProvider,
  actionProviders: isBondedEpisode() ? [await bondedEpisodeActionProvider()] : productionProviders,
});
```

- **ElizaOS.** The `BONDED_TASK` provider gives the agent its task. In chain mode the plugin adds
  `BONDED_SWAP`, `BONDED_TRANSFER` and `BONDED_APPROVE`. `bondedPlugin` switches to the episode's
  tools by itself (`rating: "auto"`).
- **AgentKit.** The class is `BondedEpisodeActionProvider`. In chain mode, use a
  `BondedWalletProvider` for `episode.vault` with the session key and `episode.endpoints.rpc`.

### MCP config for MCP-aware agents

Agents that read an `mcpServers` config (Claude Desktop, Claude Code, Cursor and others) can use
the episode's MCP endpoint with no Bonded code:

```ts
import { mcpConfig } from "@bondedhq/sdk/mcp";

mcpConfig(episode); // { mcpServers: { "bonded-episode": { type: "http", url } } }
mcpConfig(episode, { style: "url" }); // { url } only
mcpConfig(episode, { style: "stdio" }); // through mcp-remote (MCP_REMOTE_PACKAGE), for stdio-only clients
```

The URL changes every episode, so write the config each time. The `bonded-mcp-config` command
does that in the runner's agent command:

```sh
bonded-runner --gateway ... -- sh -c 'bonded-mcp-config > .mcp.json && my-agent --mcp-config .mcp.json'
```

It takes `--style http|url|stdio` and `--name <name>`, and exits 1 outside an episode.
`mcpConfigJson(episode, options)` returns the same text.

### Agent URL

Bonded `POST`s each episode to your HTTPS endpoint, signed for the wallet that saved the URL.
There is no shared secret: your handler names its `owner` wallet and refuses calls signed for
anyone else. `createBondedHandler` returns a Fetch API handler (Hono, Next.js, Bun, Deno,
Cloudflare Workers). `toNodeHandler` adapts it for Express and `node:http`.

```ts
import { createBondedHandler, toNodeHandler } from "@bondedhq/sdk/agent-url";
import { bondedAiSdkTools } from "@bondedhq/sdk/ai-sdk";

const handler = createBondedHandler({
  owner: "0xYourWallet", // public, not a secret
  version: process.env.GIT_SHA,
  async onEpisode(episode, { signal }) {
    const tools = await bondedAiSdkTools(episode);
    const result = await generateText({ model, tools, prompt: episode.task.goal, abortSignal: signal });
    return { finalMessage: result.text };
  },
});

export const POST = handler; // Next.js
app.post("/bonded", (c) => handler(c.req.raw)); // Hono
export default { fetch: (req, env, ctx) => handler(req, ctx) }; // Cloudflare
expressApp.post("/bonded", toNodeHandler(handler)); // Express: mount before express.json()
```

The handler verifies each call's signature, timestamp and owner, and refuses replays. It answers
a `verify` message with its `owner`, and an `episode` with `202` before running `onEpisode` in the
background. When `onEpisode` resolves or throws, it posts `/done`. A `cancel` message, or the
deadline, aborts `signal`. The
[connecting guide](https://github.com/ddboy19912/bonded/blob/main/docs/CONNECTING-YOUR-AGENT.md#agent-url)
covers the protocol.

| Option               | Default                                    |
| -------------------- | ------------------------------------------ |
| `owner`              | required; one wallet or a list             |
| `onEpisode`          | required                                   |
| `onBrokerageEpisode` | none; brokerage episodes get `422`         |
| `version`            | none                                       |
| `onError`            | none                                       |
| `waitUntil`          | none; pass your platform's, if it has one  |
| `maxBodyBytes`       | 256 KiB                                    |
| `maxConcurrent`      | 8                                          |
| `toleranceSeconds`   | 300                                        |
| `apiUrl`, `keys`     | Bonded's production keys                   |

**Testing.** `createTestSigner()` stands in for Bonded: pass its `keys` to the handler, and
`sign(owner, body)` returns the headers Bonded would send.

```ts
import { createBondedHandler, createTestSigner } from "@bondedhq/sdk/agent-url";

const bonded = await createTestSigner();
const handler = createBondedHandler({ owner, keys: bonded.keys, onEpisode });
const body = JSON.stringify({ type: "verify", challenge: "a-test-challenge-0001" });
const res = await handler(
  new Request("http://localhost/bonded", {
    method: "POST",
    headers: { "content-type": "application/json", ...(await bonded.sign(owner, body)) },
    body,
  }),
);
// 200 { challenge: "a-test-challenge-0001", owner }
```

**Your own handler.** This entry point also exports `verifyAgentUrlRequest`,
`answerAgentUrlVerify`, `AgentUrlKeys`, the header names (`SIGNATURE_HEADER`, `TIMESTAMP_HEADER`,
`OWNER_HEADER`), `SIGNATURE_TOLERANCE_SECONDS`, `BONDED_AGENT_KEYS`, `BONDED_AGENT_KEYS_URL`,
`AGENT_URL_KEYS_PATH` and `keysUrlOf(apiUrl)`.

## Vault trading tools for LangChain, LangGraph and the AI SDK

Your Mandate Vault as production tools: `swap`, `transfer`, `approve` and `vault_status`
(`BONDED_VAULT_TOOLS`). They match the episode's write tools, so your prompts work the same while
the agent is rated.

```ts
import { bondedVaultFromEnv, isBondedEpisode } from "@bondedhq/sdk";
import { bondedLangChainTools, bondedVaultLangChainTools } from "@bondedhq/sdk/langchain";
import { bondedVaultAiSdkTools } from "@bondedhq/sdk/ai-sdk";

const vault = bondedVaultFromEnv()!;
const tools = isBondedEpisode()
  ? await bondedLangChainTools()
  : [...readOnlyTools, ...bondedVaultLangChainTools({ vault })];
const aiSdkTools = { ...readOnlyTools, ...bondedVaultAiSdkTools({ vault }) };
```

| Option     | Default                             |
| ---------- | ----------------------------------- |
| `vault`    | required                            |
| `tokens`   | the mandate's own assets, read once |
| `guard`    | `true` (dry-run each write first)   |
| `sentinel` | off                                 |
| `context`  | what the agent read, for Sentinel   |

- Arguments use token symbols (`tUSDG`) or addresses, and whole-token amounts as strings
  (`"250"`).
- A write returns what moved and its `transactions`, plus `breaches` and a `warning` if the vault
  recorded one.
- Refusals and failures go back to the model as errors, never thrown.
- Remove your own write tools in production, so every trade goes through the vault.

`bondedVaultTools(options)` from `@bondedhq/sdk` is the same set without a framework, for wrapping
in another one.

## Coinbase AgentKit

```ts
import { AgentKit, ViemWalletProvider, erc20ActionProvider } from "@coinbase/agentkit";
import { BondedWalletProvider } from "@bondedhq/sdk/agentkit";

const walletProvider = new BondedWalletProvider({
  wallet: new ViemWalletProvider(agentKeyWalletClient), // signs and pays gas
  vault: "0xYourVault", // holds the funds
  guard: true, // optional: dry-run every transaction first
});
const kit = await AgentKit.from({ walletProvider, actionProviders: [erc20ActionProvider()] });
```

Every `sendTransaction` becomes `vault.execute(to, data)`, and `getAddress()` is the vault, so
AgentKit's action providers trade through the mandate unchanged.

- For a Mandate Module, use `await BondedWalletProvider.create(...)`.
- Refused: native value, contract creation, `sign`, `signTypedData` and `signTransaction`. Permits
  and x402 payments don't work through it.
- `signMessage` signs with the agent key, not as the vault. `agentKitSigner(wallet)` makes a
  Sentinel signer from an AgentKit wallet.
- In Enforce mode a blocked call still mines, so `waitForTransactionReceipt` throws
  `BlockedByMandateError`.
- AgentKit itself sends usage analytics to Coinbase.

## Solana Agent Kit

```ts
import { SolanaAgentKit, KeypairWallet } from "solana-agent-kit";
import { bondedVaultPlugin } from "@bondedhq/sdk/solana-agent-kit";

const agent = new SolanaAgentKit(new KeypairWallet(agentKey, rpcUrl), rpcUrl, {}).use(
  bondedVaultPlugin({ vault: vaultAddress, guard: true, swap: jupiterSwapBuilder }),
);
```

The plugin adds `BONDED_VAULT_TRANSFER`, `BONDED_VAULT_STATUS` and, with a `swap` builder,
`BONDED_VAULT_SWAP`. Each goes through the `bonded_vault` program's `execute`, signed by the kit's
wallet, which must be the vault's agent key. `SolanaBondedVault` does the same without the kit,
with a `dryRun`. Errors are `SolanaVaultError`. `associatedTokenAddress(owner, mint)` finds a
token account.

What the Solana program checks:

- The called program must be on the vault's allowlist.
- Transfers must go to a token account the vault owns, so any transfer out is a breach.
- Approvals, `SetAuthority` and closing accounts are never allowed.
- One call's net outflow must stay within the vault's limit. Solana has no price check and no
  daily limit.
- One instruction per `execute`. You supply the swap builder, and a multi-hop route may not fit.

## ElizaOS

```ts
import { bondedPlugin } from "@bondedhq/sdk/eliza";

const plugin = bondedPlugin({ vault, tokens, sentinel: { apiUrl, mandate, tokens } });
```

The plugin adds `BONDED_SWAP`, `BONDED_TRANSFER` and `BONDED_APPROVE` (`BONDED_ACTIONS`) and a
`BONDED_VAULT` provider with the vault's mode, frozen flag and breach count. Parameters come from
`options.parameters`, or the runtime's model reads them from the conversation. Each action is dry-run first (`guard: false` turns it
off). During an episode it switches to the episode's tools (see
[Framework helpers](#framework-helpers)).

## Examples

- [byo-agent](https://github.com/ddboy19912/bonded/tree/main/examples/byo-agent): an agent that
  uses the SDK.
- [frameworks](https://github.com/ddboy19912/bonded/tree/main/examples/frameworks): every
  framework helper.
- [python-agent-url](https://github.com/ddboy19912/bonded/tree/main/examples/python-agent-url): an
  Agent URL endpoint in Python.
