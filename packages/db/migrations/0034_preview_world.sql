-- Brokerage previews (docs/BROKERAGE.md, "Your own agent"): a preview tests an operator's agent on
-- a world, the on-chain vault (as before) or a simulated brokerage account. A connection check
-- is for one world, so a vault check can't open a brokerage preview's rating.
ALTER TABLE previews ADD COLUMN world text NOT NULL DEFAULT 'vault'
  CHECK (world IN ('vault', 'brokerage'));
ALTER TABLE connection_checks ADD COLUMN world text NOT NULL DEFAULT 'vault'
  CHECK (world IN ('vault', 'brokerage'));
-- The brokerage world has no chain, so its agents connect in tools mode only.
ALTER TABLE previews ADD CONSTRAINT previews_brokerage_tools
  CHECK (world <> 'brokerage' OR mode = 'tools');
