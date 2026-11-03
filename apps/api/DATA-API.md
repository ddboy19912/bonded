# Data APIs

Three APIs on the off-chain rail, next to the payment gate ([GATE.md](GATE.md)):

- **Model risk data**: the Bonded Index as JSON, and webhooks that say when a model's score
  changes.
- **Testing in CI**: rate your agent from CI on every deploy and fail the build when its score is
  under a minimum.
- **Attack data**: the published attack library as a dataset, with labelled traces.

Code: `src/data-keys.ts` (keys and registration), `src/model-risk.ts`, `src/ci-runs.ts`,
`src/attack-data.ts`, `packages/db/src/data-api.ts` (storage, migration `0027_data_apis.sql`).
Tests: `test/data-api.test.ts` and `test/ci-attack-data.test.ts`.

## Keys

Make a data API key with your wallet session (sign in at `POST /self/session`, the same sign-in as
previews, and send `Authorization: Bearer bonded_ss_...`). Send the key as
`Authorization: Bearer bonded_dk_...`. A key is shown once, when it is made; only its SHA-256 is
stored. Revoking it stops it at once, with its webhooks.

| Route | What it does |
|---|---|
| `POST /data/keys` | Make a key: `{ label? }`. 10 live keys per wallet |
| `GET /data/keys` | The wallet's keys (prefix and label, never the key) |
| `DELETE /data/keys/:id` | Revoke a key |
| `GET /data/keys/:id/usage?days=30` | The meter: requests per UTC day and API (`index`, `attacks`, `ci`, `webhooks`) |

Every keyed request is counted. A bad or revoked key is refused (401), even on the public routes.

## Model risk data

Read from `config/bonded-index.json`, which changes with a deploy. Only the fields the Index page
publishes are served, picked one by one.

| Route | Auth | What it returns |
|---|---|---|
| `GET /data/index` | None, or a key | Every model's headline: Security score and interval, Task score, dollars at risk per 1,000 runs, library version, ran-at date. Plus the Index's `updatedAt`, `hash` (SHA-256 of the file) and the current `offchainLibraryVersion` |
| `GET /data/index/models/:slug` | None, or a key | One model in full: the above, failures by attack class and by channel (each briefing and in all), breaches by type, dollars at risk with its assumptions, each briefing's counts. `:slug` is the last part of the model id, as on the site (`/index/<slug>`) |
| `POST /data/webhooks` | Key | Register `{ url, models? }` (model ids or slugs; none for every model). Returns the signing secret once. 5 per key |
| `GET /data/webhooks` | Key | The key's webhooks (URL masked, never the secret) |
| `GET /data/webhooks/:id/deliveries` | Key | The latest deliveries: status, attempts, last answer, next try |
| `DELETE /data/webhooks/:id` | Key | Remove a webhook |

Limits: 60 Index requests per address per 10 minutes without a key; 1,200 per key per 10 minutes
with one. Webhook changes: 30 per key per 10 minutes.

### Webhooks

The keeper compares the Index with the last one it saw every `INDEX_WEBHOOKS_MS` (default 30 s).
The first one it sees is the baseline. After that, a model added, removed, or whose Security or
Task score moved is one change; a re-run with the same scores is not. Each change is sent once
per webhook as a `POST`:

```json
{ "id": "index:<hash>:muse-spark-1.3", "type": "index.score_changed", "change": "changed",
  "model": "muse-spark-1.3", "label": "Muse Spark 1.3",
  "before": { "securityScore": 96, "securityInterval": [87, 99], "taskScore": 29, "libraryVersion": 1, "ranAt": "..." },
  "after": { "securityScore": 89, "...": "..." },
  "index": { "hash": "...", "previous": "...", "updatedAt": "..." },
  "url": "/data/index/models/muse-spark-1.3", "sentAt": "..." }
```

Headers: `bonded-event-id` (the change's id; use it to drop repeats), `bonded-timestamp` (Unix
seconds) and `bonded-signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`, the same
scheme as Agent URL calls and notification webhooks. To check one: compute the HMAC over the raw
body with your secret, compare in constant time, and refuse a timestamp more than 5 minutes off:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function fromBonded(secret, rawBody, headers) {
  const ts = Number(headers["bonded-timestamp"]);
  if (!Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const expected = Buffer.from(`v1=${createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex")}`);
  const got = Buffer.from(headers["bonded-signature"] ?? "");
  return got.length === expected.length && timingSafeEqual(got, expected);
}
```

Answer with any 2xx within 10 seconds. Anything else is tried again after 1 minute, 5 minutes,
30 minutes, 2 hours and 12 hours, then marked failed. Webhooks need `AGENT_URL_SECRET_KEY` on the
service (the secret is stored encrypted with it); without it they are refused.

## Testing in CI

A CI run is a preview rating of your own preview: the same flow as **Start preview rating** on the
[Test your agent](https://www.bondedhq.xyz/agents/test) page, with the same connection check, the
same caps and the same costs. Set it up once on the page: make a preview that connects by **Agent
URL**, give your agent its secret and verify the URL. Then pass that preview's id from CI.

| Route | Auth | What it does |
|---|---|---|
| `POST /ci/runs` | Key | Start a run: `{ previewId, minScore, minTaskScore?, label? }`. Starts the preview's connection check, or its rating if a check of this connection passed in the last 24 hours. Returns `202` with the run |
| `GET /ci/runs/:id` | Key | The run, moved on as far as it has got. Poll until `done` |
| `GET /ci/runs/:id/report` | Key | The preview report once the rating is done (`202` before). Labelled "Preview: not on chain, not insurable" |
| `GET /ci/runs` | Key | The wallet's runs, newest first: `?limit=`, `?before=<runId>` |

A run's `status` is `checking`, `rating`, then `passed`, `failed` (under the minimum) or `error`
(the check failed, a cap refused the rating, or the rating stopped; `reason` says which). `result`
is `"pass"` only when the Bonded Score is at or over `minScore`, and the Task score at or over
`minTaskScore` when one is given. Runs and reports are visible to the keys of the wallet that owns
the preview, and "not found" to anyone else.

Limits: 20 runs per key per hour, and the preview caps (`PREVIEW_PER_WALLET_DAILY`, default 1
rating per wallet per day; `PREVIEW_DAILY` in all). A rating takes as long as a preview does (up to
45 minutes with today's library), so poll every 30 seconds or so.

```yaml
# .github/workflows/bonded.yml
name: Bonded rating
on:
  deployment_status:
jobs:
  rate:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - name: Rate the agent and fail under the minimum
        env:
          BONDED_API: https://api-production-ba50.up.railway.app
          BONDED_KEY: ${{ secrets.BONDED_DATA_API_KEY }}
          PREVIEW_ID: ${{ vars.BONDED_PREVIEW_ID }}
        run: |
          run=$(curl -sf -X POST "$BONDED_API/ci/runs" \
            -H "Authorization: Bearer $BONDED_KEY" -H "Content-Type: application/json" \
            -d "{\"previewId\":\"$PREVIEW_ID\",\"minScore\":70,\"label\":\"$GITHUB_SHA\"}")
          url=$(echo "$run" | jq -r .statusUrl)
          while :; do
            sleep 30
            run=$(curl -sf "$BONDED_API$url" -H "Authorization: Bearer $BONDED_KEY")
            [ "$(echo "$run" | jq -r .done)" = "true" ] && break
          done
          echo "$run" | jq '{status, score, taskScore, reason, reportUrl}'
          [ "$(echo "$run" | jq -r .result)" = "pass" ]
```

## Attack data

| Route | Auth | What it returns |
|---|---|---|
| `GET /data/attacks` | Key | The library as one dataset: each on-chain attack (`attacks/`, the whole published spec) and each off-chain seed (`apps/arena/offchain-seeds/`: what it plants, its class, vectors and aims, its file's SHA-256, and for each invoice picture its SHA-256 and, for a Muse Image forgery, its metadata). `?rail=onchain\|offchain`, `?class=A4\|O1` |
| `GET /data/attacks/traces` | Key | Labelled traces: the on-chain episodes of library attacks still on record, newest first, each labelled `breach` or `held`, with its detail as `GET /episodes/:id` shows it. `?page=`, `?limit=` (up to 50), `?through=` (the snapshot from the first page), `?attack=<id>` |

Limits: 60 exports and 600 trace pages per key per hour.

Library attacks only. Held-out attacks, staged and generated seeds, fresh variants (including
the Index's variants) and anything under the ignored `datasets/` and `ratings/` folders are never
in it. Only the two library folders are read; ids that name a variant or a held-out attack are
dropped; and every answer is checked against the database's held-out ids and payload hashes
before it is sent, and refused (503) if it names one. Off-chain traces are not published, so
none are served.
