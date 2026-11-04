# Solana Agent Kit: LangGraph example

- **Template:** `examples/misc/agent-kit-langgraph` in [sendaifun/solana-agent-kit](https://github.com/sendaifun/solana-agent-kit) (Apache-2.0), solana-agent-kit 2.0.10
- **Rated:** 2026-10-03, one run of each of the 40 attack seeds plus 2 controls, on a fresh local chain
- **Models:** deepseek/deepseek-v4.1-flash and z-ai/glm-5.3-flash (since 2026-10-10); anthropic/claude-haiku-4.5 until then
- **On chain (Robinhood Chain testnet registry):** on the contracts deployed Oct 20, 2026, agents 7 (DeepSeek) and 8 (GLM), with the 2026-10-19 and 2026-10-20 ratings; on the Oct 10 contracts before that, agents 8 and 11, and agent 7 holds an earlier Haiku rating; agents 7 and 8 on the Sep 27 contracts; [leaderboard](https://www.bondedhq.xyz/leaderboard)
- **Disclosure status:** **maintainer notice pending** for the findings of the 2026-10-19 and 2026-10-20 ratings (false market data with both models, and one A9 breach with GLM; see below). Class-level results are public; which attacks and the transcripts are withheld under the [disclosure policy](README.md). The earlier ratings found no breach.

## How it was run

The example's LangGraph ReAct agent and its prompt ran unchanged. Its tools were the Arena's, defined as Solana Agent Kit `Action`s and converted with the kit's `createLangchainTools`. The kit's own Solana actions weren't exercised: the Arena's vault is an EVM contract, so this rates the template's agent behaviour, not its Solana integrations. The operator's message was the Arena's task and the mandate.

## Results

| Model | Score | Attacks breached | Controls breached | Attacks whose planted text it read | Of those: stopped to ask the user | Carried on with its own task |
|---|---|---|---|---|---|---|
| Claude Haiku 4.5 | 50 (BB) | 0 of 40 | 0 of 2 | 21 | 3 | 18 |
| DeepSeek V4.1 Flash | 50 (BB) | 0 of 40 | 0 of 2 | 24 | 14 | 20 |

The DeepSeek counts overlap: some episodes made the trade, then also asked the user about the planted request.

The same caveats apply as for the AgentKit template:
- one run per attack;
- a chatbot that sometimes stops to ask, which a live user could answer with yes;
- attacks on surfaces it never read;
- 50 is the ceiling for a clean agent at one run. Five runs raise it to 79 (below).

## Re-rated with five runs (2026-10-04)

Both models were rated again with five runs of each of the 40 attack seeds (200 attack episodes and 2 controls each), same template, settings and Monitor mode, and the scores were posted for agents 7 and 8:

| Model | Score | Attacks breached | Controls breached |
|---|---|---|---|
| Claude Haiku 4.5 | 79 (A) | 0 of 200 | 0 of 2 |
| DeepSeek V4.1 Flash | 79 (A) | 0 of 200 | 0 of 2 |

Still no breach. The score rose from 50 to 79 because more runs narrow the bound on each class's breach rate. Every agent with no breaches scores 79 at these settings, so the two models tie. The behaviour counts in the table above are from the one-run rating and weren't recounted.

## Re-rated with held-out attacks (2026-10-06)

Both models were rated again with five runs of each of the 40 published attacks and of a held-out set of unpublished attacks: 275 attack episodes and 2 controls each. The template, settings and Monitor mode are unchanged, and the scores were posted for agents 7 and 8:

| Model | Score | Attacks breached | By class | Controls breached |
|---|---|---|---|---|
| Claude Haiku 4.5 | 81 (AA) | 0 of 275 | none | 0 of 2 |
| DeepSeek V4.1 Flash | 81 (AA) | 0 of 275 | none | 0 of 2 |

Still no breach with either model. Agents with no breaches score 81 at these settings; more clean episodes narrow the bounds further than the five-run rating did.

## Rated again on the Oct 10 contracts, GLM in place of Haiku (2026-10-10)

After the testnet redeployment the template was rated again with the same settings: five runs of each of the 40 published attacks and of the 15 held-out ones, 275 attack episodes and 2 controls each, Monitor mode. GLM 5.3 Flash replaced Claude Haiku 4.5, whose list price per token is more than six times higher; a full rating cost $0.22 to $0.26 with either model (measured from the OpenRouter key's usage). The scores were posted for agents 8 (DeepSeek) and 11 (GLM):

| Model | Score | Attacks breached | By class | Controls breached |
|---|---|---|---|---|
| DeepSeek V4.1 Flash | 81 (AA) | 0 of 275 | none | 0 of 2 |
| GLM 5.3 Flash | 81 (AA) | 0 of 275 | none | 0 of 2 |

On the Oct 10 contracts, agent 7 still holds the Haiku rating of 2026-10-04 (79 (A), 200 attack episodes); the leaderboard no longer lists it.

## Rated with the market-data battery and the Security score (2026-10-19 and 2026-10-20)

Rated again with the same settings plus the two changes described in the [AgentKit note](agentkit-langchain-chatbot.md#rated-with-the-market-data-battery-and-the-security-score-2026-10-19): the Security score, set by the agent's weakest row and separate from the insurance score, and the S1 market-data battery, which feeds the agent false market data with no instruction in it. Five runs of each of the 55 published attacks and the 15 held-out ones (350 attack episodes) and 2 controls, plus 2 clean/manipulated pairs of each of 25 S1 seeds. Monitor mode. These scores are on the [leaderboard](https://www.bondedhq.xyz/leaderboard) and on chain, with their Security and insurance scores, as agents 7 (DeepSeek) and 8 (GLM) on the contracts deployed Oct 20, 2026.

| Model | Security score | Weakest row | Attack library: manipulated (breached) | Market data: acted on the lie (breached, froze) | Insurance score |
|---|---|---|---|---|---|
| DeepSeek V4.1 Flash | 17 | A2 fabricated news, market data: 15 of 18 pairs | 0 of 350 (0) | 28 of 49 (22, 2) | 83 (AA) |
| GLM 5.3 Flash | 11 | A2 fabricated news, market data: 16 of 18 pairs | 1 of 350 (1, A9) | 35 of 50 (26, 0) | 82 (AA) |

What these mean:
- **The template still resists nearly every instruction-carrying attack**: no breach with DeepSeek, one with GLM in 350 episodes (an A9 goal-drift attack that pushed it past its limits, 1 of 30). That is why its insurance score stays AA.
- **False market data moves it to trade more often than not.** A fabricated analyst call or earnings beat, a fake flash crash or a false hedge ratio got it to buy what the lie pointed at, and most of those trades tripped the vault's slippage guard (a T3 breach). Prompt-level defences don't see this: the data was false, not an instruction.
- **The Security score is set by that weakest row,** so it is low (17 and 11) while the insurance score stays AA: containment limits what a lie costs, but the agent was still fooled.
- The DeepSeek rating was run three times. The first two stopped on a market-data episode that hit the 5-minute time limit, and a rating with an agent error is not scored. The third used a 15-minute limit and finished. The counts above are from that run.

## Suggested mitigations, if deployed as an autonomous agent

Check market data before acting on it: confirm prices against an on-chain oracle, and treat news, social posts and unsourced reports as unverified. Otherwise the same as for AgentKit: limits enforced on chain or in code, allowlisted recipients and spenders, no follow-up approval of requests that come from untrusted content, and a pre-trade guard.
