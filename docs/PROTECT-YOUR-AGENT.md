# Protect your agent

How to protect your agent's real trades: with a Mandate Vault, a module on the smart account it already uses, a framework plugin, and Sentinel. The short guide is [BRING-YOUR-OWN-AGENT.md](BRING-YOUR-OWN-AGENT.md).

Protection and rating are independent. An agent can trade through a vault without being rated, and a rating always uses a fresh vault on its sandbox chain, whatever protects your real funds.

## A Mandate Vault, with the SDK

The vault holds the funds. Your agent's key can only act through `MandateVault.execute(target, data)`, which checks each action against the mandate (tokens, contracts, recipients, per-trade and daily limits) and records any breach.

- In **Monitor** mode a breach goes through and is recorded.
- In **Enforce** mode a breach is blocked and still recorded.

Create a vault from the web app (Onboard an agent), or with `buildMandate` and `MandateVaultFactory.createVault`.

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

- `dryRun` simulates `execute` from the agent key and reads the vault's own events, so it matches what the vault does. It needs an RPC that supports `eth_simulateV1` (anvil, the Arena Gateway and Robinhood Chain's public RPC do).
- Errors such as `BlockedByMandateError`, `VaultFrozenError`, `NotAgentError` and `CallRevertedError` are each a `BondedError` with a stable `code`. In Monitor mode a breaching action is not an error: it runs, and its breaches come back in the result.
- `buildMandate(rules)` turns plain rules (dollars, percentages) into the vault's parameters and the mandate hash, as the web app's onboarding does.

Full API: [SDK README](../packages/sdk/README.md).

## Check your agent trades through it

Only trades that go through the vault are checked against the mandate, and only those are covered. The agent's page shows when it last traded through the vault and how often in the last 24 hours, read from the vault's `Executed` events (`GET /self/agents/:id/vault-activity`). With active cover and no vault trade in the last 7 days, the page warns that cover would pay nothing for trades made from another wallet.

The agent key pays the gas for each `execute`. When it has gas for fewer than 20 trades, the page and an alert tell you to send it ETH (test ETH from a faucet, on the testnet).

## A module on the smart account you already use

If your agent already trades from a smart account, you don't have to move the funds. `MandateModule` is an ERC-7579 module that runs the same checks as a vault. It installs on a Safe through the Safe7579 adapter, or on any ERC-7579 account.

The agent gets a session key that can act only through `module.execute(target, data)`, and the module makes the call from the account. Modes, breach types, freeze on breach, guardian and breach log are the same as a vault's. You keep full control of the account.

**Set it up safely.**

- **The agent's key must not also be an owner, validator or ERC-1271 signer of the account.** If it is, it can sign approvals (Permit2-style signature transfers, for example) that the account honours without any call through the module.
- **Install it twice:** as an executor (required) and as a hook (recommended). Only the module the account created last can be installed.
  - The hook tells your own transactions apart from the agent's, so moving your own funds isn't mistaken for a breach.
  - A Safe owner's own `execTransaction` doesn't pass through the hook. After moving funds that way, call `sync()` on the module, ideally in the same Safe transaction. Otherwise the next action records a Deferred breach and freezes the agent.
- **Tokens outside the mandate's asset list.** On a module, approving or transferring one is a breach. Revoking an approval (`approve(x, 0)`, `setApprovalForAll(x, false)`) is always allowed.
  - An allowance the account already gave an allowed contract, on a token the module doesn't watch, isn't protected. Run `checkUnprotectedAllowances` from `@bondedhq/sdk` before installing (and while installed) to list them, and revoke them. The web app shows the same warning.
  - Better still, give the agent a dedicated account holding only the mandate's assets.
- **The base asset must move exactly** (no fee on transfer, no rebasing).

**Cover on a module.**

- Only Enforce-mode modules can hold cover (CoverManager refuses others with `ModuleMustEnforce`). In Monitor mode a breach goes through with the account's authority, and the payout would go to the account, whose owner could have asked for that breach.
- Premiums are pulled from the account. Payouts go into it, bond first, then the pool.
- In Enforce mode a breach through `execute` is blocked, so nothing is lost. A Deferred breach (an unexplained drop) freezes the agent but isn't paid, because it can't be told apart from the owner moving their own funds.
- So a module's cover pays through grey-area disputes, which on a module always need the council's decision.

**Install it.** The SDK prepares the install as one transaction the account's owner sends:

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

The SDK sends nothing. The web app's onboarding offers the same ("Protect the smart account I already use"). Build a module's mandate with `buildMandate(rules, { for: "module" })`, since the factory checks its hash on chain. Details: [contracts README](../contracts/evm/README.md#mandatemodule-one-per-smart-account).

## Framework plugins

These protect an agent in production: its real actions go through the vault. To test an agent built on a framework, see [AGENT-FRAMEWORKS.md](AGENT-FRAMEWORKS.md). Each plugin is a subpath of `@bondedhq/sdk`, with its framework as an optional peer dependency.

### Coinbase AgentKit (0.10)

`BondedWalletProvider` from `@bondedhq/sdk/agentkit`.

- Turns every `sendTransaction` into `vault.execute(to, data)`, and `getAddress()` is the vault, so AgentKit's action providers trade through the mandate unchanged. `guard: true` dry-runs each one first.
- Refuses native value (vaults are ERC-20 only), contract creation, and `sign`, `signTypedData` and `signTransaction`, since a raw signature would act outside the vault. So permits and x402 payments don't work.
- For a module, use `await BondedWalletProvider.create(...)`.

### Solana Agent Kit (2)

`bondedVaultPlugin` from `@bondedhq/sdk/solana-agent-kit`.

- Actions `BONDED_VAULT_TRANSFER`, `BONDED_VAULT_STATUS` and, when you pass a `swap` builder, `BONDED_VAULT_SWAP`, through the `bonded_vault` program's `execute`. You supply the swap builder.
- It is limited to what the Solana program checks: no destination list (any transfer out of the vault is a breach), approvals are never allowed, and there is no price check or 24-hour limit.
- One instruction per `execute`, so a multi-hop route may not fit.

### ElizaOS (1.7)

`bondedPlugin` from `@bondedhq/sdk/eliza`.

- Actions `BONDED_SWAP`, `BONDED_TRANSFER` and `BONDED_APPROVE` through the vault, each dry-run first, and a `BONDED_VAULT` provider that reports its mode, frozen state and breach count. Sentinel is optional.
- While an episode runs, it switches to the episode's tools.
- Parameters come from the caller or the runtime's small model. Amounts are whole tokens.

## Guarded, with Sentinel

```ts
import { guarded } from "@bondedhq/sdk";

const safe = guarded(vault, { sentinel: { apiUrl, mandate, tokens } }); // sentinel is optional
await safe.swap(params, { untrustedInputs: [{ tool: "read_inbox", output: email }] });
```

Before each write the guard:

1. runs the dry run and refuses a predicted breach;
2. if configured, asks Sentinel and refuses if Sentinel advises against.

That turns a Monitor-mode vault into one that doesn't knowingly breach.

- It is a client-side check: the chain can change before the transaction, and the vault's verdict is what counts. Sentinel is advisory ([SENTINEL.md](SENTINEL.md)).
- When Sentinel is down, the guard refuses by default. `onUnavailable: "proceed"` goes ahead without it.
- Sentinel sees only the first 4,000 characters of each untrusted input, so pass the part your agent acted on.
- `checkWithSentinel` calls the API directly, signed by the agent key.
