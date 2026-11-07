# Payment gate

The payment gate checks an AI agent's payments before they're made. Your agent asks the gate about each payment, and the gate answers allowed or blocked, with a receipt signed by Bonded that anyone can check.

It runs the same rules the [Arena](OFFCHAIN.md) rates agents against. A payment that counted as a breach in a rating is one the gate blocks in Enforce mode, once it has your vendors and invoices. The rules are code, not a model: the same inputs always give the same answer.

Set it up at [bondedhq.xyz/gate](https://www.bondedhq.xyz/gate). Check any receipt at [bondedhq.xyz/gate/verify](https://www.bondedhq.xyz/gate/verify).

## The rules

| Rule | A payment breaks it when |
|---|---|
| `unknown_payee` | the account is not in the vendor master |
| `unverified_vendor_change` | a vendor's bank account changes with no finance ticket |
| `duplicate_payment` | the invoice was already paid |
| `unmatched_invoice` | no approved invoice matches the vendor, reference and amount |
| `over_payment_cap` | it's over the per-payment limit |
| `over_daily_cap` | it's over the daily limit (days are UTC) |

### Payments with no invoices

Not every agent pays invoices. Turn **Match invoices** off on the Rules tab and a payment no longer needs one. It then needs a vendor on your list, and it must stay within your limits. A reference is optional, and a reference is paid to an account only once. Refunds and bank changes work as before.

You can also set a limit on payments per hour:

| Rule | A payment breaks it when |
|---|---|
| `over_hourly_limit` | it's over the number of payments allowed in any hour |

This rule is the gate's own. The Arena doesn't rate agents against it, and a rating doesn't depend on this setting.

Accounts can be bank accounts or wallet addresses. A base58 address such as a Solana wallet keeps its case when compared; everything else compares in any case, without spaces.

## Set it up

You need a wallet to sign in. Signing costs no gas.

1. Open [bondedhq.xyz/gate](https://www.bondedhq.xyz/gate), sign in and make an account. Set the per-payment and daily limits. Your API key is shown once, so copy it.
2. Add your vendors, each with the bank account on file.
3. Add the invoices you've approved for payment.
4. Open a vendor to add a ticket for each bank change finance has verified, for example by calling the number on file.
5. Start in **Monitor**, then switch to **Enforce** when the decisions look right.

| Mode | A payment that breaks a rule |
|---|---|
| Monitor | goes through, and is logged as a breach |
| Enforce | is blocked |

With **freeze on breach** on, the first breach refuses every check until you lift the freeze on the account's page.

## Check a payment

Call the gate from your agent's server, just before the payment, and keep the API key there too.

```bash
curl https://api-production-ba50.up.railway.app/payments/check \
  -H "Authorization: Bearer $BONDED_GATE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"account":"LT12 1000 0111 0100 1000","amountUsd":612.40,"invoiceReference":"NIM-88412","requestId":"pay-001"}'
```

The answer, shortened:

```json
{
  "decision": "breach",
  "result": "blocked",
  "allowed": false,
  "message": "Blocked: the account is not in the vendor master; no approved invoice matches.",
  "rules": ["unknown_payee", "unmatched_invoice"],
  "receipt": { "receipt": { "...": "..." }, "signer": "0x...", "signature": "0x..." },
  "input": { "...": "..." }
}
```

Pay only when `allowed` is true. Treat any error or timeout as a no.

| Check | Body |
|---|---|
| An invoice | `{ "account", "amountUsd", "invoiceReference", "requestId" }` |
| A refund | the same, with `"kind": "refund"` and the refund's reference. Add approved refunds with `POST /gate/accounts/:id/refunds` |
| A bank change | `{ "kind": "bank_change", "vendorId", "account", "ticket" }` |

**Retries.** The gate counts an allowed payment as made. If your bank call fails and you try again, send the same `requestId`: you get the first decision back, not a duplicate breach. Use a new `requestId` for each new payment.

## With the SDK

`paymentGate` is in `@bondedhq/sdk` from version 0.1.4. It wraps your pay function so it's only called when the gate allows the payment.

```ts
import { guardPayments, paymentGate } from "@bondedhq/sdk";

const gate = paymentGate({ apiKey: process.env.BONDED_GATE_KEY! });
const payInvoice = guardPayments(bank.payInvoice, { guard: gate });

await payInvoice({ account: "GB29 NWBK 6016 1331 9268 19", amountUsd: 612.4, invoiceReference: "NIM-88412" });
```

It fails closed, so if the gate can't be reached your function isn't called. It also checks each receipt's signature, and that the receipt is for the payment you asked about. A blocked payment throws `PaymentBlockedError`, naming the rules broken.

The SDK also has a local guard that runs the same rules inside your own process, so invoices never leave your system. It makes no receipts and no log.

## Pay by card

On the check route your code decides whether to obey the answer. On the card route it doesn't: the agent pays with a single-use Stripe Issuing card, Stripe asks the gate before every charge, and a charge that breaks a rule is declined. If the gate doesn't answer in time, the charge is declined. This route runs in Stripe test mode only for now.

1. In Stripe, in test mode, make a cardholder, top up the Issuing balance, and make a restricted key with write access to Issuing cards and read access to Issuing authorizations and transactions.
2. Set Stripe's real-time authorizations endpoint to `https://api-production-ba50.up.railway.app/stripe/issuing/authorization`, with the timeout set to decline and Autopilot off.
3. Add a webhook endpoint at `https://api-production-ba50.up.railway.app/stripe/issuing/events` for `issuing_authorization.created`, `issuing_authorization.updated` and `issuing_transaction.created`.
4. On the account's **Cards** tab, press **Link Stripe** and fill in the key, the cardholder and both signing secrets.
5. Add the vendor with its card merchant name and network id, and approve its invoice.

Your agent then asks for a card for that invoice:

```bash
curl https://api-production-ba50.up.railway.app/payments/intents \
  -H "Authorization: Bearer $BONDED_GATE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"invoiceReference":"NIM-88412"}'
```

The card works once, for the exact invoice amount, at that vendor's merchant. Its number is in this answer only. Bonded keeps the card's id and last four digits, and never holds money. Each charge gets a decision and a receipt, like a check.

## Check a receipt

Anyone holding a receipt can check it, with no sign-in. Paste it at [bondedhq.xyz/gate/verify](https://www.bondedhq.xyz/gate/verify): the answer from a check works as it is, or open a decision on the account's **Activity** tab and use **Copy receipt**. The checks run in the browser:

| Check | What it proves |
|---|---|
| Bonded's signature | Bonded made this decision, and it hasn't been changed |
| Input hash | these are the inputs the rules were given |
| Rules, run again | the same inputs give the same decision |
| Daily log root | the receipt is in that day's log, and the log wasn't rewritten |

The last check needs a proof, which exists once the day has ended (UTC). Press Verify on the decision first, and **Copy receipt** then includes it. An agent can fetch one from `GET /payments/decisions/:id/proof`.

## On chain

Each finished day's log root, and the hash of each version of your rules, is posted to GateAnchor on Robinhood Chain testnet at [`0x4434F0D9fEF49EE2E017fb1082C1F3EefABcf5a4`](https://explorer.testnet.chain.robinhood.com/address/0x4434F0D9fEF49EE2E017fb1082C1F3EefABcf5a4). A posted hash can't be changed, so an old decision can't quietly be rewritten. Only hashes go on chain: no payment details.

## Watch

Watch is the other way to connect. Bonded reads payments after they were made, so it holds no key and can't stop anything: it can only record and alert. Use it alone, or next to the check so you know when an agent skipped it.

Two sources feed it, on the account's Watch tab:

- **A wallet.** Give a public address. Bonded reads its USDC and USDT payments on the chains the service has set up, starting from when you added it. It doesn't see native coins such as ETH or any other token yet.
- **Your payment log.** Send what happened, with a gate API key:

```bash
curl https://api-production-ba50.up.railway.app/payments/watched \
  -H "Authorization: Bearer $BONDED_GATE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"payments":[{"id":"pay-001","account":"LT12 1000 0111 0100 1000","amountUsd":612.40,"reference":"NIM-88412","paidAt":"2026-11-07T10:00:00Z"}]}'
```

A log is what you tell Bonded. Bonded can't prove it, and a payment left out of it is never seen. Sending the same `id` again records nothing.

Each payment goes one of two ways:

- **It matches an earlier check** with the same payee and amount, allowed in the 24 hours before: it's marked "Checked first". The check already judged it.
- **It doesn't:** it runs through your rules, counts toward your limits, and you get an alert if it broke one. Turn on **Expect a check first** and a payment with no check before it also breaks `skipped_gate`. A wallet that never uses the check should leave this off.

A freeze set on the account applies here too, but it only refuses later checks. It can't stop a payment on your wallet or bank.

Watched payments have no receipt and stay out of the decision log, because Bonded decided nothing before the money left.

## What it doesn't do

- **It only sees what your code sends it.** On the check route the check is voluntary: code that pays without asking skips it, so keep the raw pay function out of the agent's reach. The card route closes that gap, in Stripe test mode for now. The bank payout route is built, but not live yet.
- **It doesn't move money.** Your own bank or payment API makes the payment.
- **It doesn't pay back losses yet.** Cover is on chain today. Off-chain cover is planned.
- **Rules can be followed and fraud can still happen.** If a real vendor's own systems are hacked and a correct invoice is paid to its correct account, no rule breaks.

For every route, see the [gate's API reference](https://github.com/ddboy19912/bonded/blob/main/apps/api/GATE.md).
