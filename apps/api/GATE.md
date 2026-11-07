# Payment gate API

The hosted check for off-chain payments. An agent asks `POST /payments/check` before it pays an
invoice, sends a refund or changes a vendor's bank account. The API runs the same rules the Arena
rates agents against (`checkInvoicePayment`, `checkRefundPayment` and `isVerifiedChange` in
`packages/shared/src/payment-mandate.ts`) on the gate account's state, applies the account's mode
and freeze, and answers with the decision and a signed receipt.

Code: `src/gate.ts` (routes), `src/gate-check.ts` (the check), `packages/db/src/gate.ts` (storage,
migrations `0024_payment_gate.sql` and `0026_gate_transparency.sql`),
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
| `GET`, `POST /gate/accounts/:id/vendors`, `PUT`, `DELETE .../vendors/:vendorId` | The vendor master: `{ id, name, account, cardMerchant? }`, each vendor's verified account and card merchant (`{ name, networkId }`). Changing a card merchant on file needs `ticket` (see the card route) |
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
`payment`. Refunds, bank changes, the card route and the payout route ignore the setting.

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
invoices, cards (the Stripe link for the card route) and API keys, each through the owner routes
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

## The card route (Stripe Issuing)

The agent pays an approved invoice with a single-use Stripe Issuing virtual card, and Stripe asks
the gate before every charge on it. Bonded holds no money; it only says yes or no. Code:
`src/gate-card.ts` (routes), `src/stripe-issuing.ts` (the Stripe calls behind a small client
interface, and the webhook signature check), `packages/db/src/gate-card.ts` (migration
`0025_gate_stripe_card.sql`), and `GateCardInput` in `packages/shared/src/gate-receipt.ts`.
Tests: `test/gate-card.test.ts`, with a fake Stripe client and webhooks signed the way Stripe
signs them.

| Route | Who | What it does |
|---|---|---|
| `PUT /gate/accounts/:id/stripe` | owner | Link the account's Stripe account: `{ secretKey, cardholderId, authorizationWebhookSecret?, eventsWebhookSecret? }`. `secretKey` is a restricted key (`rk_test_...`) that can create, read and update Issuing cards; `cardholderId` (`ich_...`) is the cardholder the cards are issued to. Test-mode keys only unless `GATE_ALLOW_LIVE_CREDENTIALS=true`. Stored encrypted with `AGENT_URL_SECRET_KEY`, never shown again |
| `GET`, `DELETE /gate/accounts/:id/stripe` | owner | The link (key hint only), or unlink: no new cards. Cards already issued are still checked |
| `GET /gate/accounts/:id/card-intents` | owner | The cards issued, newest first |
| `POST /payments/intents` | agent | `{ invoiceReference, vendorId? }`. If the invoice is approved and unpaid, its vendor has a card merchant, the charge would pass the rules and the account isn't frozen, Stripe issues a virtual card: single use (`lifecycle_controls.cancel_after.payment_count=1`), an all-time spending limit of the invoice amount, cash, ATM and quasi-cash categories blocked. The answer carries the card number, CVC and expiry once, as Stripe returns them (`Cache-Control: no-store`); only the card's id and last four digits are kept. The same invoice again, while its card is unused, returns the same card |
| `GET /payments/intents/:intentId` | agent | One intent, without card details |
| `POST /stripe/issuing/authorization` | Stripe | The real-time authorization webhook (below) |
| `POST /stripe/issuing/events` | Stripe | `issuing_authorization.created`, `issuing_authorization.updated`, `issuing_transaction.created` (below) |

Both Stripe routes check the `Stripe-Signature` header (HMAC-SHA256, `v1` only, 5 minutes'
tolerance) against the linked account's own endpoint secret, if it gave one, and the service's
(`STRIPE_WEBHOOK_SECRET`, `STRIPE_EVENTS_WEBHOOK_SECRET`). An unsigned or badly signed request
gets 400 and changes nothing. Their bodies may be up to 256 KB.

**Each charge.** Stripe sends `issuing_authorization.request`; the gate finds the card's intent,
runs the shared rules on the card mapping, applies the mode and freeze, records the decision with
a signed receipt (kind `card`, payee `CARD:<network id>`), all in one transaction holding the
account's lock, and answers `200 { "approved": true | false }` with a `Stripe-Version` header.

| Rule | On the card |
|---|---|
| `unknown_payee` | The merchant (`merchant_data.network_id`) isn't any vendor's card merchant on file |
| `unverified_vendor_change` | The merchant has the card's vendor's name but isn't its merchant on file, and no verified ticket covers it. A ticket covers a merchant when its account is `card:<network id>`; the charge then passes and the merchant becomes the vendor's (a new mandate version), and the ticket is used up, as for a bank change. The owner changing a merchant on file needs the same kind of ticket |
| `unmatched_invoice` | No approved invoice of the card's vendor behind the charge (another vendor's merchant breaks it even when that vendor has an invoice with the same reference), an amount other than the invoice's (the mandate pays exact amounts), or a cash or quasi-cash category |
| `duplicate_payment` | The invoice is paid, or held by a charge already approved |
| `over_payment_cap`, `over_daily_cap` | Over the limits; charges approved and still held count toward the day, and so does a captured charge until its transaction arrives |

- **Enforce** never approves a charge that breaks a rule. **Monitor** approves it and records the
  breach, except cash and quasi-cash, which are declined in either mode. A **frozen** account
  declines every charge.
- An incremental authorization is checked on the new total; declining it leaves the original
  approval standing, as Stripe does.
- The gate answers within 1.5 seconds (`budgetMs`) or declines, and keeps nothing it was
  deciding. Any error, a card it didn't issue, a missing receipt key, a non-USD charge or a
  live-mode charge (unless live credentials are allowed) is a decline: there is no fail-open.
  Measured in the tests on embedded Postgres: a few milliseconds per charge.
- The same event again gets the same answer and no second decision.

**Paths that don't reach the gate, and how each is closed.**

| Path | What the gate does | Stripe test helper that simulates it |
|---|---|---|
| Timeout or webhook error | Stripe applies its timeout setting (must be decline). `issuing_authorization.created`/`updated` with `request_history.reason` `webhook_timeout`, `webhook_error` or `network_fallback` alerts the owner (`stripe_webhook_failed`) | Stop the API, then `POST /v1/test_helpers/issuing/authorizations` |
| Stripe approved without the gate (timeout fallback, Autopilot, stand-in) | The card is cancelled at once and the owner alerted (`payment_breach`); whatever settles is recorded as a breach | As above, with the timeout setting on approve (only to test) |
| Force capture or offline transaction (no authorization) | `issuing_transaction.created` without a gate-approved authorization: a breach decision (bypassed), the payment recorded, the card cancelled, the owner alerted, the account frozen if set | `POST /v1/test_helpers/issuing/transactions/create_force_capture` |
| Capture or increment above the approved amount | The difference is recorded as an overpayment (a breach decision with `overpaidUsd`) and alerted | `.../authorizations/:id/capture` with a larger `capture_amount`; `.../authorizations/:id/increment` |
| Reversal or expiry, or Stripe declining a charge the gate approved (its answer arrived too late) | The invoice is released (intent `released`); a new card can be issued for it | `.../authorizations/:id/reverse`, `.../authorizations/:id/expire` |
| Cash, ATM, quasi-cash | Blocked on the card; declined by the gate if a request still arrives | `POST /v1/test_helpers/issuing/authorizations` with `merchant_data[category]=automated_cash_disburse` |

Nothing is marked paid until a transaction settles: a payment (`source: "card"`) is recorded on
`issuing_transaction.created`, and the intent becomes `paid`. Refunds are recorded on the card
and change nothing else. Every event id is stored, so a replay changes nothing.

**Stripe settings the founder sets** (Dashboard, test mode, Issuing settings):

1. Issuing turned on in test mode, a cardholder made (its `ich_` id goes in the link), and the
   Issuing balance topped up with test funds.
2. Real-time authorizations: the endpoint URL `https://<api host>/stripe/issuing/authorization`.
   Its signing secret goes in `STRIPE_WEBHOOK_SECRET` (or the link's
   `authorizationWebhookSecret`).
3. The authorization timeout setting: **decline**. Autopilot off (or set to decline only).
4. A webhook endpoint (Workbench, snapshot events) at `https://<api host>/stripe/issuing/events`
   for `issuing_authorization.created`, `issuing_authorization.updated` and
   `issuing_transaction.created`. Its signing secret goes in `STRIPE_EVENTS_WEBHOOK_SECRET`.
5. A restricted key with write access to Issuing cards (and read on Issuing authorizations and
   transactions), linked with `PUT /gate/accounts/:id/stripe`.

## The payout route (bank payouts through a TEE)

For bank payouts the agent never holds the payment credential. It asks the gate to pay; the gate
runs the rules and only an allowed payout is forwarded to the **payout proxy**
(`services/payout-proxy`), a small service in a Phala confidential VM that is the only place the
credential can be opened. Code: `src/gate-payout.ts` (routes), `src/payout-tee.ts` (attesting
and calling the proxy), `packages/db/src/gate-payout.ts` (migration `0028_gate_payout_proxy.sql`),
`packages/shared/src/gate-payout.ts` (sealing, signed lookups and answers). Tests:
`test/gate-payout.test.ts` (the API against a real proxy run locally, with a fake Stripe) and
`services/payout-proxy/test/proxy.test.ts`.

**Provider: Stripe Global Payouts**, the Outbound Payments API: one OutboundPayment from the
account's financial account to a recipient's payout method (a bank account), which Stripe never
retries or reroutes ([Send payouts](https://docs.stripe.com/global-payouts/send-money),
[the API](https://docs.stripe.com/api/v2/money-management/outbound-payments/create)). Sandbox keys
work with it and Stripe's test bank accounts simulate failed and returned payouts
([Test payouts](https://docs.stripe.com/global-payouts/testing)). Treasury's v1 OutboundPayments
does the same but Stripe marks it legacy. The provider sits behind the `PayoutProvider` interface
in `services/payout-proxy/src/provider.ts`, so others can be added.

A vendor paid by payout has `stripe:<recipient id>:<payout method id>` as its account in the
vendor master, for example `stripe:acct_1Nv0FGQ9RKHgCVdK:usba_test_61Nyd9...`. The rules compare
it like any account (no spaces, upper case); the payout goes to the ids as the vendor master
writes them, since Stripe's ids are case-sensitive. A new bank account means a new payout method
id, so it is a vendor change the rules catch, and the linked key can't create one.

| Route | Who | What it does |
|---|---|---|
| `GET /gate/payout-proxy` | anyone | Attests the proxy now and shows what it proved: `measurement`, `composeHash`, `sealPublicKey`, `production`, and `custody` in words |
| `PUT /gate/accounts/:id/payout-link` | owner | Link the account's Stripe account: `{ secretKey, financialAccount, eventsWebhookSecret }`, or `{ sealedCredential, eventsWebhookSecret }` (below). Test-mode keys only unless `GATE_ALLOW_LIVE_CREDENTIALS=true`, at the API and again at the proxy |
| `GET`, `DELETE /gate/accounts/:id/payout-link` | owner | The link (key hint, financial account, the TEE it is sealed to, `custody`), or unlink: the sealed credential is deleted and no payout can go through the gate |
| `GET /gate/accounts/:id/payouts` | owner | The payouts, newest first (`?limit=`, `?before=<id>`) |
| `POST /payments/payouts` | agent | `{ account, amountUsd, invoiceReference, kind? ("invoice" or "refund"), requestId? }` (below) |
| `GET /payments/payouts/:payoutId` | agent | One payout |
| `POST /stripe/payouts/events/:accountId` | Stripe | The account's payout events (below) |

**Linking.** The API attests the proxy, seals the key to the proxy's seal key (ECDH on P-256,
HKDF-SHA256, AES-256-GCM, bound to the gate account), asks the proxy to confirm it opens and is
a test-mode key, and stores only the sealed copy, with the measurement and compose hash it was
sealed under. The API holds the plain key only for that request and never writes or logs it. An
owner who wants the API never to see it seals it themselves with `sealPayoutCredential` from
`@bondedhq/shared`, to the `sealPublicKey` that `GET /gate/payout-proxy` shows, and sends
`sealedCredential`. The events secret is stored encrypted with `AGENT_URL_SECRET_KEY`.

**Each payout.** `POST /payments/payouts`:

1. Refused (503) unless the receipt key and the proxy are configured, and (409) unless the account
   has a payout link.
2. The proxy is attested again, before every payout. If it can't be reached or fails, the answer
   is 503 and nothing is checked, recorded or paid, in Enforce and Monitor mode alike (only the
   proxy can pay). A proxy whose seal key changed (redeployed) answers 409: relink.
3. The hosted check runs (`runGateCheck`, as `POST /payments/check`), and in the same transaction,
   holding the account's lock, an allowed decision records its payout (`pending`) next to the
   payment that holds the invoice. A blocked or refused decision pays nothing (200, `paid: false`).
4. The decision's signed receipt goes to the proxy with the destination and the sealed credential.
   The proxy checks the receipt's signature against `GATE_RECEIPT_ADDRESS`, that it allows the
   payment (`result: "allowed"`, an invoice or a refund), that it is under ten minutes old, that
   the destination is the receipt's payee, and that the decision wasn't paid before. It pays the
   receipt's amount and reference, with the decision id as Stripe's idempotency key and in the
   payout's metadata, and signs its answer with its attested key.

The answer is the decision (as `POST /payments/check` gives it) with `paid`, `payout` and
`payoutMessage`: **201** paid (`processing`); **502** not sent (the proxy or Stripe refused: the
payout is `not_sent` and the invoice is released, so it can be asked again); **202** unknown (the
answer was lost after it was sent: the invoice stays held until Stripe reports, and asking again
with the same `requestId` within nine minutes retries safely, since the proxy and Stripe both
dedupe the decision). The same `requestId` otherwise returns the first payout unchanged.

**Payout statuses:** `pending`, `not_sent`, `unknown`, then Stripe's `processing`, `posted`,
`failed`, `returned`, `canceled`. `failed`, `returned`, `canceled` and `not_sent` release the
invoice (its payment row is deleted), so the duplicate and daily rules no longer count it. A
final status doesn't move again, and a late `posted` doesn't undo a return.

**Stripe's events.** Each gate account has its own endpoint,
`https://<api host>/stripe/payouts/events/<gate account id>`, checked against the account's own
signing secret (`Stripe-Signature`, as the card route). It takes Stripe's thin events
`v2.money_management.outbound_payment.created`, `.posted`, `.failed`, `.returned` and `.canceled`
and acts on the type and the payout id. A payout the gate knows moves to that status. A payout it
doesn't know is looked up through the proxy (a lookup signed with the receipt key): if its
metadata names one of the account's decisions whose payout has no Stripe id yet, and it pays
exactly that decision's amount to its payee, it is that payout (its answer was lost); otherwise
(the metadata is whatever the payout's maker wrote) it is **a payout the gate never approved**: a
breach decision with a signed receipt (the rules run on what was paid), the payment and the
payout recorded (`gateApproved: false`), the owner alerted (`payment_breach`, code
`gate-payout-bypass`) and the account frozen if `freezeOnBreach` is set.
If the proxy can't be reached for the lookup, the owner is alerted (`gate-payout-unchecked`) and
the event answers 503 so Stripe sends it again. Every event id is stored; a replay changes nothing.

**What is claimed about the credential.** The API verifies the proxy with the Arena's verifier
(`apps/arena/src/tee.ts`): an Intel-signed TDX quote with an acceptable TCB status, committing to
the expected code hash, the proxy's key and a fresh challenge; an event log that replays to the
quote; an approved production OS image (dev images, which allow SSH, are refused); and a compose
hash on `GATE_PAYOUT_TEE_COMPOSE_HASHES` (the pinned image digest and compose file). When
`GATE_PAYOUT_TEE_MEASUREMENTS` is set, the measurement must be on it too, and only then does the
API say (`production: true`) that Bonded staff can't read the credential. Until a production
measurement is configured, `custody` says only that the credential is sealed to the proxy and the
API can't open it, and makes no claim about staff.

**Limits of the guarantee.** The proxy enforces what the receipt says; the rules decide what the
receipt says. Anyone holding the Stripe key outside the gate (for example in Stripe's dashboard)
can still pay from the same financial account: the gate reports it as a breach when Stripe's event
arrives, after the fact. Use a financial account only the gate pays from, and the narrowest key.

**Stripe settings the founder sets** (a sandbox):

1. Global Payouts turned on in the sandbox (Dashboard, Global Payouts, Get started) and its
   financial account funded with test money (Balances, Add funds, or the Credit a Financial
   Address test helper). Check Global Payouts is available for the account's country.
2. A recipient per vendor with a test bank account (routing `110000000`; account `000123456789`
   succeeds, `000111111112` fails, `000111111113` is returned). The vendor's account in the gate's
   vendor master is `stripe:<acct id>:<payout method id>`.
3. A restricted key (`rk_test_...`) with "Money Management Outbound Payments: Write" and "Money
   Management Financial Accounts: Read", linked with `PUT /gate/accounts/:id/payout-link` with
   the financial account's id (`fa_...`). If Stripe refuses a call for a missing permission, add
   only the one it names.
4. An event destination (Workbench, Webhooks, thin events) at
   `https://<api host>/stripe/payouts/events/<gate account id>` for the five OutboundPayment events
   above. Its signing secret goes in the link's `eventsWebhookSecret`.

## Storage and retention

Tables: `gate_accounts`, `gate_mandates`, `gate_api_keys`, `gate_vendors`, `gate_invoices`,
`gate_refunds`, `gate_tickets`, `gate_payments`, `gate_decisions`, `gate_usage_daily`,
`gate_log_roots` (migration 0026), for the card route `gate_stripe_links`,
`gate_card_intents`, `gate_card_authorizations`, `gate_card_transactions`,
`gate_stripe_events` (event ids, kept 30 days; the payout route's event ids too), and for
the payout route `gate_payout_links` (the sealed credential, never a plain key) and
`gate_payouts`. Amounts are whole cents.

The decision log keeps the record only (rules, amounts, payee account, reference, hashes, the
receipt and the rules' input: the attempt, limits, payee accounts, approved invoices or refunds,
the day's payments and tickets), never an invoice document or image. The keeper deletes decisions
older than `GATE_DECISION_RETENTION_DAYS` (365 by default) hourly. Payments made are kept, because
the duplicate rule reads them. Log roots and what was posted on chain are kept too.

## Settings

| Variable | Where | What |
|---|---|---|
| `GATE_RECEIPT_PRIVATE_KEY` | API | 32-byte hex secp256k1 key that signs receipts. Required for checks |
| `GATE_DECISION_RETENTION_DAYS` | keeper | Days of decision log to keep (default 365) |
| `STRIPE_WEBHOOK_SECRET` | API | Signing secret (`whsec_...`) of the real-time authorization endpoint |
| `STRIPE_EVENTS_WEBHOOK_SECRET` | API | Signing secret of the Issuing events endpoint |
| `STRIPE_API_VERSION` | API | The `Stripe-Version` sent and answered with (default `2026-09-30.endive`) |
| `GATE_ALLOW_LIVE_CREDENTIALS` | API | `true` accepts live Stripe keys and live charges. Off: test mode only. The payout proxy has its own setting of the same name |
| `AGENT_URL_SECRET_KEY` | API | Also encrypts the linked Stripe keys and secrets and the payout links' events secrets; `pnpm secrets:reencrypt` moves them with the rest |
| `GATE_PAYOUT_TEE_URL` | API | The payout proxy's https URL. Unset: the payout routes answer 503 |
| `GATE_PAYOUT_TEE_CODE_HASH` | API | The `CODE_HASH` the proxy's image was built with |
| `GATE_PAYOUT_TEE_COMPOSE_HASHES` | API | Comma-separated compose hashes of the proxy deployments allowed |
| `GATE_PAYOUT_TEE_MEASUREMENTS` | API | Comma-separated measurements of allowed production deployments. Until set, nothing claims staff can't read the credential |
| `GATE_PAYOUT_TEE_LOCAL` | API | `true` only for a mock proxy on this machine (no hardware checks, never a TEE) |
| `GATE_ANCHOR_ADDRESS` | keeper | GateAnchor's address (default: `gateAnchor` in the deployment file, if any). Without it, roots are made and stored, not posted |
| `GATE_ANCHOR_KEY` | keeper | 32-byte hex key that posts; GateAnchor's owner must allow its address with `setPoster`. Needed to post, and needs gas on that chain |
| `GATE_ANCHOR_RPC_URL` | keeper | GateAnchor's chain, when it isn't the protocol's (default `RPC_URL`) |
| `GATE_ANCHOR_MS` | keeper | How often the job runs (default 600000, at least 60000) |

Limits (in `createApi({ gate })`): 600 checks per account per minute, 1,200 API-key requests per
client address per minute, 20 accounts per wallet, 10 live keys per account, 500 vendors per
account. Request bodies are capped at 16 KB like the API's other routes.
