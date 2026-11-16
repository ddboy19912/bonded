-- A read-only link to a finished preview's report, made by its owner (docs/BRING-YOUR-OWN-AGENT.md,
-- "Share a report"). Anyone with the link sees the report and nothing else about the owner. The
-- owner can turn it off, which clears the token: the old link stops working at once. A preview
-- never goes on the leaderboard or the Index, shared or not.
ALTER TABLE previews ADD COLUMN share_token text UNIQUE;
ALTER TABLE previews ADD COLUMN shared_at timestamptz;
