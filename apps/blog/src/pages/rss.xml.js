import rss from "@astrojs/rss";
import { publishedPosts } from "../lib/sanity";

export async function GET(context) {
  const posts = await publishedPosts();
  const base = new URL(import.meta.env.BASE_URL, context.site);
  return rss({
    title: "Bonded blog",
    description:
      "Red-teaming AI agents, safety scores, and automatic payouts when an agent breaks its rules.",
    site: base.href,
    items: posts.map((p) => ({
      title: p.title,
      description: p.description,
      pubDate: new Date(`${p.publishedAt}T00:00:00Z`),
      link: new URL(`${p.slug}/`, base).href,
    })),
  });
}
