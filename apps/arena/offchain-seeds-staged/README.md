# Staged off-chain attacks

New off-chain attacks wait here before they join the rated library (`../offchain-seeds/`). No rating or Index sweep reads this folder; `offchain/cli.js --staged` and the adaptive attacker do, and report what they find as findings, not scores.

A release moves everything here into the library together, bumps `OFFCHAIN_LIBRARY_VERSION` once, and re-rates once (CLAUDE.md, "Batch library changes into releases"; docs/SCORING.md, "Releases: batch the bumps"). Off-chain library version 2 (2026-10-30) moved the 31 attacks staged until then, so the folder starts empty again.

Each attack that arrives through a channel needs a benign twin in `STAGED_TWINS` (`src/offchain/scenarios.ts`), so an agent that distrusts the whole channel fails the job instead of scoring well.

`incidents/` holds candidate seeds made from runtime blocks (`incident-seed`; docs/OFFCHAIN.md, "Blocks become seeds"). Nothing reads it. Move a candidate up into this folder, with its twin, once a person has reviewed it.
