-- The payment gate's card route (apps/api/src/gate-card.ts, apps/api/GATE.md): a gate account
-- links its Stripe Issuing account, the agent asks for a single-use virtual card per approved
-- invoice, and Stripe asks the gate before each charge. Amounts are whole cents (USD).

-- Each vendor's card merchant, part of the vendor master and the mandate: the merchant's name and
-- its Stripe network id (`merchant_data.network_id`). card_merchant_norm is the key the rules
-- compare: "CARD:" and the network id, without spaces, upper case. Changing it needs a verified
-- ticket whose account is "card:<network id>".
ALTER TABLE gate_vendors
  ADD COLUMN card_merchant_name text,
  ADD COLUMN card_merchant_id text,
  ADD COLUMN card_merchant_norm text;
CREATE INDEX gate_vendors_card_merchant ON gate_vendors(account_id, card_merchant_norm);

-- A card authorization is checked like an invoice payment, and logged as kind "card".
ALTER TABLE gate_decisions DROP CONSTRAINT gate_decisions_kind_check;
ALTER TABLE gate_decisions ADD CONSTRAINT gate_decisions_kind_check
  CHECK (kind IN ('invoice', 'refund', 'bank_change', 'card'));
-- A settled card transaction is a payment made (source "card").
ALTER TABLE gate_payments DROP CONSTRAINT gate_payments_source_check;
ALTER TABLE gate_payments ADD CONSTRAINT gate_payments_source_check
  CHECK (source IN ('check', 'import', 'card'));

-- A gate account's Stripe account: the restricted key the gate uses to issue and cancel cards,
-- and optionally the signing secrets of its two webhook endpoints. All stored encrypted with
-- AGENT_URL_SECRET_KEY (bound to the account), never returned. key_hint is the key's first
-- characters and last four, to tell keys apart.
CREATE TABLE gate_stripe_links (
  account_id uuid PRIMARY KEY REFERENCES gate_accounts(id),
  key_ciphertext text NOT NULL,
  key_hint text NOT NULL,
  livemode boolean NOT NULL,
  cardholder_id text NOT NULL,
  authorization_secret_ciphertext text,
  events_secret_ciphertext text,
  linked_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One single-use virtual card per approved invoice. Only the card's id and last four digits are
-- kept: the number and CVC go to the agent once and are never stored.
--   status  creating (asked Stripe), issued (card ready), authorized (the gate approved a charge,
--           the invoice is held), paid (a transaction settled), released (the approved charge was
--           reversed or expired: the invoice can be paid again), canceled (a breach cancelled the
--           card), failed (Stripe refused to make the card)
CREATE TABLE gate_card_intents (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES gate_accounts(id),
  key_id uuid REFERENCES gate_api_keys(id),
  vendor_id text NOT NULL,
  reference text NOT NULL,
  reference_norm text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  card_id text UNIQUE,
  card_last4 text,
  status text NOT NULL CHECK (status IN
    ('creating', 'issued', 'authorized', 'paid', 'released', 'canceled', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- At most one open card per invoice.
CREATE UNIQUE INDEX gate_card_intents_open ON gate_card_intents(account_id, vendor_id, reference_norm)
  WHERE status IN ('creating', 'issued', 'authorized');

-- Every authorization Stripe sent or reported on a gate card, with what the gate answered and
-- what Stripe did.
--   gate_approved    the gate's answer (null: Stripe never asked, e.g. a timeout or stand-in)
--   stripe_approved  what Stripe reports (null until an issuing_authorization.created/updated)
--   approved_cents   what the gate approved in total (increments included)
--   amount_cents     the amount held: what the gate approved, or what Stripe reports once it does
--                    (less after a partial reversal, 0 after a full one)
--   merchant_key     the merchant charging ("CARD:<network id>"), and vendor_id the vendor whose
--                    merchant that is, if any (as the rules matched it)
--   status           Stripe's: pending, closed, reversed, expired
CREATE TABLE gate_card_authorizations (
  id text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES gate_accounts(id),
  intent_id uuid NOT NULL REFERENCES gate_card_intents(id),
  decision_id uuid REFERENCES gate_decisions(id) ON DELETE SET NULL,
  gate_approved boolean,
  stripe_approved boolean,
  approved_cents bigint NOT NULL DEFAULT 0,
  amount_cents bigint NOT NULL DEFAULT 0,
  merchant_key text NOT NULL DEFAULT '',
  vendor_id text,
  status text NOT NULL DEFAULT 'pending',
  day date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gate_card_authorizations_intent ON gate_card_authorizations(intent_id);
CREATE INDEX gate_card_authorizations_day ON gate_card_authorizations(account_id, day);

-- Card transactions Stripe settled: captures (money out, amount_cents > 0) and refunds (money
-- back, amount_cents < 0), each matched to its authorization and, when it was a breach, to the
-- decision that recorded it.
CREATE TABLE gate_card_transactions (
  id text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES gate_accounts(id),
  intent_id uuid NOT NULL REFERENCES gate_card_intents(id),
  authorization_id text,
  type text NOT NULL CHECK (type IN ('capture', 'refund')),
  amount_cents bigint NOT NULL,
  decision_id uuid REFERENCES gate_decisions(id) ON DELETE SET NULL,
  payment_id bigint REFERENCES gate_payments(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gate_card_transactions_authorization ON gate_card_transactions(authorization_id);

-- Stripe events already handled, so a replayed event changes nothing; for an authorization
-- request, `answer` is what the gate answered, given again on a replay.
CREATE TABLE gate_stripe_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  account_id uuid REFERENCES gate_accounts(id),
  answer boolean,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gate_stripe_events_received ON gate_stripe_events(received_at);
