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

To guard an agent's existing pay tool, pass the gate (or the local guard) to the helper for its framework. A refused payment goes back to the model as an error, so it can react:

| Framework | Helper |
|---|---|
| Vercel AI SDK | `guardAiSdkPayTool` from `@bondedhq/sdk/ai-sdk` |
| LangChain, LangGraph | `guardLangChainPayTool` from `@bondedhq/sdk/langchain` |
| An MCP server | `guardMcpPayHandler` from `@bondedhq/sdk/mcp` |
| OpenAI Agents SDK | `guardOpenAiAgentsPayTool` from `@bondedhq/sdk/openai-agents` (from version 0.1.5) |
| x402 | `guardX402Client` from `@bondedhq/sdk/x402` (from version 0.1.5) |

For x402, the gate checks each payment before the x402 client signs it. Turn invoice matching off and add each service's `payTo` address as a vendor. Only USDC prices count, and a price under a cent counts as one cent. Details: [the SDK's README](../packages/sdk/README.md#x402).

## Pay by card

Your agent pays with cards from your own card program: Stripe Issuing, Lithic or Marqeta. Before each charge, the program asks Bonded. In Enforce mode a charge that breaks a rule is declined; in Monitor mode it goes through and is logged as a breach. Bonded holds no key for your program. It can't make, fund or charge a card. If Bonded doesn't answer in time, the charge is declined.

1. On the account's **Cards** tab, press **Connect a provider** and pick yours.
2. Copy the address Bonded gives you into your provider:
   - **Stripe Issuing:** add a webhook endpoint at the address for `issuing_authorization.request`, pick it for real-time authorizations in your Issuing settings, and set the timeout to decline. Paste the endpoint's signing secret back into Bonded.
   - **Lithic:** enroll the address for Auth Stream Access, and paste your ASA signing secret into Bonded.
   - **Marqeta:** set the address as your Gateway JIT Funding address, with the username and password Bonded shows. The password is shown once.
3. On the **Vendors** tab, give each vendor your agent may pay its card merchant name and ID.

Each charge is checked like a payment with no invoice: the merchant must be a vendor's card merchant, and the per-payment, daily and hourly limits apply. Cash, money orders and gambling (`blocked_merchant`) are declined in either mode. Each charge gets a decision and a receipt, like a check, and shows on the activity tab.

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

## Alerts

A blocked payment, a breach Monitor mode let through and a freeze each send an alert. They always go to your [inbox](https://www.bondedhq.xyz/inbox). On the account's Alerts tab you can also send them to:

- **Slack:** paste an [incoming webhook](https://api.slack.com/messaging/webhooks) URL. Bonded sends a plain message.
- **Any webhook:** paste an HTTPS address. Bonded POSTs the alert as JSON, signed with a secret shown once.
- **Email:** when it's on for the service.

These settings cover all your gate accounts and agents. A check refused while the account is frozen sends no alert, because the freeze already did; it's still in the log. Sending is tried once, so if your webhook is down an alert won't reach it, but it stays in the inbox.

## The dashboard

Each gate account shows one log and what's connected to it:

- **Activity** lists every check and every payment seen after it was made, newest first. Each line says "Checked first" or "Seen after", and where it came from: the API, a card, a wallet such as Base USDC, or your payment log. Filter by source, result or rule.
- **Connect** has the SDK, MCP and API snippets for asking first, and how to set up Watch. It also lists your API keys, wallets and payment log, with when each last reported.

The gate can't tell which bank or payment service a check is for, because your code makes that payment, so every check shows as API.

## Watch

Watch is the other way to connect. Bonded reads payments after they were made, so it holds no key and can't stop anything: it can only record and alert. Use it alone, or next to the check so you know when an agent skipped it.

Two sources feed it, on the account's Watch tab:

- **A wallet.** Give a public address. Bonded reads its USDC and USDT payments on Ethereum, Base, Arbitrum and Base Sepolia (USDT on Ethereum and Arbitrum only), starting from when you added it. It doesn't see native coins such as ETH or any other token yet.
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

- **It only sees what your code sends it.** On the check route the check is voluntary: code that pays without asking skips it, so keep the raw pay function out of the agent's reach. Card hooks close that gap for cards: your card provider asks before every charge.
- **It doesn't move money.** Your own bank or payment API makes the payment.
- **It doesn't pay back losses yet.** Cover is on chain today. Off-chain cover is planned.
- **Rules can be followed and fraud can still happen.** If a real vendor's own systems are hacked and a correct invoice is paid to its correct account, no rule breaks.

For every route, see the [gate's API reference](https://github.com/ddboy19912/bonded/blob/main/apps/api/GATE.md).
