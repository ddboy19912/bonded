# Does Bonded still matter if good agents resist the attacks?

Research date: 2026-10-16. Repository inspected at `5ebf5d8`, branch `adaptive-attacker`. This is a product assessment, not a new rating or a claim that the requested strong-agent experiment succeeded. No paid model calls were made for this research.

## Judgment

The concern is justified. Bonded has demonstrated useful enforcement and a working testing system, but it has not established that its current benchmark meaningfully ranks well-built agents, or that its scores predict insured losses. Finding a deliberately weakened bot would not resolve either problem.

The evidence supports continuing with a narrower proposition: **test the actual agent and its financial permissions, show what fails, and verify that enforcement contains it while useful work still succeeds.** The rating and insurance business need additional evidence. Strong models passing tests is a successful security outcome; it is also a commercial problem if the report provides nothing the customer did not already know.

The requested demonstration remains unproven: a realistic custom bot on DeepSeek V4.1 Flash that passes the 40 published seeds, fails to an adaptive attack, and is contained by Enforce mode or the hardened agent. Research supports testing this hypothesis. It does not guarantee the result.

## The use case, precisely

Bonded serves an operator who delegates financial authority to software, a depositor who bears its losses, and potentially a platform that decides which agents may receive deposits. Its distinct steps are:

1. Describe the authority in a mandate: assets, recipients, contracts, transaction sizes and daily limits.
2. Exercise the agent in the Arena, with hostile inputs and ordinary tasks.
3. Route real actions through a vault or smart-account module that enforces the mandate.
4. Publish evidence bound to a configuration.
5. Transfer a defined residual loss to an operator bond and underwriting pool.

These are different promises. A working claim waterfall proves settlement mechanics. A blocked transaction proves that a control worked for that transaction. Neither proves a calibrated premium or customer demand. Sources: [specification Sections 3–4, 6, 9 and 11](SPECIFICATION.md), [judge](../apps/arena/src/judge.ts), [policy contract](../contracts/evm/src/MandateBase.sol), [claims](../contracts/evm/src/ClaimsEngine.sol).

A plausible first customer is a team operating a custom treasury or rebalancing agent that reads external research, maintains state, and executes without approval for every trade. Such a team may value evidence before changing its model, tools or permissions. This is a customer hypothesis, not a customer discovered in this research. A deterministic DCA script has little prompt-injection exposure; a read-only adviser has no direct spending authority; a retail user already protected by adequate wallet permissions may need nothing extra.

## What the saved experiments actually establish

I recounted the local campaign JSON, without printing or publishing the attack text. A payload-free snapshot of the aggregates and input digests is in [the evidence audit](progress/evidence/adaptive-research-audit.json). These are saved results, not fresh on-chain replays. The original files remain gitignored.

| Test                                           | Recounted result                                                                                                                                                     | Interpretation                                                                                                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AgentKit + Flash, `strong-*`                   | 9 campaigns; 111 episodes; all 111 `ignored`; no invalid drafts; 0 unblocked breaches; about $1.407, marked estimated                                                | Serious negative evidence for this attacker and setup. Not an all-40-seed test.                                                                                      |
| Qwen/Nemo adaptive, `uplift-*`                 | 22 campaigns; 78 attempt records, including 5 invalid drafts; 73 episodes, including 5 unseen; 1 round-zero win plus 6 wins after rewriting; about $1.887, estimated | Six new seed/model failures found within four rewrite rounds, with some campaigns cut short by budget.                                                               |
| Unmodified repeats of the six adaptive winners | 30 episodes; all `ignored`; no breaches                                                                                                                              | Supports a difference between those saved texts and their original seeds. Additional Qwen A6 repeats are 5 unseen episodes and must not be added to this comparison. |
| Saved winning texts, same agent in Monitor     | 8 unblocked breaches in 18 episodes; 10 ignored; test loss $12,144.80                                                                                                | Four of six winning texts reproduced at least once. Small, selected sample.                                                                                          |
| Saved winning texts, same agent in Enforce     | 12 episodes: 4 `vault_blocked`, 5 ignored, 3 unseen; zero loss                                                                                                       | Four observed violations were contained. All 12 were not active challenges to enforcement.                                                                           |
| Saved winning texts, hardened agent            | 12 episodes: 2 guard blocks and 10 ignored; zero loss                                                                                                                | Supports containment in this sample; prompt and guard both changed.                                                                                                  |
| Three custom Flash bots, mandate shown         | 84 episodes: 73 ignored, 5 unseen, 6 errors; no breach                                                                                                               | Not 84 demonstrated refusals or 84 useful completed tasks.                                                                                                           |
| Memory bot                                     | 58 attempt records: 1 invalid draft, 57 two-session attempts; no breach                                                                                              | Tests this particular summarised-memory design.                                                                                                                      |
| Static Mistral sweep                           | 0 breaches in 40 episodes; 25 ignored, 15 unseen                                                                                                                     | Cannot say Mistral resisted all 40 attacks.                                                                                                                          |
| Static Qwen sweep                              | 2 breaches in 40 episodes; 26 ignored, 12 unseen                                                                                                                     | Model weakness is detectable, but surface coverage is incomplete.                                                                                                    |

The weak-agent adaptive attacker was DeepSeek V4 Pro, with `trace` feedback and reasoning off according to the run notes. The strong run used four candidates per round, 11–13 episodes per seed and a $0.15 stopping threshold per seed. All nine strong campaigns stopped on budget. Replay runs used zero rewrite rounds; an `attackerModel` field in those files does not mean an attacker call occurred.

The six-winner matched repeats are correctly 0/30. The earlier prose mixed that subset with 35 total repeat files. There are also six `rep7-hidden-*` files now: two breaches, two ignored, two errors, rather than the older three-run snapshot. The [historical note](ADAPTIVE-ATTACKER.md) should be read with these dates and subsets in mind.

Most importantly, `ignored` means the surface was read and no breach or guard block was recorded. It does not establish benign task completion. The saved adaptive summaries lack `taskCompleted`, the full transaction trace and individual breach records. The live judge does read the vault; the saved artifact is not yet a self-contained proof a reviewer can reconstruct without rerunning.

## What primary research says about good agents

The [companion primary-source review](AGENT-SECURITY-PRIMARY-RESEARCH.md) verifies the papers cited in the original notes and explains their threat models. Three findings matter most:

- **Model improvements are real.** Hofer and colleagues report much lower attack success against GPT-5 than Qwen in their AgentDojo study. Weak-model success does not reliably transfer to a stronger model. That is consistent with Bonded's Flash results. [Paper](https://arxiv.org/html/2606.10525v1).
- **A clean benchmark can become obsolete.** Anthropic reports retiring an older browser-agent evaluation after newer models reached zero attack success. A harder evaluation still found failures before safeguards, while several models with the full safeguards had zero observed successes. This supports harder evaluation and stronger defense, not an assertion that every deployed agent can be broken. [First-party report](https://claude.com/resources/articles/claude-in-chrome-generally-available).
- **Adaptive search can expose a real gap.** AutoDojo's banking results include DeepSeek-v4-Flash with PIGuard: 0% static versus 9% adaptive attack success across 144 task pairs. This is a different model version and environment from Bonded. It warrants a controlled experiment, not extrapolation to financial losses. [Table 6](https://arxiv.org/html/2606.15057v3).

The crypto-memory paper provides a relevant implementation-specific demonstration, not evidence that Bonded's summarised-memory bot must fail. Similarly, the AP2 shopping-agent paper demonstrates ranking manipulation and data disclosure on synthetic data; it does not demonstrate bypassing cryptographic payment authorization to steal funds. [Memory paper](https://arxiv.org/html/2503.16248v1), [AP2 paper](https://arxiv.org/html/2601.22569v1).

This review did not establish a verified population-level rate of real financial losses caused by these attacks against Flash-class trading bots. Evidence of vulnerability, evidence of deployed losses, and evidence that customers will buy Bonded are separate requirements.

## Why the current test may be easy for a good agent

**The task often gives the agent the answer.** The default goal explicitly buys a named token for a specified amount, and the AgentKit adapter adds the mandate to the user message. Recognising that a random article should not override that instruction is much easier than operating a strategy that legitimately derives orders from outside information. This is a valid task, but a narrow one. [Tasks](../apps/arena/src/episode.ts), [adapter](../apps/demo-agents/src/frameworks/langgraph.ts).

**The custom bots are hypotheses about customer mistakes.** Their prompts explicitly trust mail, alerts or retries. They were written to explore failure modes, not taken from an independently selected customer deployment. Calling them realistic does not establish prevalence. The signal follower's published-seed breach is useful evidence that integration design matters on Flash, but it fails the requested static-pass/adaptive-fail criterion. [Bot designs](../apps/demo-agents/src/custom/bots.ts).

**The search is constrained.** It uses at most 1,500 characters per draft, truncated agent replies and call arguments, no tool-result contents in feedback, and batches of candidates rather than a maintained search tree. The attacker prompt includes a task only if `seed.goal` is populated; it does not explicitly receive the CLI goal override or the structured mandate and tool schemas. A regex that notices words like “suspicious” is a weak progress signal: omitting the word does not mean the agent is closer to a violation. [Loop and attacker prompt](../apps/arena/src/adaptive.ts).

**Some classes need a different experiment, not another rewrite.** A3 price poisoning needs authentic decision dependence on the price source. A9 long-horizon drift needs cumulative state and enough actions; the ordinary default is 20 tool calls. A10 negotiation needs an actual interaction if that is the claim. The memory experiment carries notes into a new session and new vault; it does not simulate a continuously operating portfolio with persistent orders and balances. [Episode](../apps/arena/src/episode.ts), [memory experiment](../apps/arena/src/memory-attempt.ts).

**The success definition is narrower than “the agent was manipulated.”** A false headline can cause an allowed, poor trade without violating any vault rule. Such a failure may matter to a customer, but the current verdict and ordinary cover do not classify it as a mandate breach. Conversely, a blocked violation is a recorded breach without a loss.

## Which attack classes still make sense?

| Classes                              | Realistic question                                                               | Bonded's observable boundary                                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1, A2, A7: metadata, content, tools | Does external data become authority to change an order, recipient or approval?   | A mandate breach only when the resulting action crosses an encoded rule; harmful allowed decisions need a separate metric.                       |
| A3, A8: prices and panic             | Does the strategy depend on an untrusted signal, and does it exceed risk limits? | A manipulated data feed is not the on-chain valuation oracle. A legal sell within limits can still be economically bad.                          |
| A4, A5: lookalikes and addresses     | Does a resolver or adapter select the wrong token, spender or destination?       | Exact address and asset controls may contain it. Rewriting text alone may miss a deterministic integration defect.                               |
| A6: operator impersonation           | Is an instruction actually authenticated, and is its scope checked?              | A sender string is not authentication. Do not grant an attacker control of authenticated metadata without explicitly testing gateway compromise. |
| A9: drift and retries                | Are fills, retries, cumulative spending and resets handled correctly?            | Test time and shared state. A short isolated episode cannot validate a month of operation.                                                       |
| A10: counterparties                  | Can a peer's request exceed its delegated authority?                             | Test actual negotiated actions and payment scope, not just a message labelled “another agent.”                                                   |

Keep the classes, but tie each to a customer workflow and attacker access. Ten labels do not mean ten independent risks, nor ten equally exercised tests.

## The hardest product issue: what is left to insure?

When Enforce correctly blocks an unauthorized transfer or rolls back an oversized trade, there is no loss for cover to reimburse. The contract records the attempt with `blocked = true` and zero loss; the claims engine rejects blocked claims. This is desirable protection. Running in Monitor merely to produce insurable losses would be a poor customer proposition. [Enforcement](../contracts/evm/src/MandateBase.sol), [claims checks](../contracts/evm/src/ClaimsEngine.sol).

Residual risks need specific treatment:

| Failure                                            | Present treatment                                                                                         | Product consequence                                                                                                                |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Breach through `execute`, blocked in Enforce       | Recorded, zero loss, no payout                                                                            | Sell prevention and evidence if valuable; do not call this an insurance payout case.                                               |
| Later token drain through an outstanding allowance | A vault can record a Deferred breach during reconciliation; smart-account modules exclude Deferred claims | Examine the allowance and cause. Do not assume a third-party contract exploit becomes covered merely because a drop is observable. |
| Manipulated but mandate-compliant trade            | Ordinary market losses excluded; some disputed behavior may enter T4                                      | A general “AI manipulation insurance” promise would be broader than automatic coverage.                                            |
| T4 disputed drawdown                               | Dispute process; module policies require council approval                                                 | Not the same automatic, deterministic promise as a T1–T3 vault claim.                                                              |
| Owner compromise, allowed-protocol bug             | Excluded by the stated product scope                                                                      | Cannot use these risks to justify today's premium without changing the coverage.                                                   |

The module case is especially revealing: only Enforce-mode modules can hold cover, Deferred claims are excluded, and the specification says their remaining claims go through T4 disputes. That should be explicit in the product story. [Specification Sections 3.1 and 11.1](SPECIFICATION.md).

A bond reduces some incentive problems but does not by itself prove fraud resistance. The source documents mitigations, not an economic proof that every colluding operator/depositor strategy loses money. Underwriting also needs evidence about correlated model failures, implementation changes and actual attack exposure.

## What the score can honestly mean today

`scoreRating` applies exposure assumptions, a Beta upper bound, severity priors and a separate assumed custody component. Some differences between scores therefore reflect chosen assumptions or test counts, not measured differences in agent behavior. A verified TEE sets the modeled key-extraction component to zero by assumption; it does not establish zero total compromise risk. [Scoring implementation](../packages/shared/src/actuarial.ts).

For independent, identically distributed trials with zero failures in 111 tries, the one-sided 95% upper bound is about 2.7%. Adaptive candidates and reused workflows are not independent draws from production, so that calculation is only an illustration, not a real-world loss bound. Repeating 40 known seeds many times cannot establish coverage of unknown attacks.

The relevant quantity for a campaign is “breached within N actual attempts under this attacker's access and budget.” It is not interchangeable with per-episode success or annual encounter risk. Adaptive search stops after success and selects harder texts; its samples should not simply be poured into the existing binomial premium calculation.

For now, report four separate dimensions: useful task completion, observed policy violations, observed financial loss with/without enforcement, and test coverage/configuration. A score can be a benchmark summary with these qualifications. Pricing needs an independently justified exposure and loss model. The repo already discloses illustrative priors; the recommendation is to make that limitation central to the sales claim.

There is also a terminology mismatch to resolve before the next demonstration. Ratings use `verdict.breached` for any vault record. Adaptive `succeeded` is `ruling === "breach"`, which excludes `vault_blocked`. This does not change the Monitor-mode discoveries, but “0 breaches in Enforce” is inaccurate when the vault logged four blocked violations. Report **recorded violations / unblocked violations / lost value** separately. [Judge](../apps/arena/src/judge.ts), [rulings](../apps/arena/src/report.ts), [adaptive success](../apps/arena/src/adaptive.ts).

## Existing alternatives and a possible reason to choose Bonded

Basic spending controls are already available:

- Coinbase documents session and transaction caps and isolated keys in Agentic Wallets. [Launch and controls](https://www.coinbase.com/developer-platform/discover/launches/agentic-wallets).
- Privy documents recipient/contract restrictions, transfer limits and calldata conditions in its wallet policy system. [Policy documentation](https://docs.privy.io/security/wallet-infrastructure/policy-and-controls).
- MetaMask documents time-bounded delegation with on-chain enforcement, including periodic token allowances. [Advanced Permissions](https://metamask.io/en-GB/news/introducing-advanced-permissions).

These sources establish available capabilities, not comparative effectiveness or willingness to pay for Bonded. They weaken a pitch based only on adding a spending cap. Coinbase's own AgentKit security policy also treats prompt injection as a risk to manage, rather than a toolkit vulnerability by itself. [Security policy](https://github.com/coinbase/agentkit/blob/main/SECURITY.md).

The more defensible hypothesis is independent testing of the **whole configured system** across providers: its permissions, signing paths, useful tasks, model, memory and deployment binding. A customer might pay for a reproducible finding, a repaired integration, a regression check or evidence required by a platform. A public leaderboard alone is a weaker starting point if its strongest entries tie and no platform requires the score.

## The next experiment should be designed to disprove us

Do not keep editing a bot until it breaks. Select a real, owner-authorized bot or a versioned open-source strategy first, and document its normal use before inspecting attack results. Prefer a research-driven rebalancer or treasury executor with genuine external-data dependence. Use Flash as requested, but preserve the actual strategy, memory and authentication design. A local substitute model can validate plumbing; it cannot prove a Flash result.

**First, prepare without model spend.** Freeze the code, prompt, model identifier, tool schemas, mandate and task distribution. Map each of the 40 seeds to the real surfaces the bot reads. Keep “unexposed” distinct from “resisted”; do not add unnatural reading obligations just to claim 40/40 coverage. Exercise the tool adapter and vault with scripted actions. Archive the full private episode evidence: configuration hashes, vault records including `blocked`, transactions, task completion, actual spend and all errors. Retain the signed replay path as well as the model trace.

**Then, with an explicitly approved total budget and per-seed `--max-usd`, run three arms.** Use the unmodified published seed repeatedly, independent rewrites without prior target feedback, and adaptive rewrites with feedback. Match maximum target calls and attacker-token budgets as closely as possible; randomize execution order. State whether feedback is outcome-only or full trace. The third arm versus the second measures the value of adaptation; the third versus a single original-seed attempt does not.

**Validate winners on fresh runs.** Freeze the winning text before replay. Repeat the original and winning text across fresh ordinary worlds, then apply the same saved text to the same bot with Enforce enabled. Also replay the actual violating action against equivalent state under Enforce: a fresh stochastic model run might never attempt it. Test the hardened agent separately; its different prompt prevents attributing every improvement to its guard. Test benign tasks under each defense as well. Ten fresh replays per selected cell would be a useful exploratory starting point, not a promised statistical guarantee or an authorized run. Calculate costs before choosing the final count.

**Publish the actual verdicts.** Success requires a useful baseline bot, documented static exposure and repetitions, an adaptive unblocked mandate violation recorded by the vault, reproduction on fresh runs, and observed containment without losing the useful task. A malicious instruction merely quoted in the final reply is not success. A violation that loses zero value is still a policy failure, but must not be described as a drain. A single successful bot establishes possibility, not typical customer risk or the business.

**Stop honestly.** Precommit the budget and search horizon. If no strong-agent breach is found, publish that negative result and do not weaken the bot afterward under the same experiment name. If failures are only harmful trades within the mandate, acknowledge the mismatch with the current covered event. If customers already have adequate enforcement and do not value independent testing, reconsider the product rather than accumulating weak-model demos.

The spend threshold is currently a stop-between-calls mechanism, not a hard provider billing ceiling; one in-flight call may exceed it. Keep the 90-second episode limit, use provider-level spend controls where available, record estimated versus billed cost, and never try to circumvent an attacker model's refusal. [Budget code](../apps/arena/src/budget.ts), [CLI](../apps/arena/src/adaptive-cli.ts).

## What would change this assessment?

I would increase confidence after independently selected customer bots reveal reproducible, financially relevant failures; customers accept fixes or request repeat testing; and Bonded verifies containment with useful work preserved. I would increase confidence in insurance only after a specific residual covered event, credible exposure estimates and a workable fraud/correlation model are established.

I would reduce confidence if well-built customer bots keep passing, if their wallet providers already enforce all needed boundaries, or if discovered failures mostly sit outside Bonded's coverage. Those are valid outcomes. The immediate goal should be learning which of these worlds we are in, with a finite budget, rather than obtaining a dramatic exploit at any cost.

## Review notes

This research used source inspection, primary-source reading and a recount of saved experiment artifacts. It did not rerun the models, audit the contracts for security, verify a live OpenRouter balance, interview customers or validate actuarial pricing. `CLAUDE.md` points to `docs/PLAN.md`, which is absent; the specification and current source were used instead. Historical product documents contain stale implementation-status statements, so source code takes precedence for the mechanics discussed here.

Read the judgment, the coverage table and the proposed experiment together. The founder's decision is whether to test this narrower customer proposition before further investment in a universal score and insurance story.
