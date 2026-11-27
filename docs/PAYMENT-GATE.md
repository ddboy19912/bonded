# Payment gate

The payment gate checks an AI agent's payments against your rules. Before a payment, it answers allowed or blocked, with a receipt signed by Bonded that anyone can check. After a payment, it can record it and alert you to a breach.

The rules are code, not a model, so the same inputs always give the same answer. They are the rules the [Arena](OFFCHAIN.md) rates agents against. Bonded never holds a key that can move money.

Set it up at [app.bondedhq.xyz/gate](https://app.bondedhq.xyz/gate). Check any receipt at [app.bondedhq.xyz/gate/verify](https://app.bondedhq.xyz/gate/verify).

## Three ways to connect

- **Ask first.** Your agent's server asks the gate about each payment, through the [API](#check-a-payment), the [SDK](#with-the-sdk) or an MCP server.
- **Card hooks.** Your [card program](#pay-by-card) asks the gate before every charge.
- **Watch.** Bonded [reads payments after they were made](#watch), from a wallet or your payment log. It records and alerts, but can't stop anything. Use it alone, or next to the other two to catch an agent that skipped the check.

The account's **Connect** tab has the snippets for each.

## Monitor and Enforce

| Mode | A payment that breaks a rule |
|---|---|
| Monitor | goes through, and is logged as a breach |
| Enforce | is blocked |

With **freeze on breach** on, the first breach refuses every check until you lift the freeze on the account's page.

## The rules

| Rule | A payment breaks it when |
|---|---|
| `unknown_payee` | the account is not in the vendor master |
| `unverified_vendor_change` | a vendor's bank account changes with no finance ticket |
| `duplicate_payment` | the invoice was already paid |
| `unmatched_invoice` | no approved invoice matches the vendor, reference and amount |
| `over_payment_cap` | it's over the per-payment limit |
| `over_daily_cap` | it's over the daily limit (days are UTC) |
| `over_hourly_limit` | it's over the payments allowed in any hour (optional) |

Accounts can be bank accounts or wallet addresses. Base58 addresses, such as Solana wallets, are compared case-sensitively; everything else ignores case and spaces.

**Payments with no invoices.** Turn **Match invoices** off on the Rules tab. A payment then needs only a vendor on your list and to stay within your limits. A reference is optional, and is paid to an account only once.

## Set it up

1. Open [app.bondedhq.xyz/gate](https://app.bondedhq.xyz/gate) and sign in with your email, a passkey or a wallet.
2. Make an account and set the per-payment and daily limits. Copy your API key: it's shown once.
3. Add your vendors, each with the bank account on file.
4. Add the invoices you've approved for payment.
5. For each bank change finance has verified (for example, by calling the number on file), open the vendor and add a ticket.
6. Connect your agent, and start in **Monitor**. Switch to **Enforce** when the decisions look right.

## Check a payment

Call the gate from your agent's server just before the payment. Keep the API key on that server.

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

- **An invoice:** `{ "account", "amountUsd", "invoiceReference", "requestId" }`.
- **A refund:** the same, with `"kind": "refund"` and the refund's reference. Add approved refunds with `POST /gate/accounts/:id/refunds`.
- **A bank change:** `{ "kind": "bank_change", "vendorId", "account", "ticket" }`.

**Retries.** The gate counts an allowed payment as made. If your bank call fails and you retry, send the same `requestId` to get the first decision back. Use a new `requestId` for each new payment.

### With the SDK

`paymentGate` in `@bondedhq/sdk` wraps your pay function, so it's only called when the gate allows the payment.

```ts
import { guardPayments, paymentGate } from "@bondedhq/sdk";

const gate = paymentGate({ apiKey: process.env.BONDED_GATE_KEY! });
const payInvoice = guardPayments(bank.payInvoice, { guard: gate });

await payInvoice({ account: "GB29 NWBK 6016 1331 9268 19", amountUsd: 612.4, invoiceReference: "NIM-88412" });
```

It fails closed: if the gate can't be reached, your function isn't called. It checks each receipt's signature and that the receipt is for this payment. A blocked payment throws `PaymentBlockedError`, naming the rules broken. A local guard runs the same rules in your own process instead, with no receipts and no log.

To guard an agent's existing pay tool, pass the gate to its framework's helper. A refused payment goes back to the model as an error.

| Framework | Helper |
|---|---|
| Vercel AI SDK | `guardAiSdkPayTool` from `@bondedhq/sdk/ai-sdk` |
| LangChain, LangGraph | `guardLangChainPayTool` from `@bondedhq/sdk/langchain` |
| An MCP server | `guardMcpPayHandler` from `@bondedhq/sdk/mcp` |
| OpenAI Agents SDK | `guardOpenAiAgentsPayTool` from `@bondedhq/sdk/openai-agents` |
| x402 | `guardX402Client` from `@bondedhq/sdk/x402` |

For x402, turn invoice matching off and add each service's `payTo` address as a vendor. Each payment is checked against a budget for the service before the client signs it, and only USDC prices count ([the SDK's README](../packages/sdk/README.md#x402)).

### Budgets: many small payments to one payee

For payments too small and frequent to check one by one, like $0.001 per API call, the agent asks for a budget instead: for example, $1 for the weather API for the next hour. A budget lasts an hour at most.

1. The gate checks the budget once, with a signed receipt. The payee must be on your list, and the whole budget must fit in what's left of the daily limit.
2. The SDK checks each payment against the budget on the agent's side, with no call to Bonded, and reports it. In Enforce mode, a payment that doesn't fit is blocked.
3. Closing the budget gives a second receipt covering every reported payment. Until then, the whole budget counts toward the daily limit; after, only what was spent.

Watch matches the wallet's payments to the reported ones. A payment the SDK never reported is judged as unchecked, so paying around the SDK doesn't hide it.

### A signer the agent can't skip (x402)

The SDK's x402 check runs inside the agent's process, so code holding the wallet key could pay without it. [`@bondedhq/signer`](../packages/signer/README.md) takes the key away from the agent. You run it on your own server, with the key in your own KMS (AWS or Google) or a key file, and it signs only USDC transfers that fit the payee's budget. Put its address on the Watch tab: a payment the gate never saw then means the key leaked.

## Pay by card

Your agent pays with cards from your own card program: Stripe Issuing, Lithic or Marqeta. Before each charge, the program asks Bonded. If Bonded doesn't answer in time, the charge is declined. Bonded can't make, fund or charge a card.

1. On the account's **Cards** tab, press **Connect a provider** and pick yours.
2. Copy the address Bonded gives you into your provider:
   - **Stripe Issuing:** add a webhook endpoint at the address for `issuing_authorization.request`, pick it for real-time authorizations in your Issuing settings, and set the timeout to decline. Paste the endpoint's signing secret back into Bonded.
   - **Lithic:** enroll the address for Auth Stream Access, and paste your ASA signing secret into Bonded.
   - **Marqeta:** set the address as your Gateway JIT Funding address, with the username and password Bonded shows. The password is shown once.
3. On the **Vendors** tab, give each vendor your agent may pay its card merchant name and ID.

Each charge is checked like a payment with no invoice: the merchant must be a vendor's card merchant, and the limits apply. Cash, money orders and gambling (`blocked_merchant`) are declined in Monitor mode too.

## Watch

Add sources on the account's **Watch** tab:

- **A wallet.** Give a public address. Bonded reads its USDC and USDT payments on Ethereum, Base, Arbitrum and Base Sepolia (USDT on Ethereum and Arbitrum only), from when you added it. It doesn't see native coins such as ETH, or other tokens.
- **Your payment log.** Send what happened, with a gate API key. Bonded can't prove a log, and never sees a payment left out of it.

```bash
curl https://api-production-ba50.up.railway.app/payments/watched \
  -H "Authorization: Bearer $BONDED_GATE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"payments":[{"id":"pay-001","account":"LT12 1000 0111 0100 1000","amountUsd":612.40,"reference":"NIM-88412","paidAt":"2026-11-07T10:00:00Z"}]}'
```

A watched payment that matches a check allowed in the 24 hours before, for the same payee and amount, is marked "Checked first". Any other payment runs through your rules, counts toward your limits, and alerts you if it broke one. With **Expect a check first** on, a payment with no check before it also breaks `skipped_gate`.

Watched payments have no receipt, because Bonded decided nothing before the money left.

## Check a receipt

Anyone can check a receipt, with no sign-in. Paste it at [app.bondedhq.xyz/gate/verify](https://app.bondedhq.xyz/gate/verify): the answer from a check works as it is, or use **Copy receipt** on a decision in the **Activity** tab. The checks run in your browser:

| Check | What it proves |
|---|---|
| Bonded's signature | Bonded made this decision, unchanged |
| Input hash | these are the inputs the rules were given |
| Rules, run again | the same inputs give the same decision |
| Daily log root | the receipt is in that day's log, and the log wasn't rewritten |

The daily log check needs a proof, available once the day has ended (UTC). Press **Verify** on the decision, and **Copy receipt** then includes it. An agent can fetch it from `GET /payments/decisions/:id/proof`.

Each finished day's log root, and the hash of each version of your rules, is posted to GateAnchor on Robinhood Chain testnet at [`0x4434F0D9fEF49EE2E017fb1082C1F3EefABcf5a4`](https://explorer.testnet.chain.robinhood.com/address/0x4434F0D9fEF49EE2E017fb1082C1F3EefABcf5a4). A posted hash can't be changed, so an old decision can't be quietly rewritten. Only hashes go on chain, never payment details.

## Alerts

A blocked payment, a breach that Monitor let through, and a freeze each send an alert to your [inbox](https://app.bondedhq.xyz/inbox). On the **Alerts** tab you can also send them to:

- **Slack:** paste an [incoming webhook](https://api.slack.com/messaging/webhooks) URL.
- **Any webhook:** paste an HTTPS address. Bonded POSTs the alert as JSON, signed with a secret shown once.
- **Email**, when it's turned on for the service.

These settings cover all your gate accounts. Each alert is sent once, so if your webhook is down, it's only in your inbox.

## What it doesn't do

- **Asking first is voluntary.** Code that pays without asking skips the check, so keep the raw pay function out of the agent's reach. Card hooks and the x402 signer close that gap.
- **It doesn't move money or pay back losses.**
- **It can't catch every fraud.** If a real vendor is hacked and a correct invoice is paid to its correct account, no rule breaks.

Every route is in the [gate's API reference](https://github.com/ddboy19912/bonded/blob/main/apps/api/GATE.md).
