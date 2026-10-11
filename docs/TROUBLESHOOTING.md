# Troubleshooting

Every problem, warning and refusal Bonded shows, with what to do about it. Each one has a stable code: the web app's **How to fix this** links, the runner's `how to fix:` lines and the API's `code` fields all point at its section here, whose heading is the code.

Where a message carries numbers, ids or times, the sentence below is its gist. The API returns the code next to each sentence: `code` beside `error` on a refusal (and in `details.code`), `issues[].code` on a connection check's problems and warnings, `problems[].code` in an agent's health panel, and `code` on an in-app notification.

This page is generated from `PROBLEMS` in [packages/shared/src/problems.ts](../packages/shared/src/problems.ts) by `pnpm docs:troubleshooting`. Don't edit it by hand: change the list and run the command.

## Signing in and signed requests

### session-ended

**Message:** Your session has ended. Sign in again.

**What to do:** Sign in with your wallet again; sessions last 12 hours.

### not-signed-in

**Message:** You aren't signed in.

**What to do:** Sign in with your wallet on the page, then try again.

### sign-in-other-chain

**Message:** That sign-in is for another chain.

**What to do:** Switch your wallet to the chain the page uses and sign in again.

### too-many-sign-ins

**Message:** Too many sign-ins from this wallet. Try again in an hour.

**What to do:** Wait an hour, or keep the session you already have open.

### signature-expired

**Message:** The signed request has expired. Sign it again.

**What to do:** Sign again: a signed request is good for a few minutes. Check your computer's clock if it keeps happening.

### signature-reused

**Message:** That signed request was already used. Sign it again.

**What to do:** Sign again: each signature can be used once.

### bad-signature

**Message:** The signature isn't valid.

**What to do:** Sign with the wallet that owns the agent, on the right chain, and don't edit the message.

### stream-token-expired

**Message:** That stream token has expired. Ask for a new one.

**What to do:** Reload the page: it asks for a new stream token.

## Limits and requests

### preview-limit

**Message:** You can start (or run) only so many previews a day.

**What to do:** Wait until the time the message gives, or make the agent official to rate it without the preview limit.

### check-limit

**Message:** You can run only so many connection checks an hour.

**What to do:** Wait until the time the message gives. A passing check stays good for 24 hours.

### url-verify-limit

**Message:** Your Agent URL has been checked too often this hour.

**What to do:** Wait an hour before verifying the URL again.

### rating-cooldown

**Message:** An agent can be rated only so often; the next rating time is given.

**What to do:** Wait until the time the message gives.

### stream-limit

**Message:** Too many live streams are open.

**What to do:** Close other tabs showing live progress, then reload.

### rate-limited

**Message:** Too many requests. Try again in a few minutes.

**What to do:** Wait a few minutes; the limit is per address.

### body-too-large

**Message:** The request body is too large.

**What to do:** Send less: request bodies are capped (16 KB; 256 KB for Sentinel checks).

### invalid-request

**Message:** The request isn't valid.

**What to do:** Check the fields against the API reference; unknown fields are refused.

### try-again

**Message:** Another request for the same thing came first.

**What to do:** Try again.

### not-found

**Message:** That wasn't found.

**What to do:** Check the id; another wallet's previews and checks are shown as not found.

## Registering an agent

### not-owner

**Message:** Only the agent's owner (or the vault's guardian) can do that.

**What to do:** Connect the wallet that owns the agent in the registry (or guards the vault).

### not-own-agent

**Message:** This agent isn't registered as your own agent.

**What to do:** Register it with "Make it official" (or POST /self/agents) first.

### operator-managed

**Message:** This agent is managed by Bonded's operator.

**What to do:** Nothing to do: Bonded's own agents are configured by the operator.

### vault-invalid

**Message:** That address is not a Bonded vault or mandate module.

**What to do:** Use the address the factory created for this agent (shown after onboarding).

### vault-wrong-agent

**Message:** The vault or module belongs to another agent.

**What to do:** Register the vault created for this agent id, or create a new one for it.

### mandate-mismatch

**Message:** The mandate doesn't match what the vault or module enforces.

**What to do:** Register exactly the mandate the vault was created with; its rules can't change afterwards.

### vault-creation-unreadable

**Message:** The vault's creation couldn't be checked.

**What to do:** Create the vault by calling the factory directly (not through another contract), then register it.

### modules-unavailable

**Message:** Smart-account modules aren't deployed on this chain yet.

**What to do:** Use a Mandate Vault instead.

### owner-changed

**Message:** The agent changed hands since it was registered.

**What to do:** The new owner registers the agent again.

### tee-needs-runner

**Message:** A TEE-bound agent is rated in chain mode, through its runner, with a declared code hash.

**What to do:** Use the runner in chain mode and declare the code hash your TEE reports.

### bounty-reveal

**Message:** The bounty's reveal doesn't match what is on chain.

**What to do:** Reveal the submission on BountyBoard first, with the exact spec whose sha256 you committed.

## Connecting your agent

### runner-token-invalid

**Message:** That runner token isn't valid: it was revoked, replaced or its preview ended.

**What to do:** Create a new runner token on the agent's (or preview's) page and use that.

### runner-token-missing

**Message:** Create a runner token first, then start the runner.

**What to do:** Create a runner token on the agent's page and start the runner with the command shown.

### wrong-mode

**Message:** The agent runs in the other mode (tools or chain) from the one it is registered for.

**What to do:** In tools mode trades are tool calls; in chain mode they are transactions signed and sent through the RPC endpoint. Restart the runner with the right --mode, or set the agent up for the registered mode.

### runner-busy

**Message:** The runner is busy with another episode.

**What to do:** Wait for it to finish, then try again.

### runner-not-connected

**Message:** The runner isn't connected.

**What to do:** Start the runner with your token (keep it running as a service), then try again.

### agent-url-missing

**Message:** Set your Agent URL first.

**What to do:** Add your agent's HTTPS endpoint on the agent's page.

### agent-url-unverified

**Message:** The Agent URL isn't verified yet.

**What to do:** Give your agent the secret, then press Verify so Bonded can check its answer.

### agent-url-secret-unusable

**Message:** The stored Agent URL secret can't be used.

**What to do:** Set the Agent URL again to get a new secret.

### agent-url-no-version

**Message:** The Agent URL reported no version, so there is no code hash.

**What to do:** Report a version in your verify answer, or declare a code hash.

### connection-kind-mismatch

**Message:** This agent connects the other way (runner or Agent URL).

**What to do:** Use the connection the agent was set up with, or switch it on the agent's page.

### url-slow

**Message:** Your URL didn't answer in time.

**What to do:** Answer within the time given (10 seconds for verify); do slow work after answering.

### url-closed

**Message:** Your URL closed the connection before answering.

**What to do:** Check your server's logs: it dropped the request (a crash, a proxy timeout or a body size limit).

### url-certificate

**Message:** Your URL's TLS certificate wasn't accepted.

**What to do:** Serve a valid certificate for the host name (not self-signed, not expired).

### agent-secret

**Message:** Your URL refused Bonded's signed call: it isn't using the agent secret Bonded gave you.

**What to do:** Set the agent secret from the Agent URL page in your agent and check the bonded-signature header with it.

### verify-answer

**Message:** Your URL answered the verify check, but not correctly.

**What to do:** Answer verify with 200 and JSON { challenge, proof } (proof = HMAC-SHA256 of "verify." + challenge with your secret).

### url-not-public

**Message:** That URL can't be used: it must be public https on the standard port, and not one of Bonded's.

**What to do:** Use a public https URL on port 443 with no user name, password or #fragment, that resolves to a public address.

### url-unreachable

**Message:** Bonded couldn't reach your URL.

**What to do:** Check the URL is up and answers POST from the internet (no firewall or allowlist in the way).

### runner-offline

**Message:** The runner has been offline while a rating or renewal is due.

**What to do:** Restart the runner, ideally as a service (bonded-runner service --print).

## Connection checks

### runner-could-not-start

**Message:** The runner couldn't start your agent.

**What to do:** Run the agent command yourself in the same folder to see the error, then fix it and check again.

### needs-check

**Message:** Run a connection check first.

**What to do:** Run a check of this exact connection (same token or URL, mode and code); a pass lasts 24 hours.

### check-running

**Message:** A check is already running for this agent.

**What to do:** Wait for its result.

### timed-out

**Message:** It didn't finish within the episode's time.

**What to do:** Post to the episode's done URL (or exit) when the agent has finished.

### agent-exited

**Message:** It exited or was stopped before finishing.

**What to do:** Read its output in the check, fix the crash, and check again.

### never-called-a-tool

**Message:** Your agent never called a tool.

**What to do:** Read and trade through the episode's MCP or HTTP endpoints (isBondedEpisode() in @bondedhq/sdk).

### no-trade

**Message:** It didn't make the trade its task names.

**What to do:** Make sure the agent does the task it's given (the trade named in the goal).

### benign-breach

**Message:** Its actions broke the mandate in a benign episode.

**What to do:** Keep trades inside the mandate (tokens, caps, destinations); a rating counts this against it.

### unread-surfaces

**Message:** It didn't read every surface; unread ones are scored as untested.

**What to do:** Have the agent check its messages, news, prices and other reads before trading.

### tool-calls-failed

**Message:** Some tool calls failed.

**What to do:** Check the arguments the agent passes; the first failure is quoted.

### transactions-refused

**Message:** Some transactions were refused.

**What to do:** Sign for the episode's chain with the episode's key and call only the vault's execute.

### usage-not-reported

**Message:** If your agent uses a model, report its usage at /done.

**What to do:** A note, not a problem: send usage ({ inputTokens, outputTokens, costUsd }) with done for a cost estimate. An agent with no model can leave it out; the estimate then gives time only.

### episode-failed

**Message:** The episode failed.

**What to do:** Read the reason given; run the agent locally with the same input to reproduce it.

## Ratings

### tee-binding-failed

**Message:** TEE binding failed: the evidence didn't match the rated deployment.

**What to do:** Redeploy the reviewed compose file, then rate again.

### code-changed

**Message:** The agent now reports different code than when the rating was queued.

**What to do:** Run a connection check of the code that runs now, then rate again.

### no-code-hash

**Message:** No code hash: none was reported when the rating was queued.

**What to do:** Update @bondedhq/runner (it reports one), or declare a code hash, then rate again.

### fork-budget-spent

**Message:** The agent used up its share of fork requests.

**What to do:** Make fewer chain reads per episode (cache what doesn't change).

### bonded-url-failure

**Message:** Bonded couldn't reach the agent's URL; not the agent's fault, it will be retried.

**What to do:** Nothing to do: it is retried.

### rating-over-budget-agent

**Message:** The rating ran past its time budget, and the agent took most of the time.

**What to do:** Make each episode faster (fewer model calls, a faster model), then rate again.

### rating-over-budget

**Message:** The rating ran past its time budget, not because of the agent; it will be retried.

**What to do:** Nothing to do: it is retried.

### agent-failed-episode

**Message:** The agent failed an episode.

**What to do:** Run a connection check to see the failure, fix it, and rate again.

### not-attested

**Message:** Not attested: the agent didn't do its task often enough in the control episodes.

**What to do:** Make sure the agent does its benign task; an agent that does nothing can't be rated.

### incomplete-rating

**Message:** The rating was incomplete (a guard failed to answer).

**What to do:** Nothing to do: it is rated again.

### preview-stopped

**Message:** This preview was stopped.

**What to do:** Start a new preview.

### rating-running

**Message:** Its rating is running.

**What to do:** Wait for it to finish; it stops at the first failed episode.

### no-score

**Message:** The agent has no posted score yet.

**What to do:** Run a connection check, then ask for a rating.

### score-expired

**Message:** The agent's score has expired.

**What to do:** Keep the runner connected (scores renew on their own) or ask for a rating.

### score-expiring

**Message:** The agent's score expires soon.

**What to do:** Keep the runner connected so the score renews, or ask for a rating.

## Cover and claims

### score-superseded

**Message:** This agent's score is superseded: its latest rating was stopped by the agent.

**What to do:** Fix what stopped it and wait for a complete rating.

### registered-again

**Message:** The agent was registered again after its current score was posted.

**What to do:** Wait for a complete rating of the current registration.

### cover-capped

**Message:** Cover is capped on testnet.

**What to do:** Ask for less cover.

### uninsurable

**Message:** The score is too low to insure.

**What to do:** Use the report's top fixes and rate again.

### bond-too-low

**Message:** The operator bond is below the tier's minimum for the cover.

**What to do:** Stake more bond, or ask for less cover.

### capacity-exceeded

**Message:** The pool can't take that much cover right now.

**What to do:** Ask for less cover, or try later.

### attestation-expired

**Message:** The score has expired.

**What to do:** Rate the agent again.

### module-needs-enforce

**Message:** A smart-account module can hold cover only in Enforce mode.

**What to do:** Install the module in Enforce mode.

### cover-lapsing

**Message:** The cover's premium is past due.

**What to do:** Top up the vault's base asset so the next premium collection succeeds before the grace period ends.

### claim-filed

**Message:** A claim was filed for a breach.

**What to do:** Nothing to do: the keeper files covered claims and the payout goes to the vault.

### claim-paid

**Message:** A claim was paid.

**What to do:** Nothing to do: the payout went to the vault.

## The vault

### cover-without-vault-trades

**Message:** The agent has cover, but hasn't traded through its vault lately.

**What to do:** Point the agent's trades at its vault (npx @bondedhq/runner init shows the change); cover only pays for trades through the vault.

### low-gas

**Message:** The agent key is low on gas.

**What to do:** Send ETH to the agent key; it pays gas for every trade through the vault.

### vault-frozen

**Message:** The vault froze the agent after a breach.

**What to do:** Review the breach, then the guardian unfreezes (or rotates) the agent key.

### breach-recorded

**Message:** The vault recorded a breach.

**What to do:** Review it on the agent's page; a covered loss is claimed automatically.

### no-vault

**Message:** This agent has no registered vault.

**What to do:** Register the agent with its vault (or module) address.

## Notifications

### email-unavailable

**Message:** Email notifications aren't set up on this service.

**What to do:** Use a webhook, or the in-app list.

### webhook-missing

**Message:** Set a webhook URL first.

**What to do:** Save a webhook URL, then rotate its secret.

## Bonded's own services

### agent-urls-off

**Message:** Agent URL mode and webhooks are off on this service.

**What to do:** Use the runner instead; the operator has to set AGENT_URL_SECRET_KEY for URLs and webhooks.

### checks-unavailable

**Message:** Connection checks aren't available on this rating service yet.

**What to do:** Try later; the operator has to run the Arena Gateway.

### gateway-unavailable

**Message:** The rating worker has no Arena Gateway, so it can't rate an agent its operator runs.

**What to do:** Try later; the operator has to run the Arena Gateway.

### sentinel-unavailable

**Message:** Sentinel didn't answer.

**What to do:** Try again in a few seconds.

### service-error

**Message:** The request failed on Bonded's side.

**What to do:** Try again; if it keeps failing, check the status page.

## Anything else

### other

**Message:** a sentence this page doesn't list yet. The API gives it the code `other`.

**What to do:** the sentence says what went wrong in its own words. If it isn't clear, check the status page (Status, at the foot of the web app) and try again; if it keeps happening, open an issue with the message.
