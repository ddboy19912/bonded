# @bondedhq/sdk

Trade through a Bonded Mandate Vault from any TypeScript agent, wherever it runs, and get it rated
by the Bonded Arena without changing how it works.

The vault holds the agent's funds. The agent's key can only act through `MandateVault.execute(target, data)`, which checks every action against the mandate (tokens, contracts, recipients, per-trade and daily limits) and records any breach on chain. In **Monitor** mode a breach goes through and is recorded; in **Enforce** mode it is blocked and recorded. That breach log decides ratings and pays claims. This SDK is the agent's side of it: send actions, preview what the vault would decide, and ask Sentinel for advice.

```bash
npm install @bondedhq/sdk viem
```

ESM only, Node 22 or later. Inside the Bonded repository, depend on it with
`"@bondedhq/sdk": "workspace:*"`. To get your own agent rated, start at
[Test your agent](https://www.bondedhq.xyz/agents/test).

| Entry point | What it is | Peer dependency |
|---|---|---|
| `@bondedhq/sdk` | The vault client, dry runs, the guard, Sentinel, mandates, `fromBondedEnv`, the payment guard | |
| `@bondedhq/sdk/mcp` | An episode's tools over MCP, `/done`, MCP config; a guarded pay tool handler | |
| `@bondedhq/sdk/agent-url` | The Agent URL handler | |
| `@bondedhq/sdk/langchain` | The episode's tools as LangChain `StructuredTool`s; the vault's trading tools; a guarded pay tool | `@langchain/core` 1 |
| `@bondedhq/sdk/ai-sdk` | The episode's tools as a Vercel AI SDK tool set; the vault's trading tools; a guarded pay tool | `ai` 5 to 7 |
| `@bondedhq/sdk/eliza` | The ElizaOS plugin, with a rating mode | `@elizaos/core` 1.7 |
| `@bondedhq/sdk/agentkit` | AgentKit wallet provider for the vault; the episode's tools as actions | `@coinbase/agentkit` 0.10 |
| `@bondedhq/sdk/solana-agent-kit` | Solana Agent Kit plugin for the Solana vault | `solana-agent-kit` 2, `@bondedhq/solana` |

## The vault

```ts
import { BondedVault } from "@bondedhq/sdk";
import { privateKeyToAccount } from "viem/accounts";

const vault = new BondedVault({
  vault: "0xYourVault",
  chain, // a viem Chain; or pass publicClient
  account: privateKeyToAccount(agentKey), // the vault's agent key; or pass walletClient
  router: "0xRouter", // the swap venue your mandate allows (for swap)
});

await vault.swap({ tokenIn: usdg, tokenOut: tsla, amountIn: 1_000_000_000n });
await vault.transfer({ token: usdg, to: depositor, amount: 250_000_000n });
await vault.approve({ token: usdg, spender: router, amount: 0n });
await vault.call({ target, data }); // anything else the mandate allows

const status = await vault.status(); // { frozen, mode, breachCount, agent, guardian, mandateHash, agentId, freezeOnBreach }
const log = await vault.breaches(); // the vault's breach log, oldest first
```

Amounts are in the token's base units (`bigint`). Each write waits for its transaction and returns `{ hashes, breaches }`. A swap approves the router for exactly `amountIn` first when the vault's allowance is short, so it can take two transactions. `swap` speaks the interface of Bonded's testnet market (`DemoRouter`); for any other venue pass a `SwapRouter` (`{ address, encodeSwap, quote? }`) as `router`, or encode the call yourself and use `call`.

**From the environment.** `bondedVaultFromEnv()` builds the production vault from
`BONDED_VAULT_ADDRESS` (the vault or module), `BONDED_AGENT_KEY` (its agent key, a 0x private key),
`BONDED_ROUTER_ADDRESS` (the swap venue, optional), `BONDED_VAULT_CHAIN_ID` (default 46630, Robinhood
Chain testnet) and `BONDED_VAULT_RPC_URL` (default: that chain's public RPC). It returns `undefined`
while `BONDED_VAULT_ADDRESS` isn't set, so the same code runs before the agent has a vault, and
throws `BondedError` (`CONFIG`) naming every missing or malformed variable. These names differ from
the `BONDED_*` variables the runner sets for an episode, and the runner removes `BONDED_AGENT_KEY`
and `BONDED_VAULT_ADDRESS` from a rated agent's environment, so a rating never trades real funds.
If they come back anyway (a `.env` file reloaded with `node --env-file` or dotenv), it still returns
`undefined` while the process is rated (a Bonded episode's variables are set) and warns once, and a
production vault built earlier refuses to send (`BondedError` `RATED_PRODUCTION_VAULT`).
`bonded-runner init` writes the code that uses it.

### Mandate modules on smart accounts

The same client works for a `MandateModule`: the mandate on an ERC-7579 smart account the operator already uses (Safe through Safe7579, or any ERC-7579 account). Pass the module's address as `vault`. The SDK tells the two apart on chain (`identify()`; `status()` reports `kind` and `holder`, where the funds are: the vault itself or the module's account), and swaps approve and pay out to the account. Build the mandate with `buildMandate(rules, { for: "module" })`: a module's on-chain hash is the commitment to its params, which `MandateModuleFactory.createModule` checks. When the account's call fails, Safe7579 reverts with `ExecutionFailed()` and no reason; that comes back as `CallRevertedError`. A module not installed on its account gives code `MODULE_NOT_INSTALLED`. For AgentKit, use `await BondedWalletProvider.create(...)` so the wallet's address is the account.

To put a module on an account, `installMandateModule(publicClient, { moduleFactory, account, accountType, rules, agent, guardian })` prepares the one transaction the account's owner sends: `createModule`, then `installModule` as executor and as hook. It returns the module's predicted address, the params with their commitment, the mandate JSON to keep, and the calls both as a list (for a Safe MultiSend) and as an ERC-7579 batch (`execute.data`, e.g. for a user operation). Nothing is sent by the SDK.

Without `account` or `walletClient` the vault is read-only: `status`, `breaches` and `dryRun` work, writes throw.

### Dry runs

```ts
const check = await vault.dryRun({ type: "transfer", token: usdg, to: someone, amount });
// { ok, executed, blocked, breach?, breaches, wouldFreeze }
if (!check.ok) console.log(check.breach?.type, check.breach?.reason);
```

`dryRun` simulates `execute` from the agent key against the chain's current state (`eth_simulateV1`) and reads the vault's own `BreachRecorded`, `Executed` and `Frozen` events. The verdict is the contract's own, not a copy of its rules in TypeScript, so it can't drift from what the vault does. Nothing is sent. It needs an RPC that supports `eth_simulateV1` (anvil and Robinhood Chain's public RPC do); otherwise it throws `BondedError` with code `DRY_RUN_UNSUPPORTED`.

### Errors

Every error the SDK throws on purpose is a `BondedError` with a stable `code`:

| Error | When |
|---|---|
| `BlockedByMandateError` (`BLOCKED_BY_MANDATE`) | Enforce mode stopped the action. The attempt is in the breach log (`error.breach`); nothing moved |
| `VaultFrozenError` (`VAULT_FROZEN`) | The vault is frozen, or this action found an earlier unexplained outflow and froze it first (`error.breach`) |
| `NotAgentError` (`NOT_AGENT`) | The key isn't the vault's agent key |
| `CallRevertedError` (`CALL_REVERTED`) | The call itself failed (e.g. not enough balance). Nothing changed |
| `PredictedBreachError` (`PREDICTED_BREACH`) | A guarded vault refused: the dry run predicts a breach (`error.dryRun`) |
| `SentinelRefusedError` (`SENTINEL_REFUSED`) | A guarded vault refused on Sentinel's advice (`error.verdict`) |
| `SentinelError` (`SENTINEL_ERROR`) | The Sentinel API refused the request or didn't answer (`error.status`) |
| `PaymentBlockedError` (`PAYMENT_BLOCKED`) | The payment guard's Enforce mode stopped a payment or bank change (`error.breach`). Your pay function wasn't called |
| `PaymentFrozenError` (`PAYMENT_FROZEN`) | The payment guard is frozen after a breach; `guard.unfreeze()` lets payments through again |
| `BondedError` (`INVALID_PAYMENT`) | The payment guard couldn't read the payment (a missing account or reference, an amount that isn't a positive number of cents) |

In Monitor mode a breaching action is **not** an error: it runs, and its breaches come back in the result. Check `result.breaches`, or use `guarded`.

## The guard

```ts
import { guarded } from "@bondedhq/sdk";

const safe = guarded(vault, {
  sentinel: { apiUrl: "https://your-bonded-api", mandate, tokens }, // optional
});
await safe.swap(params, { untrustedInputs: [{ tool: "read_inbox", output: email }] });
```

Before each write the guard runs the dry run and refuses a predicted breach; then, if configured, it asks Sentinel and refuses if Sentinel advises against. That turns a Monitor-mode vault into one that doesn't knowingly breach. It is a client-side check: the chain can change between the dry run and the transaction, and the vault's own verdict is what counts. When Sentinel is down or busy the guard refuses by default; set `onUnavailable: "proceed"` to go ahead without its advice. `safe.check(action)` runs the checks without sending.

## Sentinel

```ts
import { checkWithSentinel } from "@bondedhq/sdk";

const verdict = await checkWithSentinel({
  apiUrl, chainId, agentId, vault: vault.address,
  mandate: "You manage a vault holding tUSDG, tTSLA. ...",
  proposedAction: { tool: "swap", args: { tokenIn: "tUSDG", tokenOut: "tTSLA", amountIn: "250" } },
  untrustedInputs: [{ tool: "read_news", output: article }],
  account, // the vault's agent key: the API only answers checks it signed
});
// { blocked, manipulated, injection, blockThreshold, model, latencyMs, advice }
```

Signs the check (EIP-191, the message from `@bondedhq/shared`) and calls `POST /sentinel/check`. Sentinel is advisory: the vault's breach log, not Sentinel, decides claims and ratings. A signed check is accepted for 120 seconds; the API takes at most 20 inputs of 4,000 characters (longer ones are cut, as Sentinel reads them).

## Mandates

```ts
import { buildMandate, describeMandate } from "@bondedhq/sdk";

const { mandate, mandateHash, params } = buildMandate({
  chainId: 46630, agentId: 12n, mode: "enforce",
  baseAsset: usdg, assets: [tsla, nvda],
  targets: [{ address: router, functions: ["swap(address,address,uint256,address)"] }],
  destinations: [depositor],
  maxTradeUsd: 5_000, maxDailyUsd: 25_000, maxDrawdownPct: 15, maxSlippagePct: 3,
  description: "Rebalance a tech basket against tUSDG.",
});
// params goes to MandateVaultFactory.createVault; keep `mandate`, the API checks it against the hash.
const text = describeMandate(mandate, tokens); // for Sentinel checks
```

The same builder the web app's onboarding uses, so both hash the same rules the same way. Cover requires `freezeOnBreach`, which is the default.

## Payment guard (off chain)

For an agent that pays invoices or refunds from a bank or payment API: check every payment
against the payment mandate first, inside your own process. It runs the same rule engine the
Arena rates off-chain agents against (`@bondedhq/shared`'s payment mandate), with no network and no
model, so invoices never leave your system. It is free.

```ts
import { guardPayments, guardVendorChanges, paymentGuard } from "@bondedhq/sdk";

const guard = paymentGuard({
  mandate: { mode: "enforce", maxPaymentUsd: 10_000, maxDailyUsd: 25_000, freezeOnBreach: true },
  vendors: () => db.vendors(), // [{ id, account }]: the vendor master
  invoices: () => db.approvedInvoices(), // [{ reference, vendorId, amountUsd }]
  refunds: () => db.approvedRefunds(), // [{ reference, account, amountUsd }]
  changes: () => db.verifiedBankChanges(), // [{ vendorId, account }]: finance-verified tickets
  state: await store.load(), // what onStateChange saved last time, if anything
  onStateChange: (state) => store.save(state),
  onBreach: (breach) => alert(breach), // { rules, reasons, blocked, account, amountUsd, lossUsd, ... }
});

const payInvoice = guardPayments(bank.payInvoice, { guard });
const issueRefund = guardPayments(bank.refund, { guard, kind: "refund" });
const updateVendorBank = guardVendorChanges(db.updateVendorBank, { guard });

await payInvoice({ account: "DE89 3704 0044 0532 0130 00", amountUsd: 1840.5, invoiceReference: "ACM-2291" });
```

The six rules: pay only a vendor's account on file or one a verified ticket covers
(`unknown_payee`), change a vendor's bank account only with a verified ticket
(`unverified_vendor_change`), pay only approved invoices for exactly the approved amount
(`unmatched_invoice`) and only once (`duplicate_payment`), and stay under the per-payment and daily
limits (`over_payment_cap`, `over_daily_cap`; days are UTC). `describePaymentMandate(mandate)` says
them in plain words, and `PAYMENT_RULE_WORDS` names each rule.

Payments with no invoices: set `invoiceMatching: false` on the mandate, and optionally
`maxPaymentsPerHour`. A payment then needs a listed vendor and to stay within the limits, and
`invoiceReference` is optional. `GATE_RULE_WORDS` adds the hourly rule's words. The hosted gate
reads the same setting from your account, so your code doesn't change.

- **Enforce** blocks: a payment that breaks a rule throws `PaymentBlockedError` naming every rule
  broken in plain words, and your pay function is never called. **Monitor** calls it anyway and
  reports the breach to `onBreach`. A bank change no ticket covers that Monitor lets through is
  remembered: its account is never treated as the vendor's.
- **Freeze on breach:** after the first breach every payment and bank change is refused
  (`PaymentFrozenError`) until a person calls `guard.unfreeze()`.
- **State:** the guard keeps the payments made, the frozen flag and unverified bank changes in
  memory. `onStateChange` gets a copy after every change; pass it back as `state` to restore it
  after a restart (or seed `state.payments` with what you paid before). A payment is recorded only
  once your pay function returns, so a failed one can be retried.
- Payments go through the guard one at a time, so two calls at once can't both pass the duplicate
  or daily check. `guard.check(payment)` gives the verdict without paying.
- Your function's first argument is read as `{ account, amountUsd, invoiceReference }` (or
  `reference`, as the Arena's `pay_invoice` and `issue_refund` tools take them); pass `toPayment`
  for any other shape.

For framework tools, wrap your existing pay tool; a refusal goes back to the model so it can react
(AI SDK: `{ error }`; LangChain: `Error: ...` text; MCP: an `isError` result):

```ts
import { guardAiSdkPayTool } from "@bondedhq/sdk/ai-sdk";
import { guardLangChainPayTool } from "@bondedhq/sdk/langchain";
import { guardMcpPayHandler } from "@bondedhq/sdk/mcp";

const tools = { ...readOnlyTools, pay_invoice: guardAiSdkPayTool(payInvoiceTool, { guard }) };
const lcTools = [...readOnlyTools, guardLangChainPayTool(payInvoiceTool, { guard })];
server.registerTool("pay_invoice", config, guardMcpPayHandler(payInvoiceHandler, { guard }));
```

The OpenAI Agents SDK works the same way, and the model gets `Error: ...` text back:

```ts
import { Agent } from "@openai/agents";
import { guardOpenAiAgentsPayTool } from "@bondedhq/sdk/openai-agents";

const agent = new Agent({
  name: "AP clerk",
  tools: [...readOnlyTools, guardOpenAiAgentsPayTool(payInvoiceTool, { guard })],
});
```

If the tool needs a person's approval (`needsApproval`), the run stops for that first. The guard
still checks the payment once it is approved.

What it doesn't do: it is a local check, so code that calls your pay function directly skips it.
Keep the unwrapped function out of the agent's reach. It makes no receipts: nothing outside your
process records or signs its decisions, so `onBreach` and `onStateChange` are your only log.

### Budgets

For many small payments to one payee, such as an API that charges $0.001 a call, ask for a budget
and check each payment against it. The budget is checked once against the rules; each payment is
checked against the budget with no rule check and no network call, in exact micro-dollars
(millionths of a dollar), so $0.001 counts as $0.001. Budgets need `invoiceMatching: false`.

```ts
const budget = await guard.budget({ account: "0x1111111111111111111111111111111111111111", amountUsd: 1 });

await budget.spend(1_000); // $0.001: throws PaymentBlockedError in Enforce mode if it doesn't fit
await budget.close(); // the unspent part stops counting toward the day
```

- **The check:** the payee must be a vendor's account (`unknown_payee`), the whole budget must fit
  in what's left of the day (`over_daily_cap`), and with `maxPaymentsPerHour` there must be room
  for a payment (`over_hourly_limit`). Enforce throws `PaymentBlockedError`; Monitor opens it and
  reports the breach.
- **The terms** (`budget.terms`): the payee, the budget, the most one payment may be
  (`maxPaymentUsd`, default the mandate's per-payment limit), how many payments it covers (what's
  left of the hour, with an hourly limit) and its end (`ttlSeconds`, an hour at most).
- **Each payment:** `spend(amountMicros)` checks it against the terms. One that doesn't fit breaks
  `over_budget`: Enforce throws and doesn't count it; Monitor counts it and reports it. Spend
  before you pay. `release(id)` takes back one the payee turned down.
- **The day:** the whole budget counts toward the daily limit until `close()`; then what was spent,
  rounded up to the cent. A budget past its end is closed the next time one is opened.
- **The hosted gate:** `gate.budget(...)` is the same, with a signed receipt whose input commits to
  the terms; the SDK checks the receipt, recomputes the input's hash and reruns its rules. Payments
  go to the gate in the background and on `close()`, whose receipt commits to every one. Unclosed
  budgets close themselves soon after they end.

### x402

For an agent that pays for APIs with [x402](https://x402.org): check each payment before the x402
client signs it. Turn invoice matching off, and put each service's `payTo` address on the vendor
list, so the agent pays only services you chose:

```ts
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { x402Guard } from "@bondedhq/sdk/x402";

const guard = paymentGate({ apiKey: process.env.BONDED_GATE_KEY! }); // or a local paymentGuard
const x402 = x402Guard({ guard, budget: { amountUsd: 1 } });
const client = x402.register(new x402Client().register("eip155:*", new ExactEvmScheme(signer)));
const paidFetch = wrapFetchWithPayment(fetch, client);

// ...and when the agent stops:
await x402.close();
```

- The first payment to a service opens a budget for it (`budget.amountUsd`, default $1, raised to
  fit a bigger price). Each payment then checks against that budget, exact to the micro-dollar.
  When it's used up or ends, the next payment closes it and opens another.
- A refused payment is never signed: the request fails with the reason. Monitor mode signs it and
  reports the breach.
- A payment the server turns down (it answers 402 again, or settlement fails) is taken back. One
  that settles is reported with its transaction hash.
- Prices count only in USDC on the networks x402 lists it for (Base, Ethereum, Arbitrum, Polygon,
  Avalanche and Solana, plus Base Sepolia and Solana devnet). A price in any other token is
  refused; add your own dollar stablecoins with `assets`.
- `guardX402Client(client, { guard })` registers a guard and returns the client, if you never close
  budgets yourself. `x402Price(requirements)` gives the payee and exact price it reads.

The guard runs in the agent's process, so code that holds the wallet key can still sign without
it. To stop that, keep the key out of the agent: run [`@bondedhq/signer`](../signer/README.md) on
your own server, with the key in your KMS, and give the agent `remoteX402Signer` in place of a
wallet. The signer runs the same budgets and signs only payments that fit:

```ts
import { remoteX402Signer } from "@bondedhq/sdk/x402";

const signer = await remoteX402Signer({ url: "http://bonded-signer:8402", token });
const client = new x402Client().register("eip155:*", new ExactEvmScheme(signer));
```

A payment the signer won't sign fails with a `BondedError` (`SIGNER_REFUSED`, `SIGNER_UNAVAILABLE`,
`SIGNER_UNAUTHORIZED` or `INVALID_PAYMENT`); `isPaymentRefusal` recognizes each.

## Hosted payment gate (off chain)

The same rules as the guard, run by Bonded instead of inside your process. Your vendors, approved
invoices and limits live in a gate account (set up at
[bondedhq.xyz/gate](https://www.bondedhq.xyz/gate)), every decision is logged, and each comes back
with a signed receipt anyone can check at
[bondedhq.xyz/gate/verify](https://www.bondedhq.xyz/gate/verify).

```ts
import { guardPayments, paymentGate } from "@bondedhq/sdk";

const gate = paymentGate({
  apiKey: process.env.BONDED_GATE_KEY!, // bonded_gk_...: keep it server side
  onBreach: (breach) => alert(breach), // { rules, reasons, blocked, decisionId, receipt, ... }
});

const payInvoice = guardPayments(bank.payInvoice, { guard: gate });

await payInvoice({ account: "DE89 3704 0044 0532 0130 00", amountUsd: 1840.5, invoiceReference: "ACM-2291" });
```

Pass `gate` wherever a `guard` goes: `guardPayments`, `guardVendorChanges` and the framework
helpers above. Or call it directly: `gate.pay(payment, send)`, `gate.check(payment)`,
`gate.decisions()`, `gate.proof(decisionId)`.

- **It fails closed.** If the gate can't be reached, your pay function isn't called and
  `PaymentGateError` says why. A check that got no answer is asked once more with the same request
  id, which is safe.
- **It checks the gate.** Each answer's receipt must carry Bonded's signature and match the payment
  you asked about, or nothing is paid. Pass `receiptKey` to pin the signing address; by default it
  reads the published one once.
- **Enforce** throws `PaymentBlockedError`, **Monitor** pays and reports to `onBreach`, and a frozen
  account throws `PaymentFrozenError` until the owner lifts the freeze at bondedhq.xyz/gate.
- **Retries:** the gate counts an allowed payment as made, so if your bank call fails and you try
  again, pass the same `requestId` both times (in the payment, or from `toPayment`). The gate gives
  back the first decision instead of a duplicate breach. A new id is made when you don't pass one.
- **Bank changes** go through `gate.changeVendorAccount({ vendorId, account, ticket }, update)`.
  `ticket` is a finance ticket the owner added to the account.

Like the guard, it only sees payments your code sends it, so keep the unwrapped pay function out of
the agent's reach. Use the guard to keep invoices inside your system; use the gate for a log and
receipts someone else can check.

## Getting rated by the Arena

The Bonded Arena rates an agent by running it through episodes: each one gives the agent a task and
a set of tools (market data, messages, trading) in a sandbox, plants attacks in what the tools
return, and judges the agent only by what its episode vault records. Your agent runs where it
always runs and keeps its own model and prompts; while it is being rated it uses the episode's
tools instead of its production ones. There are two ways to connect:

- **The runner** (`@bondedhq/runner`): it connects out to Bonded and starts your agent command once
  per episode, with the episode in `BONDED_*` environment variables.
- **Agent URL**: no install. You serve one HTTPS endpoint and Bonded calls it once per episode
  (see [Agent URL](#agent-url) below).

Either way the agent gets the same `BondedEpisode`: the task, the mode, and the episode's
endpoints (MCP, plain HTTP, `/done`, and in chain mode a fork RPC). Every endpoint URL carries the
episode's capability and stops working when the episode ends, so nothing about one episode can be
reused in the next.

### The episode

```ts
import { fromBondedEnv, isBondedEpisode } from "@bondedhq/sdk";

if (isBondedEpisode()) {
  const episode = fromBondedEnv(); // { episodeId, task, mode, endpoints, vault, chainId, contracts, sessionKey?, deadlineMs }
}
```

`isBondedEpisode()` is true when the runner set valid `BONDED_*` variables. `fromBondedEnv` reads
and checks them, naming every missing or malformed one (`BondedError`, code `EPISODE_ENV`).

That is the vault world, where ratings run. An agent that trades through a broker can also be
tested on the brokerage world (a simulated brokerage account, no vault; docs/BROKERAGE.md), with a
runner started with `--world brokerage`. Its episode is read with `fromBondedBrokerageEnv()`, and
`bondedEpisodeWorld()` says which world the runner set up:

```ts
import { bondedEpisodeWorld, fromBondedBrokerageEnv, fromBondedEnv } from "@bondedhq/sdk";

const world = bondedEpisodeWorld(); // "vault", "brokerage", or undefined outside an episode
if (world === "brokerage") {
  const episode = fromBondedBrokerageEnv(); // { world, episodeId, task, mode: "tools", endpoints, deadlineMs }
} else if (world === "vault") {
  const episode = fromBondedEnv();
}
```

`isBondedEpisode()` is true in both worlds, so an agent under test never falls through to its
production tools. In a brokerage episode `fromBondedEnv` and the vault tool helpers throw
`EPISODE_ENV` rather than guess. By Agent URL, `createBondedHandler` runs brokerage episodes with
`onBrokerageEpisode` and refuses them (422) without it.

The mode decides how the agent acts:

- **tools**: reads and writes are tool calls; `swap`, `transfer` and `approve` are tools, and the
  Arena sends each write through the episode vault.
- **chain**: reads are tool calls (that is where attacks are planted), and writes are
  transactions the agent signs itself, as in production. `episodeVault(episode)` is a
  `BondedVault` for the episode vault, signing with `episode.sessionKey` through the episode's
  fork RPC; it throws in tools mode, or when the agent's key is in a TEE (no session key).

When the agent is finished it says so, with its own model usage if it can (Bonded uses it to
estimate what a full rating will cost you; it is recorded, never trusted for limits):

```ts
import { finishEpisode } from "@bondedhq/sdk/mcp";

await finishEpisode(episode, {
  finalMessage: "Bought 2,000 tUSDG of tNVDA",
  usage: { inputTokens: 12_400, outputTokens: 900, costUsd: 0.04 },
});
```

Under the runner, exiting also ends the episode; so does its deadline.

### The episode's tools over MCP

```ts
import { connectEpisodeTools } from "@bondedhq/sdk/mcp";

const episode = await connectEpisodeTools(); // from BONDED_*; or pass the episode you were given
episode.tools; // [{ name, description, inputSchema, call(args) }]
const prices = await episode.callTool("get_prices"); // { ok: true, output, text } | { ok: false, error, text }
await episode.done({ finalMessage: "done" });
```

```ts
connectEpisodeTools(
  episode?: EpisodeToolsSource, // default fromBondedEnv()
  options?: { signal?: AbortSignal; fetch?: typeof fetch; clientName?: string },
): Promise<EpisodeTools>;

interface EpisodeTools {
  client: Client; // the official MCP SDK client
  tools: EpisodeTool[]; // listed once at connect
  listTools(): ReturnType<Client["listTools"]>; // MCP tools/list as the server answers
  callTool(name: string, args?: Record<string, unknown>): Promise<EpisodeToolResult>;
  done(body?: DoneRequest): Promise<void>; // POST {done}
  close(): Promise<void>;
}
```

A failed call is returned, not thrown (`ok: false`), so the agent's model can read the error and
react, as it would to a production tool's. `text` is what a model should read.

### Framework helpers

One call gives the episode's tools in your framework's own shape, so the agent's code stays the
same and only the tool list changes while it is being rated. Each helper takes an
`EpisodeTools` connection or an episode, and with no argument reads `BONDED_*`. Each framework is
an optional peer dependency: install the one you use.

**LangChain and LangGraph** (`@langchain/core` 1; `createReactAgent` is from `@langchain/langgraph`):

```ts
import { bondedLangChainTools } from "@bondedhq/sdk/langchain";
import { isBondedEpisode } from "@bondedhq/sdk";

const tools = isBondedEpisode() ? await bondedLangChainTools() : productionTools;
const agent = createReactAgent({ llm, tools }); // or model.bindTools(tools), ToolNode(tools)
```

`StructuredTool`s with each tool's own JSON Schema. They return the Arena's output as text, and
`Error: ...` for a failed call.

**Vercel AI SDK** (`ai` 5 or later; tested with 7):

```ts
import { bondedAiSdkTools } from "@bondedhq/sdk/ai-sdk";

const tools = isBondedEpisode() ? await bondedAiSdkTools() : productionTools;
const { text, totalUsage } = await generateText({ model, tools, stopWhen: stepCountIs(10), prompt });
```

A tool set of `tool({ inputSchema: jsonSchema(...), execute })`; `execute` returns the Arena's
output, or `{ error }` for a failed call.

**ElizaOS** (`@elizaos/core` 1.7): `bondedPlugin` has a rating mode, on by default
(`rating: "auto"`). When the runtime registers the plugin while an episode is running, it swaps
the vault actions for the episode's tools. For an agent that doesn't use the vault plugin in
production, add `bondedEpisodePlugin()` while it is being rated:

```ts
import { bondedEpisodePlugin, bondedPlugin } from "@bondedhq/sdk/eliza";

plugins: [isBondedEpisode() ? bondedEpisodePlugin() : myTradingPlugin];
```

Each tool becomes an action named after it in capitals (`get_prices` is `GET_PRICES`); its
parameters come from `options.parameters`, or the runtime's `OBJECT_SMALL` model reads them from
the conversation against the tool's JSON Schema. The `BONDED_TASK` provider gives the agent the
episode's task and mandate. In chain mode only the reads are tools, and the plugin adds
`BONDED_SWAP`, `BONDED_TRANSFER` and `BONDED_APPROVE` on `episodeVault(episode)`. The actions are
filled in by the plugin's `init`, which the runtime calls before it reads them.

**Coinbase AgentKit** (`@coinbase/agentkit` 0.10):

```ts
import { bondedEpisodeActionProvider } from "@bondedhq/sdk/agentkit";

const kit = await AgentKit.from({
  walletProvider,
  actionProviders: isBondedEpisode() ? [await bondedEpisodeActionProvider()] : productionProviders,
});
// then getLangChainTools(kit) / getVercelAITools(kit) as usual
```

Actions are named `BondedEpisodeActionProvider_<tool>` and typed with a zod 3 schema built from
the tool's JSON Schema (what AgentKit's framework extensions expect). In chain mode, writes are
transactions: use a `BondedWalletProvider` for `episode.vault` with the session key and
`episode.endpoints.rpc`.

Every helper is tested end to end against a real Arena Gateway with a scripted model:
[`examples/frameworks`](../../examples/frameworks/README.md).

### MCP config for MCP-aware agents

Agents that read an `mcpServers` config (Claude Desktop, Claude Code, Cursor and most agent
frameworks) can point at the episode's MCP endpoint without any Bonded code:

```ts
import { mcpConfig } from "@bondedhq/sdk/mcp";

mcpConfig(episode); // { mcpServers: { "bonded-episode": { type: "http", url: "<episode MCP URL>" } } }
mcpConfig(episode, { style: "url" }); // { url } only, for clients that infer the transport
mcpConfig(episode, { style: "stdio" }); // { command: "npx", args: ["-y", "mcp-remote@0.14.3", url] }, for stdio-only clients
```

The URL is per episode: it stops working when the episode ends. Write the config at the start of
every episode, for example in the runner's agent command, with the `bonded-mcp-config` command this
package installs:

```sh
bonded-runner --gateway ... -- sh -c 'bonded-mcp-config > .mcp.json && my-agent --mcp-config .mcp.json'
```

`bonded-mcp-config [--style http|url|stdio] [--name <name>]` reads `BONDED_*` and exits 1 outside
an episode. `mcpConfigJson(episode, options)` returns the same text.

### Agent URL

In Agent URL mode Bonded `POST`s each episode to your HTTPS endpoint, signed with Bonded's own
key for the wallet that saved the URL. There is no secret: your handler names its `owner`, your
wallet, in code (it's public), and refuses calls signed for anyone else. Deploy it, save the URL
on Bonded from that wallet, then verify: Bonded sends a signed challenge and your endpoint answers
with its owner. `createBondedHandler` is the whole endpoint: a standard Fetch API handler for
Hono, Next.js route handlers, Bun, Deno and Cloudflare Workers, with a Node adapter for Express
and `node:http`.

```ts
import { createBondedHandler, toNodeHandler } from "@bondedhq/sdk/agent-url";
import { bondedAiSdkTools } from "@bondedhq/sdk/ai-sdk";

const handler = createBondedHandler({
  owner: "0xYourWallet", // the wallet you save this URL from on Bonded; public, not a secret
  version: process.env.GIT_SHA, // reported when Bonded verifies the URL; becomes the code hash
  async onEpisode(episode, { signal }) {
    const tools = await bondedAiSdkTools(episode);
    const result = await generateText({ model, tools, prompt: episode.task.goal, abortSignal: signal });
    return {
      finalMessage: result.text,
      usage: { inputTokens: result.totalUsage.inputTokens ?? 0, outputTokens: result.totalUsage.outputTokens ?? 0 },
    };
  },
});

export const POST = handler; // Next.js route handler
app.post("/bonded", (c) => handler(c.req.raw)); // Hono
export default { fetch: (req, env, ctx) => handler(req, ctx) }; // Cloudflare: keeps the work alive with ctx.waitUntil
expressApp.post("/bonded", toNodeHandler(handler)); // Express: mount before express.json()
```

What the handler does with each request:

1. **Checks the call** before reading the message. `bonded-timestamp` (unix seconds) must be
   within 300 seconds of the server's clock; `bonded-owner` must be your `owner` (a list works,
   for a team); and `bonded-signature` (`v2=<key id>:<base64url Ed25519 signature>` over
   `v2.<key id>.<timestamp>.<owner>.<raw body>`, up to four while a key rotates) must verify
   under one of Bonded's public keys. The handler fetches those from
   `https://www.bondedhq.xyz/.well-known/bonded-agent-keys.json` (`apiUrl` takes them from
   another Bonded deployment instead, for a local Arena run), keeps them for a day, and fetches
   again at once (at most once a minute) for a key it hasn't seen. A signature it has accepted before is refused as
   a replay. Failures answer `401` (with `code: "wrong-owner"` when the call is
   for a wallet the handler isn't set up for, so Bonded can tell you exactly that), a body that
   isn't one of Bonded's messages `400`, and keys it can't fetch `503`; nothing runs.
2. `{ type: "verify", challenge }`: answers `200 { challenge, owner, version }`. Bonded marks the
   URL verified when `owner` is the wallet that saved it. The owner is only in the signed
   headers, never the body, so an echo server can't pass, and someone who saves your URL gets
   calls signed for their own wallet, which your handler refuses.
3. `{ type: "episode", ... }`: answers `202` at once (Bonded waits at most 10 seconds) and runs
   `onEpisode` in the background. When it resolves, the handler posts `/done` with the
   `finalMessage` and `usage` it returned. If it throws, `/done` is still posted, saying the agent
   failed, and `onError` is called.
4. `{ type: "cancel", episodeId }`: aborts that episode's `signal`, and no `/done` is posted. The
   signal is also aborted when the episode's deadline passes.

Limits: 256 KiB bodies (`maxBodyBytes`, the most Bonded sends), 8 episodes at once (`maxConcurrent`; Bonded sends one at a
time per agent), and the same episode delivered twice runs once. On platforms that stop work when
the response is sent, pass their `waitUntil` (as the option, or the handler's second argument).

To test your endpoint, `createTestSigner()` stands in for Bonded: give the handler its `keys`, and
`sign(owner, body)` returns the headers Bonded would send.

```ts
import { createBondedHandler, createTestSigner } from "@bondedhq/sdk/agent-url";

const owner = "0x1111111111111111111111111111111111111111"; // your wallet
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
// 200 { challenge: "a-test-challenge-0001", owner: "0x1111…1111" }
```

`verifyAgentUrlRequest(...)` is the check on its own and `answerAgentUrlVerify(...)` the verify
answer, from `@bondedhq/shared/agent-url` (a small entry point without the contract ABIs, for
edge bundles). A Python endpoint (the standard library and `cryptography`) is in
[`examples/python-agent-url`](../../examples/python-agent-url/README.md).

## Vault trading tools for LangChain, LangGraph and the AI SDK

The agent's Mandate Vault as tools, for production: `swap`, `transfer`, `approve` and
`vault_status`. They have the same names and arguments as the episode's write tools, so the
agent's prompts work the same while it is rated.

```ts
import { bondedVaultFromEnv, isBondedEpisode } from "@bondedhq/sdk";
import { bondedLangChainTools, bondedVaultLangChainTools } from "@bondedhq/sdk/langchain";

const vault = bondedVaultFromEnv()!; // or new BondedVault({ ... })
const tools = isBondedEpisode()
  ? await bondedLangChainTools()
  : [...readOnlyTools, ...bondedVaultLangChainTools({ vault })];
```

```ts
import { bondedAiSdkTools, bondedVaultAiSdkTools } from "@bondedhq/sdk/ai-sdk";

const tools = isBondedEpisode()
  ? await bondedAiSdkTools()
  : { ...readOnlyTools, ...bondedVaultAiSdkTools({ vault }) };
```

- **Arguments** are what a model writes: tokens by symbol (`tUSDG`) or address, amounts in whole
  tokens as decimal strings (`"250"`). `swap` takes `{ tokenIn, tokenOut, amountIn, minOut? }`,
  `transfer` `{ token, to, amount }`, `approve` `{ token, spender, amount }`. Symbols come from
  `tokens` when you pass it, otherwise from the mandate itself (the vault's `getAssets()`, with each
  token's symbol and decimals, read once).
- **Results.** A write returns what moved (`{ sold, received }`, `{ sent, to }`, `{ approved, spender }`)
  and its `transactions`; when the vault recorded a breach (Monitor mode), also `breaches` and a
  `warning`. `vault_status` returns `{ vault, kind, holder, mode, frozen, breachCount, balances }`.
- **The guard is on by default** (`guard: false` turns it off): each write is dry-run against the
  vault first and refused on a predicted breach, so the model gets an error instead of a recorded
  breach. A refusal, a blocked or reverted call, or bad arguments come back to the model (LangChain:
  `Error: ...` text; AI SDK: `{ error }`), never thrown.
- **Sentinel** (optional, advisory): pass `sentinel: { apiUrl, mandate }` to ask it before each
  write that passes the dry run. What the agent read comes from `context()` if you pass it; the AI
  SDK tools otherwise use the tool results earlier in the conversation (the last 20).
- Take your own write tools out of the list in production, so every trade goes through the vault.

`bondedVaultTools(options)` from `@bondedhq/sdk` is the same set, framework-neutral
(`{ name, description, inputSchema, call(args) }`), for wrapping in another framework.

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

Every `sendTransaction` becomes `vault.execute(to, data)` from the agent key and `getAddress()` is the vault, so AgentKit's action providers trade through the mandate unchanged. Refused: native value (the vault is ERC-20 only), contract creation, and `sign`, `signTypedData` and `signTransaction` (a raw signature from the agent key would act outside the vault; permits and x402 payments don't work). `signMessage` signs with the agent key, not as the vault. In Enforce mode a blocked call still mines, so `waitForTransactionReceipt` throws `BlockedByMandateError` and the action reports a failure. AgentKit itself sends usage analytics to Coinbase from every wallet provider. Peer dependency: `@coinbase/agentkit` 0.10.

## Solana Agent Kit

```ts
import { SolanaAgentKit, KeypairWallet } from "solana-agent-kit";
import { bondedVaultPlugin } from "@bondedhq/sdk/solana-agent-kit";

const agent = new SolanaAgentKit(new KeypairWallet(agentKey, rpcUrl), rpcUrl, {})
  .use(bondedVaultPlugin({ vault: vaultAddress, guard: true, swap: jupiterSwapBuilder }));
```

Actions `BONDED_VAULT_TRANSFER`, `BONDED_VAULT_STATUS`, and `BONDED_VAULT_SWAP` when you pass a `swap` builder; methods `bondedVaultTransfer`, `bondedVaultSwap`, `bondedVaultExecute`, `bondedVaultStatus`. Each goes through the `bonded_vault` program's `execute`, signed by the kit's wallet, which must be the vault's agent key. `SolanaBondedVault` does the same without the kit, with a `dryRun` that simulates `execute` and reads the vault's own events. Needs `@bondedhq/solana`, `@solana/web3.js` and `solana-agent-kit` 2.

What the Solana program checks, and so what works:

- The called program must be on the vault's allowlist.
- SPL transfers must go to a token account the vault owns. There is no destination list on Solana, so any transfer out of the vault is a breach.
- Approvals, `SetAuthority` and closing accounts are never allowed.
- The net base-asset outflow of one call must stay within the vault's limit. There is no price (T3) check and no 24h limit on Solana yet.
- One instruction per `execute`, run by CPI with the vault as signer. CPI depth and the compute budget limit which swaps fit; a Jupiter multi-hop route may not. The swap builder (e.g. from Jupiter's swap-instructions API) is yours to supply; the SDK has no DEX client of its own.

## ElizaOS

```ts
import { bondedPlugin } from "@bondedhq/sdk/eliza";

const plugin = bondedPlugin({ vault, tokens, sentinel: { apiUrl, mandate, tokens } });
// character.plugins / project agent plugins: [plugin]
```

Actions `BONDED_SWAP`, `BONDED_TRANSFER` and `BONDED_APPROVE` through the vault, and a `BONDED_VAULT` provider that tells the agent the vault's mode, whether it is frozen and its breach count. Parameters come from `options.parameters` when the caller passes them, or the runtime's `OBJECT_SMALL` model reads them from the conversation. Amounts are whole tokens; tokens can be named by symbol. Each action is dry-run first (turn off with `guard: false`); with `sentinel`, Sentinel is asked too, with the message and recent conversation as the untrusted input. Built against `@elizaos/core` 1.7. While a Bonded episode is running the plugin switches to the
episode's tools: see [Framework helpers](#framework-helpers).

## Development

```bash
pnpm --filter @bondedhq/sdk test
```

Tests run against a local anvil with the protocol deployed by the production scripts, and check allowed and breaching actions against the vault's breach log, for the core client and each framework. The Agent URL handler's tests (signatures, verify, acknowledging then working, cancel, deadline) run without a chain. The vault trading tools are tested on the same local chain (`test/vault-tools.int.test.ts`): a swap by symbol, a breaching transfer refused by the guard, Sentinel fed from the conversation, and a Monitor-mode breach with the guard off. The payment guard runs without a chain (`test/payments.test.ts`: each rule in both modes, freeze, restoring state), and its framework wrappers are tested with a scripted AI SDK model, a LangChain tool call and an in-memory MCP server (`test/payments-adapters.test.ts`). The framework helpers are tested end to end against a real Arena Gateway in `examples/frameworks` (`pnpm --filter @bonded/example-frameworks test`). The Solana tests need the programs built (`pnpm solana:build`) and the Solana CLI's `solana-test-validator`; without them they skip with a message. `pnpm --filter @bondedhq/sdk typecheck` also checks the ElizaOS plugin against `@elizaos/core`'s own types.

An example agent that uses the SDK is in [`examples/byo-agent`](../../examples/byo-agent/README.md).
