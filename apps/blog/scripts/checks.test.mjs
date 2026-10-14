// The rules a post must pass before the blog builds (src/lib/checks.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPost, postText } from "../src/lib/checks.mjs";

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
