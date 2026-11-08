# TEE custody: running an agent in a confidential VM

The hardened agent can run inside a Phala Cloud confidential VM. The VM's hardware vouches for which code is running, and the agent's keys are made inside it. The Arena checks that proof and puts a measurement in the score, and the agent profile shows a "TEE" badge.

Some steps below need a Phala account. Nothing here puts a secret in the repository.

## What is in the repository

| Piece | Where |
|---|---|
| The service that runs in the VM | `services/tee-agent/` |
| Its image and compose file | `services/tee-agent/Dockerfile`, `docker-compose.yml` |
| Verification in the Arena | `apps/arena/src/tee.ts`, `rate --tee-url` |
| The badge | `apps/web/src/pages/Agent.tsx` |

The service has two routes: `GET /health` and `GET /attestation?nonce=<32 bytes hex>`. It has no route that signs or returns a key.

## Try it locally (no hardware)

```bash
docker compose -f services/tee-agent/docker-compose.local.yml up --build
```

```bash
curl localhost:8080/health
```

This runs with `TEE_BACKEND=mock`. The answer looks right, but the "quote" is not a TDX quote, so the Arena refuses it. This only checks the wiring.

## Deploy to Phala Cloud

You need the `phala` CLI logged in to your account (`phala login`) and a registry the VM can pull from. These steps use GitHub Container Registry; the image must be public or you must give Phala pull access.

**1. Pick the code hash.** It is the `codeHash` you give the Arena when rating the hardened agent (`--code-hash`, or `codeHash` in the agent's config). Use the same value everywhere.

**2. Build and push the image, then pin it.** From the repository root:

```bash
docker build --platform linux/amd64 -f services/tee-agent/Dockerfile --build-arg CODE_HASH=0x<64 hex digits> -t ghcr.io/<you>/bonded-tee-agent:<tag> .
```

```bash
docker push ghcr.io/<you>/bonded-tee-agent:<tag>
```

Phala Cloud runs x86 machines, so the image must be built for `linux/amd64` (an Apple Silicon Mac builds ARM images by default, and those fail to start). `docker push` prints a `sha256:` digest. Put it in `services/tee-agent/docker-compose.yml`, replacing `REPLACE_WITH_DIGEST`. Always pin the digest. A tag can be moved, and the digest is what the hardware measures.

**3. Deploy.**

```bash
phala deploy --name bonded-tee-agent --compose services/tee-agent/docker-compose.yml --instance-type tdx.small --no-dev-os --wait
```

**Always pass `--no-dev-os`.** The CLI finds your SSH key and otherwise deploys a dev OS image, which allows SSH into the VM, so the operator could read the agent's keys. `phala cvms get <name>` must show `Dstack: dstack-0.5.9` without `dev`. The Arena does not reject dev images yet, so this is on you.

Find the app's URL with `phala cvms get <name> --json` (the `endpoints` entry, `https://<app-id>-8080.<gateway>`). Check it:

```bash
curl https://<that-url>/health
```

`backend` must say `dstack`. It prints the agent's two public keys.

**4. Get the compose hash, and check it yourself.** Download the app-compose manifest Phala built from your file (the app's Attestations page in the Phala dashboard shows it, and `phala runtime-config <name>` prints the runtime configuration), then compute its hash locally. Do not copy the hash from the agent's own answer: that is the thing being checked.

```bash
pnpm --filter @bonded/tee-agent build
```

```bash
pnpm --filter @bonded/tee-agent compose-hash path/to/app-compose.json
```

`phala cvms get <name> --json` has a `compose_file` field. Save it as a file and pass that file. The tool drops the null fields and empty `init_script` that Phala's API adds, so the hash is the one the hardware measures. The value must also equal the `compose_hash` Phala reports and the `composeHash` in `curl <url>/attestation?nonce=0x<64 hex>` and the compose hash Phala shows for the app. If they differ, stop.

**5. Rate with the TEE.** From the repository root:

```bash
pnpm arena rate --agent hardened --enforce --code-hash 0x<code hash> --tee-url https://<that-url> --tee-compose-hash 0x<compose hash>
```

The Arena sends a random challenge, verifies the quote with Intel's collateral, and prints `TEE verified: measurement 0x…`. The attestation carries it, and the report has a TEE line. Any failure stops the rating and says why.

**6. Create the TEE agent, then make it live.** The TEE proves its own key. For the score's TEE discount to apply, the vault being insured must be run by that key (the API refuses new cover otherwise). So the TEE needs its own agent and vault.

`pnpm tee:seed` does it. It registers an agent, creates a vault whose execution key is the TEE's EVM key (you stay the guardian and can rotate it), stakes the operator bond, deposits into the vault, and prints the agent's config entry. It signs with `DEPLOYER_PRIVATE_KEY` from your `.env` (never printed) and spends testnet gas. Run it from a checkout that has your `.env`, once the VM has been deployed (the address is the `evmAddress` in `curl <url>/health`, or in the evidence from your last rating; it stays the same across stop and start):

```bash
pnpm tee:seed -- --tee-address 0x<evmAddress> --tee-url https://<that-url> --compose-hash 0x<compose hash> --code-hash 0x<code hash> --dry-run
```

`--dry-run` checks the arguments and sends nothing. Run it again without `--dry-run` to do it. The last line of output is JSON with the agent id, the vault and the config entry. Add `--write-config` to write the entry into the operator agents config.

The TEE service doesn't operate a vault yet (it has no route that sends transactions), so this vault can be rated and quoted but is not traded by the TEE.

Then run a rating through the deployed API with `scripts/rate-live-tee.sh <agent id>`, after the config is deployed. It asks for the API token with no echo, starts the VM, runs the rating, prints the result and **always stops the VM when it ends**. When the score is posted, the agent's page shows the TEE badge.

## Bring your own TEE

Your own agent, running in your own TEE, can be rated with its TEE proven at every episode ([BRING-YOUR-OWN-AGENT.md](BRING-YOUR-OWN-AGENT.md#bring-your-own-tee)). It must be rated in chain mode: in tool mode the tool calls come from the runner, outside the TEE, so the TEE would bind nothing. The checks are the ones above, against your deployment instead of Bonded's:

- **Same platform.** Phala dstack on Intel TDX, booted from an approved production OS image (`APPROVED_OS_IMAGES` in `apps/arena/src/tee.ts`).
- **Same evidence.** Your service answers `GET /attestation?nonce=<32 bytes hex>` with `{ quote, eventLog, composeHash, codeHash, evmAddress, solanaPublicKey?, nonce }`. The quote's report data is `teeReportData` from `@bondedhq/shared`. `solanaPublicKey` is optional, for EVM-only agents. `services/tee-agent` is a working reference to copy.
- **A per-rating Arena key.** The fork keeps the live chain's id, so a transaction signed with your production key in the Arena would be valid on the live chain. So in a rating your TEE signs with a key it derives for that rating:
  - The Arena asks `GET /attestation?nonce=…&purpose=arena&key=<id>`.
  - Your TEE answers with evidence for the derived key, carrying `purpose: "arena"` and the `keyId`, with report data `teeArenaReportData` under its own domain.
  - Bonded's TEE agent derives it from the dstack path `bonded/agent/v1/arena/<id>` (`AgentIdentity.arenaAccount`).
  - Your agent gets the id as `BONDED_TEE_KEY_ID`.
  - A TEE that answers with its production key fails the rating.
- **Your compose hash and code hash.** Register both with your agent (onboarding step 1, "My own agent"), with the TEE's URL. The code hash your TEE reports must be the one you register.
- **A public https URL.** The Arena fetches it under fixed rules: https only, every address the name resolves to must be public (checked when connecting), no redirects, and at most 512 KB per answer.
- **At every episode.** The rating worker challenges the URL before the rating starts, for the production key and for the rating's Arena key. Then each episode carries a fresh nonce: your runner (`--tee-url`) fetches the evidence and forwards it unchanged, and the worker verifies it. Every episode must show the same measurement and Arena key, or the rating fails.
- **Afterwards.** The live checks below apply as they do to Bonded's agent, against the production key. When the measurement changes, new quotes stop, and a re-rating is queued if your runner is connected.

For cover, the vault's (or module's) agent key must be the TEE's attested production key, as for Agent B (agent 2). A TEE-bound score lifts the cover cap for an agent its operator runs from 5,000 to 20,000 tUSDG (underwriting policy).

## What the TEE does to the price

A rating includes a key-custody term. It is an assumption, not a measurement: an operator-held key is assumed more likely to be stolen than a key in a verified TEE, so the same agent rates a little better in a verified TEE. The assumption is stated in the report next to the number.

Ratings through the API use one run per attack unless an agent's config says otherwise, and fewer runs leave a wider uncertainty on every breach rate, so the same agent scores lower. The report lists the episode count, so the number is visible, and it is fixed in the config rather than tuned per rating.

## Live checks

The keeper challenges every agent that has a `tee` entry every ten minutes (`TEE_CHECK_MS`, default 600000) and compares the live measurement with the one in its on-chain score. The profile shows the result as "TEE live check".

- **Offline** (grey): the VM is stopped or not answering. Nothing is blocked because of it. A stopped VM is not a broken one, and it can't leak a key.
- **Changed** or **failed** (red): the running TEE is not the one that was rated, or its proof doesn't verify. The API stops signing new cover quotes for that agent until a check passes again or the agent is re-rated. An outage doesn't clear it. Cover already bound is not touched.

## Pausing it

- Billing is per minute. **Stopping** the VM stops the compute charge at once, and the disk is kept.
- **Stop it when you aren't using it, start it when you need it:**

```bash
phala cvms stop bonded-tee-agent
```

```bash
phala cvms start bonded-tee-agent
```

- After a stop and start the app has the same URL, the same session keys and the same measurement, and its quote verifies again. Allow a couple of minutes after `start` before rating.
- While it is stopped, API rating jobs for an agent with a TEE entry fail by design (no unmeasured score). Start it before running one, or use the script.
- **Deleting** it stops the disk charge too, but a new deployment gets a new app id, so a new URL and new keys. Update the agent's `tee` entry and re-rate.

## Things to know

- **Re-deploying changes the answer.** A new image digest means a new compose hash and a new measurement, so every re-deploy needs a new rating. That is the point: the score belongs to one exact deployment.
- **Phala's OS image counts.** If Phala upgrades the host OS image under your app, MRTD and the RTMRs change and the measurement changes with them.
- **Out-of-date platforms are refused.** Only Intel TCB statuses `UpToDate` and `SWHardeningNeeded` pass.
- **The simulator.** dstack's simulator uses a fixed development key, so the Arena refuses its quotes. Use it for development of the service, not for ratings.
