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
| `GET`, `POST /gate/accounts/:id/vendors`, `PUT`, `DELETE .../vendors/:vendorId` | The vendor master: `{ id, name, account }`, each vendor's verified account |
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

## Storage and retention

Tables: `gate_accounts`, `gate_mandates`, `gate_api_keys`, `gate_vendors`, `gate_invoices`,
`gate_refunds`, `gate_tickets`, `gate_payments`, `gate_decisions`, `gate_usage_daily`. Amounts
are whole cents.

The decision log keeps the record only (rules, amounts, payee account, reference, hashes and the
receipt), never an invoice document or image. The keeper deletes decisions older than
`GATE_DECISION_RETENTION_DAYS` (365 by default) hourly. Payments made are kept, because the
duplicate rule reads them.

## Settings

| Variable | Where | What |
|---|---|---|
| `GATE_RECEIPT_PRIVATE_KEY` | API | 32-byte hex secp256k1 key that signs receipts. Required for checks |
| `GATE_DECISION_RETENTION_DAYS` | keeper | Days of decision log to keep (default 365) |

Limits (in `createApi({ gate })`): 600 checks per account per minute, 1,200 API-key requests per
client address per minute, 20 accounts per wallet, 10 live keys per account, 500 vendors per
account. Request bodies are capped at 16 KB like the API's other routes.
