-- Budgets (apps/api/GATE.md, "Budgets"): one check covers many small payments to one payee, such
-- as x402 calls of a fraction of a cent. The budget check is a decision with a receipt, and its
-- whole budget is reserved against the daily limit (a gate_payments row, source 'budget'). The
-- agent's code spends against it with no network call and reports each payment; closing it is a
-- second decision whose receipt commits to every payment, and the reservation becomes what was
-- spent. Amounts here are micro-dollars (millionths of a US dollar), the unit USDC counts in.
ALTER TABLE gate_decisions DROP CONSTRAINT gate_decisions_kind_check;
ALTER TABLE gate_decisions ADD CONSTRAINT gate_decisions_kind_check
  CHECK (kind IN ('invoice', 'refund', 'bank_change', 'card', 'payment', 'budget', 'budget_close'));

ALTER TABLE gate_payments DROP CONSTRAINT gate_payments_source_check;
ALTER TABLE gate_payments ADD CONSTRAINT gate_payments_source_check
  CHECK (source IN ('check', 'import', 'card', 'payout', 'watch', 'hook', 'budget'));

-- One row per budget the gate let through. The id is the budget decision's id; no foreign key, so
-- pruning old decisions leaves the budget's record.
--   terms           the BudgetTerms the decision's input commits to, exactly as signed
--   spent_micros    what was reported against it so far; payments, how many
--   closed_at       set once, by the close decision (close_decision)
CREATE TABLE gate_budgets (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES gate_accounts(id),
  key_id uuid,
  payee text NOT NULL,
  payee_norm text NOT NULL,
  vendor_id text,
  budget_micros bigint NOT NULL CHECK (budget_micros > 0),
  max_payment_micros bigint NOT NULL CHECK (max_payment_micros > 0),
  max_payments integer CHECK (max_payments >= 0),
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  terms jsonb NOT NULL,
  spent_micros bigint NOT NULL DEFAULT 0,
  payments integer NOT NULL DEFAULT 0,
  closed_at timestamptz,
  close_decision uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > starts_at)
);
CREATE INDEX gate_budgets_open ON gate_budgets(account_id, expires_at) WHERE closed_at IS NULL;
CREATE INDEX gate_budgets_payee ON gate_budgets(account_id, payee_norm, starts_at);

-- Each payment reported against a budget.
--   spend_id   the spender's id for it: reporting it twice records it once
--   problem    why it broke the budget's terms, in plain words; null when it fit
CREATE TABLE gate_budget_spends (
  id bigserial PRIMARY KEY,
  budget_id uuid NOT NULL REFERENCES gate_budgets(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES gate_accounts(id),
  spend_id text NOT NULL,
  amount_micros bigint NOT NULL CHECK (amount_micros > 0),
  reference text NOT NULL DEFAULT '',
  paid_at timestamptz NOT NULL,
  problem text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (budget_id, spend_id)
);
CREATE INDEX gate_budget_spends_paid ON gate_budget_spends(account_id, paid_at);

-- A watched payment's exact amount (wallets read it from the token; older rows and logs in whole
-- cents leave it null), the budget it falls under, and the reported payment it is. Many watched
-- payments can fall under one budget; each reported payment is one watched payment. One under an
-- open budget with no reported payment yet waits for it: if none comes by the close, the close
-- judges it as a payment with no check.
ALTER TABLE gate_watched_payments ADD COLUMN amount_micros bigint;
ALTER TABLE gate_watched_payments ADD COLUMN matched_budget uuid
  REFERENCES gate_budgets(id) ON DELETE SET NULL;
ALTER TABLE gate_watched_payments ADD COLUMN matched_spend bigint
  REFERENCES gate_budget_spends(id) ON DELETE SET NULL;
CREATE INDEX gate_watched_payments_budget ON gate_watched_payments(matched_budget)
  WHERE matched_budget IS NOT NULL;
CREATE UNIQUE INDEX gate_watched_payments_spend ON gate_watched_payments(matched_spend)
  WHERE matched_spend IS NOT NULL;
