# Protect your agent

How to protect your agent's real trades once it's rated: a Mandate Vault, a module on the smart account it already uses, framework plugins, and Sentinel. The short guide is [BRING-YOUR-OWN-AGENT.md](BRING-YOUR-OWN-AGENT.md).

Protection and rating are independent. An agent can trade through a vault without being rated, and a preview needs no vault at all. The Arena rates an agent against a fresh vault with your mandate on its sandbox chain, whatever protects your real funds.

## A Mandate Vault, with the SDK

The vault holds the funds. Your agent's key can only act through `MandateVault.execute(target, data)`. That checks the action against the mandate (tokens, contracts, recipients, per-trade and daily limits) and records any breach. In **Monitor** mode a breach goes through and is recorded. In **Enforce** mode it is blocked and still recorded. Create a vault from the web app (Onboard an agent), or with `buildMandate` and `MandateVaultFactory.createVault`.

```ts
import { BondedVault } from "@bondedhq/sdk";
import { privateKeyToAccount } from "viem/accounts";

const vault = new BondedVault({
  vault: "0xYourVault",
  chain, // a viem Chain; or pass publicClient
  account: privateKeyToAccount(agentKey), // the vault's agent key; or pass walletClient
  router: "0xRouter", // the swap venue your mandate allows
});

await vault.swap({ tokenIn: usdg, tokenOut: tsla, amountIn: 1_000_000_000n });
const check = await vault.dryRun({ type: "transfer", token: usdg, to: someone, amount });
// { ok, executed, blocked, breach?, breaches, wouldFreeze }: the vault's own verdict, simulated
const status = await vault.status(); // frozen, mode, breachCount, agent, guardian, mandateHash, ...
```

- **Dry runs use the contract's own logic.** `dryRun` simulates `execute` from the agent key (`eth_simulateV1`) and reads the vault's own events, so it can't drift from what the vault does. It needs an RPC that supports `eth_simulateV1` (anvil, the Arena Gateway and Robinhood Chain's public RPC do).
- **Typed errors.** `BlockedByMandateError`, `VaultFrozenError`, `NotAgentError`, `CallRevertedError` and the rest, each a `BondedError` with a stable `code`. In Monitor mode a breaching action is not an error: it runs, and its breaches come back in the result.
- **Mandates.** `buildMandate(rules)` turns plain rules (dollars, percentages) into the vault's parameters and the mandate hash. It is the same builder the web app's onboarding uses.

The full API is in the [SDK README](../packages/sdk/README.md).

## Is your agent trading through it?

A rating tests your agent; only the trades that go through the vault are checked against the mandate, and only those are covered. The keeper indexes each vault's (and module's) `Executed` events, which only the agent key can cause, so Bonded knows the vault's trading from the chain: the first and last trade, trades in the last 24 hours and 7 days, the total and the last transaction (`vaultActivity` in `GET /self/agents/:id`, or `GET /self/agents/:id/vault-activity`). The agent's page shows when it last traded through the vault and how often in the last 24 hours. With active cover and no trade through the vault in the last 7 days (or ever), `coverWithoutVaultTrades` is true and the page warns that the cover would pay nothing for trades made from another wallet.

**Gas.** The agent key pays the gas for each `execute`. `agentGas` is `{ balanceWei, balanceEth, low, estimatedTradesLeft, basis, gasPerTrade }`: the trades left are the balance over today's gas price times the gas per trade, measured from the agent's own recent trades (`basis: "measured"`, the median of its last 20) or, without any, an assumed 350,000 gas a trade (`basis: "assumed"`). It is low under 20 trades (or at zero); then the page and an alert say to send ETH to the key (test ETH, from a faucet, on the testnet).

## A module on the smart account you already use

If your agent already trades from a smart account, you don't have to move the funds. A `MandateModule` is an ERC-7579 module that runs the same checks as a vault. The two share one implementation, `MandateBase`, and differential tests require identical results apart from the module-only rule on unlisted tokens below. The module installs on a Safe through the Safe7579 adapter, or on any ERC-7579 account.

- **The agent gets a session key** that can act only through `module.execute(target, data)`. The module makes the call from the account. Modes, breach types, freeze on breach, guardian and breach log are the same as a vault's.
- **The agent's key must not also be an owner, validator or ERC-1271 signer of the account.** If it is, it can sign approvals (Permit2-style signature transfers, for example) that the account honours without any call through the module.
- **You keep full control** of the account: move funds, uninstall the module, install others.
- **Install it twice**: as an executor (required) and as a hook (recommended). Only the module the account created last can be installed.
  - The hook tells your own transactions apart from the agent's, so moving your own funds isn't mistaken for a breach.
  - A Safe owner's own `execTransaction` doesn't pass through the hook. After moving funds that way, call `sync()` on the module (ideally in the same Safe transaction). Otherwise the next action records a Deferred breach and freezes the agent.
- **Tokens outside the mandate's asset list.** A smart account usually holds other tokens. On a module, approving or transferring one is a breach; revoking an approval (`approve(x, 0)`, `setApprovalForAll(x, false)`) is always allowed.
  - An allowance the account already gave an allowed contract, on a token the module doesn't watch, isn't protected. Use `checkUnprotectedAllowances` from `@bondedhq/sdk` to list such allowances before installing (and while installed), and revoke them; the web app shows the same warning.
  - Better still, give the agent a dedicated account holding only the mandate's assets.
- **The base asset must move exactly** (no fee on transfer, no rebasing). A premium counts only once it arrives in full.
- **Only Enforce-mode modules can hold cover.** In Monitor mode a breach goes through, and the payout would go to the account, whose owner could have asked the agent for that breach. Monitor mode also runs a breaching call with the account's authority, which reaches further than a vault's (other modules, adapters that trust the account). A Monitor-mode module still protects and records; it just can't be insured (CoverManager refuses it with `ModuleMustEnforce`).
- **What cover pays on a module.**
  - Premiums are pulled from the account; payouts go into it, bond first, then the pool.
  - In Enforce mode a breach through `execute` is blocked, so nothing is lost.
  - A Deferred breach (an unexplained drop) is recorded and freezes the agent but isn't paid, because on a smart account it can't be told apart from the owner moving their own funds.
  - So a module's cover pays through grey-area disputes. On a module those always need the council's decision, even unchallenged.

The SDK prepares the install as one transaction the account's owner sends:

```ts
import { installMandateModule, BondedVault } from "@bondedhq/sdk";

const plan = await installMandateModule(publicClient, {
  moduleFactory, // `moduleFactory` in the chain's deployment file
  account: "0xYourSafe",
  accountType: "safe7579", // or "erc7579" for an account like the reference implementation
  rules, // as for buildMandate; mode "enforce" if it will hold cover
  agent: sessionKeyAddress,
  guardian: ownerAddress, // must own the agent id to buy cover
});
// plan.calls: createModule, then installModule as executor and as hook (for a Safe MultiSend)
// plan.execute.data: the same three calls as one ERC-7579 batch (e.g. a user operation)
// plan.module: where the module will be; plan.params.mandateHash: the hash ratings and quotes use

const vault = new BondedVault({ vault: plan.module, chain, account: sessionKey });
```

Nothing is sent by the SDK. The web app's onboarding offers the same ("Protect the smart account I already use") and shows the calls to send. A module's mandate hash is the commitment to the rules it enforces (`mandateCommitment`), which the factory checks on chain. So build its mandate with `buildMandate(rules, { for: "module" })`. Details: [contracts README](../contracts/evm/README.md#mandatemodule-one-per-smart-account).

## Framework plugins

These protect an agent in production: its real actions go through the vault. (To rate an agent built on a framework, see [Use your framework](AGENT-FRAMEWORKS.md#use-your-framework).) Each plugin is a subpath of `@bondedhq/sdk`, with its framework as an optional peer dependency.

| Framework | Import | What it does | Limits |
|---|---|---|---|
| **Coinbase AgentKit** (0.10) | `BondedWalletProvider` from `@bondedhq/sdk/agentkit` | A wallet provider that turns every `sendTransaction` into `vault.execute(to, data)`; `getAddress()` is the vault. AgentKit's action providers then trade through the mandate unchanged. `guard: true` dry-runs each one first | Refuses native value (vaults are ERC-20 only), contract creation, and `sign`, `signTypedData` and `signTransaction` (a raw signature would act outside the vault, so permits and x402 payments don't work). For a module, use `await BondedWalletProvider.create(...)` |
| **Solana Agent Kit** (2) | `bondedVaultPlugin` from `@bondedhq/sdk/solana-agent-kit` | Actions `BONDED_VAULT_TRANSFER`, `BONDED_VAULT_STATUS` and, when you pass a `swap` builder, `BONDED_VAULT_SWAP`, through the `bonded_vault` program's `execute` | Scoped to what the Solana program checks: no destination list (any transfer out of the vault is a breach), approvals never allowed, no price check or 24-hour limit yet, one instruction per `execute` (a multi-hop route may not fit). You supply the swap builder |
| **ElizaOS** (1.7) | `bondedPlugin` from `@bondedhq/sdk/eliza` | Actions `BONDED_SWAP`, `BONDED_TRANSFER`, `BONDED_APPROVE` through the vault, and a `BONDED_VAULT` provider that reports its mode, frozen state and breach count. Each action is dry-run first; Sentinel optional. While an episode runs it switches to the episode's tools | Parameters come from the caller or the runtime's small model; amounts are whole tokens |

Each plugin has an end-to-end test that performs an allowed and a breaching action and checks the vault's breach log (`pnpm --filter @bondedhq/sdk test`). The Solana tests need the programs built and `solana-test-validator`; without them they skip.

## Guarded, with Sentinel

```ts
import { guarded } from "@bondedhq/sdk";

const safe = guarded(vault, { sentinel: { apiUrl, mandate, tokens } }); // sentinel is optional
await safe.swap(params, { untrustedInputs: [{ tool: "read_inbox", output: email }] });
```

Before each write the guard does two checks:
1. It runs the dry run and refuses a predicted breach.
2. If configured, it asks Sentinel and refuses if Sentinel advises against.

That turns a Monitor-mode vault into one that doesn't knowingly breach. It is a client-side check: the chain can change between the dry run and the transaction, and the vault's verdict is what counts. Sentinel is advisory ([SENTINEL.md](SENTINEL.md)). When Sentinel is down, the guard refuses by default (`onUnavailable: "proceed"` goes ahead without it). `checkWithSentinel` calls the API directly, signed by the agent key.
