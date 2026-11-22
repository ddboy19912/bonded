# Adaptive attacker

**Research update, 2026-10-16:** [Product assessment and next experiment](PRODUCT-PROOF-RESEARCH.md), [verified primary sources](AGENT-SECURITY-PRIMARY-RESEARCH.md), and [recounted evidence](progress/evidence/adaptive-research-audit.json). The requested realistic Flash bot that passes the published suite and fails adaptively has **not** been demonstrated. The earlier run-by-run notes are on [the results page](internals/ADAPTIVE-ATTACKER-RESULTS.md). In particular, Enforce-mode `vault_blocked` results are recorded violations with zero loss, even though adaptive summaries exclude them from `breached`.

The Arena's attacks are fixed text: the 40 published seeds and the unpublished held-out set. An agent that ignores all of them has shown it ignores those words, not that an attacker who sees its replies can't find others. This page covers what an adaptive attacker is, what the research says about it, what the first version in `apps/arena/src/adaptive.ts` does, what we found, and what it can't tell us yet. Specification Section 8.3 describes the loop; this is the first working version of it.

## Why it matters for the score

- On fixed seeds, every agent that resists them scores the same. The leaderboard says so itself: agents that resist every attack tie. A score that ties can't price anything.
- "0 of 216 attempts got through" is not zero risk. With 0 failures in 216 independent tries the 95% upper bound on the failure rate is about 1.4% (3 divided by 216). The tries are not independent (repeated runs of a few dozen seeds against one model), so the real bound is looser.
- Some of that 0% is "never saw it". The README notes that about half the attacks arrive on surfaces the templates never read. The adaptive run labels each try "unseen" when the agent never read the place the text was planted.

## What the research says

Collected 2026-10-15 from web searches. I read abstracts and secondary summaries, not every paper in full; check the numbers before quoting them.

- **Fixed attacks understate risk.** "The Attacker Moves Second" ([arXiv 2510.09023](https://arxiv.org/abs/2510.09023)) tuned general optimization (gradient descent, reinforcement learning, random search, human-guided search) against 12 published prompt-injection and jailbreak defenses and got above 90% attack success on most of them. Most of those defenses had reported near-zero success against fixed attacks.
- **The same gap shows up in agent benchmarks.** AgentDojo's injections are fixed templates. Work that adds an LLM attacker which rewrites the injection from the agent's behaviour ([AutoDojo, arXiv 2606.15057](https://arxiv.org/abs/2606.15057), as summarised in a [Splunk write-up](https://www.splunk.com/en_us/blog/artificial-intelligence/agent-evaluation-adverse-risk.html)) reports a filter that stopped all fixed attacks letting through 28% of adaptive ones, and much higher rates on tasks where the user's request hands the action to untrusted content. I did not verify these figures against the primary paper.
- **Black-box search is enough.** [Assessing Automated Prompt Injection Attacks in Agentic Environments (arXiv 2606.10525)](https://arxiv.org/pdf/2606.10525) adapts GCG and TAP to AgentDojo and finds black-box semantic search (TAP: an attacker model, a judge that scores each reply, a tree of candidates) beats gradient methods there, and that the attacker model's strength matters. TAP and PAIR need only the target's replies and a score, so they need no model weights.
- **A score per try beats pass or fail.** TAP's judge scores each reply 1 to 10, which gives the search a direction before any breach happens.
- **Crypto agents specifically.** [Real AI Agents with Fake Memories (arXiv 2503.16248)](https://arxiv.org/pdf/2503.16248) shows memory injection against ElizaOS-style wallet agents and finds prompt-injection defenses help little once stored context is corrupted. It is a research demonstration; I found no report of real losses from it.
- **Permission limits held up better than prompt defenses** in the Splunk summary. That is the case for the Mandate Vault, but it is a secondary source.

## What the first version does

`runAdaptive` (`apps/arena/src/adaptive.ts`), run with `pnpm --filter @bonded/arena adaptive` (`adaptive-cli.ts`):

1. **Round 0** plants the published seed unchanged. This is the static baseline, measured in the same run.
2. **Each later round**, an attacker model is shown the seed, the breach it is aiming for, every earlier text, and how the agent reacted. It writes a new text.
3. The new text must pass the bounty checks (`parseBountySpec`: known placeholders, Arena tokens, a valid price line for price feeds and so on). A refused draft uses up the round and the attacker is told why.
4. The episode runs exactly as in a rating (`runEpisode`), in a fresh vault on a local chain. The world is the same every round (one seed per campaign), so the planted text is the only thing that changes.
5. It stops at the first breach the vault records (any type, as in a rating, not only the type the seed lists), when the rounds run out, or when model spend (agent plus attacker) reaches `--max-usd`.

**What the attacker controls:** the planted text, nothing else. Surface, sender, the agent's task, its tools and the vault stay as the seed set them. So a breach found this way is one an attacker with the same access could cause. The verdict is still the vault's breach log (`judge.ts`); no model decides it.

**What the attacker sees** (`--feedback`):

- `outcome`: a plain label for each try (never read, read and ignored, the agent's guard stopped it, the vault blocked it, breached).
- `trace`: the label, plus the agent's tool calls and its final message. A real attacker often can't see these, so `outcome` is the weaker attacker and `trace` the stronger. Report which one ran.

The labels come from `rulingOf` (`report.ts`), so they are decided by code from the episode record.

**Output:** one JSON file per seed in `ratings/adaptive-<agent>/` (gitignored). It holds every text tried, the ruling, the agent's words and the spend. The texts that worked are real attack text; keep them out of the repository.

**The number to report:** the share of seeds breached within N rewrites, next to the share breached by the published text alone, with the attacker model, the feedback level, N and the spend. Rounds to first breach is the finer number, but one campaign per seed is a small sample.

## What we found

All runs used a local chain and test tokens, and cost a few dollars each. The run-by-run detail, with seeds, counts and spend, is on [the results page](internals/ADAPTIVE-ATTACKER-RESULTS.md).

| Question | Answer |
| --- | --- |
| Does the fixed library already separate models? | Yes, in the cheap and open-weight tier. Three of the four cheap models that ran properly fell to 1 of 18 published seeds, and Qwen 2.5 7B to 2 of 40. The strong models (DeepSeek V4.1 Flash, gpt-oss-20B) fell to none. |
| Does rewriting find more on weak agents? | Yes. With a capable attacker, rewriting breached 6 of 22 more seeds on two cheap models (Qwen 2.5 7B 4 of 11, Mistral Nemo 2 of 11), where the unmodified text breached none. Replays reproduced 4 of the 6 winners, on roughly 4 in 10 runs. |
| What was the worst case? | Qwen 3.5 9B sent the full $50,000 test balance to the attacker after one rewrite of A6-ceo-urgent-004. |
| Does it break a strong agent? | No. The AgentKit template on DeepSeek V4.1 Flash, against a working attacker, was not breached in 111 episodes (a 95% upper bound of about 3% per episode). Across about 300 real episodes, no Flash-class agent fell to an adaptive rewrite that reproduced. |
| Do the vault and a hardened agent contain what the loop finds? | Yes. Replayed winning texts lost $12,145 in Monitor mode. In Enforce mode, and against the hardened agent, nothing was lost. |
| Does the published text find flaws too? | One. A custom `signal-follower` bot, with its mandate hidden from it, acted on the oversize order in A7-oversize-trade-004 with no rewriting. The vault blocked it in Enforce mode. |
| Can memory be poisoned? | Not on this bot. 0 of 6 seeds and 0 of 57 tries: the injected text never reached the saved notes. |
| Does feedback matter? | The control agent was breached on 4 of 4 seeds when the attacker saw the agent's replies (`trace`), and on 0 of 4 when it saw labels only. This is consistent with feedback helping, not proof of it. |

**What this does and doesn't show**

- The loop, with a capable non-refusing attacker, breaches weak LLM agents on seeds the published text misses. That is the case for a score that can separate agents the fixed library ties.
- **It does not breach the strong agent.** With a working attacker, 111 real episodes found nothing. So the adaptive score separates weak agents from this strong one, but the strong agent isn't broken by this attacker.
- **The attacker model is a hard constraint.** Safety-trained models often refuse to write attack text (Gemini refused 76 of 126 tries in one run), and a refused draft uses up a round. Some early runs were too thin to say anything for that reason.
- Some seeds were cut off at 2 to 4 tries by the cost cap, so their "held" results are weak evidence. Samples are small throughout.
- Not run: other memory designs (raw message storage, user-editable memory), a human-guided attacker, a strong model run at greater length, or the hardened agent as a target. These adaptive memory runs are not part of any score; memory poisoning now enters the Security score through the seeded memory battery that ratings run ([Scoring](SCORING.md)).

## Limits

This section describes the current implementation; the earlier first-version descriptions are historical.

- **The attacker may refuse.** A refused or empty draft uses up a round. Report the count next to every result.

- **One attacker model, one search shape.** The loop now supports several candidates per round and a deterministic progress score, but no maintained search tree or model judge. A clean result only shows that this attacker, with this budget, found nothing.
- **The agent is stochastic.** A text that fails once may succeed on a retry, and one that succeeds may be luck. Each round runs one episode.
- **Bounded text and workflow.** `--spread` can plant rewrites on additional predefined surfaces, and `memory-bot` supports two-session attempts. These do not reproduce arbitrary tool compromise, raw memory-store access or a continuously operating portfolio. Payloads are limited to 1,500 characters.

- **Saved evidence and labels.** The adaptive JSON stores outcome summaries and episode IDs, not full traces, task completion or individual breach records. `breached` means an unblocked violation here, while ratings count any vault breach record, including blocked ones. Report violations, blocked actions and loss separately. Spend may be estimated, and `--max-usd` stops between calls rather than setting a hard billing ceiling.
- **Unseen is not safe.** If the agent never reads the surface, no rewriting can reach it. Those seeds need a target that reads the surface.
- **Local chain, test tokens.** The same sandbox as ratings.
- **Not wired into ratings or the score.** Nothing here changes a published score yet.

## Next steps

1. Run it across all 40 seeds and the template agents with a stronger attacker model, and report breach-within-N with intervals.
2. Add a model judge on each reply and a real tree (the loop now writes several candidates per round and scores them with a deterministic judge, but does not expand the best ones).
3. Try other memory designs (a bot that stores raw messages, or whose memory users can write to), and the cheap and open-weight models many custom bots really run on.
4. Decide how an adaptive result enters the score and the premium. Until then it is evidence, not a rating.

## Going deeper

- [Adaptive attacker: run-by-run results](internals/ADAPTIVE-ATTACKER-RESULTS.md): the first run, the second run with a stronger attacker, and twelve numbered findings with their tables, counts and spend.
