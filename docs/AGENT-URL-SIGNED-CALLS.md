# Agent URL without a secret: Bonded-signed calls (plan)

Status: built and merged (2026-11-13). The production key was set on 2026-11-14 and its public
key is built into the SDK; the npm release and a run against a deployed agent are still to do
(Section 6). Nothing here changes the on-chain attestation format or any library
version: this is how the gateway talks to an agent, not how a rating is scored.

## 1. The problem

To connect a hosted agent by URL today, the owner:

1. deploys the handler,
2. saves the URL on Bonded and gets a secret (shown once),
3. opens their host's dashboard, adds `BONDED_AGENT_SECRET`, and redeploys,
4. clicks Verify.

Step 3 is the friction: a second deploy, a trip to another dashboard, and a secret to keep safe.
Losing it means making a new one and doing step 3 again.

## 2. What the secret does today

One shared secret per URL row (stored encrypted in the API, `apps/api/src/secrets.ts`) does two
jobs:

- **The calls are really from Bonded.** The gateway (`apps/arena/src/gateway/agent-url.ts`)
  signs every call with HMAC-SHA256 (`bonded-signature: v1=…`), and the SDK's
  `createBondedHandler` refuses anything that doesn't check out. Without it, anyone could post
  fake episodes to the agent and spend its model budget.
- **The URL belongs to the person who saved it.** Verify sends a challenge and the agent answers
  with an HMAC of it. Only a deployment holding that row's secret can answer, so nobody can save
  someone else's URL and make Bonded send it episodes.

Any replacement has to do both jobs.

## 3. The design

### 3.1 Bonded signs with its own key

The gateway signs every call with an Ed25519 key that only Bonded holds. The public key is
published by the API at `/.well-known/bonded-agent-keys.json`, so the handler can check a call
without any secret of the owner's.

The signed text covers the owner as well as the body, so a call signed for one wallet can't be
passed off as another's:

```
v2.<key id>.<timestamp>.<owner wallet, lowercase>.<raw body>
```

The agent's URL isn't signed, on purpose: behind a proxy or a tunnel the handler can't reliably
see the URL Bonded called, and it is never asked to work it out from request headers. Binding a
call to one URL isn't needed for either job in Section 2: the owner in the signed text is what
keeps the URL its owner's. Replaying a captured call to another of the same owner's agents within
the 5-minute window does no harm (the episode's endpoints accept one run, and replays are
refused).

Header: `bonded-signature: v2=<key id>:<base64url signature>`. This replaces `v1` (HMAC) for
agent URLs outright (Section 5).

### 3.2 Ownership: the owner's wallet goes in the code, not in a secret

A signature from Bonded alone isn't enough: Bonded signs calls for every customer, so an attacker
could save the victim's URL in their own account and Bonded would send it properly signed
episodes.

So the handler is told whose agent it is, with a value that is **public**, so it can sit in the
code itself:

```ts
export const POST = createBondedHandler({
  owner: "0x3f…a1", // your wallet: filled in on the page you copy this from
  async onBrokerageEpisode(episode, { signal }) { … },
});
```

The handler refuses any call whose signed owner isn't that wallet. Bonded only signs a call for
wallet W when W's owner (signed in with that wallet) saved the URL. An attacker who saves the
victim's URL gets calls signed for the attacker's wallet. The victim's handler refuses them, so
the attacker's verify fails and Bonded never sends episodes there.

We use the wallet, not the agent or preview id, because it doesn't change: one deployment keeps
working across new previews, and when a preview becomes a registered agent. `owner` can be a list,
for a team.

### 3.3 Verify

Verify stays, but the answer no longer needs a secret: the handler checks the call's `v2`
signature and owner, then answers `{ challenge, owner, version? }`. Bonded marks the URL verified
when the answer's owner matches the wallet that saved it.

The owner travels only in a header (`bonded-owner`) and in the signed text, never in the verify
body. So a server that just echoes the body back answers without an owner and fails. Only a
handler set up for that wallet answers with it.

What verify proves, and why that is enough without a secret: the job is to stop someone making
Bonded call a URL that isn't theirs (Section 2). Bonded signs a call for wallet W only when W
saved the URL, so to verify someone else's URL an attacker needs that server to answer with the
attacker's wallet. A handler set up for its real owner refuses the call, so it never does. A
server built to copy the `bonded-owner` header into its answer is one the attacker runs, and
claiming your own server is allowed. The secret answered a question this design no longer asks:
"does this server hold a value only Bonded and its owner know?".

### 3.4 The new flow

1. Copy the handler from the page (the owner's wallet is already in it) and deploy.
2. Paste the URL.
3. "Save and verify" is one click: saving verifies at once.

No secret, no env var, one deploy. `runner init --url --owner <wallet>` writes the same handler.

## 4. Keys and rotation

- **Where the key lives:** an env var on the gateway to start (`AGENT_URL_SIGNING_KEY`), the
  only service that calls agents. The signer sits behind one small interface, so moving it into a
  KMS later changes one file. Move it before the first design partner connects a real agent.
- **Key ids:** every signature names its key id, the first 12 characters of the base64url
  SHA-256 of the public key, so nothing needs configuring. The handler fetches the published set,
  keeps it for a day, and fetches again at once (at most once a minute) for a key id it hasn't
  seen. The SDK can also carry Bonded's public key (`BONDED_AGENT_KEYS`) as a fallback, used only
  when the handler has never fetched the set (the address is down when it starts). Once it has
  fetched the set, the published set is the only one it trusts: a bundled key is never added to
  it, so it can't outlive its removal from the set.
- **Rotation:** `AGENT_URL_SIGNING_KEY=<new>,<old>`: both are published and the first signs.
  Handlers pick up the new key on its first call. Drop the old one after a day.
- **If the key leaks:** take it off the published set and sign with a new one. A handler that
  has fetched the set stops trusting it at its next fetch: within a day, at once if it restarts or
  sees the new key's id. Taking a key off the set is how it is revoked; there is no separate
  revocation list. If the leaked key is the one bundled in the SDK, publish a new SDK without it
  too: a handler that starts while the keys address is down would still fall back to it until its
  first successful fetch. This is a worse case than one leaked customer secret, because one key
  covers every agent. That is why it belongs in a KMS.

## 5. No fallback: the secret goes away

Decided 2026-11-12: there are no outside users yet, so agent URLs move to signed calls completely,
in one release. No `v1` header, no secret option, no migration period.

- **Removed:** the agent secret for agent URLs. That means `newAgentSecret`, the encrypted secret
  column and its routes (`…/agent-url/secret`), `createBondedHandler({ secret })`, the HMAC verify
  proof, `BONDED_AGENT_SECRET` in snippets, the runner's `init` and docs, and the "Lost the
  secret?" flow in the web app.
- **Existing rows:** our own test rows are reset. Their URLs show as not verified, and verifying
  again with the new handler fixes them.
- **SDK:** a breaking change for agent URLs, so the version gets a major bump (or a minor one
  while it is still 0.x, with the change called out in the release notes).
- **Python:** `examples/python-agent-url` checks Ed25519 with the `cryptography` package.
- **Not in this change:** webhooks and model-risk notifications (`notifications.ts`,
  `model-risk.ts`, `apps/api/DATA-API.md`) keep their HMAC secret. They are a different feature.
  They could move to the same signed calls later, and should, so Bonded has one scheme.

### 5.1 "Works perfectly" before the secret is deleted

The secret code is deleted in the same release, so these must pass first, on the real gateway
and the published SDK against a deployed test agent:

1. A real episode is signed, checked and answered.
2. A call with a bad signature, an old timestamp, a replayed body, an unknown key id or another
   owner is refused.
3. Someone else's account saving the same URL can't verify it, and gets no episodes.
4. A body-echo server fails verify.
5. Rotating the key: a running handler keeps working across the switch.
6. The TypeScript handler (Node and edge runtimes) and the Python example both pass 1 to 4.

## 6. Work, in order

Items 1 to 5 are built in one branch, `agent-url-signed-calls`, with their tests: the secret is
removed as the new path lands. Section 5.1's checks 1 to 4 and 6 pass locally (a real gateway,
the SDK handler and the Python example, in the Arena's and the framework examples' integration
tests); item 6 is running them against a deployed agent once item 7 is done.

1. **Shared:** `v2` signing payload, header format, verify and answer schemas, keys-file format.
   Remove the agent-URL HMAC helpers (`packages/shared/src/agent-url.ts`).
2. **Gateway:** Ed25519 signer with key ids, signing in the owner wallet
   (`apps/arena/src/gateway/agent-url.ts`).
3. **API:** save a URL without a secret; verify checks the answered owner; serve the keys file;
   remove the secret column, routes and encryption context for agent URLs (`previews.ts`,
   `self-serve.ts`, `secrets.ts`).
4. **SDK:** `owner` option and the `v2` check against the fetched keys; remove `secret`. Then
   the npm release (SDK 0.2.0, shared 0.2.0, runner 0.1.5).
5. **Web, docs, runner `init`, Python example:** snippets fill in the signed-in wallet; the
   connect step is "paste URL, verify"; every mention of `BONDED_AGENT_SECRET` goes.
6. **End-to-end tests** from Section 5.1, run against the deployed test agent before merging.
7. **Key setup (the founder):** `pnpm --filter @bonded/api agent-url-key`, then set
   `AGENT_URL_SIGNING_KEY` on the api service in Railway (the arena-worker takes the same value).
   The API publishes the public key. It needs production access. Done 2026-11-14 (key id
   `ind7eq0xdV0-`); its public key is in `BONDED_AGENT_KEYS` (`packages/sdk/src/signature.ts`).

## 7. Decisions

- **Key storage:** gateway env var now, KMS before the first design partner.
- **Secret for new URLs:** none. Signed calls only.
- **Old scheme:** removed for agent URLs in the same release; webhooks keep HMAC for now.
