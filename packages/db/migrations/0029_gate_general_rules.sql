-- Rules for payments with no invoices (apps/api/GATE.md). With invoice_matching off, a payment is
-- checked against the payee list and the limits, and logged as kind 'payment'.
--   invoice_matching       on for every account unless its owner turns it off
--   max_payments_per_hour  payments allowed in any hour with invoice matching off; null for no limit
ALTER TABLE gate_accounts ADD COLUMN invoice_matching boolean NOT NULL DEFAULT true;
ALTER TABLE gate_accounts ADD COLUMN max_payments_per_hour integer
  CHECK (max_payments_per_hour > 0);

ALTER TABLE gate_decisions DROP CONSTRAINT gate_decisions_kind_check;
ALTER TABLE gate_decisions ADD CONSTRAINT gate_decisions_kind_check
  CHECK (kind IN ('invoice', 'refund', 'bank_change', 'card', 'payment'));

-- The hourly limit counts recent payments.
CREATE INDEX gate_payments_recent ON gate_payments(account_id, created_at);

-- Accounts now keep their case when it matters: a mixed-case base58 address (a Solana wallet, say)
-- is compared as written, and every other account in upper case (normalAccount in
-- @bondedhq/shared). Rows stored before kept such an address in upper case, so they wouldn't match
-- it any more: set them again from the account as written, without its spaces. Card merchant keys
-- ("CARD:...") aren't base58 and stay as they are; stored decisions and receipts don't change.
UPDATE gate_vendors SET account_norm = regexp_replace(account, '\s', '', 'g')
  WHERE regexp_replace(account, '\s', '', 'g') ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND account ~ '[a-z]' AND account ~ '[A-Z]';
UPDATE gate_refunds SET account_norm = regexp_replace(account, '\s', '', 'g')
  WHERE regexp_replace(account, '\s', '', 'g') ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND account ~ '[a-z]' AND account ~ '[A-Z]';
UPDATE gate_tickets SET account_norm = regexp_replace(account, '\s', '', 'g')
  WHERE regexp_replace(account, '\s', '', 'g') ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND account ~ '[a-z]' AND account ~ '[A-Z]';
UPDATE gate_payments SET payee_norm = regexp_replace(payee, '\s', '', 'g')
  WHERE regexp_replace(payee, '\s', '', 'g') ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    AND payee ~ '[a-z]' AND payee ~ '[A-Z]';
