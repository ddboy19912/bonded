# Privacy and your data

Bonded's privacy page is at [www.bondedhq.xyz/privacy](https://www.bondedhq.xyz/privacy). It says what Bonded keeps when you test an agent, how long it keeps it, who sees it, and how to have it deleted. Questions: hello@bondedhq.xyz.

## How long Bonded keeps it

An hourly clean-up deletes data on these schedules:

- **Test traces** (the live event stream and connection checks' step logs): 30 days.
- **Payment gate decisions:** 365 days.
- **Inbox notifications:** 90 days.
- **Sign-in codes, passkey challenges and expired sessions:** a day.
- **Previews that never started a rating** close as `expired` after 7 days, the life of the runner token.

## Deleting a preview

You can delete one of your previews with **Remove** (`DELETE /previews/:id`). Its reports, episodes, share link, tokens, Agent URL, hosted code, checks and notifications are deleted at once. The empty preview and rating rows stay, because the daily preview limits count them.

## If you run your own copy

Two of the retention periods are settings. Keep them in step with your privacy page.

- `EVENTS_RETENTION_DAYS` (default 30): test traces.
- `GATE_DECISION_RETENTION_DAYS` (default 365): payment gate decisions.
