-- Watch mode (apps/api/GATE.md): payments Bonded reads after they were made, from a log a business
-- sends or a wallet it watches. These never sit in the decision log and have no receipt: nothing
-- was decided before the money left.
--   expect_checks   a watched payment with no check before it raises an alert
ALTER TABLE gate_accounts ADD COLUMN expect_checks boolean NOT NULL DEFAULT false;

-- A watched payment counts toward the limits and the duplicate rule, like a check's.
ALTER TABLE gate_payments DROP CONSTRAINT gate_payments_source_check;
ALTER TABLE gate_payments ADD CONSTRAINT gate_payments_source_check
  CHECK (source IN ('check', 'import', 'card', 'payout', 'watch'));

-- A public address to read. Bonded holds no key for it.
--   next_block  the first block not read yet; null until the watcher first sees the wallet
CREATE TABLE gate_watch_wallets (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES gate_accounts(id),
  chain_id integer NOT NULL,
  address text NOT NULL,
  label text NOT NULL DEFAULT '',
  next_block bigint,
  last_read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, chain_id, address)
);

-- One row per payment seen.
--   external_id  names the payment at its source, so reading it twice records it once. Log and
--                wallet ids have their own prefix, so a log can't claim a wallet's payment
--   matched_decision  the allowed check it matches; each check matches one payment
--   rules        what it broke; empty when it matched a check, which already judged it
CREATE TABLE gate_watched_payments (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES gate_accounts(id),
  source text NOT NULL CHECK (source IN ('log', 'wallet')),
  external_id text NOT NULL,
  payee text NOT NULL,
  payee_norm text NOT NULL,
  vendor_id text,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  reference text NOT NULL DEFAULT '',
  rules text[] NOT NULL DEFAULT '{}',
  loss_cents bigint NOT NULL DEFAULT 0,
  overpaid_cents bigint NOT NULL DEFAULT 0,
  matched_decision uuid REFERENCES gate_decisions(id) ON DELETE SET NULL,
  details jsonb NOT NULL DEFAULT '{}',
  paid_at timestamptz NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, external_id)
);
CREATE UNIQUE INDEX gate_watched_payments_decision ON gate_watched_payments(matched_decision)
  WHERE matched_decision IS NOT NULL;
CREATE INDEX gate_watched_payments_seen ON gate_watched_payments(seen_at);

-- Matching a watched payment to a check looks up allowed checks by payee and amount.
CREATE INDEX gate_decisions_watch_match ON gate_decisions(account_id, payee, amount_cents, created_at);
