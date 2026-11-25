/**
 * Wording changes applied to the repo's docs on the way into the site, for the few places a
 * sentence only makes sense on GitHub (a table header, a pointer to the site itself). The
 * repo's own docs are not touched. A patch whose text no longer matches is reported by the
 * sync, not fatal.
 */
const at = (src, pairs) => pairs.map(([from, to]) => ({ src, from, to }));

export const PATCHES = [
  ...at("README.md", [
    [
      "The same pages are published as a searchable site at [docs.bondedhq.xyz](https://docs.bondedhq.xyz) (built from these files by `apps/docs`; run it locally with `pnpm docs:dev`).\n",
      "",
    ],
    ["| | |\n|---|---|\n| **Web app**", "| What | Where |\n|---|---|\n| **Web app**"],
    [
      "| | |\n|---|---|\n| [YOUR-AGENTS.md]",
      "| Page | What it covers |\n|---|---|\n| [YOUR-AGENTS.md]",
    ],
  ]),

  ...at("docs/DEVELOPING-REFERENCE.md", [
    [
      ": [docs/progress/evidence/self-serve-testnet.json](progress/evidence/self-serve-testnet.json).",
      ".",
    ],
  ]),

  ...at("docs/BOUNTIES.md", [
    [": [docs/progress/evidence/bounty-testnet.json](progress/evidence/bounty-testnet.json).", "."],
  ]),
];
