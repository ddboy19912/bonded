import { publishedPosts, urlFor } from "../lib/sanity";

/**
 * The three newest posts, as JSON, for the landing page (apps/web). Sanity doesn't allow reads
 * from other origins, so the landing page reads this file, which is served from the same domain
 * and rebuilt whenever a post is published.
 */
export async function GET() {
  const posts = (await publishedPosts()).slice(0, 3).map((p) => ({
    title: p.title,
    slug: p.slug,
    description: p.description,
    publishedAt: p.publishedAt,
    cover: urlFor(p.cover).width(800).height(420).fit("crop").url(),
    alt: p.cover.alt ?? "",
  }));
  return new Response(JSON.stringify(posts), {
    headers: { "Content-Type": "application/json" },
  });
}
