# Signing in without a wallet

Most teams testing a trading or payments agent don't use crypto. They can sign in to Bonded with an email address, and then with a passkey (Touch ID, Face ID, Windows Hello or a phone). A wallet still works as before, and is still what on-chain actions need.

## How it works

1. **Email.** Enter an address and Bonded emails a 6-digit code. Entering the code signs you in. The first time, that makes your account: there is no password and no separate sign-up.
2. **Passkey.** Once signed in, you can add a passkey. From then on, "Sign in with a passkey" is one tap, with no code to wait for and nothing to phish. You can add several (a laptop and a phone) and remove any of them.
3. **The same session.** Either way you get the same kind of session a wallet gets, for 12 hours. Everything you can do with a wallet session you can do with it: previews, connection checks, Bonded running your agent, Agent URLs, the payment gate and notifications.

## Your account id

Each account has an id in a wallet's format: `0x` and 40 hex characters, derived from the account and the same every time. It is what Bonded records as the owner of your previews, and what Bonded's signed calls to your Agent URL name as the owner (`BONDED_AGENT_OWNER` in the examples).

It is **not a wallet**. Nobody holds a key for it, so nothing on chain can be done with it. Official ratings, Mandate Vaults, cover and claims need a wallet.

## Limits and safety

- **A code** works once, for 10 minutes, and stops after 5 wrong tries. Asking for a new code makes older ones stop working. An address can ask for 5 codes an hour. Only a hash of each code is kept.
- **The code request** answers the same whether or not the address has an account, so it can't be used to find out who uses Bonded.
- **A passkey** is bound to bondedhq.xyz: a lookalike site can't use it. Bonded keeps only its public key and checks every sign-in on its servers, with a fresh challenge that works once, for 5 minutes.
- **Sign-in requests** share the API's per-address limits.

## For developers

| Endpoint | What it does |
|---|---|
| `POST /account/email/code` | `{ email }`: emails a 6-digit code (202) |
| `POST /account/email/session` | `{ email, code }`: a session (201), the same answer a wallet sign-in gives, plus `account.email` |
| `GET /account` | The signed-in account: email, owner id and passkeys |
| `POST /account/passkeys/options` | Signed in: options to add a passkey (WebAuthn) |
| `POST /account/passkeys` | Signed in: `{ response, name? }`, the browser's answer; adds the passkey (201) |
| `DELETE /account/passkeys/:id` | Signed in: removes a passkey |
| `POST /account/passkey/options` | Options to sign in with a passkey |
| `POST /account/passkey/session` | `{ response }`: the browser's answer for a session (201) |

**Settings:**
- Email uses the same sender as notifications: `RESEND_API_KEY` and `EMAIL_FROM` on the api service. Without them, email sign-in answers 503.
- Passkeys use `WEBAUTHN_RP_ID` (default `bondedhq.xyz`) and `WEBAUTHN_ORIGINS` (default `https://www.bondedhq.xyz,https://bondedhq.xyz`). Passkeys don't work on Vercel preview addresses, which are other sites.

**Where it lives:** `apps/api/src/accounts.ts`, migration 0039 (`accounts`, `email_codes`, `passkeys`, `passkey_challenges`), and `apps/api/test/accounts.test.ts`, which tests passkeys with a software authenticator.
