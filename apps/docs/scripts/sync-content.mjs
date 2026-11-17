// Builds the docs site's pages from the Markdown already in the repo (README, docs/, the
// contracts' READMEs). Nothing under src/content/docs except index.mdx is written by hand.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DROP_SECTIONS, EVIDENCE_DIRS, FOLDERS, PAGES, SHORT_NAMES } from "./pages.mjs";
import { PATCHES } from "./patches.mjs";
import { BASE, pageUrl, transform } from "./transform.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const outDir = path.resolve(here, "../src/content/docs");
const publicDir = path.resolve(here, "../public");

const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
/** Hosting, model-repo and local-path names that must not reach the public site. */
const PRIVATE_EVIDENCE =
  /bonded-sentinel-laya|sentinel\/kaggle\/README|railway\.app|\/Users\/|\.railway\.internal/;
const exists = (p) => fs.existsSync(path.join(root, p));
const isFile = (p) => exists(p) && fs.statSync(path.join(root, p)).isFile();
/** "file", "dir" or null for a repo path (never outside the repo). */
const kind = (p) => {
  if (p.startsWith("..") || p.includes("node_modules") || !exists(p)) return null;
  return fs.statSync(path.join(root, p)).isDirectory() ? "dir" : "file";
};

function listFiles(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    return e.isDirectory() ? listFiles(rel) : [rel];
  });
}

// Start clean so a renamed or removed doc doesn't linger. index.mdx is the one page written by hand.
for (const entry of fs.readdirSync(outDir)) {
  if (entry !== "index.mdx") fs.rmSync(path.join(outDir, entry), { recursive: true, force: true });
}
fs.rmSync(path.join(publicDir, "evidence"), { recursive: true, force: true });
fs.rmSync(path.join(publicDir, "images"), { recursive: true, force: true });

// Pages: the fixed list, then every file in the decision and progress folders.
const pages = PAGES.map((p) => ({ ...p }));
const folderPages = [];
for (const folder of FOLDERS) {
  const files = fs
    .readdirSync(path.join(root, folder.dir))
    .filter((f) => f.endsWith(".md"))
    .sort();
  for (const file of files) {
    folderPages.push({ src: `${folder.dir}/${file}`, slug: `${folder.slug}/${folder.name(file)}` });
  }
}
pages.push(...folderPages);

const targets = new Map(pages.map((p) => [p.src, pageUrl(p.slug)]));
for (const f of FOLDERS) targets.set(f.dir, pageUrl(f.slug));
targets.set("docs", `${BASE}/`);

const labels = new Map(pages.filter((p) => p.label).map((p) => [p.src, p.label]));
const leftovers = [];
const ctx = {
  targets,
  evidence: EVIDENCE_DIRS,
  exists: (p) => isFile(p) && !PRIVATE_EVIDENCE.test(read(p)),
  labels,
  shorts: new Map(Object.entries(SHORT_NAMES)),
  kind,
  leftovers,
};

/** The source text with this page's wording patches applied. */
function patched(src) {
  let text = read(src);
  for (const patch of PATCHES.filter((p) => p.src === src)) {
    if (!text.includes(patch.from)) {
      console.warn(`docs: patch for ${src} no longer matches: ${patch.from.slice(0, 60)}`);
      continue;
    }
    text = text.replaceAll(patch.from, patch.to);
  }
  return text;
}

for (const page of pages) {
  const dest = path.join(outDir, `${page.slug}.md`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(
    dest,
    transform(patched(page.src), page.src, ctx, {
      title: page.title,
      dropSections: DROP_SECTIONS[page.src],
    }),
  );
}

// Index pages for the folders.
for (const folder of FOLDERS) {
  const entries = folderPages
    .filter((p) => p.slug.startsWith(`${folder.slug}/`))
    .map((p) => {
      const m = patched(p.src).match(/^# (.+)$/m);
      return `- [${m ? m[1].replace(/`/g, "") : p.slug}](${pageUrl(p.slug)})`;
    });
  const dest = path.join(outDir, folder.slug, "index.md");
  fs.writeFileSync(
    dest,
    [
      "---",
      `title: ${JSON.stringify(folder.index.title)}`,
      `description: ${JSON.stringify(folder.index.description)}`,
      "---",
      "",
      folder.index.intro,
      "",
      ...entries,
      "",
    ].join("\n"),
  );
}

// Evidence files the pages cite, served as they are, except any that name something private.
for (const { from, to, only } of EVIDENCE_DIRS) {
  if (!exists(from)) continue;
  for (const file of listFiles(from)) {
    if (only && !only.test(file)) continue;
    if (PRIVATE_EVIDENCE.test(read(file))) {
      console.warn(`docs: evidence not published (names something private): ${file}`);
      continue;
    }
    const dest = path.join(publicDir, to, file.slice(from.length + 1));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(root, file), dest);
  }
}

for (const line of leftovers)
  console.warn(`docs: repository path left in prose: ${line.slice(0, 160)}`);
console.log(`docs: wrote ${pages.length} pages`);
