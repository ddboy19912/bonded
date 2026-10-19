# Bonded blog

The blog at [bondedhq.xyz/blog](https://www.bondedhq.xyz/blog/). It's a small Astro site, built into the web app's output by `apps/web/build/include-blog.mjs`, the same way as the docs.

Posts live in **Sanity** (project "Bonded", `v74fgzgp`, dataset `production`), not in this repo. The build reads published posts from Sanity's API; the dataset is public, so no token is needed, and drafts stay private.

## Write and publish a post

1. Open the editor: **[bondedhq.sanity.studio](https://bondedhq.sanity.studio/)**, and sign in with the Bonded Sanity account.
2. Create a **Post**: title, URL slug (generate it from the title), description (under 200 characters), publish date, tags, and a **cover image** (1600×840 works best) with its alt text. Turn on **Lead the blog index** to show it first.
3. Write the body. Headings, quotes, lists, links, images and tables are all available.
4. Click **Publish**. Sanity tells Vercel to rebuild the site (a webhook to a Vercel deploy hook), and the post goes live in a minute or two.

The cover is shown on the post and in the list, and becomes the post's link-preview image (cropped to 1200×630).

## Checks before anything goes live

Every build checks each published post (`src/lib/checks.mjs`, tested in `scripts/checks.test.mjs`). If one fails, **the build stops and the site keeps its last good version**; the build log lists what to fix in Sanity. A post fails if:

- it's missing a title, slug, description, publish date, cover image, cover alt text or body;
- the slug isn't lowercase letters, numbers and hyphens, or the description is over 200 characters;
- it says Bonded covers trading or market losses (it pays for rule breaches only);
- it uses "§" (write "Section 20");
- it links to `bonded-nu.vercel.app` or `bondedhq.xyz` (use `https://www.bondedhq.xyz`).

## Wording rules for public claims

- Bonded pays for **rule breaches** (an action outside the agent's mandate), never for market or trading losses. Say "when your agent breaks its rules, the vault pays you back".
- Don't name other companies. Talk about the category ("sandboxed agent platforms").
- Every number links to its source: an Arena report, a claim, an evidence file or the README's results.
- Say when something is testnet only.

## Develop

`pnpm --filter @bonded/blog dev` previews it at http://localhost:4322/blog/ (the port the web app's dev server proxies /blog to) with the live posts. `pnpm --filter @bonded/blog test` runs the checks' tests.
