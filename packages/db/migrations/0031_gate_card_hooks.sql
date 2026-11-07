-- Card hooks (apps/api/GATE.md, "Card hooks"): a business's own card program asks the gate before
-- each charge, and the gate answers approve or decline. Bonded holds no key for the program, only
-- what proves a request came from it.
--   provider              stripe (Issuing), lithic (Auth Stream Access) or marqeta (Gateway JIT)
--   secret_ciphertext     the signing secret (Stripe and Lithic), encrypted; never returned. Null
--                         until the owner pastes it: Stripe shows it only once the address is set
--   secret_hint           the start and end of that secret, to tell secrets apart
--   basic_user            the username Marqeta sends (Marqeta only)
--   basic_password_hash   SHA-256 of the password Bonded made for Marqeta; the password itself is
--                         shown once and never stored
--   last_request_at       when the program last asked, for the Connect tab
CREATE TABLE gate_card_hooks (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES gate_accounts(id),
  provider text NOT NULL CHECK (provider IN ('stripe', 'lithic', 'marqeta')),
  label text NOT NULL DEFAULT '',
  secret_ciphertext text,
  secret_hint text NOT NULL DEFAULT '',
  basic_user text,
  basic_password_hash text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_request_at timestamptz,
  CHECK ((provider = 'marqeta') = (basic_password_hash IS NOT NULL)),
  CHECK (provider <> 'marqeta' OR secret_ciphertext IS NULL)
);
CREATE INDEX gate_card_hooks_account ON gate_card_hooks(account_id);

-- A charge a card hook approved counts toward the limits, like a check's payment.
ALTER TABLE gate_payments DROP CONSTRAINT gate_payments_source_check;
ALTER TABLE gate_payments ADD CONSTRAINT gate_payments_source_check
  CHECK (source IN ('check', 'import', 'card', 'payout', 'watch', 'hook'));
