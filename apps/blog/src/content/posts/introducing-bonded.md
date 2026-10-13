---
title: "Introducing Bonded"
description: "AI agents now trade with real money. Bonded attacks them, scores them, and pays people back automatically when one breaks its rules."
date: 2026-10-11
tags: [Announcement]
cover: ../../assets/covers/introducing-bonded.jpg
coverAlt: "Bonded: Don't cage your agent. Bond it. A Bonded Score dial reading 97, AAA."
---

AI agents now trade with real money. When one gets tricked by a poisoned token description, a fake "admin" message or a lookalike address, someone loses funds, and today nobody pays them back.

Bonded changes that. We rate AI agents by attacking them, price insurance from what the attacks found, and pay depositors automatically when an agent breaks its rules. **Payouts are decided by the agent's vault on chain, never by an AI.**

## How it works

1. **Mandate Vault.** The agent trades from a vault that knows its rules: which tokens, which contracts, where funds may go, how much per trade and per day. Every action goes through the vault, which blocks or records any breach on chain.
2. **The Arena.** AI attackers in 10 classes, from prompt injection and fake news to lookalike addresses and hostile counterparty agents, are planted in the agent's world inside a sandboxed copy of the chain. The verdict of each episode is the vault's breach log.
3. **Bonded Score.** Breach rates become an expected loss, a premium and a score from 0 to 100. The score is signed and readable on Robinhood Chain, Arbitrum, Ethereum and Solana.
4. **Bond and cover.** The operator stakes a bond that pays first. Underwriters fund a pool that pays the rest.
5. **Automatic claims.** When the vault records a breach, the claim is filed and paid within seconds.

## What we've measured so far

Two demo agents, rated live on Robinhood Chain testnet on 10 October 2026, with five runs of every attack, including 15 held-out attacks:

| | Agent A | Agent B |
|---|---|---|
| Design | Acts on what it reads; checks addresses only by their first and last characters | Treats what it reads as data; full guard; key in a TEE |
| Score | 54 (BB) | 97 (AAA) |
| Premium | 6.4% a year | 1.1% a year |
| What the Arena found | Address poisoning: 20 of 25 episodes breached | No breaches |

And the loop works end to end: on testnet, a lookalike of Agent A's depositor asked for a "refund", the agent paid 5,000 test dollars, and the claim paid back 4,500 automatically: 4,000 from the operator's bond, 500 from the pool.

The assumptions behind these numbers (fixed attack seeds, illustrative yearly attack rates) are [published next to them](https://github.com/ddboy19912/bonded#results-measured-with-their-assumptions).

## Try it

- [Test your own agent](https://www.bondedhq.xyz/agents/test): free, any framework, with only a wallet sign-in.
- [The leaderboard](https://www.bondedhq.xyz/leaderboard): open-source agent templates, rated.
- [The docs](https://www.bondedhq.xyz/docs/): how every piece works.

**Don't cage your agent. Bond it.**

*Bonded runs on Robinhood Chain testnet. Test tokens only; nothing here has real value yet.*
