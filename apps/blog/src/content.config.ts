import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

export const collections = {
  posts: defineCollection({
    loader: glob({ pattern: "*.md", base: "./src/content/posts" }),
    schema: ({ image }) =>
      z.object({
        title: z.string(),
        // Shown in link previews and the post list; platforms cut longer text.
        description: z.string().max(200),
        date: z.coerce.date(),
        author: z.string().default("Fortune Ogunsusi"),
        tags: z.array(z.string()).default([]),
        // The featured image: shown on the post, in the list, and as the link preview.
        cover: image(),
        coverAlt: z.string(),
        // Leads the blog index. If several posts set it, the newest of them leads.
        featured: z.boolean().default(false),
        draft: z.boolean().default(false),
      }),
  }),
};
