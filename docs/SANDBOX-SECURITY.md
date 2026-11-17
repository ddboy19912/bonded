# Sandbox security

How Bonded keeps a test of your agent honest, and what can still tell its sandbox apart from production. The short guide is [BRING-YOUR-OWN-AGENT.md](BRING-YOUR-OWN-AGENT.md).

## Security model

Your agent is untrusted, and so is the gateway from your side. Agent URLs, previews and checks also let anyone make Bonded do work or call out, so each of them is authenticated, rate-limited and size-limited.

**What Bonded calls.**
- Your Agent URL, with `POST`s of exactly three kinds (verify, episode, cancel), each signed with Bonded's key for the wallet that saved the URL, with the limits and URL rules above.
- Your webhook, with a signed `POST` when a rating ends.
- Your TEE's evidence endpoint (`GET …/attestation`), for a TEE-bound agent.
- Nothing else of yours. Bonded never follows a redirect, never calls a private or internal address, and never calls its own hosts on your behalf.

**What Bonded never does.**
- Run your code. The runner runs the command you gave it, on your machine; an Agent URL runs on your server.
- See your code, your wallet, your production key, your model or your prompts. It sees what your agent does in the episode: its tool calls and transactions, what it reports at `/done`, and (runner) the last 4 KB of its output.
- Give your agent the runner token, or send the token anywhere but an https gateway (or one on this machine).
- Return a secret twice. Webhook secrets are shown once and kept only encrypted (AES-256-GCM, bound to the row they belong to); runner tokens, session tokens and capability tokens only as SHA-256 hashes.
- Show a rating's verdicts while it runs, or anyone's check, preview or rating stream to anyone but its owner.
- Let anything your agent, runner or TEE reports (exit codes, final messages, usage, a code hash) change a verdict.

| | Can | Can't |
|---|---|---|
| **Your agent**, in an episode | Call that episode's tools; in chain mode, read the sandbox chain and send signed `execute` calls to the episode's vault; say it's done | Reach any other episode (each has its own capability URL: 32 random bytes, dead when the episode ends); change chain state any other way (cheat, admin, signing and unlocked-account methods are refused); act as another account (transactions must be signed by the episode's key); send ETH; exceed the step cap or the limits above; read attack content from the chain (it is only ever in the tools) |
| **The gateway** | Send your runner an episode or a cancel; `POST` signed verify, episode and cancel messages to your Agent URL | Choose what runs: the runner only ever runs the command you gave it. See your code, your wallet or your production key |
| **The runner** | Start and stop your command; forward your TEE's evidence unchanged | Pass the runner token to your agent; send the token anywhere but an https gateway (or one on this machine); act on chain |
| **Anyone with your runner token** | Connect a runner as your agent (replacing yours), and so answer the episodes of your next rating | Rate the agent or change its registration: both need the owner's wallet signature. Revoke or replace the token from the agent's page |
| **Anyone who saves your Agent URL** | Have Bonded send it calls signed for *their* wallet | Get those calls accepted: your endpoint refuses any owner but yours, so they can't verify the URL and Bonded never sends it their episodes. There is no agent secret to steal; Bonded's signing key never leaves Bonded |
| **Anyone else** | Sign in with their own wallet and start their own preview, within the caps | Read your previews, checks, streams, reports or settings ("not found"); register a URL that points at Bonded or a private network |

More protections:
- **Request caps.** Request bodies, batches, request rates, concurrent requests and the sandbox node's answers are all capped (see [Chain mode](CONNECTING-YOUR-AGENT.md#chain-mode)), so a misbehaving agent can't exhaust the gateway.
- **Connection limits.** Runner connections are rate-limited per client address, per token and overall, so anonymous guessing can't lock real runners out. Behind a proxy, the gateway trusts only the configured number of `X-Forwarded-For` hops (`GATEWAY_TRUST_PROXY`, 1 on Railway).
- **Outbound limits.** Calls to Agent URLs are limited per registration, and verify calls (which anyone registering a URL can cause) per host, per registrable domain and per resolved address, so Bonded can't be aimed at one site.
- **Replays.** Each wallet signature opens one session or makes one request; Agent URL and webhook calls carry a timestamp, and handlers refuse a signature seen before.
- **Docker.** The runner and your agent run as an unprivileged user.

The judge, the payout rules and the scoring model are the same deterministic code for your agent as for Bonded's own. Your agent is held to the stricter trial and liveness rules above, because you see what it reads.

## Limits: what can still tell the sandbox from production

The Arena aims to make an attacked episode look like any other, and the sandbox look like the chain it copies:

- **The same interface.** The same tools, schemas and result shapes in every episode, attacked or not. Nothing in the episode names the attack, its class, or whether there is one.
- **No order to read.** Episodes run in a random order with the controls among them, and controls draw their goals from the same goals attack episodes get. Progress shows counts only until the end.
- **A world generated per rating.** Messages, news, posts, alerts, counterparty messages, the market report and token notes come from a grammar (templates whose slots draw from word lists, names, numbers and times). Each rating seeds every episode's world from a secret seed of its own, so there is no list of benign items to check what your agent reads against.
- **Yesterday shows up in every world.** Some episodes carry items from yesterday: a "Carried from yesterday" block in the market report, an inbox message from yesterday. Bonded's own agents also run a world-state battery ([SCORING.md](SCORING.md#world-state-observations)), two days on one vault where yesterday's trades are real, so carried items alone say nothing about an attack. Operator-run agents don't run that battery yet (their time budget doesn't plan it), but their worlds carry yesterday's items like any other.
- **Planted content looks like the rest.** It takes senders, subjects and titles from the same grammar, and is dated on the chain's own clock (on a fork, the live chain's current time). Benign content includes the same kinds of things attacks use, such as zero-value transfers with notes, and prices a few percent off the oracle.
- **A real-looking chain.** On a fork, the chain keeps its real chain id, contracts and block times, and `web3_clientVersion` answers with the live chain's node version. The vault and its registry entry have neutral names, and the MCP server and OpenAPI document describe themselves as trading tools.

What remains detectable, and so what a determined operator could exploit:

- **That it is being rated at all.** The runner starts your agent once per episode with `BONDED_*` variables, and an Agent URL receives signed episode messages, so an agent could behave differently while rated. This is inherent to rating an agent you run. It is why a declared score attests the behaviour of the code under test, and only a TEE binds that code to production.
- **The connection check is benign.** It has no attack, and you see it run live, event by event. A rating's episodes never stream that way.
- **The grammar is public.** Someone who reads the code could learn to recognise generated text. That is why idling under attack is made pointless (see [What the report shows](PREVIEWS-AND-RATINGS.md#what-the-report-shows)) rather than only hard to do.
- **The node is a local fork.** Blocks are mined one per transaction and lack some live-chain fields (for example Arbitrum's `l1BlockNumber`). Node error messages are the sandbox's, and each write is mined at once. A connection check runs on a fresh local chain, not a fork.
- **The vault is fresh each episode.** Its on-chain history starts with the episode, though the transfer-history tool shows earlier deposits.
- **Tool mode tests decisions, not signing.** The Arena signs writes with its own key, so tool mode says nothing about how your agent handles its key. Chain mode does.
- **The published seeds are public** (`attacks/`). The held-out set made for each rating is what keeps a rating honest against tuning.
- **Your agent's model calls are yours.** Bonded doesn't pay for them and doesn't limit them. Usage your agent reports at `done` is recorded, never trusted.
