# Payment gate API

The hosted check for off-chain payments. An agent asks `POST /payments/check` before it pays an
invoice, sends a refund or changes a vendor's bank account. The API runs the same rules the Arena
rates agents against (`checkInvoicePayment`, `checkRefundPayment` and `isVerifiedChange` in
`packages/shared/src/payment-mandate.ts`) on the gate account's state, applies the account's mode
and freeze, and answers with the decision and a signed receipt.

Code: `src/gate.ts` (routes), `src/gate-check.ts` (the check), `packages/db/src/gate.ts` (storage,
migrations `0024_payment_gate.sql` to `0033_gate_budgets.sql`), `src/gate-budget.ts` and
`packages/db/src/gate-budget.ts` (budgets),
`packages/shared/src/gate-receipt.ts` (receipts, input and mandate hashing, offline verification),
`packages/shared/src/gate-log.ts` (daily log roots and proofs), `apps/keeper/src/gate-anchor.ts`
(the keeper job that makes and posts them), `contracts/evm/src/GateAnchor.sol` (where they go on
chain) and `apps/web/src/pages/Gate.tsx` (the account list), `GateAccount.tsx` and `src/components/gate` (an account's page), `GateVerify.tsx` (checking a receipt). Tests: `test/gate.test.ts`,
`test/gate-anchor.test.ts`, `packages/shared/test/gate-receipt.test.ts` and `gate-log.test.ts`,
`contracts/evm/test/GateAnchor.t.sol` and `apps/web/src/pages/Gate.test.tsx`.

## Who can call what

- **The owner** manages a gate account with a wallet session: sign in at `POST /self/session`
  (the same sign-in as previews) and send `Authorization: Bearer bonded_ss_...`. Another wallet's
  accounts show as not found.
- **The agent** checks payments with the account's API key: `Authorization: Bearer bonded_gk_...`.
  A key is shown once, when it is made; only its SHA-256 is stored. Revoking it stops it at once.
- `GET /gate/receipt-key` needs nothing.

## Routes

Owner (wallet session):

| Route | What it does |
|---|---|
| `POST /gate/accounts` | Make an account: `{ name?, mode? ("monitor" default, or "enforce"), maxPaymentUsd, maxDailyUsd, freezeOnBreach?, keyLabel? }`. Returns the account and its first API key |
| `GET /gate/accounts` | The wallet's accounts |
| `GET /gate/accounts/:id` | One account, its current mandate version and hash, and its rules in plain words |
| `PUT /gate/accounts/:id` | Change `name`, `mode`, `maxPaymentUsd`, `maxDailyUsd` or `freezeOnBreach` |
| `POST /gate/accounts/:id/unfreeze` | Lift a freeze |
| `GET /gate/accounts/:id/mandates` | Every mandate version, newest first, with its hash and who made it |
| `GET`, `POST /gate/accounts/:id/keys`, `DELETE .../keys/:keyId` | List, make (`{ label? }`) and revoke API keys (10 live at most) |
| `GET`, `POST /gate/accounts/:id/vendors`, `PUT`, `DELETE .../vendors/:vendorId` | The vendor master: `{ id, name, account, cardMerchant? }`, each vendor's verified account and card merchant (`{ name, networkId }`). Changing a card merchant on file needs `ticket`, a verified ticket for `card:<network id>` |
| `GET`, `POST /gate/accounts/:id/invoices`, `DELETE .../invoices/:itemId` | Approved invoices: `{ vendorId, reference, amountUsd }` |
| `GET`, `POST /gate/accounts/:id/refunds`, `DELETE .../refunds/:itemId` | Approved refunds: `{ reference, account, amountUsd, name?, reason? }` |
| `GET`, `POST /gate/accounts/:id/tickets`, `DELETE .../tickets/:itemId` | Verified bank-change tickets: `{ id, vendorId, account, verifiedBy }`; `GET` also shows `usedBy`, the decision that applied it |
| `GET`, `POST /gate/accounts/:id/payments` | Payments made; `POST` imports one made before the gate (`{ kind?, account, amountUsd, reference, day }`) so the duplicate and daily rules count it |
| `GET /gate/accounts/:id/decisions`, `.../decisions/:decisionId` | The decision log, as below |
| `GET /gate/accounts/:id/usage?days=30` | The meter: checks per UTC day |

Agent (API key):

| Route | What it does |
|---|---|
| `POST /payments/check` | Check one payment, refund or bank change (below) |
| `GET /payments/decisions` | The decision log, newest first: `?limit=` (1 to 100), `?before=<next>`, `?result=allowed\|blocked\|refused` |
| `GET /payments/decisions/:decisionId` | One decision with its receipt |
| `GET /payments/decisions/:decisionId/proof` | Where its receipt sits in its day's log root (below) |

The owner gets the same proof at `GET /gate/accounts/:id/decisions/:decisionId/proof`. A decision
(from either log) also carries `input`, what the rules were given, so its hash can be recomputed
(empty for decisions made before migration 0026).

Public (no sign-in):

| Route | What it does |
|---|---|
| `GET /gate/receipt-key` | The receipt key's address and the EIP-712 domain and types |
| `GET /gate/anchors/:id/mandates` | Each mandate version's hash, newest first, and where it was posted on chain (`posted`: `{ chainId, contract, txHash, postedAt }` or null) |
| `GET /gate/anchors/:id/roots` | Each day's log root, newest first (`?limit=`, `?before=<day>`), with the day's number on chain and `posted` |

The public routes give hashes only, the same ones that go on chain, and not how many decisions a
day had.

## Watch mode

Payments read after they were made (`gate-watch.ts`). Nothing here can stop a payment.

| Route | What it does |
|---|---|
| `POST /payments/watched` | API key. Up to 100 payments already made: `{ id, account, amountUsd, reference?, paidAt }`. The same `id` records nothing |
| `GET /gate/watch-chains` | Public. The chains a wallet can be watched on |
| `GET /gate/accounts/:id/wallets`, `POST`, `DELETE .../:walletId` | Owner. Public addresses to read |
| `GET /gate/accounts/:id/watched` | Owner. The payments seen, newest first |
| `GET /gate/accounts/:id/activity` | Owner. Checks and watched payments in one list, newest first by when each happened. `?source=check,card,log,wallet` (`card` covers card hooks too; their `rail` names the provider, as "Lithic card"), `?result=allowed,blocked,refused,seen`, `?rule=`, `?limit=`, `?before=<next>`. Each item has `entry`, `source`, `rail`, and `decision` or `watched` |
| `GET /gate/accounts/:id/connections` | Owner. Live API keys, wallets, the payment log and card hooks, with when each last reported |

A payment that matches an allowed check (same payee and amount, up to 24 hours before it) is recorded with `checkedFirst: true`, and its rules aren't run: the check judged it. Each check matches one payment. Any other runs through `checkWatchedPayment`, is added to `gate_payments` with source `watch`, and alerts the owner (`payment_seen_breach`, or `gate_skipped` with `expectChecks` on and no other rule broken). `freezeOnBreach` applies. Watched payments get no receipt and aren't in the decision log or its log roots.

The keeper reads wallets every 30 seconds on every chain in `WATCH_CHAINS` (Ethereum, Base, Arbitrum, Base Sepolia), each through a free public node set in the code. Nothing needs setting. `GATE_WATCH_RPC_URLS`, a JSON object of chain id to RPC URL on both the API and the keeper, can replace a chain's node. The public nodes keep limited history: Ethereum's reaches about a day and a half back, so a keeper down longer than that stops reading Ethereum wallets until a node with more history is set there. A failing wallet doesn't stop the others. It reads the stablecoins in `WATCH_CHAINS`, valued at one dollar, after each chain's confirmations. A new wallet starts at the current block. Transfers between an account's own wallets, and zero-value transfers, are skipped. `pruneWatched` follows `GATE_DECISION_RETENTION_DAYS`; what a watched payment added to `gate_payments` stays.

## Budgets

One check for many small payments to one payee (`gate-budget.ts`), for payments too small and too
frequent to check one at a time, such as x402 calls of $0.001. Amounts in a budget are
micro-dollars (millionths of a dollar, the unit USDC counts in), so a $0.001 payment counts as
exactly that. The account needs invoice matching off.

| Route | What it does |
|---|---|
| `POST /payments/budgets` | API key. Ask for a budget: `{ account, amountUsd, maxPaymentUsd?, ttlSeconds?, requestId? }`. `amountUsd` has at most two decimals; `maxPaymentUsd` up to six (default and most: the account's per-payment limit); `ttlSeconds` 60 to 3,600 (the default). Answers like a check, with `budget` (null unless it opened) |
| `POST /payments/budgets/:budgetId/spends` | API key. Up to 500 payments made against it: `{ id, amountMicros, reference?, at }`. The same `id` records nothing |
| `POST /payments/budgets/:budgetId/close` | API key. Close it now. Closing a closed one gives back its close decision |
| `GET /payments/budgets`, `.../:budgetId` | API key. Budgets, newest first (`?open=true`, `?limit=`, `?before=`); one budget with its payments |
| `GET /gate/accounts/:id/budgets`, `.../:budgetId` | Owner. The same |

- **The budget check** is a decision of kind `budget` with a receipt. Its rules (`checkBudget` in
  `packages/shared/src/payment-budget.ts`): the payee is a vendor's account (`unknown_payee`), the
  whole budget fits in what's left of the day (`over_daily_cap`), and with an hourly limit there is
  room for a payment (`over_hourly_limit`), counting what open budgets may still pay. The input
  carries `terms`: the payee, the budget, the per-payment limit, how many payments it covers (what
  the hourly limit had room for) and when it opens and ends. `evaluateGateInput` checks the terms
  follow from the rest of the input, so the receipt's input hash commits to them.
- **Opened** (allowed, or let through by Monitor mode), the whole budget is reserved: a
  `gate_payments` row with source `budget` counts toward the day. Blocked or refused, nothing opens.
- **Payments against it** are checked by the agent's code (the SDK), with no call to the API, then
  reported. The API checks each against the terms again (`budgetSpendProblem`) and records it even
  when it doesn't fit, since it was already paid; one that breaks the terms alerts the owner
  (`payment_breach`) and freezes the account when it freezes on a breach. Each one counts toward
  the hourly limit.
- **Closing** is a decision of kind `budget_close`: its input is the terms and every payment in the
  order reported, its receipt's amount is what was spent rounded up to the cent, its reference is
  the budget's id, and it breaks `over_budget` when any payment broke the terms. The reservation
  becomes what was spent; with nothing spent, it goes. Budgets that ended more than 10 minutes ago
  close on their own: the API checks every minute (where `GATE_RECEIPT_PRIVATE_KEY` is set), and a
  new budget closes the account's first.
- **Watch** matches a payment to an open budget when it pays the budget's payee while the budget is
  open, fits the per-payment limit, and leaves the payments matched to it within the budget by
  exact amount and count. A matched payment has `matched_budget` set, breaks nothing and adds
  nothing to `gate_payments`: the reservation already counts. Wallets read exact amounts; a
  payment log can send `amountUsd` with up to six decimals.

## The check

```json
{ "kind": "invoice", "account": "GB29 NWBK 6016 1331 9268 19", "amountUsd": 612.4, "invoiceReference": "NIM-88412", "requestId": "pay-001" }
{ "kind": "refund", "account": "...", "amountUsd": 49.99, "invoiceReference": "R-77" }
{ "kind": "bank_change", "vendorId": "nimbus", "account": "...", "ticket": "FIN-1" }
```

`kind` defaults to `invoice`. With `invoiceMatching` off on the account (`PUT /gate/accounts/:id`),
an invoice check runs as kind `payment`: no invoice is needed, `invoiceReference` is optional, and
the rules are the payee list, the limits, `maxPaymentsPerHour` (`over_hourly_limit`) and a
reference paid to an account only once. The answer and the receipt say `payment`, and the input
carries `paymentsLastHour`. Only the owner can change the setting; an agent's key can't ask for
`payment`. Refunds and bank changes ignore the setting.

`requestId` is optional: the same id again returns the first decision
unchanged (`replayed: true`), so a retry after a timeout can't trip the duplicate rule; the same id
with a different check is refused (409).

The answer always has `decision` (`pass`, `breach`, or `frozen`), `result` (`allowed`, `blocked`
or `refused`), `allowed`, the `rules` broken with their `reasons` in words, `lossUsd` and
`overpaidUsd` (what left, when a breach went out), the mandate version and hash it was checked
against, `input` (exactly what the rules were given; left out when a repeated request id returns
an earlier decision, so keep it from the first answer) and `receipt`.

- **Enforce** blocks a payment that breaks a rule. **Monitor** lets it through and records it.
- A **frozen** account (after a breach, with `freezeOnBreach`) is refused before the rules run,
  in either mode, until the owner lifts the freeze.
- A payment that goes out is recorded, so later checks see it (duplicates, the day's total).
- A verified bank change (a ticket covers that vendor and account) becomes the vendor's verified
  account and a new mandate version. An unverified one never does, even when Monitor lets it
  through. A ticket covers one change: once applied it is used up, so an old ticket can't move
  the vendor back to an account it has since left. Delete a ticket you no longer want applied.
- Each check of an account runs in one transaction holding the account's row lock, so two
  checks of the same invoice can't both pass and the day's total is always right.
- The owner is alerted (in-app list, webhook, email, as set in `/self/notifications`) on a block
  (`payment_blocked`), a breach Monitor let through (`payment_breach`) and a freeze
  (`gate_frozen`). The webhook body is `{ type, dedupeKey, gateAccountId, message, code, fix?,
  details?, at }`; each type can be muted like the others.

From an agent, `paymentGate` in `@bondedhq/sdk` wraps this route: it fails closed, checks each
receipt, and works as the `guard` for `guardPayments` and the framework helpers
(`packages/sdk/src/gate.ts`, `apps/api/test/gate-sdk.test.ts`).

## Receipts

A receipt is EIP-712 typed data (domain `Bonded Payment Gate`, version `1`, no chain) signed by
the receipt key: the decision id, gate account id, kind, decision, result, mode, rules broken,
amount in cents, payee account (no spaces, upper case), reference, `inputHash` (SHA-256 of the
input's canonical JSON), `mandateHash` (SHA-256 of the mandate version's canonical JSON),
`mandateVersion` and the time in Unix seconds.

To check one offline with `@bondedhq/shared`:

```ts
const key = await (await fetch(`${api}/gate/receipt-key`)).json();
await verifyGateReceipt(answer.receipt, key.address); // true
gateInputHash(answer.input) === answer.receipt.receipt.inputHash; // true
evaluateGateInput(answer.input).rules; // the same rules
```

Without a receipt key the service gives no decisions: `POST /payments/check` answers 503.

The web app (signed in with the owner's wallet) lists the owner's accounts at `/gate`, and each
opens at `/gate/:id` with a tab for its activity, rules, vendors (with their bank-change tickets),
invoices, Watch, cards (card hooks), alerts and API keys, each through the owner routes
above. Forms and details open in modals, and a new API key is shown once. Each decision opens with
its receipt, and its Verify button runs these checks, and the log root check below, in the browser.
Refunds and imported payments are API only.

Anyone can run the same checks without signing in at `/gate/verify` (`GateVerify.tsx`): paste an
agent's check answer (the receipt and its input), or a receipt the owner copied from a decision
(with its log proof once Verify has loaded it). The root is read from GateAnchor on chain.

## Hashes on chain

Each mandate version's hash and one log root per account per UTC day are posted to
[`GateAnchor`](../../contracts/evm/src/GateAnchor.sol), where they can't be changed.

- **The log root** (`gateLogRoot` in `packages/shared/src/gate-log.ts`) is a Merkle tree over the
  day's receipts in decision order. Each leaf is the receipt's EIP-712 hash (`gateReceiptHash`)
  hashed twice; each node is keccak256(left, right); a level with an odd count carries its last
  node up; the root is keccak256(abi.encode(count, tree root)). It commits to every receipt, their
  order and their number.
- **The keeper** makes a day's root ten minutes after the day ends (UTC), for every account with
  decisions that day, looking back 7 days. It stores it (`gate_log_roots`, migration 0026) whether
  or not GateAnchor is set up. With GateAnchor set up it then posts every mandate hash and day root
  not on chain yet, every `GATE_ANCHOR_MS`. It reads the contract first: a hash already there is
  recorded as posted, a different one is never overwritten (the row keeps the error), and a stored
  mandate whose hash doesn't match is never posted.
- **A proof** is `{ index, count, siblings }`, with `receiptHash`, `root`, `day`, `dayNumber`,
  `accountKey` (the account's UUID as 16 bytes) and `posted`. It answers 409 until the day has a
  root, and once some of the day's decisions have been deleted (retention).

To check a receipt against its root, offline or on chain:

```ts
const p = await (await fetch(`${api}/payments/decisions/${id}/proof`, auth)).json();
verifyGateLogProof(gateReceiptHash(receipt.receipt), p.proof, p.root); // true
// On chain, against the root GateAnchor holds:
anchor.verifyReceipt(p.accountKey, p.dayNumber, p.receiptHash, p.proof.index, p.proof.count, p.proof.siblings);
```

## Card hooks

The business issues its agent's cards in its own card program, and the program asks the gate
before each charge. The gate answers approve or decline in the program's own format. Bonded holds
no key for the program: it can't make, fund or charge a card. Code: `src/gate-card-hook.ts`,
`packages/db/src/gate-card-hook.ts` (migration `0031_gate_card_hooks.sql`), and
`GateCardChargeInput` in `packages/shared/src/gate-receipt.ts`. Tests: `test/gate-card-hook.test.ts`.

| Route | What it does |
|---|---|
| `GET`, `POST /gate/accounts/:id/card-hooks`, `DELETE .../:hookId` | Owner. Card hooks (5 at most): `{ provider: "stripe" \| "lithic" \| "marqeta", label?, secret? }`. Each has a `path` to give the program. Marqeta: Bonded makes a username and password, and returns the password once |
| `PUT /gate/accounts/:id/card-hooks/:hookId/secret` | Owner. A Stripe or Lithic hook's signing secret (`whsec_...`). Stripe shows it only after the address is set, so it can come after the hook. A hook without one refuses every request (`ready: false`) |
| `POST /payments/card-hook/:hookId` | The card program. Stripe Issuing's `issuing_authorization.request` webhook, Lithic's Auth Stream Access request, or Marqeta's Gateway JIT Funding request |

Each program proves the request: Stripe signs it (`Stripe-Signature`), Lithic signs it
(`webhook-id`, `webhook-timestamp`, `webhook-signature`: HMAC-SHA256 of
"id.timestamp.body" with the base64 secret after `whsec_`), and Marqeta signs in with Basic auth.
A request that doesn't check gets 401. The signing secret is stored encrypted
(`AGENT_URL_SECRET_KEY`); the Marqeta password only as its SHA-256.

A charge runs the general rules (`checkGeneralPayment`) with the merchant as the payee
(`cardMerchantKey` of its network id: Stripe's `network_id`, Lithic's `acceptor_id`, Marqeta's
`mid`). A merchant no vendor has as its card merchant breaks `unknown_payee`. The per-payment,
daily and hourly limits apply. Invoice matching doesn't: a charge has no invoice. Merchant
category codes 4829, 6010, 6011, 6012, 6051, 6540 and 7995 (cash, money orders, stored-value
loads, gambling) break `blocked_merchant`, which is declined in either mode. Otherwise Monitor
lets a breaking charge through and Enforce declines it, and a frozen account declines every
charge. Each answer is a decision of kind `card` with a signed receipt, its input of kind
`card_charge`, and an approved charge is added to `gate_payments` with source `hook`. The
program's id for the charge is the decision's request id, so a request sent twice gets the same
answer and one decision. Breaches alert the owner as a check's do.

Answers: Stripe `{ approved }` with `Stripe-Version`. Lithic `{ token, result }`: `APPROVED`, or
`UNAUTHORIZED_MERCHANT` (a merchant rule), `VELOCITY_EXCEEDED` (a limit) or `CARD_PAUSED` (frozen,
or anything the gate couldn't decide). Marqeta echoes the funding request with the amount to two
decimals: 200 approves, 402 declines with `decline_reason` `INVALID_MERCHANT` or
`TRANSACTION_NOT_PERMITTED`. A request that spends nothing is approved without a decision: a $0 check that a card works,
Lithic's refunds to the card and balance inquiries, and Marqeta methods other than an
authorization, its increment, or auth plus capture. A Lithic status Bonded doesn't know is checked
like a charge. Marqeta balance inquiries are declined: the answer needs the card's balances, which
Bonded doesn't have.

Anything the gate can't decide declines: a request it can't read, a non-USD charge, an error, or
an answer not ready inside 1.5 seconds (Stripe waits 2, Marqeta 3, Lithic 6). The budget is checked
as the transaction's last step, and the answer waits for COMMIT, so it always matches the record: a
late one rolls back and declines. Only a database that hangs 300 ms past the budget gets a decline
without its outcome. Card hook requests may be up to 64 KB (Stripe's events carry the card), above
the API's usual 16 KB. Stripe live-mode charges are declined
unless `GATE_ALLOW_LIVE_CHARGES=true`; Lithic and Marqeta requests don't say whether they're
live.

Not yet: refunds, reversals and expiries aren't read, so an approved charge counts toward the
daily limit even if it never settles.

## Storage and retention

Tables: `gate_accounts`, `gate_mandates`, `gate_api_keys`, `gate_vendors`, `gate_invoices`,
`gate_refunds`, `gate_tickets`, `gate_payments`, `gate_decisions`, `gate_usage_daily`,
`gate_log_roots` (migration 0026), `gate_watch_wallets` and `gate_watched_payments` (0030),
`gate_card_hooks` (0031), and `gate_budgets` and `gate_budget_spends` (0033). Amounts are whole
cents, except in budgets and a watched payment's `amount_micros`, which are micro-dollars. Migration
0032 dropped the tables of the old card route and payout route, which held customers' Stripe keys;
their decisions and payments stay.

The decision log keeps the record only (rules, amounts, payee account, reference, hashes, the
receipt and the rules' input: the attempt, limits, payee accounts, approved invoices or refunds,
the day's payments and tickets), never an invoice document or image. The keeper deletes decisions
older than `GATE_DECISION_RETENTION_DAYS` (365 by default) hourly, and budgets closed before
then with their payments. Payments made are kept, because
the duplicate rule reads them. Log roots and what was posted on chain are kept too.

## Settings

| Variable | Where | What |
|---|---|---|
| `GATE_RECEIPT_PRIVATE_KEY` | API | 32-byte hex secp256k1 key that signs receipts. Required for checks |
| `GATE_DECISION_RETENTION_DAYS` | keeper | Days of decision log to keep (default 365) |
| `GATE_ALLOW_LIVE_CHARGES` | API | `true`: card hooks answer Stripe live-mode charges. Off: declined. Lithic and Marqeta requests don't say whether they're live |
| `STRIPE_API_VERSION` | API | The `Stripe-Version` card hooks answer Stripe with (default `2026-09-30.endive`) |
| `AGENT_URL_SECRET_KEY` | API | Also encrypts card hooks' signing secrets; `pnpm secrets:reencrypt` moves them with the rest |
| `GATE_WATCH_RPC_URLS` | API, keeper | Optional. JSON of chain id to RPC URL, replacing a chain's public node (Watch mode) |
| `GATE_ANCHOR_ADDRESS` | keeper | GateAnchor's address (default: `gateAnchor` in the deployment file, if any). Without it, roots are made and stored, not posted |
| `GATE_ANCHOR_KEY` | keeper | 32-byte hex key that posts; GateAnchor's owner must allow its address with `setPoster`. Needed to post, and needs gas on that chain |
| `GATE_ANCHOR_RPC_URL` | keeper | GateAnchor's chain, when it isn't the protocol's (default `RPC_URL`) |
| `GATE_ANCHOR_MS` | keeper | How often the job runs (default 600000, at least 60000) |

Limits (in `createApi({ gate })`): 600 checks per account per minute, 1,200 API-key requests per
client address per minute, 20 accounts per wallet, 10 live keys per account, 500 vendors per
account, 5 card hooks per account. Request bodies are capped at 16 KB like the API's other routes,
except card hooks (64 KB).
