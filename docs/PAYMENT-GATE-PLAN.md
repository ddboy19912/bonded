# Payment gate plan: protecting money off chain

Date: 2026-11-02. Status: plan, nothing here is built yet.

## Why

Off chain, Bonded attacks and rates agents (the Arena and the [Bonded Index](INDEX.md)). It doesn't protect money yet. The mandate's Enforce mode works only inside the sandbox ledger, and there is no bond, pool or claim for off-chain agents ([OFFCHAIN.md](OFFCHAIN.md): "rated, not yet insured").

On chain, the vault holds the money and the contract enforces the rules, so nobody can skip them, Bonded included. This plan builds the off-chain equivalent: a **payment gate** that checks every payment an agent makes against the mandate before it reaches a bank or card, sits in the payment path so it can't be skipped, and shows users exactly what it decided and why.

## On chain vs off chain

| | On chain (today) | Off chain (this plan) |
|---|---|---|
| Who holds the money | The vault contract | The bank or card issuer |
| Who enforces the rules | The contract | The payment gate, in the payment path |
| Who users trust | Code on a public chain | Bonded's gate, made checkable by the transparency and safety work below |
| Who can verify a decision | Anyone, from the chain | The user, from signed receipts and hashes posted on chain |
| After a breach | Recorded on chain; bond, then pool, pays | Blocked, recorded and alerted. Cover comes later (Phase 8) |

## What we build on

| Piece | Where | What it gives |
|---|---|---|
| The mandate's six rules | `apps/arena/src/offchain/ledger.ts` | `unknown_payee`, `unverified_vendor_change`, `duplicate_payment`, `unmatched_invoice`, `over_payment_cap`, `over_daily_cap`; Monitor and Enforce; freeze on breach |
| Framework adapters | `packages/sdk/src/` (AI SDK, LangChain, MCP, Eliza, AgentKit, Solana Agent Kit) | The pattern for wrapping an agent's tools |
| Sentinel's check route and client | `packages/sdk/src/sentinel.ts`, `apps/api` | A hosted check with a signed request, already live for trading agents |
| Sentinel (Laya v5) | [SENTINEL.md](SENTINEL.md) | The guard model and its held-out evaluation gate |
| TEE custody | `services/tee-agent/`, [TEE.md](TEE.md) | Keys made inside a Phala confidential VM, with a public attestation |
| Arena traces | `apps/arena/ratings/index-traces/` | Labelled payment attacks and benign twins from the Index runs |

## Phases

Each phase ships on its own and is useful without the next.

### Phase 1: one rule engine

Move the mandate's rule check out of the sandbox ledger into a package of its own (`@bondedhq/payment-mandate`). The Arena's ledger and the gate both call it, so the rules an agent is rated against are exactly the rules that guard it in production.

- Input: a proposed payment (account, amount, invoice reference), the vendor master, approved invoices and refunds, verified change tickets, today's total.
- Output: allow or block, every rule broken, and a plain-language reason per rule.
- No network, no model, same answer every time.
- Tests: the existing ledger tests move with it; the Arena's results must not change (rerun `pnpm demo:loop` and the off-chain test suite; no library version bump, since judging doesn't change).

### Phase 2: free SDK check

Wrap an agent's pay tool in each supported framework so every payment goes through the Phase 1 check first, inside the builder's own process.

- Free and local. Invoices never leave the builder's system.
- Monitor (log and let through) or Enforce (block).
- Limit: the agent's code can still skip it. That is stated in the docs; the gate (Phase 5) closes it.

### Phase 3: hosted check API

`POST /payments/check` on the Bonded API runs the same check and returns the decision with a signed receipt.

- The receipt holds: the decision, the rules applied, a hash of the inputs, a hash of the user's mandate, the time, and Bonded's signature.
- Logged per user, with alerts on a block or a freeze.
- Priced per check, like the "Sentinel guard" line in the business model.
- Every block becomes a candidate Arena seed, reviewed by hand before it joins the staged library.

### Phase 4: transparency

Users can see and check the rules that guard their money.

- **Rules page:** each user's mandate in plain words in the dashboard (limits, vendors, who can approve a bank change), with its history of changes.
- **Signed receipts** from Phase 3, downloadable and verifiable with a published key.
- **Hashes on chain:** the hash of each mandate version and a daily hash of the decision log are posted on chain, so neither can be changed later without it showing. This uses a new small contract; the frozen attestation format (`BondedTypes.Attestation`) is not touched.
- **Open rule engine:** the Phase 1 package is in the public repo, so anyone can run a receipt's inputs and get the same answer.

### Phase 5: the payment gate

Put the check in the payment path so it can't be skipped. Two routes, card first.

**5a. Card authorization (first).** The agent pays with a virtual card. Card issuers that support real-time authorization (Stripe Issuing, Lithic, Marqeta) ask an endpoint to approve each charge before it goes through; Bonded's gate answers. Bonded never holds the money or a payment key, only says yes or no.

- Needs a fast answer (Stripe Issuing allows about two seconds), so the check runs without a model on this path.
- The issuer's own card limits stay on as a second line.

**5b. Bank and payout proxy (second).** For bank transfers and payout APIs, the agent never gets the payment credential. It asks the gate to pay; the gate checks and forwards.

- Credentials are held inside a TEE (the Phala setup from [TEE.md](TEE.md)), with a public attestation of the code running. Bonded staff can't read them.
- Credentials are as narrow as the provider allows: payouts only, the bank's own limits and approved-payee list on as a backstop.

**For both routes:**

- **Fail mode is the user's choice:** if the gate is down, block payments (safer) or let them through (keeps the business running). Default: block.
- **Revoke any time:** removing the webhook or the credential cuts Bonded out at once.
- Measured before launch: false blocks on the benign twins (target: none), and response time at p50 and p95.

### Phase 6: Sentinel for payments

Retrain Laya on payment attacks so Sentinel can flag what the rules can't see, such as a lookalike domain on an email that asks to pay a known vendor.

- Training data: Arena traces of the off-chain classes (O1 to O6) and their benign twins. Held-out classes and seed families are kept out of training, as in [SENTINEL.md](SENTINEL.md).
- Advisory only: Sentinel can flag a payment for a human or hold it for review, but the rules decide. A Sentinel flag never pays or blocks on its own.
- Goes live only after it passes the held-out evaluation, with numbers and assumptions published.
- Runs on the API and SDK paths, not on the card path's two-second budget unless measured fast enough.

### Phase 7: the other APIs

From the business model's API lines, carried over to the off-chain rail:

| API | What it does | Who pays |
|---|---|---|
| **Testing in CI** | Run the Arena against an agent on every deploy (the Agent URL route already exists); fail the build if the score drops; private reports | Agent builders, subscription |
| **Model risk data** | Index scores, failures by attack type and channel, alerts when a model's score changes | Platforms and companies choosing a model |
| **Attack data** | Library attacks (text and Muse Image forgeries) with labelled traces, for testing and training guard models. The held-out set is never sold or shared | Model makers and security teams |

### Phase 8 (later): off-chain cover

Cover needs two things this plan provides: a rail we can enforce (the gate) and loss data (the Arena plus gate logs). The bond and pool stay on chain; a loss the gate records would be filed against them the way the vault's breaches are today. Pricing, legal shape and the claims rule are a separate plan.

## Keeping users safe

- Prefer the card route: Bonded only approves or declines, and holds nothing.
- Where credentials are held, hold them in a TEE with a public attestation.
- Narrow credentials, with the bank's or issuer's own limits as a backstop.
- The user picks the fail mode and can revoke at any time.
- Every decision has a signed receipt; mandate and log hashes are on chain.
- The rule engine is open and gives the same answer for the same inputs.
- An independent security audit before real customers; a security certification such as SOC 2 once there are paying ones.

## Decisions for the founder

1. Card issuer for Phase 5a (Stripe Issuing, Lithic or Marqeta).
2. Which chain carries the Phase 4 hashes.
3. Pricing for checks, CI testing and the data APIs.
4. Retention: how long check inputs and logs are kept, and whether invoices are stored or only hashed.
5. Legal advice before Phase 5b: holding payment credentials for others may need a licence in some markets.

## Not in this plan

- Changes to on-chain contracts other than the small hash contract in Phase 4.
- Any change to ratings or the library version. New seeds from gate blocks go to the staged library and wait for a release.
