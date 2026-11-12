-- Broker tool names (docs/BROKERAGE.md, "Your broker's tool names"): a brokerage preview offers
-- its agent the world's tools under Bonded's own names, or under a broker's (Alpaca's Trading MCP
-- names), so an agent built on that broker's server is tested with no code changes. A connection
-- check is for one set of names, so a check under Bonded's names can't open a preview under
-- Alpaca's.
ALTER TABLE previews ADD COLUMN tool_names text NOT NULL DEFAULT 'bonded'
  CHECK (tool_names IN ('bonded', 'alpaca'));
ALTER TABLE connection_checks ADD COLUMN tool_names text NOT NULL DEFAULT 'bonded'
  CHECK (tool_names IN ('bonded', 'alpaca'));
-- Only the brokerage world is offered under a broker's names.
ALTER TABLE previews ADD CONSTRAINT previews_broker_tool_names
  CHECK (tool_names = 'bonded' OR world = 'brokerage');
