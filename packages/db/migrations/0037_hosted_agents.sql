-- Hosted agents ("Run it on Bonded", docs/HOSTED-AGENTS.md): instead of running a runner or an
-- Agent URL, the owner gives Bonded their agent, its instructions on a model they pick or one
-- code file, and Bonded runs it for each episode. A preview connects this way with connection
-- 'hosted', for now on the brokerage world only.
ALTER TABLE previews DROP CONSTRAINT previews_connection_check;
ALTER TABLE previews ADD CONSTRAINT previews_connection_check
  CHECK (connection IN ('runner', 'url', 'hosted'));
ALTER TABLE previews ADD CONSTRAINT previews_hosted_brokerage
  CHECK (connection <> 'hosted' OR world = 'brokerage');

-- What a hosted preview runs: one row per preview (its owner key), replaced on every save with a
-- new id, so a connection check passes only the agent it ran. code_hash commits to the kind, the
-- model and the text (hostedCodeHash in @bondedhq/shared).
CREATE TABLE hosted_agents (
  id uuid PRIMARY KEY,
  owner_key text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('instructions', 'code')),
  model text NOT NULL,
  instructions text,
  language text CHECK (language IN ('js', 'ts')),
  code text,
  code_hash text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (kind = 'instructions' AND instructions IS NOT NULL AND code IS NULL AND language IS NULL)
    OR (kind = 'code' AND code IS NOT NULL AND language IS NOT NULL AND instructions IS NULL)
  )
);
