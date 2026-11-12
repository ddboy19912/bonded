# Agent URL without a secret: Bonded-signed calls (plan)

Status: plan, not built. Nothing here changes the on-chain attestation format or any library
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

The gateway signs every call with an Ed25519 key that only Bonded holds. The public key ships
inside the SDK and is also published at a fixed URL, so the handler can check a call without any
secret of the owner's.

The signed text covers more than today's so a signature can't be reused elsewhere:

```
v2.<key id>.<timestamp>.<owner wallet, lowercase>.<agent url>.<raw body>
```

Header: `bonded-signature: v2=<key id>:<base64url signature>`. While an agent row also has an old
secret, the gateway sends both `v1=` and `v2=` values (the header already allows several).

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

### 3.4 The new flow

1. Copy the handler from the page (the owner's wallet is already in it) and deploy.
2. Paste the URL.
3. Verify: it passes at once.

No secret, no env var, one deploy. If the handler is already deployed with the right wallet,
saving and verifying is one click.

## 4. Keys and rotation

- **Where the key lives:** the gateway, the only thing that calls agents. Ideally in a KMS;
  failing that, an env var on the gateway, like `AGENT_URL_SECRET_KEY` today.
- **Key ids:** every signature names its key id. The SDK ships the current and next public keys.
  It also fetches `https://api.<domain>/.well-known/bonded-agent-keys.json`, caches it for a day,
  and accepts only keys listed there or in the bundled ones.
- **Rotation:** publish the next key, release an SDK with it, wait, then switch the signer. Old
  SDKs that can't fetch keep working until the bundled key is retired.
- **If the key leaks:** remove it from the published list and sign with the next key. Handlers
  that fetch pick that up within a day; an emergency SDK release covers those that don't. This is
  a worse case than one leaked customer secret, because one key covers every agent. That is why it
  belongs in a KMS.

## 5. Compatibility

- Existing secrets keep working: `createBondedHandler({ secret })` checks `v1` as it does now.
  Rows with a secret get both headers.
- `createBondedHandler({ owner })` is the new default in the snippets. Passing both is allowed
  (useful while moving over).
- New rows get no secret unless the owner asks for one ("Use a secret instead", for agents that
  can't verify Ed25519).
- Other languages need an Ed25519 check. Python has no Ed25519 in its standard library, so
  `examples/python-agent-url` gains a dependency (`cryptography` or PyNaCl), or keeps the secret
  path.
- Webhooks and model-risk notifications (`notifications.ts`, `model-risk.ts`) use the same HMAC
  scheme. They are out of scope; they could move later the same way.

## 6. Work, in order

Each item is its own PR, with its tests in the same commit.

1. **Shared:** `v2` signing payload, header format, verify and answer schemas, published-keys
   format (`packages/shared/src/agent-url.ts`).
2. **Gateway:** Ed25519 signer with key ids; send `v2` (and `v1` when the row has a secret);
   pass the owner wallet and URL into the signature (`apps/arena/src/gateway/agent-url.ts`).
3. **API:** save a URL without making a secret; verify checks the answered owner; serve the
   published keys; keep the secret routes for rows that use one (`apps/api/src/previews.ts`,
   `self-serve.ts`).
4. **SDK:** `owner` option, `v2` check against bundled plus fetched keys, replay guard
   unchanged; `npm` release. The version is a minor bump, since `secret` still works.
5. **Web:** snippets fill in the signed-in wallet; the connect step drops the secret block
   (secret flow behind "Use a secret instead"); the docs page is updated.
6. **Python example and the runner's `init`:** Ed25519 check, or document the secret path.
7. **Key setup:** generate the first key pair, store it, publish the keys file. The founder does
   this step (it needs production access).

## 7. Open questions for the founder

- KMS now, or a gateway env var first and KMS later?
- Should a new row still offer a secret by default for languages without easy Ed25519, or only on
  request?
- Retire `v1` for agent URLs at some date, or keep it for good?
