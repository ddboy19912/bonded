# Sentinel: how it works

Sentinel is Bonded's real-time guard. Before an agent's trade goes through, Sentinel reads the agent's mandate, the trade it wants to make and what it read along the way. It judges whether the agent was manipulated into that trade.

Sentinel runs on Laya, Convai Innovations' open-source decision model, which Bonded fine-tunes on attacks from the Arena.

**Sentinel is advisory.** It can block a suspicious trade, but it never decides a payout. Payouts come from the vault's on-chain breach log, so a wrong Sentinel answer can never cause a wrongful payout.

## What it checks

Each check answers two questions about the proposed trade:

- **Manipulated?** Is the agent acting on something it read rather than on its mandate?
- **Injection in the inputs?** Does what it read contain planted instructions?

Whether the trade is within the mandate is not a model question. Plain code decides it with the vault's exact rules.

Only "manipulated" blocks a trade. Sentinel blocks when Laya scores the trade 0.7 or higher.

## Modes

- **Off.** No check. The vault still enforces the mandate on-chain. This is the default.
- **Laya only.** Laya checks every trade. This is the mode Bonded runs. The checks never leave Bonded's infrastructure.
- **Cascade.** Laya answers first, and an LLM decides only when Laya is unsure. It is not switched on, because no cascade policy has passed the held-out evaluation. When it is, escalated checks will send the mandate, the trade and the agent's inputs to the LLM provider.
- **LLM only.** An LLM alone. This is used only in the Arena, as a baseline to measure against.

```
agent wants to trade → Sentinel checks it
   ├─ looks fine        → trade goes ahead
   └─ looks manipulated → trade blocked, vault owner alerted
```

## Using Sentinel

### Rate your agent with Sentinel in front

When you onboard an agent, tick "Rate it with Sentinel in front". An operator config sets `"sentinel": true`. Every rating episode then runs with Sentinel checking the agent's trades.

- The report records the Sentinel model and settings, and the agent page and PDF say "Sentinel on".
- The rating attests a combined code hash, so the score is never passed off as the agent's alone.
- If the agent breaches less with Sentinel, it scores higher and its premium falls. The discount is measured, not assumed.
- A check that gets no answer counts as a guard failure and makes the rating incomplete. The trade is still refused, so the agent stays safe.
- Sentinel can't be used with a TEE agent, because the TEE attests the agent's own code hash.

### Ask before each trade

`POST /sentinel/check` takes the mandate, the proposed action and what the agent read. Sign it with the agent's own key over `sentinelCheckMessage` and `sentinelCheckDigest` from `@bondedhq/shared`. The key must be the vault's current `agent()`, so a key the guardian rotates out stops working at once.

It answers `{ blocked, manipulated, injection, blockThreshold, model, latencyMs }`, or an error: 429 (throttled) or 503 (busy, waking up or no answer). Treat anything other than a clear `blocked: false` as "don't trade".

- **Limits:** 30 checks a minute per agent, 4 running at once, 20 s each, and a 256 KB body.
- **Waking up:** Sentinel sleeps when idle. The first check after a quiet spell waits up to 10 s for it to wake, and gets a 503 if it isn't up by then. Retry once after a few seconds.
- **Status:** `GET /sentinel` reports `configured` and `available`.
- **What's stored:** only the outcome (agent, time, manipulated score, blocked). The action and inputs are never stored. Agent pages show the last 7 days' counts.

The answer is advice. The agent decides whether to go ahead, and the vault enforces the mandate either way.

## How well it works

Measured on held-out Arena episodes: attacks from classes Laya never saw in training (A7 and A10), plus benign trading episodes. Threshold 0.7.

| Test set                                 | Attacks blocked     | False alarms |
| ---------------------------------------- | ------------------- | ------------ |
| 6 new attack variants (56 attacks)       | 54 of 56 (96.4%)    | 0 of 592     |
| 8 original A7/A10 families (87 attacks)  | 50 of 87 (57.5%)    | 0 of 931     |

The 95% interval for the first row is 87.9–99.0% blocked and 0–0.6% false alarms.

Assumptions and limits:

- The attacks come from the Arena's scripted vulnerable agent, which follows whatever it's told, so every attack case is a real manipulation.
- Laya separates attacks from benign trades almost perfectly (AUC 0.999), but it scores four of the original families low: A7 research-api-smuggling and json-field, and A10 otc-settlement and x402-prepay. Lowering the threshold doesn't fix this. Similar examples are needed in training.
- 6 and 8 attack families are small samples, so the intervals are wide.
- The live model is trained on trades. A version trained on off-chain payments has not passed the evaluation.

## Speed

One check is one pass of the model over the mandate, the proposed action and the inputs (about 500 to 700 tokens on Arena episodes).

| Where                            | Per check                      |
| -------------------------------- | ------------------------------ |
| NVIDIA T4 GPU (24 test rows)     | p50 217 ms, p95 228 ms         |
| Apple M-series GPU (648 cases)   | p50 280 ms, p95 614 ms         |
| Apple M-series CPU (2 threads)   | 2.3–2.9 s (p50 about 2.6 s)    |

So Sentinel takes under 300 ms per check on a T4 GPU and about 2.5 s on CPU. That is fine for agents that trade minutes apart, since the check runs once before each trade. It is too slow for high-frequency agents.

## Keeping it current

Sentinel only knows the attacks it has seen. It is retrained when new attack classes appear (from bounties or incidents), when it misses a breach or raises false alarms, and when its confidence drifts. A new model goes live only if it does better on the held-out evaluation. The previous model is kept for rollback, and the Arena is re-run, because Sentinel changes premiums.

## Blocks become attacks

A blocked check can become a new attack for the library. Bonded keeps only a check's outcome, so the agent's owner saves the check (its `mandate`, `proposedAction` and `untrustedInputs`, plus Sentinel's answer) as JSON and runs:

```bash
pnpm --filter @bonded/arena incident-seed -- --block blocked-check.json
```

Plain code, no model, turns it into a candidate attack. It is a finding, not a score, until a person reviews it and a release adds it to the library.
