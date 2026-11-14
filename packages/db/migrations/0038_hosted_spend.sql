-- What agents Bonded runs (docs/HOSTED-AGENTS.md) spent on Bonded's model key, by day (UTC) and
-- owner's wallet, so the daily budget (HOSTED_DAILY_USD) and each wallet's share of it
-- (HOSTED_WALLET_DAILY_USD) hold across deploys, restarts and every process that runs hosted
-- agents. Calls in flight are reserved in memory; their cost lands here when they end.
CREATE TABLE hosted_spend (
  day date NOT NULL,
  owner text NOT NULL,
  spent_usd numeric(12, 6) NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  PRIMARY KEY (day, owner)
);
