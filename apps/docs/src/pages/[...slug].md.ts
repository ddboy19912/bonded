import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection, type CollectionEntry } from "astro:content";

/**
 * Every docs page as plain Markdown at its own address plus ".md" (the home page at /index.md):
 * what "View as Markdown" opens and what the "Open in ChatGPT / Claude" links hand to the model.
 */
export const getStaticPaths: GetStaticPaths = async () => {
  const docs = await getCollection("docs");
  return docs.map((entry) => ({ params: { slug: entry.id }, props: { entry } }));
};

/**
 * A page written in MDX (the docs home) as plain Markdown: its imports go, a card becomes a list
 * item linking to its page, and anything else in braces or tags (the hero image) is dropped.
 */
export function mdxToMarkdown(body: string): string {
  return body
    .replace(/^import .*$/gm, "")
    .replace(
      /<DocCard\s+([^>]*?)>\s*([\s\S]*?)\s*<\/DocCard>/g,
      (_, attrs: string, text: string) => {
        const title = /title="([^"]*)"/.exec(attrs)?.[1] ?? "";
        const href = /href="([^"]*)"/.exec(attrs)?.[1] ?? "";
        return `- [${title}](${href}): ${text.replace(/\s+/g, " ").trim()}`;
      },
    )
    .replace(/^[ \t]+(- \[)/gm, "$1")
    .replace(/<figure[\s\S]*?<\/figure>/g, "")
    .replace(/<\/?[A-Z][^>]*>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const GET: APIRoute = ({ props }) => {
  const { entry } = props as { entry: CollectionEntry<"docs"> };
  const { title, description } = entry.data;
  const head = [`# ${title}`, description ? `\n\n> ${description}` : ""].join("");
  const body = entry.filePath?.endsWith(".mdx")
    ? mdxToMarkdown(entry.body ?? "")
    : (entry.body ?? "");
  return new Response(`${head}\n\n${body}`, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
};
