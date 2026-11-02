// How the blog index is split into pages (src/lib/paginate.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { GRID_SIZE, pagePath, paginate } from "../src/lib/paginate.mjs";

const posts = (n) => Array.from({ length: n }, (_, i) => `p${i + 1}`);

test("no posts still gives one empty page", () => {
  assert.deepEqual(paginate([]), [{ number: 1, total: 1, lead: undefined, posts: [] }]);
});

test("a lead post alone is one page with an empty grid", () => {
  assert.deepEqual(paginate(posts(1)), [{ number: 1, total: 1, lead: "p1", posts: [] }]);
});

test("the lead post and a full grid fit on page 1", () => {
  const pages = paginate(posts(1 + GRID_SIZE));
  assert.equal(pages.length, 1);
  assert.equal(pages[0].lead, "p1");
  assert.equal(pages[0].posts.length, GRID_SIZE);
});

test("one post over the grid starts page 2, and only page 1 has the lead", () => {
  const pages = paginate(posts(2 + GRID_SIZE));
  assert.equal(pages.length, 2);
  assert.equal(pages[1].lead, undefined);
  assert.deepEqual(pages[1].posts, [`p${GRID_SIZE + 2}`]);
  assert.ok(pages.every((p) => p.total === 2));
});

test("every post appears exactly once, in order", () => {
  const all = posts(30);
  const pages = paginate(all);
  const flat = pages.flatMap((p) => [p.lead, ...p.posts].filter(Boolean));
  assert.deepEqual(flat, all);
  assert.deepEqual(
    pages.map((p) => p.number),
    [1, 2, 3, 4],
  );
});

test("page 1 is the blog's front page, the rest live under /page/", () => {
  assert.equal(pagePath("/blog/", 1), "/blog/");
  assert.equal(pagePath("/blog/", 3), "/blog/page/3/");
});
