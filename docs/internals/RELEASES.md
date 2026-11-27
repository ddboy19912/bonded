# Releases, versions and the leaderboard (maintainers)

How the rated attack library changes, how its versions are bumped, and how the leaderboard is refreshed. This is maintainer detail, kept out of the public docs site; the public summary is in [SCORING.md](../SCORING.md).

## Task score: running and versioning

Every rating runs each single-day twin once: Bonded's own agents, operator-run agents, previews
and `--profile hosted` alike (`pnpm arena rate --benign-runs <n>` changes that, `--no-benign` skips
them; the API worker skips them when `RATE_WITH_BENIGN` is `false` or `0`). The hosted time and
budget plans count them (`remoteRatingPlan` and `previewRatingPlan` in apps/api). The twins are
published, so an operator could tune an agent to them; that can only raise its Task score, never
its Security score or insurance score.

Twins' episodes are kept apart from controls and attacks: they never count towards the Security
score, the insurance score, liveness or the Sentinel dataset. The Task score lives in the report,
which `reportHash` commits to; it is not an attestation field.

The Task score has its own version, `TASK_SCORE_VERSION` (`packages/shared/src/library-version.ts`),
recorded in the report's `task.version` and the leaderboard entry's. Bump it when a twin is
added, removed or changed, or the Task score's rule changes; `library-version.test.ts`
fingerprints the twins. It is kept apart from the attack library version on purpose: the twins
never enter the Security score or the insurance score, so changing them must not mark every
measured Security score as older.

To add the Task score to leaderboard entries rated earlier without re-running the attack
library, run `pnpm --filter @bonded/arena leaderboard task --max-usd <n>` (`--dry-run` for the
plan and estimate first). It runs `arena task` for each entry: six controls and the twins, no
attacks, about 22 episodes against a full rating's ~450. The entry's Security score, insurance score and
on-chain post are unchanged; its `task` block says `source: "task"`, and its under-attack part is
empty, so its Task score is the lower of controls and twins. An entry rated in full later gets
the full Task score (`source: "rating"`).

## Attack library version (in detail)

`ATTACK_LIBRARY_VERSION` (`packages/shared/src/library-version.ts`) is one number for everything a
rating is measured against: the published attacks (`attacks/`), the S1 market-data seeds
(`apps/arena/s1-seeds`), the memory seeds (`apps/arena/s1-seeds-memory`), the world-state seeds
(`apps/arena/world-seeds`) and the scoring rules (`susceptibility()` and `scoreRating()`, the S1,
memory and world-state counting rules). Every rating report
records it as `libraryVersion` (and in `report.md`), and every leaderboard entry copies it.

Bump it by hand, in the same commit, when a seed is added, removed or changed, or when a scoring
rule changes what a rating would produce, and add a line to the history in that file. The test
`apps/arena/test/library-version.test.ts` fingerprints the seed folders (the world-state seeds
joined in version 2) and fails if they change without a bump; scoring rules aren't fingerprinted, so a scoring change needs the bump by
judgement. Bumping it costs nothing on chain: the version is in the report, which `reportHash`
commits to.

The web leaderboard shows the current version. Entries rated on an older version are marked as
such and left off the podium, and entries with no version are shown as rated before versions
were recorded. The six entries from the Oct 19–20, 2026 re-rating were backfilled as version 1:
their reports carry S1 fields that only the code after commit 82814f61 writes, and the seeds and
`actuarial.ts` have not changed since 21:53 on Oct 19, before they started.

To bring the board up to date after a bump, run `pnpm --filter @bonded/arena leaderboard refresh`
([below](#refreshing-the-leaderboard)).

Version 2 (Oct 26, 2026) added the world-state battery and changed every world: a world with no
history now sometimes shows items from yesterday (a carried block in the market report in about
40% of worlds, an inbox message from yesterday in about 30%). Security scores on version 1 and version 2
are not directly comparable.

### Releases: batch the bumps

A bump makes every leaderboard entry out of date, and re-rating all six costs about $3 and
3 hours. So the rated library changes only in releases, never at the end of each feature:

- New attacks, seeds and twins land in the staged folders (`apps/arena/world-seeds-staged/`,
  `apps/arena/world-twins-staged/`), which no rating reads. `arena world --staged` runs them.
- Their validation results go in the feature's doc as findings, with their assumptions, not as
  leaderboard scores.
- A release moves everything staged since the last one into the rated folders together, bumps
  `ATTACK_LIBRARY_VERSION` (and `TASK_SCORE_VERSION` if twins moved) once, and re-rates once.
  The founder decides when a release happens. Each world releases the same way with its own
  version, and re-rates only its own rows: the invoice world with `OFFCHAIN_LIBRARY_VERSION`
  (docs/OFFCHAIN.md), the brokerage world with `BROKERAGE_LIBRARY_VERSION` (docs/BROKERAGE.md).
  A release in one world never marks another's ratings as older, so it never needs a re-rate
  outside that world.
- A fix to a rated seed or scoring rule that is wrong (it miscounts, or a seed can't be passed)
  waits for the next release too, unless the founder asks for it sooner.

## Refreshing the leaderboard

`pnpm --filter @bonded/arena leaderboard refresh` re-rates every entry in `config/leaderboard.json`
(or `--only <slug,slug>`) with its agent and model and the standard settings: 5 runs of each
attack, the held-out set (the newest folder in `~/.config/bonded/held-out`, or `--held-out`),
900 s episodes, S1 at 2 pairs a seed, and a total `--max-usd` cap shared across the model-driven
entries. It writes each rating to `apps/arena/ratings/refresh-v<version>/<slug>` and is safe to
run again: a slug whose folder holds a complete, publishable rating on the current version is
skipped, and a folder from a rating that stopped early, hit an agent error or crashed is moved
aside (to `<slug>.failed-<n>`, its spend still counted against the cap) and rated again. Once every
entry is complete it posts them all with `leaderboard add --post` semantics (a score already
posted for the same report is not posted twice) and prints a summary. `--dry-run` prints the plan
and a cost estimate without running anything; `--no-post` stops after updating the file.

An entry the board already lists on the current attack library is skipped too, when the
registry on Robinhood Chain testnet holds its score (the same report hash and insurance score):
it is not re-rated or posted again, so a refresh right after a library bump re-rates only what the
bump made stale (and a refresh with nothing to rate needs no held-out set). If the registry can't be read, the refresh stops rather than re-rate entries that
may be current. Only the entries a refresh covers (all, or `--only`) are read. A named run (`--run <name>`) skips this check: a new name re-rates every entry, and running the same name again still skips what that run already completed.

Each rating is its own `arena rate` process on its own local chain, logged to `<slug>.log` next to
its folder. A model-driven rating took 70–90 minutes in the Oct 19–20 re-rating, so the default
one-at-a-time run of the six entries takes about six hours; `--parallel 4` cuts that to under two.
The cost estimate is $0.45 per model-driven rating at 5 runs (that re-rating spent $0.33–0.41 per
entry on DeepSeek v4.1 Flash and GLM 5.3 Flash); retries cost extra and count against the cap.

## One version per world

Each world has its own library version, so a release in one world re-rates only that world's rows and never marks another's as older:

- `ATTACK_LIBRARY_VERSION`: on-chain attacks, seeds and scoring (above).
- `OFFCHAIN_LIBRARY_VERSION`: off-chain seeds, Index variants, controls, twins and judging. The off-chain Index rows live in `config/bonded-index.json`.
- `BROKERAGE_LIBRARY_VERSION`: brokerage seeds, the base account and judging. The brokerage rows live in `config/brokerage-index.json`, written by `pnpm --filter @bonded/arena brokerage-index --models <ids> --max-usd <n>`, which replaces a model's earlier entry. A brokerage release re-rates only these rows; an invoice or on-chain release never touches them.
