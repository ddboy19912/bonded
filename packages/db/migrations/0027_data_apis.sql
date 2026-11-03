-- The data APIs (apps/api/DATA-API.md): model risk data from the Bonded Index, testing in CI on
-- the preview rating flow, and the attack data export. Keys are made by an owner's wallet session
-- and work like gate API keys: only the key's sha256 is kept, and the key is shown once.
CREATE TABLE data_api_keys (
  id uuid PRIMARY KEY,
  owner text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  prefix text NOT NULL,
  label text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX data_api_keys_owner ON data_api_keys(owner, created_at);

-- The meter: requests per key per UTC day, per API (index, attacks, ci, webhooks). Counts only.
CREATE TABLE data_api_usage_daily (
  key_id uuid NOT NULL REFERENCES data_api_keys(id),
  day date NOT NULL,
  api text NOT NULL CHECK (api IN ('index', 'attacks', 'ci', 'webhooks')),
  requests integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, day, api)
);

-- Webhooks told when a model's score in the Bonded Index changes. The signing secret is stored
-- only encrypted (AGENT_URL_SECRET_KEY), bound to the row.
--   models  the model addresses (`indexModelSlug`) to hear about; empty for every model
CREATE TABLE index_webhooks (
  id uuid PRIMARY KEY,
  key_id uuid NOT NULL REFERENCES data_api_keys(id),
  url text NOT NULL,
  secret_ciphertext text NOT NULL,
  models text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX index_webhooks_key ON index_webhooks(key_id);

-- Each Bonded Index the keeper has seen (config/bonded-index.json, which changes with a deploy):
-- its hash and each model's scores, so the next one can be compared with it.
CREATE TABLE index_snapshots (
  id bigserial PRIMARY KEY,
  hash text NOT NULL,
  models jsonb NOT NULL,
  updated_at text NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now()
);

-- One delivery of one change to one webhook, retried with backoff until it is answered with a
-- 2xx or runs out of attempts. `event_id` names the change, so it is queued once per webhook.
--   status  pending (waiting for its next attempt), delivered, or failed (no attempts left)
CREATE TABLE index_webhook_deliveries (
  id bigserial PRIMARY KEY,
  webhook_id uuid NOT NULL REFERENCES index_webhooks(id),
  event_id text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_at timestamptz NOT NULL DEFAULT now(),
  last_status integer,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE (webhook_id, event_id)
);
CREATE INDEX index_webhook_deliveries_due ON index_webhook_deliveries(next_at)
  WHERE status = 'pending';

-- Testing in CI: one run is a preview rating of the owner's preview (an Agent URL it verified on
-- the Test your agent page), started by a data API key and judged against a minimum score.
--   status  checking (its connection check is running), rating (its preview rating is queued or
--           running), passed, failed (it scored under the minimum), or error (it couldn't finish)
CREATE TABLE ci_runs (
  id uuid PRIMARY KEY,
  key_id uuid NOT NULL REFERENCES data_api_keys(id),
  owner text NOT NULL,
  preview_id uuid NOT NULL REFERENCES previews(id),
  min_score integer NOT NULL CHECK (min_score BETWEEN 0 AND 100),
  min_task_score integer CHECK (min_task_score BETWEEN 0 AND 100),
  status text NOT NULL CHECK (status IN ('checking', 'rating', 'passed', 'failed', 'error')),
  check_id uuid,
  rating_id uuid,
  score integer,
  task_score integer,
  reason text,
  label text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX ci_runs_owner ON ci_runs(owner, created_at);
CREATE INDEX ci_runs_key ON ci_runs(key_id, created_at);
