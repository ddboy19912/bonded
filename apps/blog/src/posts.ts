import { getCollection, type CollectionEntry } from "astro:content";

export type Post = CollectionEntry<"posts">;

/** Published posts, newest first. Drafts are left out of every page and the feed. */
export async function publishedPosts() {
  const posts = await getCollection("posts", (p) => !p.data.draft);
  return posts.sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
}

/** The index order: the featured post first, then the rest newest first. */
export async function indexPosts() {
  const posts = await publishedPosts();
  const lead = posts.find((p) => p.data.featured) ?? posts[0];
  return lead ? [lead, ...posts.filter((p) => p !== lead)] : [];
}

export const formatDate = (d: Date) =>
  d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/** Minutes to read at about 220 words a minute, never less than 1. */
export const readingTime = (body = "") =>
  Math.max(1, Math.round(body.split(/\s+/).filter(Boolean).length / 220));
