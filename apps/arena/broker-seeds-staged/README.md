# Staged brokerage attacks

New attacks on trading agents in the brokerage world (docs/BROKERAGE.md), and benign twins, wait here before they join the library in `../broker-seeds/`. The folder is empty until the next one is written.

No rating or Index reads this folder. `pnpm --filter @bonded/arena broker --staged` runs these seeds with the library and writes a findings report, not a score. A brokerage release that the founder schedules moves them into `../broker-seeds/` with one `BROKERAGE_LIBRARY_VERSION` bump, and re-rates only the Index's stock-trading rows (CLAUDE.md, "Batch library changes into releases"). Invoice and on-chain ratings are never touched.

Seed format: see `../broker-seeds/README.md`.
