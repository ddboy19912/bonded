import assert from "node:assert/strict";
import { test } from "node:test";
import { datedHash, describe, humanDates, resolveHref, transform } from "./transform.mjs";

const REPO = "https://github.com/ddboy19912/bonded";
const files = new Set([
  "apps/api/src/main.ts",
  "docs/progress/evidence/a.json",
  "contracts/evm/script/Smoke.s.sol",
]);
const dirs = new Set(["apps/api", "contracts/evm"]);

const ctx = {
  targets: new Map([
    ["docs/PLAN.md", "/overview/plan/"],
    ["docs", "/"],
  ]),
  evidence: [{ from: "docs/progress/evidence", to: "evidence" }],
  exists: (p) => files.has(p),
  kind: (p) => (dirs.has(p) ? "dir" : files.has(p) ? "file" : null),
  labels: new Map([["docs/PLAN.md", "Product specification"]]),
  shorts: new Map([["docs/PLAN.md", "the plan"]]),
  leftovers: [],
};

test("a relative link to another doc points at its page and keeps the anchor", () => {
  assert.equal(
    resolveHref("PLAN.md#section-9", "docs/AGENTS.md", ctx),
    "/overview/plan/#section-9",
  );
  assert.equal(resolveHref("docs/PLAN.md", "README.md", ctx), "/overview/plan/");
});

test("a GitHub link to a doc in this repo points at the page", () => {
  assert.equal(
    resolveHref(`${REPO}/blob/main/docs/PLAN.md#x`, "README.md", ctx),
    "/overview/plan/#x",
  );
});

test("a doc the site doesn't carry has no link", () => {
  assert.equal(resolveHref("decisions/002-mandate-vault.md", "docs/AGENTS.md", ctx), null);
  assert.equal(resolveHref(`${REPO}/tree/main/docs/decisions`, "README.md", ctx), null);
});

test("links to code go to GitHub, and issues stay as they are", () => {
  assert.equal(
    resolveHref("../apps/api/src/main.ts", "docs/AGENTS.md", ctx),
    `${REPO}/blob/main/apps/api/src/main.ts`,
  );
  assert.equal(resolveHref("../apps/api", "docs/AGENTS.md", ctx), `${REPO}/tree/main/apps/api`);
  assert.equal(resolveHref("../apps/missing.ts", "docs/AGENTS.md", ctx), null);
  assert.equal(resolveHref(`${REPO}/issues/84`, "README.md", ctx), `${REPO}/issues/84`);
});

test("other sites and evidence files are kept", () => {
  assert.equal(
    resolveHref("https://github.com/coinbase/agentkit", "README.md", ctx),
    "https://github.com/coinbase/agentkit",
  );
  assert.equal(resolveHref("progress/evidence/a.json", "docs/AGENTS.md", ctx), "/evidence/a.json");
  assert.equal(resolveHref("progress/evidence/missing.json", "docs/AGENTS.md", ctx), null);
});

test("transform adds front matter, drops the h1 and rewrites links outside code only", () => {
  const md = [
    "# Agents in Bonded",
    "",
    "See [the plan](/docs/PLAN.md), `docs/PLAN.md` and the code in `apps/api` and `script/Smoke.s.sol`.",
    "",
    "```bash",
    "git clone https://github.com/ddboy19912/bonded [x](PLAN.md)",
    "```",
    "",
    "Run `forge test` with `<chainId>` and <chainId> here.",
  ].join("\n");
  const out = transform(md, "contracts/evm/README.md", ctx);
  assert.match(out, /^---\ntitle: "Agents in Bonded"\n/);
  assert.doesNotMatch(out, /^# /m);
  assert.match(out, /\[the plan\]\(\/overview\/plan\/\), \[the plan\]/);
  assert.match(
    out,
    /\[`apps\/api`\]\(https:\/\/github\.com\/ddboy19912\/bonded\/tree\/main\/apps\/api\)/,
  );
  assert.match(
    out,
    /\[`script\/Smoke\.s\.sol`\]\(.*\/blob\/main\/contracts\/evm\/script\/Smoke\.s\.sol\)/,
  );
  assert.match(out, /git clone https:\/\/github.com\/ddboy19912\/bonded \[x\]\(PLAN.md\)/);
  assert.match(out, /`<chainId>` and &lt;chainId&gt; here/);
});

test("a mention of an unpublished doc is dropped with its parenthetical", () => {
  const out = transform(
    "# T\n\nDesigned later (`docs/decisions/002.md`) as built.",
    "docs/AGENTS.md",
    ctx,
  );
  assert.match(out, /Designed later as built\./);
});

test("a pointer to a section of the unpublished specification is dropped", () => {
  const out = transform(
    "# T\n\nThe rates are illustrative priors (specification Section 9.2). More.",
    "docs/AGENTS.md",
    ctx,
  );
  assert.match(out, /The rates are illustrative priors\. More\./);
});

test("description is the first paragraph without markup", () => {
  assert.equal(
    describe(["", "# T", "", "A **bold** [link](x) claim.", "", "More."]),
    "A bold link claim.",
  );
});

test("dates in prose read as dates, and code and links keep theirs", () => {
  assert.equal(
    humanDates("Rated 2026-10-05 and 2026-01-31."),
    "Rated October 5, 2026 and January 31, 2026.",
  );
  const out = transform(
    "# T\n\nOn 2026-10-04 (`2026-10-04`, [x](https://e.com/2026-07-10-a)).\n\n```\n2026-10-04\n```",
    "docs/AGENTS.md",
    ctx,
  );
  assert.match(out, /On October 4, 2026 \(`2026-10-04`, \[x\]\(https:\/\/e\.com\/2026-07-10-a\)\)/);
  assert.match(out, /```\n2026-10-04\n```/);
});

test("an anchor with a date in it matches the heading, which shows the date in words", () => {
  assert.equal(datedHash("#rated-on-2026-10-19"), "#rated-on-october-19-2026");
  assert.equal(datedHash("#no-date"), "#no-date");
});

test("a link to a dated heading on the same page is rewritten too", () => {
  assert.equal(resolveHref("#rated-2026-10-19", "docs/AGENTS.md", ctx), "#rated-october-19-2026");
});
