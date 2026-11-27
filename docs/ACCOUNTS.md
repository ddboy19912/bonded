# Signing in without a wallet

You can sign in to Bonded with an email address, then add a passkey (Touch ID, Face ID, Windows Hello or a phone). A wallet still works, and on-chain actions still need one.

## How it works

1. **Email.** Enter your address and Bonded emails you a 6-digit code. Enter the code to sign in. The first time, this creates your account. There is no password and no separate sign-up.
2. **Passkey.** Once signed in, you can add a passkey. After that, "Sign in with a passkey" is one tap, with no code to wait for. You can add several (a laptop and a phone) and remove any of them.
3. **Your session.** Either way, you get the same 12-hour session a wallet gets. It covers everything a wallet session does: previews, connection checks, Bonded running your agent, Agent URLs, the payment gate and notifications.

## Your account id

Each account has an id in a wallet's format: `0x` and 40 hex characters. It never changes. Bonded records it as the owner of your previews, and Bonded's signed calls to your Agent URL name it as the owner (`BONDED_AGENT_OWNER` in the examples).

It is **not a wallet**. Nobody holds a key for it, so nothing can be done with it on chain. Official ratings, Mandate Vaults, cover and claims need a wallet.

## Limits and safety

- **A code** works once, for 10 minutes, and stops working after 5 wrong tries. Asking for a new code cancels older ones. An address can ask for 5 codes an hour. Bonded keeps only a hash of each code.
- **The code request** gives the same answer whether or not the address has an account, so it can't be used to find out who uses Bonded.
- **A passkey** is bound to bondedhq.xyz, so a lookalike site can't use it. Bonded keeps only its public key, and checks every sign-in against a fresh challenge that works once, for 5 minutes.
- **Sign-in requests** share the API's per-address rate limits.

## API

| Endpoint | What it does |
|---|---|
| `POST /account/email/code` | `{ email }`: emails a 6-digit code (202) |
| `POST /account/email/session` | `{ email, code }`: a session (201), the same answer a wallet sign-in gives, plus `account.email` |
| `GET /account` | The signed-in account: email, owner id and passkeys |
| `POST /account/passkeys/options` | Signed in: options to add a passkey (WebAuthn) |
| `POST /account/passkeys` | Signed in: `{ response, name? }`, the browser's answer; adds the passkey (201) |
| `DELETE /account/passkeys/:id` | Signed in: removes a passkey |
| `POST /account/passkey/options` | Options to sign in with a passkey |
| `POST /account/passkey/session` | `{ response }`: the browser's answer, for a session (201) |
