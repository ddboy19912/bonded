// The rules every published post must pass before the blog builds. A failing post stops the build,
// so the deploy keeps the last good version of the site. Plain JS so `node --test` can run it.

/** All the text in a post: title, description, body text, table cells and link targets. */
export function postText(post) {
  const parts = [post.title ?? "", post.description ?? ""];
  for (const block of post.body ?? []) {
    if (block._type === "block") {
      for (const child of block.children ?? []) parts.push(child.text ?? "");
      for (const def of block.markDefs ?? []) if (def.href) parts.push(def.href);
    } else if (block._type === "dataTable") {
      for (const row of block.rows ?? []) parts.push(...(row.cells ?? []));
    } else if (block._type === "image") {
      parts.push(block.alt ?? "", block.caption ?? "");
    } else if (block._type === "operative") {
      for (const f of ["code", "name", "targets", "summary", "attack", "breach", "defence"])
        parts.push(block[f] ?? "");
      parts.push(block.portrait?.alt ?? "");
    }
  }
  return parts.join("\n");
}

/** True for a real calendar date written YYYY-MM-DD (so 2026-02-30 fails). */
export function isCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// Saying Bonded covers, insures, pays, reimburses, refunds or compensates market or trading losses.
const LOSS_CLAIM =
  /\b(cover(s|ed|ing)?|insur(e|es|ed|ing)|pa(y|ys|id|ying)|reimburs(e|es|ed|ing)|refund(s|ed|ing)?|compensat(e|es|ed|ing))\b(\s+(you|back|for|your|all|any|of)){0,4}\s+(trading|market)\s+loss/gi;
// An explicit denial before the claim, in the same sentence: "Bonded does not cover trading losses".
const DENIAL = /\b(not|never|no|n't|nor|neither|cannot)\b|n't\b/i;

/** Sentences that claim Bonded pays for trading or market losses. Denials don't count. */
export function lossClaims(text) {
  const claims = [];
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    for (const m of sentence.matchAll(LOSS_CLAIM)) {
      if (!DENIAL.test(sentence.slice(0, m.index))) claims.push(sentence.trim());
    }
  }
  return claims;
}

const SITE_HOSTS = new Set(["bondedhq.xyz", "www.bondedhq.xyz", "bonded-nu.vercel.app"]);

/** Problems with the URLs in a post's text and links. */
function linkProblems(text) {
  const problems = [];
  for (const [raw] of text.matchAll(/\bhttps?:\/\/[^\s<>"')\]]+/gi)) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      problems.push(`has a link that isn't a valid URL: ${raw}`);
      continue;
    }
    const host = url.hostname.toLowerCase();
    // Readers can't always open the repository; link to the chain explorer, the docs or the app.
    if (host === "github.com" || host.endsWith(".github.com"))
      problems.push(
        `links to GitHub (${raw}); link to the chain explorer, the docs or the app instead`,
      );
    // Links to the site use the canonical scheme and host.
    else if (SITE_HOSTS.has(host) && (url.protocol !== "https:" || host !== "www.bondedhq.xyz"))
      problems.push(`links to ${raw} (use https://www.bondedhq.xyz)`);
  }
  return problems;
}

/** Problems with one post, as readable sentences. An empty list means it can go live. */
export function checkPost(post) {
  const problems = [];
  const name = post.title || post.slug || "untitled post";
  if (!post.title) problems.push("has no title");
  if (!post.slug || !/^[a-z0-9-]+$/.test(post.slug))
    problems.push(
      `has a bad URL slug "${post.slug ?? ""}" (use lowercase letters, numbers and hyphens)`,
    );
  if (!post.description) problems.push("has no description");
  else if (post.description.length > 200) problems.push("has a description over 200 characters");
  if (!post.publishedAt) problems.push("has no publish date");
  else if (!isCalendarDate(post.publishedAt))
    problems.push(`has a publish date that isn't a real date: ${post.publishedAt}`);
  if (!post.cover?.asset) problems.push("has no cover image");
  else if (!post.cover.alt) problems.push("has a cover image without alt text");
  if (!post.body?.length) problems.push("has no body");

  for (const block of post.body ?? []) {
    if (block._type === "image") {
      if (!block.asset) problems.push("has an image block with no image");
      else if (!block.alt) problems.push("has an image without alt text");
    } else if (block._type === "operative") {
      const label = `operative ${block.code ?? block.name ?? ""}`.trim();
      if (!block.code) problems.push(`has ${label} without an attack class (A1 to A10)`);
      if (!block.name) problems.push(`has ${label} without a codename`);
      if (!block.portrait?.asset) problems.push(`has ${label} without a portrait`);
      else if (!block.portrait.alt) problems.push(`has ${label} with a portrait but no alt text`);
    }
  }

  const text = postText(post);
  // Bonded pays for rule breaches, never for market or trading losses.
  for (const claim of lossClaims(text))
    problems.push(`says Bonded pays for trading or market losses (rule breaches only): "${claim}"`);
  // House style: "Section 20", never the section sign.
  if (text.includes("§")) problems.push('uses "§" (write "Section 20")');
  problems.push(...linkProblems(text));

  return problems.map((p) => `"${name}" ${p}`);
}
