-- Removing a preview, and closing stale ones (docs/BRING-YOUR-OWN-AGENT.md, "Remove a preview").
--
-- removed_at  set when the owner removes the preview. Everything in it is deleted then (its
--             report, episodes, share link, runner tokens, Agent URL, hosted code and connection
--             checks); what stays is the bare row and its ratings' bare rows (no report), because
--             the daily preview limits count them. A removed preview is "not found" everywhere.
-- 'expired'   a preview that never started a rating and is older than its runner token's life
--             (PREVIEW_TOKEN_DAYS, 7 days): the keeper closes it, like a stopped one.
ALTER TABLE previews ADD COLUMN removed_at timestamptz;
ALTER TABLE previews DROP CONSTRAINT previews_status_check;
ALTER TABLE previews ADD CONSTRAINT previews_status_check CHECK (status IN
  ('created', 'checking', 'ready', 'queued', 'starting', 'running', 'done', 'failed', 'refused',
   'stopped', 'expired'));
