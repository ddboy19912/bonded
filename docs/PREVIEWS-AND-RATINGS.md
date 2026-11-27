# Previews and official ratings

Test your agent for free with a preview, fix what the report shows, then make the rating official if you want a signed score on chain and cover. The short guide is [BRING-YOUR-OWN-AGENT.md](BRING-YOUR-OWN-AGENT.md).

## Preview or official rating?

Both use the same judge and the same scoring model.

| | **Preview** | **Official rating** |
|---|---|---|
| Cost to you | Nothing on chain | A vault and an operator bond |
| Who sees it | Only you, unless you share a link | Public, on chain |
| Runs each attack | Once | Three times |
| Signed and posted on chain | No | Yes |
| Cover can be quoted from it | No | Yes |

A preview needs no vault, bond, registration or tokens. It is a check of how your agent does, not a forecast of its official score: one run of each attack means fewer trials, so the score is less precise.

## Run a preview

You need a way to sign in (an email, a passkey or a browser wallet) and your agent, either at a public HTTPS address or able to run next to the runner. The page is [app.bondedhq.xyz/agents/test](https://app.bondedhq.xyz/agents/test), on Robinhood Chain testnet.

![Five steps: sign in, connect, run the check (no attack), run the preview, read the report.](images/byoa-test-steps.svg)

1. **Sign in** with your email (a one-time code), a passkey, or a wallet signature. You stay signed in for 12 hours. Nothing is sent on chain.
2. **Say which framework your agent uses and where it runs.** **On your computer or server** uses the runner (the default), which works anywhere you can run a command. **On a host like Vercel** uses an Agent URL, for an agent that only runs when called. Tools or chain mode is under **Advanced (optional)**; tools mode fits most agents. Press **Continue**.
3. **Connect it** ([Connect your agent](CONNECTING-YOUR-AGENT.md#connect-your-agent)).
   - **Agent URL:** copy the handler from the page (your wallet is already in it as `owner`), deploy it, paste the URL and press **Verify it now**. There is no secret to keep.
   - **Runner:** copy the commands now, since the runner token is shown once. Start the runner with npx or Docker ([Keep it running](CONNECTING-YOUR-AGENT.md#keep-it-running)) where your agent runs.
   - **Fastest, for a Node agent:** run the page's `init` command in your agent's folder. It edits your code after asking, starts the runner and runs the connection check ([Set it up with init](CONNECTING-YOUR-AGENT.md#set-it-up-with-init)).
4. **Run the connection check:** one episode with no attack, streamed live, then what to fix ([The connection check](CONNECTING-YOUR-AGENT.md#the-connection-check)). A preview needs a passing check of this exact connection in the last 24 hours.
5. **Read the estimate:** about how long the preview will take and, if your agent reported its model usage, what your model will cost.
6. **Press Start preview rating.** The page shows progress and an ETA, and can notify you when it ends ([Notifications](#notifications)).
7. **Read the report** ([What the report shows](#what-the-report-shows)). Change your agent and press **Rate again** to see the two side by side.
8. **Make it official** when you want a score on chain and cover ([Make it official](#make-it-official)).

If a step fails, look up its message on the [troubleshooting page](TROUBLESHOOTING.md).

## What a preview runs

- Every published attack once, plus a fresh held-out set made for this preview alone.
- 6 control episodes with no attack, and 16 benign twins (honest versions of attacks, for the Task score), shuffled in among the attacks.
- Up to 72 episodes, 90 seconds each, within 45 minutes in all. A stock-trading preview has 20 episodes of up to 4 minutes each, also within 45 minutes.

**While it runs:**

- It stops at the first episode your agent fails (it crashed, errored or ran out of time, or the runner or Agent URL went away), and shows the reason.
- You see counts and an ETA, but no verdicts until it finishes, so you can't adapt your agent to which episodes are attacks.

**Limits.** You can run a few previews a day. A refusal says when you can try again.

## What the report shows

The report is labelled "Preview: private, not published". It shows:

- **Fix these first:** the three changes that address the most of its breaches.
- The score and tier, and results for each attack class.
- What your agent read and didn't. A source it never read leaves its attacks untested, which lowers the score.
- Whether it still did its normal task, and the Task score ([SCORING.md](SCORING.md#task-score)).
- For each breach: the exact text your agent read, what it did, and what would have stopped it.

After **Rate again**, the new report shows the two ratings side by side ("54 → 81"), with each attack class's breaches before and after.

## Notifications

A preview can tell you when it finishes, fails or is refused: by browser notification while the tab is open, by email, or by webhook to a public https URL you set. Webhook calls are signed with `bonded-timestamp` and `bonded-signature` (`v1=`, a hex HMAC-SHA256 of `<timestamp>.<raw body>`) under a webhook secret (`bonded_ws_...`) shown once when you set the URL. Answer within 10 seconds; calls are not retried.

## Share or remove a preview

**Share a report.** **Make a link**, under a finished report, gives a read-only link (`app.bondedhq.xyz/shared/…`). It shows the report and when it ran, but not who ran it, the agent's address, its code or its instructions. **Stop sharing** turns it off at once. A shared report stays off the leaderboard and the Index.

**Remove a preview.** **Remove**, under "Your previews", deletes the preview's report, episodes, share link, runner tokens, Agent URL, the code or instructions Bonded ran, and its checks (`DELETE /previews/:id`). You can't remove one while its rating or a check is queued or running. A removed preview still counts toward the day's limit.

What Bonded keeps and for how long: the [privacy page](https://www.bondedhq.xyz/privacy).

## Make it official

**Make it official** on the report opens onboarding with your preview's choices filled in. Then:

1. Register the agent.
2. Create its vault (or choose a module) and stake its bond.
3. Connect it again and run a passing check. The preview's runner token and Agent URL belong to the preview, so the registered agent gets its own.
4. Rate it. The official rating always runs again from scratch, attested.

The preview's report stays linked to the agent. Details: [OFFICIAL-RATINGS.md](OFFICIAL-RATINGS.md).
