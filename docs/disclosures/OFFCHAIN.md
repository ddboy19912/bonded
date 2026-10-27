# Off-chain disclosure and publication policy

Bonded's off-chain rail rates agents that pay invoices and move money through a payment API (`docs/OFFCHAIN.md`). A low score there is a finding about software and prompts that other people run, often inside a finance team. This page covers how those findings reach the agent's maintainers, and what Bonded will never publish about them.

It extends the on-chain [disclosure policy](README.md) rather than replacing it. The same rule applies to both rails: publish what helps users, withhold what hands someone a working attack.

## What is public, and when

| Detail | Public |
|---|---|
| Score, tier, expected loss and premium | At once |
| Breaches per attack class and per vector (e.g. "O1: 3 of 12 episodes, 2 over SMS") | At once |
| The agent, model, date and settings rated; which briefings were run | At once |
| Which staged or held-out attacks broke the agent, and the episode transcripts | Only after the maintainers have been told **and** either they have fixed it or **30 days** have passed |
| The wording of fresh variants, adaptive rewrites, held-out attacks and counterparty replies | Never |
| The generation prompts and model outputs behind those variants | Never, except a test-world image's provenance, committed so a rating can be replayed |

A rating that finds no breach withholds nothing. A rating that finds one is reported at class and vector level at once, and the specific attacks wait for the maintainers.

The published attack library (`attacks/`, and the staged seeds in `apps/arena/offchain-seeds-staged/`) is different: those seeds are test cases, written for a fictional business, and they are public by design. What stays private is the mapping from a real agent to the exact wording that drains it, and the generated text around it.

## Telling the maintainers

1. Rate the agent as its operator runs it. For an open-source template, that means its published prompt and loop with only its tools pointed at the Arena. For a hosted agent, that means the endpoint and settings its operator gave.
2. Write a note in this folder: what was tested, the class-level and vector-level results, and the mitigations that would have stopped it.
3. Send it privately, through the project's `SECURITY.md` if it has one, otherwise a GitHub security advisory, the vendor's security contact, or a private email. **Never a public issue, a public pull request or a social post with the details.** A person at Bonded sends it. Bonded's tooling never contacts anyone by itself.
4. Record the date in the note (`disclosure.status: notified`, `notifiedAt`). Until then the page says "maintainer notice pending".
5. Publish the specific attack and the transcript only when the maintainer confirms a fix, or 30 days after notice, whichever comes first. If the maintainer is actively fixing it and asks for more time in writing, Bonded may extend the window and says so on the note.

An adaptive run writes a draft note beside its result, and `offchain-findings --results <dir>` rebuilds it from saved results (docs/OFFCHAIN.md, "Findings feed disclosure and bounties"). The draft carries the class and vector result only. A person reviews it, adds the maintainer's contact, and sends it. The tooling never sends anything.

If a finding suggests an attack already running against real businesses, tell the maintainer and, where it helps, the payment provider first. Publish the mitigation advice without the payload.

## The rule against publishing a phishing kit

Bonded does not publish a phishing kit, and does not help anyone else publish one. This applies to the repository, the docs site, the leaderboard, papers, talks, posts, support replies and bounty decisions.

A **seed** is a test case. It is one message or document, set in a fictional business, with accounts, references and senders that exist only in the test world. It is written to test one rule and to be replayed exactly.

A **kit** is anything that turns a seed into something runnable against a real business. That includes:

- real targeting data: a real vendor, executive, employee, mailbox, phone number, bank account or invoice;
- ready-to-send text aimed at a real organisation, or a template that only needs a name filled in;
- mass-generation prompts, fine-tunes or scripts that produce campaign text, especially ones tuned to get past a model's or a vendor's filters;
- multi-channel playbooks that sequence chat, tickets, voicemail, text, portal, plugin, memory, agent and knowledge-base messages into one campaign;
- delivery infrastructure: sending code, lookalike domains or mailboxes, call or SMS gateways, credential or payment capture, or QR codes that point at a real account;
- a transcript, adaptive rewrite or held-out variant that shows a named agent failing to a named input.

Never publish any of those. In practice:

- Fresh variants, adaptive rewrites, held-out sets and counterparty replies stay in the gitignored `ratings/` folder or the private held-out directory outside the repo. They are not pasted into issues, pull requests, PR descriptions, commit messages, docs, slides or chat.
- A result may quote a public seed, because the seed is already public and uses the test world. It may not quote generated text that surrounds it.
- An image's provenance file (`<file>.json`) is committed only for a test-world picture, with test accounts and `.example` addresses, so a rating can be replayed. It is not published on the site and is never written against a real business.
- A mitigation note may describe the pattern ("a bank change confirmed only by text message") and the control that stops it ("verify the account against a finance ticket"). It may not include the message that worked.
- A public example is sanitised before it leaves the repo: fictional names, `.example` domains, test account numbers, no real dates, no real invoice references.

## Real businesses and real people

- Use `.example` domains, fictional company names and test account numbers in seeds, variants and tests. A real vendor, colleague or account never appears in attack text.
- Never use a real person's name, voice, mailbox or signature, even from a public source.
- A voicemail twin or seed may imitate a role ("the CEO"), not a real individual.
- Do not test against a live payment account, a real supplier portal or a real inbox. Ratings run in the Arena's sandbox.
- Bonded never asks a maintainer, researcher or bounty hunter for bank details, card numbers or a third-party payment account. Bounty rewards are paid on chain to the hunter's wallet, as the bounty board records (docs/BOUNTIES.md).

## Bounty hunters and outside researchers

- A bounty payload is private on the board and in the API, and the same 30-day rule applies to any finding it produces (docs/BOUNTIES.md).
- An adaptive rewrite that beat an agent is a **bounty candidate** for the off-chain library, written privately beside the result. It is not an on-chain bounty submission: the `BountyBoard` takes on-chain attack specs only. A person reviews the candidate and moves it into `offchain-seeds-staged/` if it should join the library.
- A submission that is only a kit, or that needs a real target to work, is rejected. So is one that copies a held-out attack.
- A researcher who asks for the payload behind a published finding is refused, politely, and pointed at the class-level result and the mitigation.
- Bonded does not accept payment details from outside contributors and does not send money anywhere except the bounty board's on-chain reward.

## If a kit is published anyway

If attack text, a transcript or a generation recipe reaches the public by mistake, Bonded removes it where it can, tells the affected maintainer, and records what happened. A bounty hunter or contributor who publishes a kit loses eligibility for rewards and may be blocked from the bounty board. A maintainer who publishes a working payload against another vendor's agent is handled the same way as any other report of abuse.

## Where the findings live

| Material | Where |
|---|---|
| Public seeds and staged seeds | The repo (`attacks/`, `apps/arena/offchain-seeds-staged/`) |
| Index variants | `apps/arena/offchain-index/variants/`, committed so every model meets the same set |
| Fresh variants, adaptive rewrites, episode traces | `apps/arena/ratings/` (gitignored) |
| Held-out sets and their `ledger.txt` / `spent.txt` | A private directory outside the repo, by default `~/.config/bonded/offchain-held-out` |
| Disclosure notes | This folder |

## Scope

This policy applies to Bonded staff, contractors, bounty hunters, and anyone using Bonded's tooling or results to describe an attack. It covers both rails. Where it is stricter than the on-chain policy, it wins for off-chain findings.

## Notes

- [Responsible disclosure for on-chain ratings](README.md)
- [Community attack bounties](../BOUNTIES.md)
