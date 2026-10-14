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
    }
  }
  return parts.join("\n");
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
  if (!post.cover?.asset) problems.push("has no cover image");
  else if (!post.cover.alt) problems.push("has a cover image without alt text");
  if (!post.body?.length) problems.push("has no body");

  const text = postText(post);
  // Bonded pays for rule breaches, never for market or trading losses.
  if (
    /\b(cover|covers|covered|insure|insures|insured)\s+(your\s+|all\s+)?(trading|market)\s+loss/i.test(
      text,
    )
  )
    problems.push("says Bonded covers trading or market losses (it pays for rule breaches only)");
  // House style: "Section 20", never the section sign.
  if (text.includes("§")) problems.push('uses "§" (write "Section 20")');
  // Links to the site use the canonical host.
  if (/https?:\/\/(bonded-nu\.vercel\.app|bondedhq\.xyz)/.test(text))
    problems.push("links to bonded-nu.vercel.app or bondedhq.xyz (use https://www.bondedhq.xyz)");

  return problems.map((p) => `"${name}" ${p}`);
}
