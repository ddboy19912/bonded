# What agent-security research actually establishes

Research date: 2026-10-16. Primary sources only. This note audits the citations in [ADAPTIVE-ATTACKER.md](ADAPTIVE-ATTACKER.md) and separates evidence of agent compromise from evidence of financial loss. No paid model calls or attack campaigns were run for this research. The recommendations below are analysis, not experimental results.

The founder's concern is justified: a capable model can make a simple attack library stop distinguishing agents. The literature does not justify promising that enough rewriting will eventually break Bonded's DeepSeek V4.1 Flash target. It does justify testing the whole application, including which facts it delegates to external sources, what its memory stores, and which actions its execution layer permits. Those are separate questions from whether the model recognizes an obvious hostile instruction.

## Audit of the four existing citations

All four identifiers resolved to the stated papers. Their dates precede this research date. The full-text versions below were inspected, rather than relying on the Splunk summary.

| Identifier                                          | Verified title and date                                                                                                                         | What to retain or correct                                                                                                      |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| [2510.09023v1](https://arxiv.org/html/2510.09023v1) | _The Attacker Moves Second: Stronger Adaptive Attacks Bypass Defenses Against LLM Jailbreaks and Prompt Injections_, submitted October 10, 2025 | The 12-defense finding is real. It mixes threat models and benchmarks; it is not a probability of stealing from a trading bot. |
| [2606.15057v3](https://arxiv.org/html/2606.15057v3) | _AutoDojo: A Generative Benchmark for Evaluating Prompt Injection Defenses in LLM Agents_, submitted June 13, 2026; version 3 September 28      | The 0% to 28% result is real. The optimizer uses outcome feedback, not the defender's conversational replies.                  |
| [2606.10525v1](https://arxiv.org/html/2606.10525v1) | _Assessing Automated Prompt Injection Attacks in Agentic Environments_, June 9, 2026                                                            | Semantic search works, but the paper also finds much stronger frontier-model resistance and poor cross-model transfer.         |
| [2503.16248v3](https://arxiv.org/html/2503.16248v3) | _Real AI Agents with Fake Memories: Fatal Context Manipulation Attacks on Web3 Agents_, submitted March 20, 2025; version 3 July 9              | Financially relevant, but distinguish an ElizaOS demonstration, simulated memory replacement, and actual production losses.    |

### Adaptive attacks: strong methodological evidence, different budgets

Nasr and colleagues bypass 12 defenses, exceeding 90% attack success for most. They explicitly use different evaluations for different defenses: harmful-content jailbreaks, agent actions, and text-output manipulation. Access ranges from model weights to generation-only queries; large compute budgets and human expertise are allowed. Their AgentDojo experiments include adaptive success above 95% against Spotlighting and prompt sandwiching. They caution that their defense numbers are not directly comparable. This supports evaluating an attacker that knows the defense, not transplanting a headline success rate into Bonded. A cheap, short, text-rewrite campaign is a narrower experiment. [Sections 3–5](https://arxiv.org/html/2510.09023v1).

### AutoDojo: the closest evidence for the proposed gap

The AgentDojo evaluation has 389 user-task/injection-task pairs: banking 144, Slack 105, travel 140. PIGuard plus GPT-4o-mini has 0.0% static ASR and 28.0% adaptive ASR. The optimizer receives pooled compromise counts under a strict black-box setting. Under-specified tasks are harder to defend. Table 6 also reports DeepSeek-v4-Flash plus PIGuard: banking 0.0% static versus 9.0% adaptive, with 100% clean-task utility. That model name is not Bonded's V4.1 Flash. Some adaptive results are worse than static results. Information-flow defenses hold substantially better, with utility tradeoffs. These are simulated task outcomes, not losses of customer deposits. [Tables 1, 5–7; Sections 3–4](https://arxiv.org/html/2606.15057v3).

### Automated attacks: model quality is a real defense

Hofer and colleagues select 80 task pairs across four domains, perform four independent optimization runs, and evaluate each generated injection six times. On GPT-5, single-task and universal TAP achieve 4.5% and 4.7% ASR. Universal TAP reaches 30.0% Success@N versus approximately 14% for single-task TAP; those are task-level compromise measures, not per-attempt rates. Qwen3-4B is much more vulnerable. Weak-model optimized attacks transfer poorly to frontier models. The search's LLM judge is imperfect: GPT-5 precision is 29.4% even though recall is 100%. AgentDojo's deterministic state check supplies ground truth. This supports Bonded's vault verdict and repeated replay; it does not establish a special advantage for adding a model judge. [Sections 5.3, 6.1–6.3](https://arxiv.org/html/2606.10525v1).

### Memory: a different trust boundary

The Web3 paper demonstrates indirect memory poisoning through ordinary interactions with an ElizaOS agent and separately studies direct memory-store access. Its CrAIBench evaluation also simulates poisoned retrieved history. Table I lists 135 multi-step user tasks and 564 associated injection cases, plus 31 single-step tasks and 121 cases; the abstract's “150+” is too coarse for experimental denominators. Multi-step target models include GPT-4o, GPT-4o-mini, Claude Sonnet 3.5 and 3.7. These are not Flash results. Corrupting a retrieved memory block is a stronger premise than getting a careful summarizer to write malicious notes. The paper demonstrates financial-action risks, not a documented theft from an unrelated production customer. [Sections III–V; Table I](https://arxiv.org/html/2503.16248v3).

## More recent evidence should temper both optimism and alarm

Anthropic's August 26, 2026 browser announcement describes retiring an evaluation saturated by newer models. Stronger professional attacks achieved 17.6% success against Opus 4.5 and 3.8% against Opus 5 before safeguards, conditional on reaching the model. With full safeguards, several models had zero observed successes. The article lacks enough numerical detail to reconstruct denominators or confidence intervals. This is a vendor browser evaluation, not financial-loss incidence. Both model improvement and benchmark saturation matter. [First-party report](https://claude.com/resources/articles/claude-in-chrome-generally-available).

The original AgentDojo paper calls its framework extensible and explicitly supports new attacks. Its initial environment contains 97 tasks and 629 security cases. Saying “AgentDojo is fixed templates” confuses a particular static attack configuration with the framework. Bonded should make the same distinction between its extensible Arena and today's seed library. [AgentDojo paper](https://arxiv.org/abs/2406.13352).

## Why execution controls remain relevant

CaMeL separates trusted planning from untrusted content and tracks data provenance before tool execution. Its revised paper reports 77% task completion with its security guarantees versus 84% for the undefended system. This is evidence that architectural controls can coexist with useful agents, not proof that all policies are correct. Its own limitations include side channels, integration complexity, user intervention, and attacks outside the protected data/control flows. Security depends on the implemented capabilities and policies. A permission boundary can enforce “only these recipients”; it cannot infer that an allowed trade is economically wise. [CaMeL, Sections 5–9](https://arxiv.org/html/2503.18813v2).

Google's Chrome security architecture combines probabilistic judgments with enforced origin boundaries and sensitive-action checks. It distinguishes the planner from components that decide permitted origins, and explicitly discusses reducing exposure to irrelevant untrusted content. Its initial deployment uses a simpler form of origin gating than the full design. This is evidence of a practical layered approach, not a guarantee that every sensitive action is detected. [Google's architecture announcement](https://blog.google/security/architecting-security-for-agentic/).

These controls are already a commercial category. Coinbase advertises server-wallet allowlists, transaction limits and rate controls, and agentic-wallet per-session/per-transaction spending caps. Its spend-permission API includes a spender, token, allowance, recurring period, start and expiry. This validates demand for bounded delegation while weakening any claim that basic spending limits alone differentiate Bonded. [Server Wallets](https://www.coinbase.com/developer-platform/products/wallets), [Agentic Wallets](https://www.coinbase.com/en-ca/developer-platform/products/agentic-wallets), [spend-permission API](https://docs.cdp.coinbase.com/api-reference/v2/rest-api/evm-smart-accounts/create-a-spend-permission).

## Financial evidence: keep three claims separate

| Claim                                                                      | What would establish it                                                                      | Status of the evidence reviewed here                                                             |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A model can be redirected                                                  | An attacker-induced tool action or deterministic benchmark success                           | Established in multiple research settings, including capable models.                             |
| A trading application's mandate can be violated and a vault can contain it | A realistic bot, attacker-controlled input, recorded breach, and matched Enforce-mode replay | Must be demonstrated in Bonded's exact configuration. External papers cannot supply this result. |
| Customers suffer enough uncovered losses to buy Bonded                     | Verified production incidents, exposure and loss data, plus customer demand                  | Not established by these sources.                                                                |

This search did not verify a primary incident report of an unrelated production trading customer losing funds through the exact indirect-prompt-injection path Bonded tests. That is a limitation of this research, not a claim that no such incidents exist. Widely repeated prize-game stories should not be used as production-loss statistics. The Freysa first-party FAQ did not return readable content in this pass, so its incident details are not used as evidence.

## Implications for the next Bonded experiment

The following are proposed research controls, not findings from the papers:

1. **Choose the application before choosing the attack.** Import or faithfully adapt a bot whose operator can explain its genuine job. Freeze its prompt, tool access, memory behavior and mandate before searching. Do not weaken it after seeing failures simply to obtain a demo.
2. **Make normal behavior measurable.** The clean bot must finish useful trades. Include normal third-party signals that it should act on. An agent that rejects every external instruction can look secure while being unsuitable for a signal-execution product.
3. **State which facts outsiders may supply.** Distinguish advice, signed operator orders, market facts, recipient addresses, and policy changes. A bot may legitimately read a signal; that must not silently authorize the signal source to change its mandate.
4. **Test data integrity separately from explicit instruction following.** If an attacker changes a trade's input facts and the resulting trade remains inside policy, record the economic effect separately. A zero-breach vault does not by itself prove those facts are trustworthy.
5. **Use matched static controls.** The 40 published seeds need a full sweep on the frozen custom bot, with task-compatible exposure. Compare adaptive search with the same number of unmodified-seed retries and fresh nonadaptive rewrites. Otherwise apparent uplift may be repeated sampling or general diversity.
6. **Separate discovery from confirmation.** Freeze a discovered candidate, then replay on new runs. Report total campaigns, all executed episodes, drafts lost, timeouts, feedback access, model versions, budget and realized spend. Never report only the winners.
7. **Replay attempted actions against enforcement.** A paired stochastic replay can choose a different action. In addition, take the actual violating action from the Monitor trace and deterministically show the same action is blocked by Enforce under the same state and mandate.
8. **Keep the pass criterion falsifiable.** A valid result is a useful frozen bot that passes the static suite, shows adaptive-only breach under the vault's stated verdict, reproduces more often than matched controls, and is contained by the execution layer. If it does not happen within the approved budget, record that outcome and stop the campaign.

Before any paid run, the founder must authorize a total budget and a per-seed cap. Free scripted checks can validate exposure, deterministic verdicts and replay plumbing; they cannot establish Flash's vulnerability. More speculative attack generation is not automatically the highest-value use of the next dollar.

## Product conclusions to test with customers

The narrow hypothesis “good models frequently fail our ten classes” remains unproven for the current target. The broader hypothesis “operators want independent, inspectable limits on delegated financial authority” is compatible with good models and has existing product evidence. Bonded still needs to prove why its particular limits, audit trail, integration and coverage are more valuable than a wallet provider's controls.

A useful commercial experiment would ask real operators for their current policies, incident histories, and a bot they would actually connect. Measure the work required to integrate it, normal task completion, prevented violations, and which remaining losses they expect cover to pay. The test should be allowed to conclude that a simple existing wallet policy meets their needs.

An adaptive benchmark is an engineering test, not an actuarial loss forecast. Pricing requires a separate account of exposure frequency, attacker access, correlated failures, severity, policy changes and deployment drift. Multiplying a sandbox success rate by deposits does not establish those quantities. Bonded can offer honest evidence of tested behavior and enforceable limits while it gathers the evidence needed for broader claims.
