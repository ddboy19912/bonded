# Payout proxy

The payment gate's payout proxy: a small service in a Phala Cloud confidential VM that holds
nothing but its own keys, and opens a gate account's payout credential (sealed to it) only to pay
out what a gate receipt allows. How the gate uses it: `apps/api/GATE.md`, "The payout route". How
TEE custody works in Bonded: `docs/TEE.md`.

## What it does

| Route | What |
|---|---|
| `GET /health` | Its code hash, keys, the gate receipt address it obeys, and whether it accepts live keys |
| `GET /attestation?nonce=<32 bytes hex>` | Fresh TDX evidence committing to its code, its EVM key and the nonce |
| `GET /seal-key` | Its P-256 seal key, signed by its EVM key |
| `POST /payouts` | Pay one gate decision (a signed receipt, the destination and the sealed credential) |
| `POST /payouts/lookup` | Read one payout from Stripe, for a lookup the gate signed |
| `POST /credentials/check` | Whether a sealed credential opens and is acceptable; its hint |

It pays only when the receipt is signed by `GATE_RECEIPT_ADDRESS`, says `allowed`, is an invoice
or refund, is under `PAYOUT_MAX_RECEIPT_AGE_SECONDS` (600) old, wasn't paid before, and names
exactly the destination asked for. The amount and reference come from the receipt. It refuses live
keys unless its own `GATE_ALLOW_LIVE_CREDENTIALS` is `true`, which stays `false` until the founder
has legal advice. It never returns, logs or stores a credential; paid decision ids are kept in
`PAYOUT_LEDGER_PATH` so a restart doesn't forget them.

## Run it locally (no hardware, no money)

```bash
GATE_RECEIPT_ADDRESS=0x<your local API's receipt address> docker compose -f services/payout-proxy/docker-compose.local.yml up --build
```

This runs `TEE_BACKEND=mock` with `PAYOUT_PROVIDER=fake`: nothing is paid, and its "quote" is not
a TDX quote. The API accepts it only with `GATE_PAYOUT_TEE_LOCAL=true` and a loopback
`GATE_PAYOUT_TEE_URL` (`http://127.0.0.1:8080`, with `GATE_PAYOUT_TEE_CODE_HASH` set to
`0x00…01`, the local build's code hash), and then never claims it is a TEE.

Tests: `pnpm --filter @bonded/payout-proxy test`, and the API's `test/gate-payout.test.ts`.

## Deploy to Phala Cloud (founder)

You need the `phala` CLI logged in (`phala login`) and a registry the VM can pull from (these
steps use GitHub Container Registry). Nothing here puts a secret in the repository: the proxy
holds no secret of its own until an owner links a payout account.

**1. Pick the code hash.** Any 32-byte value you'll keep for this build, for example the commit
it is built from, padded: `0x<64 hex digits>`. It is `GATE_PAYOUT_TEE_CODE_HASH` on the API.

**2. Build for linux/amd64, push, pin the digest.** From the repository root:

```bash
docker build --platform linux/amd64 -f services/payout-proxy/Dockerfile --build-arg CODE_HASH=0x<64 hex digits> -t ghcr.io/<you>/bonded-payout-proxy:<tag> .
```

```bash
docker push ghcr.io/<you>/bonded-payout-proxy:<tag>
```

Put the `sha256:` digest `docker push` printed in `docker-compose.yml` in place of
`REPLACE_WITH_DIGEST`. Always the digest, never a tag: the digest is what the hardware measures.

**3. Set the receipt address.** In `docker-compose.yml`, replace `REPLACE_WITH_RECEIPT_ADDRESS`
with the address `curl https://<api host>/gate/receipt-key` shows. Leave
`GATE_ALLOW_LIVE_CREDENTIALS: "false"`. Everything in this file is measured, so these settings
can't be changed without changing the compose hash.

**4. Deploy, always with `--no-dev-os`.**

```bash
phala deploy --name bonded-payout-proxy --compose services/payout-proxy/docker-compose.yml --instance-type tdx.small --no-dev-os --wait
```

Without `--no-dev-os` the CLI deploys a dev OS image, which allows SSH into the VM: the operator
could read every credential it opens. The gate API refuses a dev image anyway, but check it
yourself: `phala cvms get bonded-payout-proxy` must show `Dstack: dstack-0.5.9` without `dev`.

**5. Get the compose hash and check it yourself.** Save the `compose_file` field of
`phala cvms get bonded-payout-proxy --json` as a file, then:

```bash
pnpm --filter @bonded/tee-agent build
```

```bash
pnpm --filter @bonded/tee-agent compose-hash path/to/app-compose.json
```

It must equal the compose hash Phala shows for the app and `composeHash` in
`curl https://<proxy url>/attestation?nonce=0x<64 hex>`. If they differ, stop. The proxy's URL is
the `endpoints` entry of `phala cvms get bonded-payout-proxy --json`
(`https://<app-id>-8080.<gateway>`); `curl <url>/health` must say `backend: dstack`.

**6. Configure the API** (its host settings, not the repository):

| Variable | Value |
|---|---|
| `GATE_PAYOUT_TEE_URL` | the proxy's URL |
| `GATE_PAYOUT_TEE_CODE_HASH` | the code hash from step 1 |
| `GATE_PAYOUT_TEE_COMPOSE_HASHES` | the compose hash from step 5 |

Redeploy the API, then `curl https://<api host>/gate/payout-proxy`. It verifies the proxy's quote
with Intel's collateral and shows `measurement`, with `production: false`.

**7. Allow the production measurement.** Once steps 4 and 5 checked out (production OS, pinned
image and compose file), set `GATE_PAYOUT_TEE_MEASUREMENTS` to that `measurement` and redeploy the
API. Only now does the API say Bonded staff can't read the credential (`production: true`).

**8. Stripe.** Set up the sandbox as `apps/api/GATE.md` lists ("Stripe settings the founder sets"
under the payout route), then link a gate account with `PUT /gate/accounts/:id/payout-link`.

## Re-deploying

A new image or compose file is a new compose hash and measurement: add them to the API's lists
(the compose hash first, the measurement once checked) before or with the change, or the API
refuses the proxy. dstack derives the proxy's keys from the app's identity, so a new app (a fresh
`phala deploy`, or one deleted and made again) has a new seal key, and every gate account must
relink its payout account: its credential was sealed to the old key, and the API answers 409
until then. Stopping and starting the same app keeps its keys, URL and measurement.

```bash
phala cvms stop bonded-payout-proxy
```

```bash
phala cvms start bonded-payout-proxy
```

While it is stopped, the payout route answers 503 and nothing is paid: the gate fails closed.
