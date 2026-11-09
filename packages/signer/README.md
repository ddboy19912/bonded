# @bondedhq/signer

An x402 signer the agent can't get around.

The x402 guard in `@bondedhq/sdk/x402` runs inside the agent's own process, so code that holds the wallet key can sign a payment without it. This signer moves the key out of the agent. You run it on your own server, with the key in your own KMS (or a key file). The agent asks it to sign each x402 payment, and it signs only payments that fit the payee's budget on Bonded's payment gate. Bonded never holds the key.

```
agent (no key) ──"sign this x402 payment"──▶ bonded-signer (your server) ──▶ key in your KMS
                                                   │
                                                   └── budgets ──▶ Bonded's payment gate (signed receipts)
```

## What it signs

Only USDC's signed transfer (`TransferWithAuthorization`, EIP-3009), which x402's `exact` scheme uses on EVM chains, and only when:

- it's from the signer's own address, in USDC on a network it pays on (Base, Ethereum, Arbitrum, Polygon, Avalanche and Base Sepolia by default);
- it stays valid for at most 15 minutes (`BONDED_SIGNER_MAX_VALIDITY_SECONDS`);
- it fits the payee's budget. The first payment to a payee opens a budget with the gate: one check against your rules (vendor list, per-payment and daily limits) and a signed receipt. Later payments count against that budget in exact micro-dollars, with no network call. When the budget is used up or ends, the next payment opens a new one.

Everything else is refused: other typed data, permits, raw hashes, messages and transactions. If a budget has to be opened and the gate can't be reached, nothing is signed.

In Monitor mode a payment that breaks a rule is signed and logged as a breach, as with the in-process guard. Use Enforce mode for a hard stop.

## Set it up

1. **A gate account.** At [bondedhq.xyz/gate](https://www.bondedhq.xyz/gate), turn **Match invoices** off, add each x402 service's `payTo` address as a vendor, set the per-payment and daily limits, and switch to Enforce when the decisions look right. Copy the API key.
2. **A key.** Best: a secp256k1 key in a KMS, so the key can't be copied off the server.
   - AWS: a KMS key with spec `ECC_SECG_P256K1` and usage `SIGN_VERIFY`. Give the signer's role `kms:GetPublicKey` and `kms:Sign` on that key only.
   - Google Cloud: a key with algorithm `EC_SIGN_SECP256K1_SHA256`. Give the signer's service account `cloudkms.cryptoKeyVersions.useToSign` and `cloudkms.cryptoKeyVersions.viewPublicKey` on it only.
   - Or a key file (`0x` and 64 hex digits, `chmod 600`) on a machine the agent can't reach.
3. **Run it** where the agent can't read its files, environment or KMS credentials: its own container, VM or cloud role.

```bash
docker build -f packages/signer/Dockerfile -t bonded-signer .
```

```bash
docker run -p 8402:8402 \
  -e BONDED_GATE_KEY=bonded_gk_... \
  -e BONDED_SIGNER_TOKENS=<a random token of 32+ characters> \
  -e BONDED_SIGNER_AWS_KMS_KEY_ID=alias/agent-payments -e AWS_REGION=us-east-1 \
  bonded-signer
```

Or without Docker: `npx @bondedhq/signer` with the same variables (install `@aws-sdk/client-kms` or `@google-cloud/kms` next to it for a KMS key).

4. **Fund the signer's address** with USDC. It's in the first log line (`"event":"listening"`). It needs no ETH: the x402 facilitator pays the gas.
5. **Watch the address.** Add it on the gate account's Watch tab. Only the signer holds the key, so a payment from it that the gate never saw means the key leaked.

| Variable | |
|---|---|
| `BONDED_GATE_KEY` | required: the gate account's API key |
| `BONDED_SIGNER_TOKENS` | required: tokens agents send, comma separated, each 32+ characters. Give each agent its own |
| `BONDED_SIGNER_AWS_KMS_KEY_ID` (+ `AWS_REGION`) | the key, in AWS KMS |
| `BONDED_SIGNER_GCP_KMS_KEY` | the key, in Google Cloud KMS: `projects/…/cryptoKeyVersions/1` |
| `BONDED_SIGNER_KEY_FILE` | the key, in a file |
| `BONDED_SIGNER_PRIVATE_KEY` | the key itself; for testing only |
| `BONDED_SIGNER_NETWORKS` | CAIP-2 ids, comma separated (default: every network above) |
| `BONDED_SIGNER_MAX_VALIDITY_SECONDS` | longest a signed payment may stay valid (default 900) |
| `BONDED_BUDGET_USD` | each payee's budget (default $1; raised to fit a bigger price) |
| `BONDED_BUDGET_TTL_SECONDS` | how long a budget lasts, 60 to 3,600 (default 3,600) |
| `BONDED_BUDGET_MAX_PAYMENT_USD` | the most one payment may be (default: the gate's per-payment limit) |
| `BONDED_API_URL`, `BONDED_RECEIPT_KEY` | another gate API, and the receipt key to pin |
| `PORT`, `HOST` | default 8402 and 127.0.0.1 (the image uses 0.0.0.0) |

Set exactly one of the four key variables. The signer logs one JSON line per payment it signs or refuses. On SIGTERM it closes its budgets, so their unspent part stops counting toward the day.

## The agent's side

The agent gets a signer object in place of a wallet. It has an address but no key:

```ts
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { remoteX402Signer } from "@bondedhq/sdk/x402";

const signer = await remoteX402Signer({
  url: "http://bonded-signer:8402",
  token: process.env.BONDED_SIGNER_TOKEN!,
});
const client = new x402Client().register("eip155:*", new ExactEvmScheme(signer));
const fetchWithPayment = wrapFetchWithPayment(fetch, client);
```

A refused payment fails the request with a `BondedError` (`SIGNER_REFUSED`, `SIGNER_UNAVAILABLE`, `SIGNER_UNAUTHORIZED` or `INVALID_PAYMENT`), and `isPaymentRefusal` recognizes it. A token can only ask for x402 payments: if one leaks, the most it can do is spend within the budgets. Revoke it by removing it from `BONDED_SIGNER_TOKENS`.

## In your own server

The pieces are exported, to run the signer inside an existing service or with another key:

```ts
import { paymentGate } from "@bondedhq/sdk";
import { awsKms, digestSignerAccount, serveX402Signer, X402Signer } from "@bondedhq/signer";

const signer = new X402Signer({
  account: await digestSignerAccount(await awsKms({ keyId: "alias/agent-payments" })),
  guard: paymentGate({ apiKey: process.env.BONDED_GATE_KEY! }),
  budget: { amountUsd: 1 },
});
await serveX402Signer(signer, { tokens: [process.env.SIGNER_TOKEN!], port: 8402 });
```

- `account` takes anything that signs EIP-712 data: a viem account, `digestSignerAccount` over any KMS or HSM that signs digests (`DigestSigner`), or a wallet provider's viem account.
- `guard` takes the hosted `PaymentGate` or a local `PaymentGuard` from `@bondedhq/sdk`.
- `x402SignerHandler` is the HTTP API as a fetch-style handler, for servers that take web requests.

## HTTP API

| Route | |
|---|---|
| `GET /healthz` | `{ ok: true }`, no token |
| `GET /v1/x402/signer` | `{ address, networks }` |
| `POST /v1/x402/sign` | `{ typedData }` in, `{ signature }` out. 403 `refused`: it breaks the budget, or the gate can't be reached. 400 `invalid`: not a payment this signer signs |

Both `/v1` routes need `Authorization: Bearer <token>`. Serve it over TLS, or on a private network, when the agent is on another machine.

## Limits

- EVM only, x402's `exact` scheme with EIP-3009 tokens (USDC). Not yet: Solana, and Permit2 payments (x402's `upto` scheme).
- The signer doesn't see whether a payment settled. A payment the service turned down stays counted in its budget (the in-process guard takes those back). Budgets are small and short, so this costs at most a little headroom.
- Budgets live in memory. After a restart the next payment opens a new budget; the gate still counts every budget against the day's limit, so a restart can't raise it.
- It stops only what goes through the key. Keep the agent away from the key: no shared file system, environment or cloud role.
