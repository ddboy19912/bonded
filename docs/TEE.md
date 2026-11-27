# TEE custody: running an agent in a confidential VM

An agent's keys can be made and kept inside a Phala Cloud confidential VM (Intel TDX). The VM's hardware vouches for which code is running. The Arena checks that proof and puts a measurement in the score, and the agent's profile shows a "TEE" badge.

This page covers Bonded's reference TEE agent, `services/tee-agent`. To have your own agent's TEE checked in a rating, see [Bring your own TEE](OFFICIAL-RATINGS.md#bring-your-own-tee).

## What the TEE changes

- **The score.** A rating includes a key-custody term. It is an assumption, not a measurement: a key on the operator's server is assumed more likely to be stolen than a key in a verified TEE, so the same agent rates a little better in a verified TEE. The report states the assumption next to the number.
- **Cover.** For the TEE discount to apply, the vault being insured must be run by the TEE's attested key. The API refuses new cover otherwise. A TEE-bound score lifts the cover cap for an agent its operator runs from 5,000 to 20,000 tUSDG.

## The service

The service in the VM has two routes: `GET /health` and `GET /attestation?nonce=<32 bytes hex>`. It has no route that signs or returns a key.

To check the wiring locally, with no TEE hardware:

```bash
docker compose -f services/tee-agent/docker-compose.local.yml up --build
```

```bash
curl localhost:8080/health
```

This runs with `TEE_BACKEND=mock`. The "quote" it returns is not a TDX quote, so the Arena refuses it.

## Deploy to Phala Cloud

You need the `phala` CLI logged in to your account (`phala login`) and a registry the VM can pull from. These steps use GitHub Container Registry. The image must be public, or Phala must have pull access.

1. **Pick the code hash.** This is the `codeHash` you give the Arena when rating the agent (`--code-hash`, or `codeHash` in the agent's config). Use the same value everywhere.

2. **Build and push the image.** From the repository root:

   ```bash
   docker build --platform linux/amd64 -f services/tee-agent/Dockerfile --build-arg CODE_HASH=0x<64 hex digits> -t ghcr.io/<you>/bonded-tee-agent:<tag> .
   ```

   ```bash
   docker push ghcr.io/<you>/bonded-tee-agent:<tag>
   ```

   Phala Cloud runs x86 machines, so build for `linux/amd64`. An Apple Silicon Mac builds ARM images by default, and those fail to start.

3. **Pin the digest.** `docker push` prints a `sha256:` digest. Put it in `services/tee-agent/docker-compose.yml` in place of `REPLACE_WITH_DIGEST`. Always pin the digest: a tag can be moved, and the digest is what the hardware measures.

4. **Deploy.**

   ```bash
   phala deploy --name bonded-tee-agent --compose services/tee-agent/docker-compose.yml --instance-type tdx.small --no-dev-os --wait
   ```

   **Always pass `--no-dev-os`.** Without it, the CLI finds your SSH key and deploys a dev OS image, which allows SSH into the VM, so the operator could read the agent's keys. The Arena refuses dev images. `phala cvms get <name>` must show `Dstack: dstack-0.5.9`, without `dev`.

5. **Check it.** Find the app's URL with `phala cvms get <name> --json` (the `endpoints` entry, `https://<app-id>-8080.<gateway>`), then:

   ```bash
   curl https://<that-url>/health
   ```

   `backend` must say `dstack`. The answer includes the agent's two public keys.

6. **Compute the compose hash yourself.** Don't copy it from the agent's own answer: that is the thing being checked. `phala cvms get <name> --json` has a `compose_file` field. Save it as a file, then:

   ```bash
   pnpm --filter @bonded/tee-agent build
   ```

   ```bash
   pnpm --filter @bonded/tee-agent compose-hash path/to/app-compose.json
   ```

   The tool drops the null fields and empty `init_script` that Phala's API adds, so you get the hash the hardware measures. It must equal the `compose_hash` Phala reports and the `composeHash` in `curl <url>/attestation?nonce=0x<64 hex>`. If they differ, stop.

7. **Rate with the TEE.** From the repository root:

   ```bash
   pnpm arena rate --agent hardened --enforce --code-hash 0x<code hash> --tee-url https://<that-url> --tee-compose-hash 0x<compose hash>
   ```

   The Arena sends a random challenge, verifies the quote with Intel's collateral, and prints `TEE verified: measurement 0x…`. The attestation carries the measurement, and the report has a TEE line. Any failure stops the rating and says why.

## Live checks

Every ten minutes, Bonded challenges each agent that has a TEE and compares the live measurement with the one in its on-chain score. The profile shows the result as "TEE live check".

- **Offline** (grey): the VM is stopped or not answering. Nothing is blocked. A stopped VM is not a broken one, and it can't leak a key.
- **Changed** or **failed** (red): the running TEE is not the one that was rated, or its proof doesn't verify. The API stops signing new cover quotes for that agent until a check passes again or the agent is re-rated. Cover already bound is not affected.

## Stopping and starting the VM

Billing is per minute. Stopping the VM stops the compute charge at once and keeps the disk.

```bash
phala cvms stop bonded-tee-agent
```

```bash
phala cvms start bonded-tee-agent
```

- After a restart, the app keeps the same URL, keys and measurement, and its quote verifies again. Allow a couple of minutes after `start` before rating.
- While the VM is stopped, ratings for an agent with a TEE fail, so a score is never posted without a measurement.
- Deleting the VM stops the disk charge too, but a new deployment gets a new app id, so a new URL and new keys. Update the agent's TEE details and re-rate.

## Things to know

- **Re-deploying changes the measurement.** A new image digest means a new compose hash and a new measurement, so every re-deploy needs a new rating. The score belongs to one exact deployment.
- **Phala's OS image counts.** If Phala upgrades the host OS image under your app, the measurement changes with it.
- **Out-of-date platforms are refused.** Only Intel TCB statuses `UpToDate` and `SWHardeningNeeded` pass.
- **The simulator is for development only.** dstack's simulator uses a fixed development key, so the Arena refuses its quotes.
