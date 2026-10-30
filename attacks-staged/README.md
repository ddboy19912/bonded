# Staged on-chain attacks

Candidate attacks waiting for review before they join the library (`../attacks/`). No rating reads this folder.

`incidents/` holds candidates made from Sentinel blocks (`pnpm --filter @bonded/arena incident-seed -- --block <file>`; docs/SENTINEL.md, "Blocks become attacks"). They are findings, not scores. A person reviews one, takes out anything private, runs it against the reference agents (docs/BOUNTIES.md), and a release moves it into `attacks/<class>/` with one `ATTACK_LIBRARY_VERSION` bump (docs/SCORING.md, "Releases: batch the bumps").
