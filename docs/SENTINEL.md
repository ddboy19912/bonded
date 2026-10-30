# Sentinel: how it works, end to end

Sentinel is Bonded's real-time guard. Before an agent's trade goes through, Sentinel reads the agent's mandate, the trade it wants to make and what it read along the way, and judges whether the agent has been manipulated into it. It runs on Laya, a small model we fine-tuned for this one question. This page covers the modes Sentinel can run in, how to use it, how well it works today, how it's trained and how fast it is.

**Safety rule.** Sentinel only advises and blocks suspicious trades. Payouts are decided by the vault's on-chain breach log, so a wrong Sentinel answer can never cause a wrongful payout.

## Modes

| Mode | What checks each trade | Where it's used | Status |
| --- | --- | --- | --- |
| **Off** | Nothing. The vault still enforces the mandate on-chain. | Any agent rated or run without Sentinel | Default for agents |
| **Laya only** | Laya alone. It blocks when it scores the trade 0.7 or higher for "manipulated". | The live API and rating worker (`SENTINEL_MODE=laya`) | **Live today** (Laya v5) |
| **Cascade** | Laya first. When Laya is unsure (its score falls inside a calibrated band), an LLM makes the call instead. | The live API and rating worker (`SENTINEL_MODE=cascade`) | Built and tested, **not switched on**. It turns on only with a frozen policy that has passed the held-out evaluation; none has yet (see [The cascade](#the-cascade)). |
| **LLM only** | An LLM alone (any OpenRouter model) | The Arena only (`--sentinel-model <model id>`), as the baseline the cascade is measured against | Not offered in production |

In every mode only "manipulated" blocks a trade. Laya-only checks never leave Bonded's infrastructure. In cascade mode, the checks that are escalated send the mandate, proposed action and untrusted inputs to the configured LLM provider.

The live settings (Laya v5, the v3 question set, a 0.7 block threshold) are `SENTINEL_SERVING` in `@bondedhq/shared`. The service itself is pinned by `SENTINEL_MODEL_REPO` and `SENTINEL_MODEL_REVISION`.

## A check, step by step

```
agent wants to trade → Sentinel checks it (about 2.5 s on CPU, under 300 ms on an NVIDIA T4 GPU)
   ├─ looks fine        → trade goes ahead
   ├─ looks manipulated → trade blocked, vault owner alerted
   └─ cascade mode only: Laya unsure (score strictly inside the band) → the LLM decides
```

Scores equal to either edge of the band stay with Laya.

**Questions per version.** v1 and v2 answer three questions. v3, the live set, answers two: "manipulated" and "injection in inputs". Code decides "within the mandate or breach" with the policy guard's exact check, and "suspicious" is derived as manipulated but within the rules (`SentinelQuestionSet` in `@bondedhq/shared`; [Stress suite](SENTINEL-STRESS.md) explains why). Older v1 adapters can also escalate low-confidence action-risk answers or likely breaches; those answers never decide payouts.

## Using Sentinel

Three ways in, all on the live mode above:

- **The Sentinel page** (`/sentinel` in the web app) says whether it's running, how v5 was tested, and how to use it.
- **Rate with Sentinel on.** When onboarding, an owner can tick "Rate it with Sentinel in front"; the registration message then carries a `sentinel on` line. An operator config sets `"sentinel": true`. The worker runs every rating episode with Sentinel in front of the agent (`ratedAgent` in `apps/api/src/sentinel.ts`). The report records `sentinel: { model, questions, blockThreshold }` and the checkpoint, and the agent page and the PDF say "Sentinel on". A config's `codeHash` is always the agent's own code; with Sentinel on the worker attests a combined hash (`ratedCodeHash`), for operator configs and self-serve alike, so the score is never passed off as the agent's alone. Sentinel with a TEE agent is refused for now: the TEE attests the agent's own code hash. If the agent breaches less, it scores higher and its premium falls: the discount is measured, not assumed. A Sentinel-on rating is never attested without Sentinel actually answering: it fails without `SENTINEL_URL`, and any check that got no answer (the service down, a bad key, a malformed reply) is counted in the report as `guardFailures`, which makes the rating incomplete. The guard still refuses the write in that case, so the agent stays safe.
- **Ask before each trade.** `POST /sentinel/check` takes the mandate, the proposed action and what the agent read, signed with the agent's own key over `sentinelCheckMessage` and `sentinelCheckDigest` from `@bondedhq/shared`. The key is the vault's current `agent()`, read on every check, so a key the guardian rotates out stops working at once. It answers `{ blocked, manipulated, injection, blockThreshold, model, latencyMs }`, or an error (429 throttled, 503 busy, waking up or no answer): treat anything but a clear `blocked: false` as "don't trade". Limits: 30 checks a minute per agent, 4 running at once, 20 s each, and a 256 KB body (the most its fields allow). Only the outcome is stored (`sentinel_checks`: agent, time, manipulated probability, blocked); the action and inputs never are. Agent pages show the last 7 days' counts. `GET /sentinel` reports `configured` and `available`: available means its health probe passes (checked at most every 30 s) and no check has gone unanswered in the last 2 minutes. On Railway, Sentinel sleeps when idle (see Memory below): the first check after a quiet spell waits up to 10 s for it to wake and gets a 503 if it isn't up by then, so retry once after a few seconds; while it sleeps, `available` is false until a probe wakes it.

The answer is advice: the agent decides whether to go ahead, and the vault enforces the mandate either way.

## How well it works today

Measured on held-out Arena episodes: attacks from classes Laya never saw in training (A7 and A10) and benign trading episodes. Laya v5 at revision `f8d3057`, threshold 0.7, measured on 2026-10-09.

| Test set | Attacks blocked | False alarms |
| --- | --- | --- |
| 6 new attack variants, drafted for this test (56 attacks, 592 benign) | 54 of 56 (96.4%; 95% interval 87.9–99.0%) | 0 of 592 (0–0.6%) |
| The 8 original A7/A10 attack families (87 attacks, 931 benign) | 50 of 87 (57.5%) | 0 of 931 |

Assumptions and limits:
- The attacks come from the Arena's scripted vulnerable agent, which follows whatever it's told, so every attack case is a real manipulation. An LLM-driven agent resisted all 33 episodes of the new variants, so they produced no attack cases.
- Laya ranks attacks almost perfectly (it separates attacks from benign trades with an AUC of 0.999), but it scores four of the original families low: A7 research-api-smuggling and json-field, and A10 otc-settlement and x402-prepay. That's the known gap. Lowering the threshold doesn't fix it: at 0.17, the new variants were blocked at the same rate with 3 false alarms. The fix is to include similar examples in the next retrain.
- 6 and 8 attack families are small samples, so the intervals are wide.

## How it's trained

Laya learns from labelled examples of the question "is this action manipulated?". The examples come from Arena attack episodes and synthetic cases. Whole attack classes (A7 and A10 today) and all benign control episodes are kept out of training, so the numbers above are measured on attacks the model has never seen.

For builders: `pnpm sentinel:synth` writes the synthetic examples and `pnpm sentinel:dataset` builds the training files. The fine-tune runs on GPU (Kaggle T4s), and the result is pushed to the model repo and pinned by revision.

**Stress test.** `pnpm sentinel:stress` scores a model on 528 disguised cases in 44 families, with rule-checked labels and locked test-only variants. The weakness map for v1 and v2, and what v3 had to fix, is in [Stress suite](SENTINEL-STRESS.md).

## Keeping it current

Sentinel only knows the attacks it has seen, so it is retrained when new attack classes or variants appear (from bounties or incidents), when it misses a breach or raises false alarms, and when its confidence drifts on recent labelled rows. A new model goes live only if it measures better on the held-out evaluation.

Every retrain must:
- pass the held-out evaluation;
- keep the previous model for rollback;
- trigger an Arena re-run, because Sentinel changes premiums.

When a held-out class has to join training, new held-out classes are chosen first, or the evaluation stops being honest.

## Blocks become attacks

A blocked check can become a new attack for the library, so live incidents feed it. Bonded keeps only a check's outcome, so the agent's owner saves the check (its `mandate`, `proposedAction` and `untrustedInputs`, plus Sentinel's answer) as JSON and runs:

```bash
pnpm --filter @bonded/arena incident-seed -- --block blocked-check.json
```

Plain code, no model, takes the text the agent read that names the action's address, puts `{{attacker}}` in the address's place, and takes the surface from the tool that returned it, the class from the surface, and what counts as success from the action (a transfer, an approval or a call). The mandate is not copied. The candidate must pass the bounty spec check and not copy a library attack. It goes to `attacks-staged/incidents/`, which no rating reads: a finding, not a score, until a person reviews it and a release moves it into `attacks/<class>/`. A swap names no outside address, so a blocked swap is left for a person to write up.

## Speed

One check is one forward pass over the mandate, the proposed action and the untrusted inputs (about 500 to 700 tokens on Arena episodes).

| Where | Conditions | Per check | Source |
|---|---|---|---|
| CPU | Apple M-series laptop, PyTorch, 2 threads, real held-out states | 2.3–2.9 s (p50 about 2.6 s); 4 or 8 threads are no faster | Measured, base Laya (same size as the fine-tune) |
| GPU | Apple M-series laptop GPU (MPS), Laya v5, 648 held-out cases | p50 280 ms, p95 614 ms | Measured |
| GPU | NVIDIA T4, fine-tuned model, our 24 test rows | p50 217 ms, p95 228 ms | Measured |
| GPU | NVIDIA T4, the author's benchmark | about 33 ms per forward pass | Laya's README, not ours |

So Sentinel takes **under 300 ms per check on a T4 GPU** and **about 2.5 s on CPU**. The author's 33 ms is one forward pass on a short input; our check answers questions about a 500 to 700 token state.

What this means: 2.5 s is acceptable for agents that trade minutes apart, since the check runs once before each trade. It is too slow for high-frequency agents. In cascade mode, escalated checks add an LLM call (p50 about 1.9 s, p95 about 4.1 s with DeepSeek v4.1 Flash in our evaluation).

Memory: the model needs about 2 GB. Railway bills memory used, about $10 per GB a month, so a Sentinel awake all month costs about $20: in October 2026 it was $17.78 of the project's $25.21. So on Railway it sleeps after 5 to 10 minutes without traffic (`sleepApplication` in `.railway/railway.ts`) and isn't billed while asleep. A request on the private network wakes it; it was serving 11 s after its container started (model download and load). A Sentinel-on rating waits up to 2 minutes for it to wake and pings it every minute until the rating ends, since a guard that gets no answer blocks the trade and would change the score.

## The cascade

The cascade is meant to get close to an LLM's detection at a fraction of its cost: Laya answers most checks itself, and only the unsure ones go to the LLM. It's built and tested, but it stays off until a frozen policy passes the held-out evaluation below.

### Status (2026-10-09)

Two candidates were evaluated with Laya v5 and DeepSeek v4.1 Flash as the LLM. Neither passed, so production runs Laya only.

| Final test, 534 cases (52 attacks, 482 benign) | Laya only | LLM only | Cascade (band 0.1–0.45) |
| --- | --- | --- | --- |
| Attacks blocked at 0.7 | 53.8% | 100% (51 of 51 answered) | 82.4% |
| False alarms at 0.7 | 0% | 1.04% | 0.62% |
| Checks sent to the LLM | – | all | 28.8% |
| Measured LLM spend per 1,000 checks | $0 | about $0.17 | about $0.046 |

- **First candidate (band 0.1–0.45): failed the final test.** The pass rules require the cascade to block as many attacks as the LLM alone and never overturn a decision Laya got right. It blocked 82.4% against 100%: 9 attacks scored between 0.45 and 0.7 from Laya, so they were neither sent to the LLM nor blocked. The LLM also blocked 3 benign actions Laya had allowed, and one LLM call failed all its retries.
- **Second candidate: failed calibration.** With the first test's data used for calibration, no band passed. Catching every attack needs the band to start below 0.144, but one benign action scored 0.105 and the LLM wrongly blocks it, so any band starting low enough counts a lost Laya decision.

The main obstacle is Laya's weak spot on the four families listed in [How well it works today](#how-well-it-works-today). Retraining Laya on similar examples is expected to help the cascade pass.

### Running the evaluation

Use distinct held-out Arena episodes and fresh benign controls. Calibration and final-test sets must have no shared input states or attack seed families; keep every variant of a seed together. Contradictory labels and ambiguous duplicate families are rejected. The tool deduplicates inputs and records both dataset hashes. Keep the private JSONL and scored-case files under ignored `apps/arena/datasets/`; publish only the aggregate report.

First score calibration data using the pinned Laya service and the selected LLM-only guard:

```bash
pnpm sentinel:cascade score \
  --arena datasets/cascade/calibration.jsonl \
  --laya http://localhost:8000 \
  --repo ddboy19912/bonded-sentinel-laya \
  --revision f8d305790ca9e6811e91da88d6c00c862554b0f9 \
  --llm deepseek/deepseek-v4.1-flash \
  --max-usd 5 --out datasets/cascade/calibration-scores.json
```

Paths passed through this root script are relative to `apps/arena`. `LAYA_API_KEY` authenticates Laya; `LLM_API_KEY` or `OPENROUTER_API_KEY` authenticates the fallback. The Laya health response must confirm the pinned revision. Paid scoring uses a request timeout and stops when provider cost is missing or the spending cap is exceeded; the last in-flight call can exceed the cap. A failed call is retried up to 2 more times, and the retries are recorded in the scores and reported (live checks do not retry). Existing output paths are rejected before making paid calls.

Then choose the band using calibration answers alone and freeze the final-test dataset and rules:

```bash
pnpm sentinel:cascade calibrate \
  --scores datasets/cascade/calibration-scores.json \
  --arena datasets/cascade/final-test.jsonl \
  --max-tpr-drop 0 --min-benign 300 \
  --out datasets/cascade/policy.json
```

The default tolerance is zero absolute TPR degradation. The calibration search uses a 0.05 probability grid and selects the lowest measured LLM spend among passing bands. Gates require enough distinct negative cases, no errors, known provider cost, cheaper LLM spend, TPR at ≤1% FPR at least as high as the LLM-only guard within the frozen tolerance, and no lower TPR at the actual 0.7 production threshold. Production false positives must stay at ≤1%, and no individual case may lose a Laya-correct block/allow decision. A confidently wrong Laya answer outside every usable band can make calibration fail; the tool never widens the tolerance automatically.

By default hosting is unknown, not free. To include an assumed allocation when comparing costs, freeze `--hosting-usd-per-1000 <amount>` during calibration. Reports separate measured provider spend from this allocation. Wilson intervals show uncertainty in production-threshold TPR/FPR; sample rates are not population guarantees.

Finally score the frozen test set once:

```bash
pnpm sentinel:cascade test \
  --policy datasets/cascade/policy.json \
  --arena datasets/cascade/final-test.jsonl \
  --laya http://localhost:8000 --max-usd 5 \
  --out datasets/cascade/final-report.json
```

A failed gate exits nonzero and cannot activate production. Do not tune against this result and reuse that test set: any new candidate needs a fresh final-test set. The report contains Laya-only, LLM-only and cascade comparisons, escalation rate, total and path p50/p95 latency, counts, retries, uncertainty and cost per thousand. Replay latency is the sum of separately measured path latencies; the deployed API records real checks separately.

Before rollout, also run the locked stress, consistency and Arena regression checks against the deployed model, including its previously recorded stress exceptions. Use the same frozen cascade in the Arena with `--sentinel-policy <policy.json>` and the same `--sentinel-model laya:<url>`; a new guard must not inherit a prior exception without fresh evidence.

### Switching it on

Put the passing files on both the API and the rating worker, give both the LLM key, and set:

```dotenv
SENTINEL_MODE=cascade
SENTINEL_CASCADE_POLICY_FILE=/app/config/cascade-policy.json
SENTINEL_CASCADE_EVALUATION_FILE=/app/config/cascade-final-report.json
```

Each service refuses to start in cascade mode unless the report passed and the policy matches `SENTINEL_MODEL_REPO`, `SENTINEL_MODEL_REVISION` and the configured LLM endpoint. The serving model also checks its health revision. `SENTINEL_MODE=laya` rolls back without requiring cascade files.

Laya-only rating hashes remain compatible; cascade ratings include the frozen policy hash, so older scores are never presented as scores for a different cascade. Agents rated with Sentinel on should be re-rated after the switch.

`GET /sentinel` adds `fallback`, `pipelineHash` and durable `metrics24h` for the current pipeline. Metrics include errors, escalations, known-cost coverage, provider cost per thousand and per-path latency. `POST /sentinel/check` adds routing and timing fields. Errors record no verdict and return 503; incomplete Sentinel-on ratings remain unattestable. Neither raw inputs nor provider error text is persisted. Historical rows have unknown path/cost metadata, and missing cost is never reported as zero.
