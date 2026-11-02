# Payment gate API

The hosted check for off-chain payments. An agent asks `POST /payments/check` before it pays an
invoice, sends a refund or changes a vendor's bank account. The API runs the same rules the Arena
rates agents against (`checkInvoicePayment`, `checkRefundPayment` and `isVerifiedChange` in
`packages/shared/src/payment-mandate.ts`) on the gate account's state, applies the account's mode
and freeze, and answers with the decision and a signed receipt.

Code: `src/gate.ts` (routes), `src/gate-check.ts` (the check), `packages/db/src/gate.ts` (storage,
migration `0024_payment_gate.sql`), `packages/shared/src/gate-receipt.ts` (receipts, input and
mandate hashing, offline verification). Tests: `test/gate.test.ts` and
`packages/shared/test/gate-receipt.test.ts`.

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
| `GET`, `POST /gate/accounts/:id/tickets`, `DELETE .../tickets/:itemId` | Verified bank-change tickets: `{ id, vendorId, account, verifiedBy }` |
| `GET`, `POST /gate/accounts/:id/payments` | Payments made; `POST` imports one made before the gate (`{ kind?, account, amountUsd, reference, day }`) so the duplicate and daily rules count it |
| `GET /gate/accounts/:id/decisions`, `.../decisions/:decisionId` | The decision log, as below |
| `GET /gate/accounts/:id/usage?days=30` | The meter: checks per UTC day |

Agent (API key):

| Route | What it does |
|---|---|
| `POST /payments/check` | Check one payment, refund or bank change (below) |
| `GET /payments/decisions` | The decision log, newest first: `?limit=` (1 to 100), `?before=<next>`, `?result=allowed\|blocked\|refused` |
| `GET /payments/decisions/:decisionId` | One decision with its receipt |

Public: `GET /gate/receipt-key` returns the receipt key's address and the EIP-712 domain and types.

## The check

```json
{ "kind": "invoice", "account": "GB29 NWBK 6016 1331 9268 19", "amountUsd": 612.4, "invoiceReference": "NIM-88412", "requestId": "pay-001" }
{ "kind": "refund", "account": "...", "amountUsd": 49.99, "invoiceReference": "R-77" }
{ "kind": "bank_change", "vendorId": "nimbus", "account": "...", "ticket": "FIN-1" }
```

`kind` defaults to `invoice`. `requestId` is optional: the same id again returns the first decision
unchanged (`replayed: true`), so a retry after a timeout can't trip the duplicate rule; the same id
with a different check is refused (409).

The answer always has `decision` (`pass`, `breach`, or `frozen`), `result` (`allowed`, `blocked`
or `refused`), `allowed`, the `rules` broken with their `reasons` in words, `lossUsd` and
`overpaidUsd` (what left, when a breach went out), the mandate version and hash it was checked
against, `input` (exactly what the rules were given) and `receipt`.

- **Enforce** blocks a payment that breaks a rule. **Monitor** lets it through and records it.
- A **frozen** account (after a breach, with `freezeOnBreach`) is refused before the rules run,
  in either mode, until the owner lifts the freeze.
- A payment that goes out is recorded, so later checks see it (duplicates, the day's total).
- A verified bank change (a ticket covers that vendor and account) becomes the vendor's verified
  account and a new mandate version. An unverified one never does, even when Monitor lets it
  through.
- Each check of an account runs in one transaction holding the account's row lock, so two
  checks of the same invoice can't both pass and the day's total is always right.
- The owner is alerted (in-app list, webhook, email, as set in `/self/notifications`) on a block
  (`payment_blocked`), a breach Monitor let through (`payment_breach`) and a freeze
  (`gate_frozen`). The webhook body is `{ type, dedupeKey, gateAccountId, message, code, fix?,
  details?, at }`; each type can be muted like the others.

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
| `unverified_vendor_change` | The merchant has the card's vendor's name but isn't its merchant on file, and no verified ticket covers it. A ticket covers a merchant when its account is `card:<network id>`; the charge then passes and the merchant becomes the vendor's (a new mandate version). The owner changing a merchant on file needs the same ticket |
| `unmatched_invoice` | No approved invoice of that vendor behind the card, an amount other than the invoice's (the mandate pays exact amounts), or a cash or quasi-cash category |
| `duplicate_payment` | The invoice is paid, or held by a charge already approved |
| `over_payment_cap`, `over_daily_cap` | Over the limits; charges approved and still held count toward the day |

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
| Reversal or expiry | The invoice is released (intent `released`); a new card can be issued for it | `.../authorizations/:id/reverse`, `.../authorizations/:id/expire` |
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

## Storage and retention

Tables: `gate_accounts`, `gate_mandates`, `gate_api_keys`, `gate_vendors`, `gate_invoices`,
`gate_refunds`, `gate_tickets`, `gate_payments`, `gate_decisions`, `gate_usage_daily`, and for
the card route `gate_stripe_links`, `gate_card_intents`, `gate_card_authorizations`,
`gate_card_transactions`, `gate_stripe_events` (event ids, kept 30 days). Amounts are whole
cents.

The decision log keeps the record only (rules, amounts, payee account, reference, hashes and the
receipt), never an invoice document or image. The keeper deletes decisions older than
`GATE_DECISION_RETENTION_DAYS` (365 by default) hourly. Payments made are kept, because the
duplicate rule reads them.

## Settings

| Variable | Where | What |
|---|---|---|
| `GATE_RECEIPT_PRIVATE_KEY` | API | 32-byte hex secp256k1 key that signs receipts. Required for checks |
| `GATE_DECISION_RETENTION_DAYS` | keeper | Days of decision log to keep (default 365) |
| `STRIPE_WEBHOOK_SECRET` | API | Signing secret (`whsec_...`) of the real-time authorization endpoint |
| `STRIPE_EVENTS_WEBHOOK_SECRET` | API | Signing secret of the Issuing events endpoint |
| `STRIPE_API_VERSION` | API | The `Stripe-Version` sent and answered with (default `2026-09-30.endive`) |
| `GATE_ALLOW_LIVE_CREDENTIALS` | API | `true` accepts live Stripe keys and live charges. Off: test mode only |
| `AGENT_URL_SECRET_KEY` | API | Also encrypts the linked Stripe keys and secrets; `pnpm secrets:reencrypt` moves them with the rest |

Limits (in `createApi({ gate })`): 600 checks per account per minute, 1,200 API-key requests per
client address per minute, 20 accounts per wallet, 10 live keys per account, 500 vendors per
account. Request bodies are capped at 16 KB like the API's other routes.
