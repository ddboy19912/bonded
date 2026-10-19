import { useQuery } from "@tanstack/react-query";

/** What the landing page shows of a blog post. The posts live in Sanity; the blog build lists the newest three. */
export interface BlogPostSummary {
  title: string;
  slug: string;
  description: string;
  publishedAt: string;
  cover: string;
  alt: string;
}

// Written by the blog's build (apps/blog/src/pages/latest.json.ts) and served from the same
// domain: Sanity itself refuses reads from other origins.
const LATEST_URL = "/blog/latest.json";

export async function fetchLatestPosts(signal?: AbortSignal): Promise<BlogPostSummary[]> {
  const res = await fetch(LATEST_URL, { signal });
  if (!res.ok) throw new Error(`Blog request failed (${res.status})`);
  // The rewrite to index.html answers a missing file with HTML, so check what came back.
  const posts: unknown = await res.json();
  return Array.isArray(posts) ? (posts as BlogPostSummary[]) : [];
}

/** The three newest posts. The landing page hides the section if this fails or is empty. */
export function useLatestPosts() {
  return useQuery({
    queryKey: ["blog", "latest"],
    queryFn: ({ signal }) => fetchLatestPosts(signal),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

export const blogPostPath = (slug: string) => `/blog/${slug}/`;

export const formatPostDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
