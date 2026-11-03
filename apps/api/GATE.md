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
chain) and `apps/web/src/pages/Gate.tsx` (the rules page). Tests: `test/gate.test.ts`,
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
| `GET`, `POST /gate/accounts/:id/vendors`, `PUT`, `DELETE .../vendors/:vendorId` | The vendor master: `{ id, name, account }`, each vendor's verified account |
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

`kind` defaults to `invoice`. `requestId` is optional: the same id again returns the first decision
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

The rules page in the web app (`/gate`, signed in with the owner's wallet) shows the mandate in
plain words, its vendors, every version with its hash, and the decision log. Its Verify button
runs these checks, and the log root check below, in the browser.

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

## Storage and retention

Tables: `gate_accounts`, `gate_mandates`, `gate_api_keys`, `gate_vendors`, `gate_invoices`,
`gate_refunds`, `gate_tickets`, `gate_payments`, `gate_decisions`, `gate_usage_daily`, and
`gate_log_roots` (migration 0026). Amounts are whole cents.

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
| `GATE_ANCHOR_ADDRESS` | keeper | GateAnchor's address (default: `gateAnchor` in the deployment file, if any). Without it, roots are made and stored, not posted |
| `GATE_ANCHOR_KEY` | keeper | 32-byte hex key that posts; GateAnchor's owner must allow its address with `setPoster`. Needed to post, and needs gas on that chain |
| `GATE_ANCHOR_RPC_URL` | keeper | GateAnchor's chain, when it isn't the protocol's (default `RPC_URL`) |
| `GATE_ANCHOR_MS` | keeper | How often the job runs (default 600000, at least 60000) |

Limits (in `createApi({ gate })`): 600 checks per account per minute, 1,200 API-key requests per
client address per minute, 20 accounts per wallet, 10 live keys per account, 500 vendors per
account. Request bodies are capped at 16 KB like the API's other routes.
