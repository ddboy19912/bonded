# Bonded blog

The blog at [bondedhq.xyz/blog](https://www.bondedhq.xyz/blog/). It's a small Astro site, built into the web app's output by `apps/web/build/include-blog.mjs`, the same way as the docs.

## Publish a post

1. Add a Markdown file to `src/content/posts/`. The file name is the URL: `locked-isnt-safe.md` is served at `/blog/locked-isnt-safe/`.
2. Put its cover image in `src/assets/covers/` (1600×840, JPEG). It's shown on the post and in the list, and becomes the post's link-preview image.
3. Start the post with this front matter:

   ```md
   ---
   title: "Sandboxed isn't safe"
   description: "One or two sentences. Shown in link previews; keep it under 200 characters."
   date: 2026-10-13
   tags: [Agent safety]
   cover: ../../assets/covers/sandboxed-isnt-safe.jpg
   coverAlt: "What the image shows, for screen readers"
   ---
   ```

   Add `draft: true` to keep a post off the site and the feed.
4. Run `pnpm --filter @bonded/blog test`. It checks the front matter and the wording rules below.
5. Open a PR. The post goes live when it's merged and Vercel deploys.

`pnpm --filter @bonded/blog dev` previews it at http://localhost:4321/blog/.

## Wording rules for public claims

- Bonded pays for **rule breaches** (an action outside the agent's mandate), never for market or trading losses. Say "when your agent breaks its rules, the vault pays you back".
- Don't name other companies. Talk about the category ("sandboxed agent platforms").
- Every number links to its source: an Arena report, a claim, an evidence file or the README's results.
- Say when something is testnet only.
