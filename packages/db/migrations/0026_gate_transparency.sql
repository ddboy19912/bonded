-- The payment gate's transparency (apps/api/GATE.md, "Hashes on chain"): what each check's rules
-- were given, each day's log root, and what the keeper posted to GateAnchor.

-- Exactly what the rule engine was given for the check (`GateInput` in @bondedhq/shared): the
-- attempt, the limits and the records the rules read (payee accounts, approved invoices or
-- refunds, the day's payments, tickets). Never an invoice document. Its SHA-256 is input_hash, so
-- the owner can recompute the hash and rerun the rules. Empty for decisions made before this.
ALTER TABLE gate_decisions ADD COLUMN input jsonb;

-- One root per account per UTC day over that day's receipts, in decision order (`gateLogRoot`),
-- made once the day has ended. Kept after the decisions themselves are deleted.
--   receipts     how many receipts the root covers
--   anchor_*     where and when it was posted on chain; anchor_tx is empty when the keeper found
--                it already posted; anchor_error says why the last try failed
CREATE TABLE gate_log_roots (
  account_id uuid NOT NULL REFERENCES gate_accounts(id),
  day date NOT NULL,
  root text NOT NULL,
  receipts integer NOT NULL CHECK (receipts > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  anchor_chain_id integer,
  anchor_contract text,
  anchor_tx text,
  anchored_at timestamptz,
  anchor_error text,
  PRIMARY KEY (account_id, day)
);
CREATE INDEX gate_log_roots_unposted ON gate_log_roots(created_at) WHERE anchored_at IS NULL;

-- Each mandate version's hash as posted on chain, the same way.
ALTER TABLE gate_mandates
  ADD COLUMN anchor_chain_id integer,
  ADD COLUMN anchor_contract text,
  ADD COLUMN anchor_tx text,
  ADD COLUMN anchored_at timestamptz,
  ADD COLUMN anchor_error text;
CREATE INDEX gate_mandates_unposted ON gate_mandates(created_at) WHERE anchored_at IS NULL;
