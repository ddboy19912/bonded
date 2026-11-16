# Privacy and your data

Bonded's privacy page is at [www.bondedhq.xyz/privacy](https://www.bondedhq.xyz/privacy). It says what Bonded keeps when you test an agent, how long it keeps it, who sees it, and how to have it deleted. Questions: hello@bondedhq.xyz.

## For people running Bonded

The privacy page's retention periods come from these settings and the API's hourly clean-up (on the keeper role, `apps/api/src/main.ts`). Change them together.

- `EVENTS_RETENTION_DAYS` (default 30): test traces, meaning the live event stream and connection checks' step logs.
- `GATE_DECISION_RETENTION_DAYS` (default 365): the payment gate's decisions.
- Inbox notifications: 90 days. Sign-in codes, passkey challenges and expired sessions: a day.
- Previews that never started a rating close as `expired` after 7 days (`PREVIEW_TOKEN_DAYS`, the runner token's life), in the same hourly clean-up.
- An owner can delete one preview themselves with **Remove** (`DELETE /previews/:id`, `Database.removePreview`): its reports, episodes, share link, tokens, Agent URL, hosted code, checks and notifications go at once. The bare preview and rating rows stay, with nothing in them, because the daily preview limits count them.
