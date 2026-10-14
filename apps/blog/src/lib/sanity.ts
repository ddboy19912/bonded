import { createClient } from "@sanity/client";
import { createImageUrlBuilder } from "@sanity/image-url";
import { checkPost } from "./checks.mjs";

/**
 * Posts come from Sanity (project "Bonded", edited at bondedhq.sanity.studio). The dataset is
 * public, so the build reads published posts without a token; drafts stay private.
 */
export const sanity = createClient({
  projectId: import.meta.env.PUBLIC_SANITY_PROJECT_ID ?? "v74fgzgp",
  dataset: import.meta.env.PUBLIC_SANITY_DATASET ?? "production",
  apiVersion: "2026-09-29",
  useCdn: false,
  perspective: "published",
});

const builder = createImageUrlBuilder(sanity);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const urlFor = (source: any) => builder.image(source).auto("format");

/** The link preview: the image cropped to 1200x630 as a plain JPEG, which every platform reads. */
export const ogImageUrl = (image: SanityImage) =>
  builder.image(image).width(1200).height(630).fit("crop").format("jpg").url();

export interface SanityImage {
  asset: { _ref: string };
  alt?: string;
  caption?: string;
  hotspot?: unknown;
  crop?: unknown;
}

export interface Post {
  title: string;
  slug: string;
  description: string;
  publishedAt: string;
  author: string;
  tags: string[];
  featured: boolean;
  cover: SanityImage;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any[];
}

// Every published post, even one missing its slug: checkPost rejects it, so it stops the build
// instead of silently not appearing on the blog.
const POSTS_QUERY = /* groq */ `*[_type == "post"] | order(publishedAt desc, _createdAt desc) {
  title,
  "slug": slug.current,
  description,
  publishedAt,
  "author": coalesce(author, "Fortune Ogunsusi"),
  "tags": coalesce(tags, []),
  "featured": coalesce(featured, false),
  cover { asset, alt, hotspot, crop },
  body
}`;

let cache: Promise<Post[]> | undefined;

/**
 * Published posts, newest first. Throws (and so stops the build) if any post breaks the rules
 * in checks.mjs, so a bad post never reaches the site.
 */
export function publishedPosts(): Promise<Post[]> {
  cache ??= sanity.fetch<Post[]>(POSTS_QUERY).then((posts) => {
    const problems = posts.flatMap(checkPost);
    if (problems.length)
      throw new Error(`Blog posts need fixing in Sanity:\n- ${problems.join("\n- ")}`);
    return posts;
  });
  return cache;
}

/** The index order: the featured post first, then the rest newest first. */
export async function indexPosts() {
  const posts = await publishedPosts();
  const lead = posts.find((p) => p.featured) ?? posts[0];
  return lead ? [lead, ...posts.filter((p) => p !== lead)] : [];
}

export const formatDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/** Minutes to read at about 220 words a minute, never less than 1. */
export function readingTime(post: Post) {
  const words = post.body
    .filter((b) => b._type === "block")
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .flatMap((b) => b.children.map((c: any) => c.text))
    .join(" ")
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}

/** A responsive set of widths for one image, cropped to the given aspect ratio. */
export function srcset(image: SanityImage, widths: number[], ratio = 1600 / 840) {
  return widths
    .map(
      (w) =>
        `${urlFor(image)
          .width(w)
          .height(Math.round(w / ratio))
          .fit("crop")
          .url()} ${w}w`,
    )
    .join(", ");
}
