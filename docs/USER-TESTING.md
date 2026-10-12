# Testing "bring your own agent" with real builders

A short kit for watching 3 to 5 people connect their own agent to Bonded, so we fix what they hit before announcing. It isn't on the docs site.

## Who to invite

People who already have an agent's code and run it themselves: a forked ElizaOS, Coinbase AgentKit, LangChain/LangGraph or Vercel AI SDK template, or their own bot. Mix:
- at least one who runs it on a laptop and one who has it online (a server, Railway, Vercel);
- at least one who isn't a full-time developer (changes settings and prompts more than code).

They need a browser wallet. Testnet only: no real money.

## Before the session

- Their agent runs and does something today (on its own, without Bonded).
- Nothing else installed in advance: setup is part of what we're testing.
- Ask them to share their screen and think out loud. Record only with their permission.

## The session (about 45 minutes)

Give them only this, and say as little as possible after it:

> "On www.bondedhq.xyz, find out how safe your agent is. Then, if you'd use it for real, set it up so its money is protected and insured."

Watch, don't help. If they're stuck for more than 3 minutes, give the smallest hint you can and note exactly where and why.

Note the time at each milestone:

| Milestone | Time | Stuck? Where, and what they said |
|---|---|---|
| Found "Test your agent" | | |
| Signed in | | |
| Chose framework and where it runs | | |
| Connected (runner connected, or URL verified) | | |
| Connection check passed | | |
| Started the preview | | |
| Read the report and named one fix | | |
| Applied a fix and rated again | | |
| Made it official (onboarding done) | | |
| Agent's first trade through the vault | | |
| Bought cover | | |

## Questions at the end

1. In one sentence, what does Bonded do for you?
2. What was the most confusing moment?
3. Was anything asked of you that you didn't understand?
4. Did the report tell you what to change? What would you change first?
5. Would you put real money behind this agent with Bonded's cover? What would stop you?
6. What would you tell a friend about it?
7. On a scale of 1 to 10, how likely are you to use it again? Why that number?

## After each session

- Open one GitHub issue per problem, labelled `user-test`, with the milestone, what they did, what they expected, and a screenshot or the exact message they saw.
- Mark which problems more than one person hit: fix those first.
- Don't change the product between sessions unless something blocks everyone; otherwise later sessions can't be compared.
