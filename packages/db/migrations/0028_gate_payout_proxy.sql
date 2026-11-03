-- The payment gate's payout route (apps/api/src/gate-payout.ts, apps/api/GATE.md): the agent asks
-- the gate to pay an invoice by bank payout; the gate checks it and forwards an allowed payout to
-- the payout proxy, a service in a TEE that alone can open the provider credential. Amounts are
-- whole cents (USD).

-- A payout that reached the provider without the gate (someone used the key outside it) is
-- recorded as a payment made, source "payout", next to its breach decision.
ALTER TABLE gate_payments DROP CONSTRAINT gate_payments_source_check;
ALTER TABLE gate_payments ADD CONSTRAINT gate_payments_source_check
  CHECK (source IN ('check', 'import', 'card', 'payout'));

-- A gate account's payout provider account. The credential is stored only sealed to the payout
-- proxy's seal key (sealed_to), which the API checked against the proxy's attestation: the API
-- can't open it. tee_measurement and tee_compose_hash are what the proxy proved when it was
-- linked (the measurement is null when the API ran without hardware checks). The events endpoint's
-- signing secret is encrypted with AGENT_URL_SECRET_KEY like the card route's.
CREATE TABLE gate_payout_links (
  account_id uuid PRIMARY KEY REFERENCES gate_accounts(id),
  provider text NOT NULL CHECK (provider IN ('stripe')),
  sealed_credential jsonb NOT NULL,
  sealed_to text NOT NULL,
  tee_measurement text,
  tee_compose_hash text NOT NULL,
  key_hint text NOT NULL,
  financial_account text NOT NULL,
  livemode boolean NOT NULL,
  events_secret_ciphertext text NOT NULL,
  linked_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Every payout: the ones the gate allowed and forwarded, and any the provider reported that the
-- gate never approved (gate_approved false: a breach).
--   status        pending (being forwarded), not_sent (the proxy or provider refused, or the
--                 proxy was down: the invoice is released), unknown (forwarded, the answer was
--                 lost: the invoice stays held until the provider reports), then the provider's:
--                 processing, posted, failed, returned, canceled. failed, returned and canceled
--                 release the invoice.
--   payment_id    the payment that holds the invoice (null once released)
--   payee         the normalised payee the rules checked; destination as the vendor master has it
CREATE TABLE gate_payouts (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES gate_accounts(id),
  decision_id uuid UNIQUE REFERENCES gate_decisions(id) ON DELETE SET NULL,
  key_id uuid REFERENCES gate_api_keys(id),
  payment_id bigint REFERENCES gate_payments(id) ON DELETE SET NULL,
  provider text NOT NULL,
  provider_payout_id text UNIQUE,
  status text NOT NULL CHECK (status IN ('pending', 'not_sent', 'unknown', 'processing', 'posted',
    'failed', 'returned', 'canceled')),
  gate_approved boolean NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  payee text NOT NULL,
  destination text NOT NULL,
  vendor_id text,
  reference text NOT NULL DEFAULT '',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gate_payouts_account ON gate_payouts(account_id, created_at);
