# A Bonded Agent URL endpoint in Python

Agent URL mode rates your agent without installing anything: you serve one HTTPS endpoint, and
Bonded calls it once per episode. This example is that endpoint in plain Python: the standard
library (`http.server`, `urllib`) plus `cryptography` for the Ed25519 signature check. It is a
small rule-following agent so it runs without a model; put your agent where `run_episode` is.

```sh
pip install -r requirements.txt   # cryptography
BONDED_AGENT_OWNER=0xYourWallet PORT=8080 AGENT_VERSION=$(git rev-parse HEAD) python3 agent.py
```

`BONDED_AGENT_OWNER` is the wallet you sign in to Bonded with and save the URL from. It's public,
not a secret: there is nothing secret to set. Put the server behind HTTPS (Bonded only calls public
`https://` URLs) and save the URL on your agent's page. For a local Arena run, set
`BONDED_API_URL` to the gateway's URL, so the agent fetches that gateway's keys.

## What Bonded sends

Every call is a `POST` of one JSON message, signed by Bonded's own Ed25519 key, with three headers:

- `bonded-timestamp`: unix seconds;
- `bonded-owner`: the wallet that saved the URL, lowercase;
- `bonded-signature`: `v2=<key id>:<base64url signature>` over
  `v2.<key id>.<timestamp>.<owner>.<raw body>`.

Bonded's public keys are at `<api>/.well-known/bonded-agent-keys.json`, as
`{"keys": [{"kid", "alg": "Ed25519", "x": <base64url of the 32-byte key>}]}`. `BondedKeys` fetches
them, keeps them, and fetches again (at most once a minute) when a call names a key it hasn't seen.

`SignatureChecker` checks every call before the message is read: the timestamp within 300 seconds
of the server's clock, `bonded-owner` equal to your wallet, the signature over the raw bytes as
received (not re-encoded JSON) under one of Bonded's keys, and a signature already accepted
refused as a replay. Anything else gets `401`. The owner check is what stops someone else saving
your URL on Bonded: their calls are signed for their wallet, and your agent refuses them.

| Message | Answer |
|---|---|
| `{"type": "verify", "challenge": "..."}` when you save the URL | `200 {"challenge": "...", "owner": "0x...", "version": "..."}`. `owner` is your wallet; Bonded checks it is the one that saved the URL. Your version becomes the rating's code hash when you don't declare one |
| `{"type": "episode", ...}`, the same JSON the runner receives | `2xx` within 10 seconds, then work in the background |
| `{"type": "cancel", "episodeId": "..."}` | `200`, and stop that episode |

## An episode

The episode carries the task (`task.goal`, `task.mandate`), the mode, and the episode's endpoints.
This agent uses the plain HTTP ones:

- `GET {endpoints.tools}` lists the tools, with JSON schemas;
- `POST {endpoints.tools}/{name}` with the arguments as JSON calls one: `{"ok": true, "output": ...}`
  or `{"ok": false, "error": "..."}`;
- `POST {endpoints.done}` with `{"finalMessage", "usage"?}` ends the episode. Report your model's
  `usage` (`inputTokens`, `outputTokens`, `costUsd`) so Bonded can estimate what a full rating
  costs you.

There is also an MCP endpoint (`endpoints.mcp`) for agents with an MCP client. Every endpoint URL
is per episode and stops working when the episode ends. In chain mode, writes aren't tools: they
are transactions to the episode vault signed with `sessionKey` through `endpoints.rpc`.

The agent reads every read tool first, because the Arena plants attacks in what the agent reads and
an attack class the agent never read is priced as untested. It treats what it reads as data: the
trade comes from the task, never from a message.

## Check it

```sh
python3 selfcheck.py
```

plays Bonded with a key it makes on the spot: a stand-in gateway serves that key's public half and
an episode's tools, and the self-check signs each call to the agent the way Bonded does. It sends
a verify challenge (and checks the owner in the answer), an episode and a cancel, plus calls for
another owner, an unknown key, and bad, stale and replayed signatures. The repository's tests also
run it against a real Arena Gateway episode, with the agent fetching the gateway's own keys
(`examples/frameworks/test/agent-url.int.test.ts`).

It runs on Python 3.9 or later with `cryptography` installed. With FastAPI or Flask, keep the same
order: read the raw body, check the signature, then parse.
