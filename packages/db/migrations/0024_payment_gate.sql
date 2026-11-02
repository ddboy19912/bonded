-- The payment gate's hosted check (apps/api/src/gate.ts, apps/api/GATE.md): a gate account per
-- business, checked by its agents with an API key, managed by its owner's wallet session.
-- Amounts are whole cents. Accounts and references are matched by their normalised form (no
-- spaces, upper case), as the shared rule engine compares them (payment-mandate.ts).
--
--   mode              monitor (a breaking payment goes through and is recorded) or enforce
--   frozen_at         set when a breach froze the account (freeze_on_breach); checks are refused
--   mandate_version   the current version in gate_mandates, and its hash
CREATE TABLE gate_accounts (
  id uuid PRIMARY KEY,
  owner text NOT NULL,
  name text NOT NULL DEFAULT '',
  mode text NOT NULL CHECK (mode IN ('monitor', 'enforce')),
  max_payment_cents bigint NOT NULL CHECK (max_payment_cents > 0),
  max_daily_cents bigint NOT NULL CHECK (max_daily_cents > 0),
  freeze_on_breach boolean NOT NULL DEFAULT false,
  frozen_at timestamptz,
  frozen_by uuid,
  mandate_version integer NOT NULL DEFAULT 1,
  mandate_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gate_accounts_owner ON gate_accounts(owner, created_at);

-- Every version of each account's mandate (mode, limits, freeze setting and vendor master), kept
-- so the rules page can show its history and each hash can be checked later.
--   created_by  the owner's wallet, or "ticket:<id>" for a bank change a verified ticket covered
CREATE TABLE gate_mandates (
  account_id uuid NOT NULL REFERENCES gate_accounts(id),
  version integer NOT NULL,
  mandate jsonb NOT NULL,
  hash text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, version)
);

-- API keys for an account's agents: only the key's sha256 is kept; the key is shown once.
CREATE TABLE gate_api_keys (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES gate_accounts(id),
  key_hash text NOT NULL UNIQUE,
  prefix text NOT NULL,
  label text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX gate_api_keys_account ON gate_api_keys(account_id);

-- The vendor master: each vendor's verified account (the one on file, or one a verified ticket
-- changed it to). Part of the mandate.
CREATE TABLE gate_vendors (
  account_id uuid NOT NULL REFERENCES gate_accounts(id),
  id text NOT NULL,
  name text NOT NULL,
  account text NOT NULL,
  account_norm text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, id)
);
CREATE INDEX gate_vendors_account ON gate_vendors(account_id, account_norm);

-- Invoices the business approved for payment: this vendor, this reference, this amount.
CREATE TABLE gate_invoices (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES gate_accounts(id),
  vendor_id text NOT NULL,
  reference text NOT NULL,
  reference_norm text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, vendor_id, reference_norm)
);
CREATE INDEX gate_invoices_reference ON gate_invoices(account_id, reference_norm);

-- Customer refunds finance approved: this account, this reference, this amount.
CREATE TABLE gate_refunds (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES gate_accounts(id),
  reference text NOT NULL,
  reference_norm text NOT NULL,
  name text NOT NULL DEFAULT '',
  account text NOT NULL,
  account_norm text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, account_norm, reference_norm)
);

-- Bank-change tickets finance verified out of band: the only way a vendor's account may change.
CREATE TABLE gate_tickets (
  account_id uuid NOT NULL REFERENCES gate_accounts(id),
  id text NOT NULL,
  vendor_id text NOT NULL,
  account text NOT NULL,
  account_norm text NOT NULL,
  verified_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, id)
);
CREATE INDEX gate_tickets_vendor ON gate_tickets(account_id, vendor_id, account_norm);

-- The decision log: one row per check, with its signed receipt. The record only (rules, amounts,
-- the payee's account, the reference and the hashes); never an invoice document or image. Kept
-- GATE_DECISION_RETENTION_DAYS (default 365) and then deleted by the keeper.
--   seq          the log's order, and its page cursor
--   request_id   the caller's id for the check: the same id again returns the same decision
--   request_hash what that id was first sent with, so a reused id can't hide a different check
--   decision     pass, breach, or frozen (refused before the check)
--   result       allowed, blocked (Enforce mode) or refused (frozen)
CREATE TABLE gate_decisions (
  id uuid PRIMARY KEY,
  seq bigserial NOT NULL UNIQUE,
  account_id uuid NOT NULL REFERENCES gate_accounts(id),
  key_id uuid REFERENCES gate_api_keys(id),
  request_id text,
  request_hash text,
  kind text NOT NULL CHECK (kind IN ('invoice', 'refund', 'bank_change')),
  decision text NOT NULL CHECK (decision IN ('pass', 'breach', 'frozen')),
  result text NOT NULL CHECK (result IN ('allowed', 'blocked', 'refused')),
  mode text NOT NULL,
  rules text[] NOT NULL DEFAULT '{}',
  amount_cents bigint NOT NULL,
  loss_cents bigint NOT NULL DEFAULT 0,
  overpaid_cents bigint NOT NULL DEFAULT 0,
  payee text NOT NULL,
  vendor_id text,
  reference text NOT NULL DEFAULT '',
  input_hash text NOT NULL,
  mandate_hash text NOT NULL,
  mandate_version integer NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gate_decisions_account ON gate_decisions(account_id, seq);
CREATE INDEX gate_decisions_created ON gate_decisions(created_at);
CREATE UNIQUE INDEX gate_decisions_request ON gate_decisions(account_id, request_id)
  WHERE request_id IS NOT NULL;
ALTER TABLE gate_accounts ADD CONSTRAINT gate_accounts_frozen_by
  FOREIGN KEY (frozen_by) REFERENCES gate_decisions(id) ON DELETE SET NULL;

-- Payments made: the ones the gate let through, and any the owner imported (made before the
-- gate). They are what the duplicate and daily rules read, so they outlive the decision log.
CREATE TABLE gate_payments (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES gate_accounts(id),
  decision_id uuid REFERENCES gate_decisions(id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source IN ('check', 'import')),
  kind text NOT NULL CHECK (kind IN ('invoice', 'refund')),
  payee text NOT NULL,
  payee_norm text NOT NULL,
  vendor_id text,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  reference text NOT NULL,
  reference_norm text NOT NULL,
  day date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gate_payments_day ON gate_payments(account_id, day);
CREATE INDEX gate_payments_reference ON gate_payments(account_id, reference_norm);

-- The meter: checks per account per UTC day. Counts only; no pricing.
CREATE TABLE gate_usage_daily (
  account_id uuid NOT NULL REFERENCES gate_accounts(id),
  day date NOT NULL,
  checks integer NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day)
);
