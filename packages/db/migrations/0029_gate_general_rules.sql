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
