# Bonded smart contracts

These are the Solidity contracts behind Bonded. They hold AI agents' money under a set of rules (the **mandate**), sell insurance on those agents, and pay depositors automatically when an agent breaks its rules.

The deployed addresses are in [`deployments/`](deployments/README.md).

## At a glance

A deployment has 9 protocol contracts: [`BondedRegistry`](src/BondedRegistry.sol), [`MandateVaultFactory`](src/MandateVaultFactory.sol), [`MandateModuleFactory`](src/MandateModuleFactory.sol), [`CoverPool`](src/CoverPool.sol), [`OperatorBond`](src/OperatorBond.sol), [`CoverManager`](src/CoverManager.sol), [`ClaimsEngine`](src/ClaimsEngine.sol), [`DisputeModule`](src/DisputeModule.sol) and [`BountyBoard`](src/BountyBoard.sol).

Each agent then gets its own [`MandateVault`](src/MandateVault.sol), or a [`MandateModule`](src/MandateModule.sol) if it trades from a smart account (a Safe or any ERC-7579 account) its operator already has. Both run the same rules, which live in [`MandateBase`](src/MandateBase.sol).

On testnets, 6 more contracts provide a [demo market](#the-testnet-demo-market) to trade in.

## Who's involved

- **Operator:** builds or runs an agent, registers it, locks a bond and buys cover.
- **Agent:** the AI itself. It can act only through its vault's (or module's) `execute` function.
- **Depositor:** puts money into an agent's vault and is protected by the cover.
- **Underwriter:** deposits into the CoverPool to earn premiums, taking on claim risk.
- **Attester:** the Arena's signing key. It signs scores and insurance quotes after testing an agent.
- **Council:** decides disputed grey-area claims. A multisig.
- **Keeper:** Bonded's bot that files claims, collects premiums and relays scores. Anyone can do these jobs.

## How it fits together

![How the contracts fit together: the operator registers the agent, creates its vault and locks a bond; depositors deposit into the MandateVault and underwriters into CoverPool; the agent trades through the vault into the market; premiums go to CoverManager and CoverPool; ClaimsEngine reads breaches, slashes OperatorBond first and has CoverPool pay the rest, both paying out to the vault; DisputeModule handles grey-area claims; the Arena attester signs scores to BondedRegistry.](../../docs/images/contracts-overview.svg)

### The life of a policy

This is the loop that [`script/Smoke.s.sol`](script/Smoke.s.sol) runs, with its numbers:

1. **Register.** The operator registers the agent in `BondedRegistry`, which mints an agent NFT.
2. **Create the vault.** `MandateVaultFactory` deploys a `MandateVault` with the agent's mandate: which tokens it may hold, which contracts and functions it may call, and its spending limits.
3. **Lock a bond.** The operator stakes 10,000 tUSDG in `OperatorBond`.
4. **Fund.** Underwriters deposit 500,000 into `CoverPool`, and depositors put 40,000 into the vault.
5. **Rate and quote.** The Arena tests the agent off-chain and the attester signs a quote: 20,000 of cover at 1.2% a year.
6. **Buy cover.** The operator submits the quote to `CoverManager`, which issues a policy to the vault. Premiums then stream out of the vault.
7. **Trade.** The agent swaps 1,000 tUSDG for tTSLA. The mandate allows it, so nothing happens.
8. **Breach.** The agent is tricked into sending 5,000 tUSDG to an attacker. The vault records the breach at the oracle price and freezes the agent.
9. **Claim.** Anyone calls `ClaimsEngine.fileClaim`. It pays 4,500 back into the vault (the 5,000 loss minus the 10% deductible), taken from the operator's bond, which drops to 5,500.

## The protocol contracts

### BondedRegistry

**The directory of AI agents.** Each agent is an NFT (ERC-721), and whoever holds it is the agent's operator. Every other contract asks the registry who owns an agent, so transferring the NFT hands over the agent and its bond. It follows the shape of ERC-8004, the emerging standard for on-chain agent identity.

It stores each agent's Arena scores: the 0–100 Security score and the insurance score that prices cover. The Task score stays in the report, which the attestation commits to through `reportHash`.

- A score is a message signed by an approved attester, so anyone can post it, to any chain.
- Each score expires, and an older score can't replace a newer one.
- Any contract can read it, so a vault, lending market or trading platform can require a minimum score.
- It keeps the list of approved attesters, which CoverManager and BountyBoard also use.

The attestation format is frozen: changing `BondedTypes.Attestation` or its EIP-712 typehash would mean redeploying and re-rating everything. See [SCORING.md](../../docs/SCORING.md#the-attestation-format-is-frozen).

### MandateVaultFactory

**Creates vaults and vouches for them.** Anyone can create a vault for an agent. CoverManager only insures vaults the factory created, so nobody can insure a fake vault that reports made-up breaches.

### MandateVault (one per agent)

**Holds an agent's money and checks every action against its mandate.** Depositors receive vault shares (ERC-4626). The agent can move funds only through `execute`, and each action records at most one breach:

- **T1, unauthorized action:** calling a contract, function or recipient outside the mandate, or approving an unknown spender.
- **T2, limit:** spending more than the per-transaction or 24-hour limit.
- **T3, asset:** value leaving without equivalent allowed assets coming back, such as buying a lookalike token.
- **Deferred T1:** money leaving outside `execute`, found by `reconcile()`, such as a spender draining an earlier approval.

A vault runs in one of two modes:

- **Monitor:** the action goes through, the breach is recorded and the agent is frozen. Insurance pays the loss.
- **Enforce:** the action is blocked, but the attempt is still recorded and the agent frozen.

The **guardian** is the operator's safety key. It can freeze, unfreeze and replace a compromised agent key.

### MandateModuleFactory

**Creates modules and vouches for them.** A smart account creates its own module, so nobody can take another account's place. Only the module an account created last can be installed.

It checks on chain that `params.mandateHash` equals `BondedTypes.mandateCommitment(params)`, the hash of the rules the module will enforce (`mandateCommitment` in `@bondedhq/shared` computes the same value). Modules are deployed with CREATE2, and `predictModule` gives the address in advance, so an account can create and install its module in one batch.

### MandateModule (one per smart account)

**The mandate for an agent that trades from a smart account its operator already uses.** It is an ERC-7579 module: it installs on a Safe through the [Safe7579](https://github.com/rhinestonewtf/safe7579) adapter, and on any ERC-7579 account. The funds stay in the account.

- **Same rules as a vault.** The agent's session key acts only through `module.execute(target, data)`, which runs the same checks and makes the call from the account.
- **Install it twice:** as an executor (type 2, required) and as a hook (type 4, recommended). The hook runs around the owner's own transactions, so an owner's withdrawal isn't mistaken for a breach.
- **The owner keeps full control.** A Safe owner's own `execTransaction` doesn't pass through the hook, so after moving funds that way the owner calls `sync()`. Otherwise the next check records the withdrawal as a Deferred breach and freezes the agent.
- **The agent can never call** the account itself or the module.
- **Tokens outside the asset list:** approving or transferring one is a T1 breach. Revoking an approval (`approve(x, 0)`, `setApprovalForAll(x, false)`) is always allowed. An existing approval of an unlisted token isn't protected, so give the agent a dedicated account holding only the mandate's assets. `checkUnprotectedAllowances` in `@bondedhq/shared` lists such approvals.
- **The agent's key must not also be an owner, validator or ERC-1271 signer of the account.** Otherwise it could sign approvals the account honours without going through the module.
- **Only Enforce-mode modules can hold cover.** In Monitor mode a breach goes through with the account's authority, and the payout would go to the account, whose owner could have asked the agent for that breach.
- **Claims pay the account.** Deferred breaches are recorded and freeze the agent but aren't paid, because they can't be told apart from the owner moving their own funds. Grey-area payouts on a module always need the council's approval.

### OperatorBond

**The operator's skin in the game.** Operators lock tUSDG against each agent, and this is taken first when a claim is paid.

- Anyone can add to a bond. Only the agent's owner can withdraw.
- Withdrawing needs a request and a cooldown.
- A bond stays locked until the claim window after the agent's last policy has closed.

### CoverPool

**The underwriters' pool.** Underwriters deposit tUSDG and receive pool shares (`bdUSDG`). The pool earns most of the premiums and pays whatever part of a claim the operator's bond doesn't cover.

Withdrawals need a request and a cooldown, so underwriters can't run ahead of a claim. Only free capital, not needed to back active cover, can leave.

### CoverManager

**Sells the insurance.** It turns a signed Arena quote into a policy for a vault, or for an Enforce-mode module.

- **Checks the quote:** signed by an approved attester, not expired or used, matching the vault's agent, mandate and base asset. The caller must be both the vault's guardian and the agent's owner.
- **Requires a vault that freezes on breach**, so a compromised agent can't drain the payout too.
- **Checks the bond and the score tier:**

  | Insurance score | Minimum bond (share of cover) | Max cover per agent (share of pool) |
  | --------------- | ----------------------------- | ----------------------------------- |
  | 60 and above    | 10%                           | 10%                                 |
  | 45–59           | 20%                           | 10%                                 |
  | 25–44           | 30%                           | 2%                                  |
  | below 25        | Not insurable                 |                                     |

- **Enforces pool-wide limits** (see [Key parameters](#key-parameters)). Agents on the same AI model family are capped together, because one new jailbreak could hit all of them.
- **Issues a policy NFT to the vault.** It can't be transferred. Breaches in the waiting period aren't covered, so nobody can insure after being hacked.
- **Streams premiums** from the vault and splits them between the CoverPool, the BountyBoard and a treasury.
- **Gives a grace period** if the vault can't pay. After that the policy lapses, and unpaid premium is deducted from a later payout.

### ClaimsEngine

**Pays claims automatically.** There is no claim form and no adjuster: the vault's breach record is the proof. Anyone can call `fileClaim(policyId, breachIds)`.

For each breach it checks that the covered vault recorded it, that it wasn't blocked, that it happened while the policy was active, and that it hasn't been claimed before.

The payout follows a waterfall, operator bond first, then the pool:

```
loss                      5,000
minus 10% deductible     −  500
payout                    4,500   (capped at the cover left on the policy)
  1st from operator bond  4,500   (all of it here; the bond had 10,000)
  2nd from CoverPool          0   (would pay any part the bond couldn't)
→ paid into the vault, restoring every depositor's share value
```

- A claim is paid in full or not at all. If the pool can't cover its part, the claim waits.
- For a module's policy, the payout goes into the smart account.

### DisputeModule

**Handles grey-area claims** the vault can't prove on its own, such as a loss through bad judgement.

1. Anyone proposes a payout with evidence and a 250 tUSDG deposit.
2. If nobody challenges it within 2 days, it is paid through ClaimsEngine and the deposit is returned.
3. A challenger can post the same deposit. The council then decides, and the winner takes both deposits.

On a module's policy, step 2 doesn't apply: a payout needs the council's approval even if nobody challenges it.

### BountyBoard

**Pays for new attacks on AI agents,** funded by a share of premiums.

1. A hunter commits to an attack without revealing it. The commitment includes their address, so nobody can copy it.
2. They reveal it, and the Arena tests it.
3. An attester accepts it and pays a reward, or rejects it.

Accepted attacks join the Arena's library, and insured agents are re-tested against them.

## Optional: GateAnchor

[`GateAnchor`](src/GateAnchor.sol) is the public record of the off-chain [payment gate](../../docs/PAYMENT-GATE.md). It holds no money and no other contract reads it.

- **What it holds:** for each gate account, the hash of each mandate version (`postMandate`) and one log root per UTC day over that day's signed receipts (`postLogRoot`).
- **No overwriting:** a version or a day can be posted once, and a day only after it has ended.
- **Who posts:** addresses the owner allows with `setPoster` (the keeper).
- **Reading:** `mandateHashOf(account, version)`, `logRootOf(account, day)`, and `verifyReceipt(account, day, receiptHash, index, count, siblings)` to check a receipt's proof against the posted root.

## The testnet demo market

On testnets the deploy script brings its own tokens, prices and exchange. None of these go to mainnet, where Bonded uses real tokens, Chainlink prices and real exchanges.

- **tUSDG** (`TestToken`): a fake dollar with 6 decimals, used for vaults, bonds, the pool, premiums and payouts. Anyone can mint up to 1,000,000 per call from `faucet`.
- **tTSLA, tAMZN, tNVDA** (`TestToken`): fake stock tokens with 18 decimals. Up to 1,000 per faucet call.
- **MockOracle:** prices set by the owner: tUSDG $1, tTSLA $250, tAMZN $200, tNVDA $180.
- **DemoRouter:** swaps at the oracle price minus 0.2%.

[`ChainlinkOracle`](src/oracles/ChainlinkOracle.sol) is the production price feed.

## Ownership

Each contract's owner can change its parameters, attesters and fees. Ownership changes take two steps (`Ownable2Step`). Contracts that move money for each other are linked once at deployment, and those links can't be changed, so an owner can't later point them at a contract that drains funds.

## Key parameters

| Parameter                          | Default                         | Contract      |
| ---------------------------------- | ------------------------------- | ------------- |
| Policy term                        | 30 days                         | CoverManager  |
| Waiting period                     | 1 day (0 on testnets)           | CoverManager  |
| Premium grace period               | 3 days                          | CoverManager  |
| Max total cover                    | 2× pool                         | CoverManager  |
| Max per agent                      | 10% of pool (2% for 25–44)      | CoverManager  |
| Max per model family               | 40% of pool                     | CoverManager  |
| Deductible                         | 10%                             | ClaimsEngine  |
| Claim window after a policy ends   | 7 days                          | ClaimsEngine  |
| Underwriter withdrawal cooldown    | 7 days, then a 2-day window     | CoverPool     |
| Bond withdrawal cooldown           | 7 days                          | OperatorBond  |
| Dispute deposit / challenge period | 250 tUSDG / 2 days              | DisputeModule |

## Build and test

From this folder, with [Foundry](https://book.getfoundry.sh/getting-started/installation) installed:

```bash
git submodule update --init --recursive   # once, to fetch lib/
forge build                 # compile
forge test                  # run all tests
python3 test/invariant/mutations.py       # plant known bugs and check the tests catch each one
```

From the repo root:

```bash
pnpm demo:local             # local chain: deploy everything, then run the demo loop
pnpm contracts:deploy robinhood   # deploy to a testnet; needs DEPLOYER_PRIVATE_KEY in .env
pnpm contracts:smoke robinhood    # run the demo loop on a testnet
```

[`deployments/README.md`](deployments/README.md#deploying) has the deploy steps.
