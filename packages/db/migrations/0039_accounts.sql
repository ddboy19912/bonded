-- Sign-in without a wallet (docs/ACCOUNTS.md): an account is an email address, proved with a
-- one-time code, and any passkeys its owner adds. Each account has an owner id in a wallet's
-- format (0x and 40 hex characters, derived from the account's id), which every owner column
-- already takes: previews, checks, hosted agents and Agent URL signatures work unchanged. It is
-- not a wallet: nothing can sign for it, so nothing on chain is reachable with it.
CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  owner_id text NOT NULL UNIQUE CHECK (owner_id ~ '^0x[0-9a-f]{40}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at timestamptz
);

-- One-time sign-in codes: only their hash is kept. A code lasts 10 minutes, takes 5 wrong tries,
-- and works once.
CREATE TABLE email_codes (
  id uuid PRIMARY KEY,
  email text NOT NULL CHECK (email = lower(email)),
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX email_codes_email ON email_codes(email, created_at);

-- Passkeys (WebAuthn credentials): the credential id and public key the authenticator gave when
-- it was added, and its signature counter.
CREATE TABLE passkeys (
  id text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[] NOT NULL DEFAULT '{}',
  name text NOT NULL DEFAULT 'Passkey',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX passkeys_account ON passkeys(account_id);

-- A WebAuthn challenge, kept until it is answered once or expires (5 minutes): to add a passkey
-- (for a signed-in account) or to sign in with one.
CREATE TABLE passkey_challenges (
  id uuid PRIMARY KEY,
  challenge text NOT NULL UNIQUE,
  purpose text NOT NULL CHECK (purpose IN ('register', 'sign-in')),
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
