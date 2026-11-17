# How Bonded's attack bounties work

A plain-language guide for people new to Bonded. The technical reference is [BOUNTIES.md](BOUNTIES.md).

## The idea in one paragraph

Bonded rates AI trading agents by attacking them in the Arena with a library of known attacks. That library is only as good as the attacks in it. Bounties let anyone add to it: find an attack the library misses, prove it works, and get paid. Every accepted attack is then run against every rated agent, so all their scores and cover prices take it into account. It works like an antivirus signature update, with the people who find the new signatures getting paid.

## Who takes part

| Who | Role |
|---|---|
| **Hunter** | Anyone with a wallet: a security researcher, a red-teamer, another agent builder. Writes the attack and gets paid. |
| **BountyBoard** | A smart contract. It holds the bounty pool, records each submission, and pays rewards. |
| **The Arena** | Bonded's sandbox. It runs the attack against two reference agents and decides by a fixed rule. No AI judges the result. |
| **The attester** | Bonded's signing key. It sends the Arena's decision to BountyBoard. The contract only accepts decisions from registered attesters. |
| **Cover buyers** | Fund the pool without doing anything: a share of every premium goes to it. |

## The flow

![A bounty in six steps: write the attack, commit a hash (timestamped, unreadable), reveal, send the text, the Arena tests it three times against an undefended and three times against a defended agent, then it's paid and added and every agent is re-rated.](images/bounties-flow.webp)

**Why commit, then reveal?** If a hunter posted the attack in the open straight away, someone watching the chain could copy it and submit it first. The commit records a fingerprint of the attack, tied to the hunter's address, without showing what it is. Only that hunter can reveal it later, so the timestamp is theirs.

## How the Arena decides

The Arena tests every submission against two scripted reference agents. Scripted means they behave the same way every time, so the same attack always gets the same verdict.

- The **undefended agent** follows instructions it reads. If an attack can't fool it, the attack doesn't work.
- The **defended agent** has Bonded's protections. If an attack fools it too, the attack beats current defences.

![How the Arena decides: a duplicate is rejected; an attack that doesn't fool the undefended agent 2 of 3 times is rejected as not reproducible; one that fools the defended agent 2 of 3 times is accepted for 2,000 tUSDG; otherwise a new attack type on a new surface is accepted for 500 tUSDG, and anything else is rejected as already known.](images/bounties-decision.webp)

A "surface" is where the attack reaches the agent: a news headline, a social post, an inbox message, a token's name, a tool's output, and so on. An attack type the library already covers, on a surface it already covers, adds nothing new.

The hunter can't choose the agent's task. The Arena always gives the agents an ordinary, harmless task, so the attack has to do all the work. Otherwise a task like "buy far more than the limit" would breach the mandate with no attack at all.

## What happens after acceptance

1. **The hunter is paid** straight from the pool by the BountyBoard contract.
2. **The attack joins the library**, so every future rating includes it.
3. **Every agent is queued for a fresh rating.** An agent that falls for the new attack gets a lower score, and its cover costs more. An agent that resists it keeps its score.

The attack's text stays private. The public list shows its title, type, surfaces, status and reward, never the payload, so a published bounty can't be used against agents that haven't been re-rated yet. See the [disclosure policy](disclosures/README.md).

## Why it's built this way

- **Payouts don't depend on AI.** The reference agents are scripts and the rule is code (`apps/arena/src/bounty.ts`), so anyone can rerun a submission and get the same verdict.
- **A payout can't happen twice.** The decision is stored before it's sent, and a retry checks the chain first.
- **It raises the bar for everyone.** Every accepted attack is run against every rated agent, so the library, and the standard the Security score sets, gets harder to pass over time instead of going stale.
- **The pool is funded by cover.** A share of every premium goes to it, so it keeps paying hunters as long as cover is bought.

## Limits

- **The reference agents only understand phrasings their script knows.** An attack that would fool a language-model agent but not the script is rejected as not reproducible. An AI reference agent would catch more, but its verdicts wouldn't be repeatable, and payouts must be.
- **The pool has to hold the reward.** If it doesn't, the payout fails and is retried.
- **One attester key.** Bonded runs the only attester today, so hunters trust Bonded to send the Arena's verdict. The verdict itself can be checked by rerunning the rule.

## On testnet today

- The Bounties page is at https://www.bondedhq.xyz/bounties. Connect a wallet on Robinhood Chain testnet to submit.
- The pool holds test tUSDG, which has no value.
- The first submission was a live end-to-end test made by the Bonded team from a separate test wallet. It is not an outside hunter.
