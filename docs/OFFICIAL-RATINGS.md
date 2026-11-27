# Official ratings

An official rating is attested: the attester signs the score and posts it to the registry on chain, and cover can be quoted from it. Start with a free preview ([PREVIEWS-AND-RATINGS.md](PREVIEWS-AND-RATINGS.md)).

## From the web app

### 1. Onboard your agent

Go to [app.bondedhq.xyz/agents/new](https://app.bondedhq.xyz/agents/new), or press **Make it official** on a preview's report.

1. In **What gets rated**, choose **My own agent: any framework or language, where it already runs**.
2. Say which framework your agent uses and where it runs (**On my computer or server** for the runner, **On a host like Vercel** for an Agent URL).
3. Under **Advanced (optional)**, you can set:
   - how it acts, **Tools** or **Chain**;
   - a code hash, needed only for a TEE-bound agent (the one its TEE reports) or to pin your own (an image digest `sha256:…`, or 32 bytes of hex). Otherwise each rating records the code reported ([The code hash fills itself in](CONNECTING-YOUR-AGENT.md#the-code-hash-fills-itself-in));
   - a TEE URL and compose hash (chain mode, runner only).
4. Set the mandate (below), create a vault or choose a module, and **stake an operator bond**.
5. Sign the registration in your wallet. The mandate must match the vault's on-chain one exactly.

**The suggested mandate.** From a preview, the page suggests a mandate based on what your agent traded. Both presets use Enforce mode, the exchange only, no recipients, and freeze on breach:

- **Conservative trader** (recommended): only the tokens it was seen trading, a per-trade cap of 1.25 times its largest trade (rounded up to $100), and a daily cap of 4 times that.
- **Active trader:** every market token, 2 times the largest trade per trade, and 10 times that a day.

With no trade seen, the per-trade cap starts at $5,000: set it yourself. It is a starting point from a few episodes, not a measurement of what your agent needs.

**The bond** is your own stake. It pays first on a claim against the agent's cover, so you lose it only when your agent breaks its mandate and someone is paid for it. The page shows the minimum for the cover you want.

**Your wallet.** The page can add Robinhood Chain testnet to your wallet and links to test-ETH faucets. Test tUSDG for the bond and deposit is minted for you. A wallet that supports batched calls (EIP-5792) confirms a vault's 7 transactions in 3 steps, a module's 4 in 2.

### 2. Connect your agent

In onboarding's last step, or later under **Connect your agent** on the agent's page, verify its Agent URL or create a runner token and start the runner. The token (`bonded_rt_...`) is shown once; a new one replaces the old, and **Revoke the runner token** disconnects the runner. A preview's token and Agent URL don't carry over. The page shows the runner's status, and why a connected runner doesn't count (for example, the wrong mode).

### 3. Check and rate

Run the connection check ([The connection check](CONNECTING-YOUR-AGENT.md#the-connection-check)), then press **Rate my agent**. A rating needs a reachable agent, a passing check of this connection in the last 24 hours, a code hash (declared or reported) and a staked bond.

What a rating runs:

- every published attack three times, plus a held-out set made for this rating alone;
- 6 control episodes and 16 benign twins, shuffled in among the attacks;
- up to 172 episodes, 90 seconds each, within 3 hours in all.

The page shows the episode count, time budget and an estimate first, then progress. Every attempt, failed ones included, stays in the agent's history.

**Limits.** Each agent can be rated once an hour and twice a day, and each owner three times a day across their agents. Every official rating counts: the ones you ask for, renewals, and re-ratings after a TEE change.

**When a rating stops.** A rating stops for good at the first episode your agent fails (it crashed, timed out, or the runner or URL went away). Then:

- the current score is superseded: it stays on chain until it expires, but no new cover is quoted until a complete rating posts. Cover already bought is not touched;
- a cooldown starts: 1 hour, doubling with each stop in a row, up to 48 hours.

A stop that isn't your agent's doing is retried and doesn't count against you.

### 4. Use your vault

On the agent's page, pick your framework. It shows the one line that sends your agent's trades through the vault (the same change `init` makes), with the vault's address in `BONDED_VAULT_ADDRESS`. A rating tests the agent; only trades through the vault are protected and covered ([PROTECT-YOUR-AGENT.md](PROTECT-YOUR-AGENT.md)).

### 5. Buy cover

Buy cover from the vault page, within the cover cap for the score's binding ([Binding levels](#binding-levels)).

- **Cover pays for** losses from your agent breaking its mandate: a manipulated, malfunctioning or compromised agent making a trade or transfer the mandate doesn't allow.
- **It doesn't pay for** market losses within the rules, your own keys being stolen, bugs in other contracts, or, on a module, losses found only later.

The page shows the yearly premium and a recommended amount within what the vault holds and the caps. If the agent hasn't traded through its vault in the last 7 days, it warns that cover pays only for what goes through the vault.

## Binding levels

Only a TEE binds the score to the code that trades in production. A declared score says what your code did in the Arena; you could run different code afterwards, so its cover is capped lower.

**Declared**

- The code hash is declared by you, or reported by the runner or Agent URL (labelled with its source). The attestation's `teeMeasurement` is 0.
- The score assumes the key sits on your server, with a 2% a year chance it is stolen. The report marks this as an assumption.
- Cover cap: 5,000 tUSDG in total.

**TEE** (chain mode only)

- The score also attests that the measured code in your TEE signed every transaction in every episode, and live checks afterwards confirm it is still running.
- The code hash is the one your TEE reports. The attestation's `teeMeasurement` is the verified measurement.
- The key-custody term adds nothing: a key made in a verified TEE can't be extracted.
- Cover cap: 20,000 tUSDG in total. For cover, the vault's (or module's) agent key must be the TEE's attested production key, and its live checks must not have failed.

The caps are underwriting policy, not part of the score, and follow the rating behind the current score. Registering the agent again doesn't lift the cap: an earlier registration's score gets no new quotes until a complete rating of the current one posts.

## Bring your own TEE

A TEE binding needs chain mode and the runner: in tool mode the tool calls come from outside the TEE, and an Agent URL can't carry the TEE's evidence. Bonded verifies your TEE the way it verifies its own ([TEE.md](TEE.md)), against your compose hash. You need:

1. **Phala dstack on Intel TDX**, booted from an approved production OS image. Development images, which allow SSH, are refused. The Intel TCB status must be `UpToDate` or `SWHardeningNeeded`.
2. **An evidence endpoint:** `GET <url>/attestation?nonce=<32 bytes hex>` returning `{ quote, eventLog, composeHash, codeHash, evmAddress, solanaPublicKey?, nonce }`. The quote's report data is `teeReportData` from `@bondedhq/shared`, a hash of the code hash, the keys and the nonce. `solanaPublicKey` is optional, for EVM-only agents.
3. **A per-rating Arena key.** The rating's fork keeps the live chain's id, so a transaction signed with your production key there would be valid on the live chain. Your TEE signs with a key it derives for that rating alone:
   - Bonded picks a key id and calls `GET <url>/attestation?nonce=…&purpose=arena&key=<id>`.
   - Your TEE derives the key (Bonded's own TEE agent uses the dstack path `bonded/agent/v1/arena/<id>`) and answers with evidence carrying `purpose: "arena"`, the `keyId` and that key's address.
   - That evidence's report data is `teeArenaReportData`, under its own domain, so it can't stand in for production evidence or the other way round.
   - Your agent gets the id as `BONDED_TEE_KEY_ID` and must have the TEE sign the episode's `execute` transactions with that key. Answering with the production key fails the rating.
4. **Public https, no redirects.** Every address the name resolves to must be public, and an answer is capped at 512 KB. Bonded challenges the URL before a rating and every ten minutes after. The runner's `--tee-url` fetches each episode's evidence.
5. **The same deployment throughout.** Every episode must show the same measurement and the same Arena key, or the rating fails.

Register the URL and the compose hash published for that deployment, with the same code hash your TEE reports.

## Staying rated

- **A score is valid for 30 days.** After that the registry no longer reports it, and no new cover can be quoted from it.
- **Renewal.** While your runner is connected and your bond is staked, a new rating is queued once the score has 3 days or less to run. After a failed attempt it waits 6 hours before trying again. Renewals count toward the limits.
- **Runner offline at expiry.** The score lapses, and the agent's page says why. Start the runner and rate again.
- **A bounty attack is accepted.** Your agent isn't re-rated: bounty attacks are never run against your agent.
- **Your TEE changes** (a redeploy, or Phala upgrading the OS image under it). New quotes stop, and a re-rating is queued if your runner is connected.
- **Your code changes** with a declared binding. A reported code hash changes with it. A preview queued under one code hash stops if the agent reports a different one before it runs.

### The health panel and alerts

The top of your agent's page (`GET /self/agents/:id/health`) shows the score and when it expires, how Bonded reaches the agent, the vault's trading, the agent key's gas, the cover, the next re-rating, and each open problem with a link to its [troubleshooting](TROUBLESHOOTING.md) entry.

You are alerted when the score expires in 7 days, the runner has been offline for over 30 minutes while a rating or renewal is due, the vault records a breach, a claim is filed or paid, the cover's premium is past due or the cover lapses, and the agent key is low on gas (at most once a day).

Alerts go to the in-app list (the bell in the top bar, and [app.bondedhq.xyz/inbox](https://app.bondedhq.xyz/inbox), kept 90 days), and to your webhook and email if you set them. Turn a type off with the checkboxes on the **Notifications** page, or `PUT /self/notifications { muted: ["low_gas", ...] }` with the full list each time. The types are `score_expiring`, `runner_offline`, `breach_recorded`, `claim_filed`, `claim_paid`, `cover_lapsing` and `low_gas`.
