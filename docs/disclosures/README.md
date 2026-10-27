# Responsible disclosure

The public leaderboard rates open-source agent templates in the Arena. A low score on a popular template is a finding about software other people run, so results are published in a way that helps users without handing anyone a working exploit.

## What is public, and when

| Detail | Public |
|---|---|
| Score, tier, expected loss and premium | At once |
| Breaches per attack class (e.g. "A2: 3 of 4 episodes") | At once |
| The template, model and date rated; the on-chain attestation | At once |
| Which attack seeds broke the agent, and the episode transcripts | Only after the maintainers have been told **and** either they have fixed it or **30 days** have passed |
| Bounty submissions' payloads (docs/BOUNTIES.md) | Never on the board; the same 30-day rule applies to findings they produce |

The attack seeds themselves are already public in `attacks/`. What the policy protects is the mapping from a specific template and model to the exact inputs that drain it, and the transcripts showing how.

A rating that finds no breach withholds nothing: its note is published at once (`disclosure.status: published`). A rating that does find a breach is `pending`: its class-level result is public, and the details wait until the maintainers have been notified.

## Before an entry goes public with findings

1. Rate the template unchanged: its published prompt and loop, with only its tools pointed at the Arena.
2. Write a note in this folder: what was tested, the class-level results, and the suggested mitigations.
3. Send the maintainers the note, through the project's security policy (`SECURITY.md`) if it has one, otherwise a GitHub security advisory or a private email. **Never a public issue with details.** A person at Bonded sends it; Bonded's tooling never contacts anyone by itself.
4. Record the date in the entry (`disclosure.status: notified`, `notifiedAt`). Until then, the page shows "maintainer notice pending".

## Framing

Every note says the same three things, because each is true:
- **These are templates.** They're starting points, not products, and they're built to show what an agent can do, not to defend it. A breach shows what happens when one is deployed as is.
- **The model matters.** The same template can score differently on another model. Every entry names the model rated.
- **The fix is mostly outside the prompt.** Mandate limits enforced in code or on chain, an allowlist of tools and recipients, and a pre-trade guard (Bonded's Sentinel is one) stop these classes, whatever the prompt says.

## Off-chain findings

The same policy covers the off-chain rail: agents that pay invoices and move money through a payment API. The class-level and vector-level result is public at once; the exact attack, the transcript and the generated text wait for the maintainers. Off-chain findings also carry a rule against publishing a phishing kit: no real targeting data, no ready-to-send campaign text, no mass-generation prompts and no delivery infrastructure. That rule is written out in [Off-chain disclosure and publication policy](OFFCHAIN.md).

## Notes

- [Off-chain disclosure and publication policy](OFFCHAIN.md)
- [Coinbase AgentKit, LangChain chatbot template](agentkit-langchain-chatbot.md)
- [Solana Agent Kit, LangGraph example](solana-agent-kit-langgraph.md)
