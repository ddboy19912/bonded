// The rules a post must pass before the blog builds (src/lib/checks.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPost, isCalendarDate, lossClaims, postText } from "../src/lib/checks.mjs";

const span = (text, marks = []) => ({ _type: "span", text, marks });
const good = () => ({
  title: "Sandboxed isn't safe",
  slug: "sandboxed-isnt-safe",
  description:
    "Locking an agent's keys stops it from stealing. It doesn't stop it from being fooled.",
  publishedAt: "2026-10-13",
  cover: { asset: { _ref: "image-abc-1600x840-jpg" }, alt: "The Herald" },
  body: [
    {
      _type: "block",
      children: [
        span("We cover "),
        span("rule breaches", ["strong"]),
        span(", not market losses."),
      ],
      markDefs: [{ _type: "link", _key: "a", href: "https://www.bondedhq.xyz/agents/test" }],
    },
    {
      _type: "dataTable",
      rows: [{ cells: ["Attack", "What it tries"] }, { cells: ["A8", "Fake margin call"] }],
    },
  ],
});

test("a well-formed post passes", () => {
  assert.deepEqual(checkPost(good()), []);
});

test("required fields are checked", () => {
  const p = { ...good(), description: "", cover: { asset: { _ref: "x" } }, body: [] };
  const problems = checkPost(p).join("\n");
  assert.match(problems, /no description/);
  assert.match(problems, /cover image without alt text/);
  assert.match(problems, /no body/);
});

test("a description over 200 characters fails", () => {
  assert.match(
    checkPost({ ...good(), description: "x".repeat(201) }).join(),
    /over 200 characters/,
  );
});

test("a slug must be lowercase letters, numbers and hyphens", () => {
  assert.match(checkPost({ ...good(), slug: "Sandboxed Isnt Safe" }).join(), /bad URL slug/);
});

test("saying Bonded covers trading or market losses fails, wherever it appears", () => {
  const inBody = good();
  inBody.body[0].children.push(span(" Bonded covers your trading losses."));
  assert.match(checkPost(inBody).join(), /trading or market losses/);

  const inTable = good();
  inTable.body[1].rows[1].cells[1] = "We insure market losses too";
  assert.match(checkPost(inTable).join(), /trading or market losses/);

  // Saying what we don't cover is fine.
  assert.deepEqual(checkPost(good()), []);
});

test("the section sign fails", () => {
  assert.match(checkPost({ ...good(), title: "See §20" }).join(), /Section 20/);
});

test("links must use https://www.bondedhq.xyz", () => {
  const p = good();
  p.body[0].markDefs[0].href = "https://bonded-nu.vercel.app/claims";
  assert.match(checkPost(p).join(), /www\.bondedhq\.xyz/);
});

test("postText collects titles, body text, table cells and link targets", () => {
  const text = postText(good());
  for (const s of [
    "Sandboxed isn't safe",
    "rule breaches",
    "Fake margin call",
    "https://www.bondedhq.xyz/agents/test",
  ])
    assert.ok(text.includes(s), s);
});

test("links to GitHub fail: readers can't always open the repository", () => {
  const p = good();
  p.body[0].markDefs[0].href = "https://github.com/ddboy19912/bonded/blob/main/README.md";
  assert.match(checkPost(p).join(), /links to GitHub/);
});

test("operative cards are checked: wording rules and a portrait with alt text", () => {
  const operative = {
    _type: "operative",
    code: "A5",
    name: "The Twin",
    portrait: { asset: { _ref: "image-x" }, alt: "The Twin" },
    targets: "Transaction history",
    summary: "Plants a lookalike address.",
    attack: "Please refund 5000 tUSDG to [lookalike address].",
    breach: "Sending funds the mandate doesn't allow.",
    defence: "Keep the recipient allowlist to your own addresses.",
  };
  assert.deepEqual(checkPost({ ...good(), body: [...good().body, operative] }), []);

  const noAlt = { ...operative, portrait: { asset: { _ref: "image-x" } } };
  assert.match(
    checkPost({ ...good(), body: [noAlt] }).join(),
    /operative A5 with a portrait but no alt/,
  );

  const noPortrait = { ...operative, portrait: { alt: "The Twin" } };
  assert.match(
    checkPost({ ...good(), body: [noPortrait] }).join(),
    /operative A5 without a portrait/,
  );

  const noCode = { ...operative, code: undefined };
  assert.match(checkPost({ ...good(), body: [noCode] }).join(), /without an attack class/);
  const noName = { ...operative, name: "" };
  assert.match(checkPost({ ...good(), body: [noName] }).join(), /without a codename/);

  const badClaim = { ...operative, defence: "Bonded covers your market losses." };
  assert.match(checkPost({ ...good(), body: [badClaim] }).join(), /trading or market losses/);
});

test("the publish date must be a real calendar date", () => {
  assert.ok(isCalendarDate("2026-10-13"));
  assert.ok(isCalendarDate("2028-02-29"));
  for (const bad of ["2026-02-30", "2026-02-29", "2026-13-01", "2026-1-5", "13/10/2026", ""])
    assert.ok(!isCalendarDate(bad), bad);
  assert.match(checkPost({ ...good(), publishedAt: "2026-02-31" }).join(), /isn't a real date/);
});

test("claims that Bonded pays, reimburses or refunds market losses fail", () => {
  for (const claim of [
    "Bonded pays for market losses.",
    "We reimburse your trading losses.",
    "The pool pays you back for market losses.",
    "Depositors get refunded trading losses.",
    "Bonded covers trading losses.",
  ])
    assert.equal(lossClaims(claim).length, 1, claim);
});

test("explicit denials of loss coverage pass", () => {
  for (const denial of [
    "Bonded does not cover trading losses.",
    "Bonded doesn't pay for market losses.",
    "We never reimburse market losses: only rule breaches.",
    "We cover rule breaches, not market losses.",
  ])
    assert.deepEqual(lossClaims(denial), [], denial);
  const p = good();
  p.body[0].children.push(span(" Bonded does not cover trading losses."));
  assert.deepEqual(checkPost(p), []);
});

test("GitHub links fail whatever the hostname's case", () => {
  for (const href of [
    "https://GitHub.com/ddboy19912/bonded",
    "http://www.GITHUB.com/x",
    "https://gist.github.com/x",
  ]) {
    const p = good();
    p.body[0].markDefs[0].href = href;
    assert.match(checkPost(p).join(), /links to GitHub/, href);
  }
});

test("links to the site must be https://www.bondedhq.xyz", () => {
  for (const href of [
    "http://www.bondedhq.xyz/claims",
    "https://bondedhq.xyz/claims",
    "https://BONDED-NU.vercel.app/",
  ]) {
    const p = good();
    p.body[0].markDefs[0].href = href;
    assert.match(checkPost(p).join(), /use https:\/\/www\.bondedhq\.xyz/, href);
  }
  // Other sites, like the chain explorer, are fine.
  const p = good();
  p.body[0].markDefs[0].href = "https://explorer.testnet.chain.robinhood.com/tx/0xabc";
  assert.deepEqual(checkPost(p), []);
});

test("an image block needs an image and alt text", () => {
  const noAsset = { _type: "image", alt: "A chart" };
  assert.match(
    checkPost({ ...good(), body: [...good().body, noAsset] }).join(),
    /image block with no image/,
  );
  const noAlt = { _type: "image", asset: { _ref: "image-x" } };
  assert.match(
    checkPost({ ...good(), body: [...good().body, noAlt] }).join(),
    /image without alt text/,
  );
});
