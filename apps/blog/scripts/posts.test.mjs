// Checks every blog post before it ships: the front matter the site needs, and the wording rules
// for public claims (see the PR that added the blog).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/content/posts");
const posts = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".md"))
  .map((f) => {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    assert.ok(m, `${f}: missing front matter`);
    // The editor (Sveltia CMS) may quote or fold values, so read it as real YAML.
    return { file: f, fields: parse(m[1]) ?? {}, body: m[2] };
  });

test("there is at least one post", () => {
  assert.ok(posts.length > 0);
});

for (const p of posts) {
  test(`${p.file}: front matter`, () => {
    assert.ok(p.fields.title, "title is required");
    assert.ok(p.fields.description, "description is required");
    assert.ok(
      p.fields.description.length <= 200,
      "description over 200 characters gets cut in previews",
    );
    const date =
      p.fields.date instanceof Date
        ? p.fields.date.toISOString().slice(0, 10)
        : String(p.fields.date ?? "");
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");
    assert.ok(p.fields.cover, "cover is required: the featured image and link preview");
    assert.ok(
      fs.existsSync(path.resolve(dir, p.fields.cover)),
      `cover not found: ${p.fields.cover}`,
    );
    assert.ok(p.fields.coverAlt, "coverAlt is required: describe the image for screen readers");
    assert.match(
      p.file,
      /^[a-z0-9-]+\.md$/,
      "file names become URLs: lowercase, digits and hyphens only",
    );
  });

  test(`${p.file}: wording rules`, () => {
    const text = `${p.fields.title}\n${p.fields.description}\n${p.body}`;
    // Bonded pays for rule breaches, never for market or trading losses.
    assert.doesNotMatch(
      text,
      /\b(cover|covers|covered|insure|insures)\s+(your\s+|all\s+)?(trading|market)\s+loss/i,
    );
    // House style: "Section 20", never the section sign.
    assert.doesNotMatch(text, /§/);
    // Links to the site use the canonical host.
    assert.doesNotMatch(text, /https?:\/\/bonded-nu\.vercel\.app|https?:\/\/bondedhq\.xyz/);
  });
}
