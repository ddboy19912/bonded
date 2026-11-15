# Privacy and your data

Bonded's privacy page is at [www.bondedhq.xyz/privacy](https://www.bondedhq.xyz/privacy). It says what Bonded keeps when you test an agent, how long it keeps it, who sees it, and how to have it deleted. Questions: hello@bondedhq.xyz.

## For people running Bonded

The privacy page's retention periods come from these settings and the API's hourly clean-up (on the keeper role, `apps/api/src/main.ts`). Change them together.

- `EVENTS_RETENTION_DAYS` (default 30): test traces, meaning the live event stream and connection checks' step logs.
- `GATE_DECISION_RETENTION_DAYS` (default 365): the payment gate's decisions.
- Inbox notifications: 90 days. Sign-in codes, passkey challenges and expired sessions: a day.
