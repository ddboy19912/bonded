import path from "node:path";

/** The docs site is served at the root of docs.bondedhq.xyz, so page URLs have no prefix. */
export const BASE = "";
/** The repository, for links to code. */
export const GITHUB = "https://github.com/ddboy19912/bonded";
const REPO_URL = /^https?:\/\/github\.com\/ddboy19912\/bonded(?:\/|$)/;
const KNOWN_HTML = new Set([
  "br",
  "details",
  "summary",
  "sub",
  "sup",
  "kbd",
  "em",
  "strong",
  "b",
  "i",
]);

/** `README.md` -> `/overview/introduction/` for every repo path that has a page. */
export function pageUrl(slug) {
  return `${BASE}/${slug}/`;
}

/**
 * Where a link found in `srcPath` points: `{ external: href }` for other sites (and the
 * repository's own issues), `{ repoPath, hash }` for a path in this repository, or null.
 */
export function locate(href, srcPath) {
  if (href.startsWith("#")) return { repoPath: srcPath, hash: href };

  let repoPath;
  let hash;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    if (!REPO_URL.test(href)) return { external: href }; // someone else's site
    const url = new URL(href);
    hash = url.hash;
    const m = url.pathname.match(/^\/ddboy19912\/bonded\/(?:blob|tree)\/[^/]+\/(.*)$/);
    if (!m) return { external: href }; // the repository itself, issues, pull requests: keep
    repoPath = m[1];
  } else {
    const [p, ...rest] = href.split("#");
    hash = rest.length ? `#${rest.join("#")}` : "";
    if (!p) return null;
    const decoded = decodeURIComponent(p);
    repoPath = decoded.startsWith("/")
      ? path.posix.normalize(decoded.slice(1))
      : path.posix.normalize(path.posix.join(path.posix.dirname(srcPath), decoded));
  }
  return { repoPath: repoPath.replace(/\/$/, ""), hash };
}

/**
 * Resolve a link found in `srcPath` to a site URL, or null when the target is not part of the
 * site (source code, scripts, issues): those links are dropped and only their text stays.
 *
 * `ctx.targets` maps repo paths to URLs, `ctx.evidence` maps repo directories to site
 * directories, and `ctx.exists(repoPath)` says whether a file is on disk.
 */
export function resolveHref(href, srcPath, ctx) {
  const loc = locate(href, srcPath);
  if (!loc) return null;
  if (loc.external) return loc.external;
  const { repoPath, hash } = loc;
  if (href.startsWith("#")) return hash;

  const hit = ctx.targets.get(repoPath);
  if (hit) return hit + hash;
  for (const { from, to } of ctx.evidence) {
    if (repoPath.startsWith(`${from}/`) && ctx.exists(repoPath)) {
      return `${BASE}/${to}/${repoPath.slice(from.length + 1)}`;
    }
  }
  if (isUnpublishedDoc(repoPath)) return null;
  return githubUrl(repoPath, ctx) ? githubUrl(repoPath, ctx) + hash : null;
}

/** A page of the repo's `docs/` folder that the site doesn't carry: nothing to link to. */
function isUnpublishedDoc(repoPath) {
  return repoPath === "docs" || repoPath.startsWith("docs/");
}

/** Link to a file or folder of the repository on GitHub, or null if it isn't there. */
export function githubUrl(repoPath, ctx) {
  const kind = ctx.kind(repoPath);
  return kind ? `${GITHUB}/${kind === "dir" ? "tree" : "blob"}/main/${repoPath}` : null;
}

/** True for a path into the repository's code or config (not a file a command produces). */
export function isRepoPath(text) {
  if (/[\s=:{}<>*]/.test(text)) return false;
  if (
    /^(apps|packages|services|contracts|config|scripts?|attacks|docs|programs|src|\.railway)(\/|$)/.test(
      text,
    )
  ) {
    return true;
  }
  return (
    /\.(s\.sol|sol|ts|tsx|mjs|py|ipynb|rs|sh)$/.test(text) ||
    /^(turbo\.json|railway\.json|SECURITY\.md|README\.md)$/.test(text)
  );
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** `2026-10-05` -> `October 5, 2026`, in prose only (code, links and addresses are untouched). */
export function humanDates(text) {
  return text.replace(
    /\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g,
    (all, y, m, d) => `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`,
  );
}

/** A bare `docs/X.md` in prose links to its page, or goes if the site has none. */
function linkPlainDocPaths(text, ctx) {
  return text.replace(/\b(docs\/[A-Za-z0-9_/.-]+\.md)\b/g, (all, p) => {
    const url = ctx.targets.get(p);
    return url ? `[${ctx.shorts.get(p) ?? ctx.labels.get(p) ?? "the docs"}](${url})` : REPO_MARK;
  });
}

/** Wrap or escape one stretch of prose with no code or links in it. */
function escapePlaceholders(text, ctx) {
  return humanDates(linkPlainDocPaths(text, ctx)).replace(
    /<(\/?)([A-Za-z][^<>\n]*)>/g,
    (all, slash, inner) => {
      const tag = inner.split(/[\s/]/)[0].toLowerCase();
      return KNOWN_HTML.has(tag) ? all : `&lt;${slash}${inner}&gt;`;
    },
  );
}

const REPO_MARK = "\u0000";
const INLINE = /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|`([^`\n]+)`/g;

/** Rewrite the links on one line of prose. */
function transformLine(line, srcPath, ctx) {
  let out = "";
  let last = 0;
  for (const m of line.matchAll(INLINE)) {
    out += escapePlaceholders(line.slice(last, m.index), ctx);
    last = m.index + m[0].length;
    if (m[1] !== undefined) {
      const url = resolveHref(m[2], srcPath, ctx);
      // A link whose text is a file name reads as the page's name instead.
      const loc = locate(m[2], srcPath);
      const bare = m[1].replace(/`/g, "");
      const label = loc?.repoPath && ctx.labels.get(loc.repoPath);
      const text = label && (isRepoPath(bare) || /\.md$/.test(bare)) ? label : m[1];
      if (url) out += `[${text}](${url})`;
      else out += isRepoPath(bare) ? REPO_MARK : text;
    } else {
      const code = m[3];
      const key = code.replace(/\/$/, "");
      const known = ctx.targets.get(key);
      if (known && ctx.shorts.has(code)) out += `[${ctx.shorts.get(code)}](${known})`;
      else if (known) out += m[0];
      else if (isRepoPath(code) && isUnpublishedDoc(key)) out += REPO_MARK;
      else if (isRepoPath(code)) {
        // Code is shown as a link to GitHub; a path relative to the page's own folder works too.
        const url =
          githubUrl(key, ctx) ??
          githubUrl(path.posix.normalize(path.posix.join(path.posix.dirname(srcPath), key)), ctx) ??
          githubUrl(`contracts/evm/${key}`, ctx); // `script/Deploy.s.sol` and the like
        out += url ? `[${m[0]}](${url})` : m[0];
      } else out += m[0];
    }
  }
  return scrubReferences(out + escapePlaceholders(line.slice(last), ctx), ctx);
}

/**
 * Drop mentions of docs the site doesn't carry: a parenthetical that names such a file, and
 * decision record numbers (the decision records are not published).
 */
export function scrubReferences(line, ctx) {
  const filler = String.raw`(?:(?:see|in|code|e\.g\.|the code is|such as|for example)[: ]\s*)?`;
  const mark = `${filler}${REPO_MARK}(?:\\s*(?:,|and|or|;)\\s*${REPO_MARK})*`;
  let out = line
    .replace(new RegExp(String.raw`\s*\(\s*${mark}\s*\)`, "g"), "")
    .replace(/\s*\((?:see |and )?\[?(?:ADR-\d+|decision records?)[^)]*\)/gi, "")
    .replace(/[;,]? ?\b(?:see )?ADR-\d+(?:,? decision \d+)?(?= *[.;,)|])/gi, "");
  if (out.includes(REPO_MARK)) {
    ctx.leftovers?.push(line.replaceAll(REPO_MARK, "⟦path⟧").trim());
    out = out.replaceAll(REPO_MARK, "");
  }
  return out;
}

/** Plain-text summary for the page description: the first paragraph, trimmed. */
export function describe(lines) {
  const para = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      if (para.length) break;
      continue;
    }
    if (/^([#>|!<`-]|\d+\.)/.test(t)) {
      if (para.length) break;
      continue;
    }
    para.push(t);
  }
  const text = para
    .join(" ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ");
  if (text.length <= 200) return text;
  const cut = text.slice(0, 200);
  return `${cut.slice(0, cut.lastIndexOf(" "))}…`;
}

/** Turn one repo Markdown file into a Starlight page: front matter, rewritten links. */
export function transform(markdown, srcPath, ctx, { title, dropSections = [] } = {}) {
  let lines = markdown.replace(/\r\n/g, "\n").split("\n");
  for (const name of dropSections) {
    const start = lines.findIndex((l) => l === `## ${name}` || l.startsWith(`## ${name} `));
    if (start < 0) continue;
    const next = lines.findIndex((l, i) => i > start && /^## /.test(l));
    lines = [...lines.slice(0, start), ...(next < 0 ? [] : lines.slice(next))];
  }
  let h1 = lines.findIndex((l) => /^# /.test(l));
  const heading = h1 >= 0 ? lines[h1].replace(/^# /, "").replace(/`/g, "").trim() : srcPath;
  if (h1 >= 0) lines.splice(h1, 1);

  let fence = null;
  // Lines that only point at decision records (not published) go.
  lines = lines.filter((l) => !/^(Design records?: |- \[ADR-\d+\])/.test(l));

  const body = lines.map((line) => {
    const f = line.match(/^\s*(```+|~~~+)/);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return line;
    }
    if (fence) return line;
    return transformLine(line, srcPath, ctx);
  });

  const front = [
    "---",
    `title: ${JSON.stringify(title ?? heading)}`,
    `description: ${JSON.stringify(describe(body))}`,
    "---",
    "",
  ];
  return `${front.join("\n")}${body.join("\n").replace(/^\n+/, "")}`;
}
