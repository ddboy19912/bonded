// Splits the index into pages. Plain JS so `node --test` can run it.

/** Posts in the grid on each page. Even, so the two-column grid never ends on a lone card. */
export const GRID_SIZE = 8;

/**
 * Pages of the blog index. The lead post sits above the grid on page 1 only; every page
 * has at most `size` posts in its grid. There is always at least one page, even with no posts.
 * @template T
 * @param {T[]} posts the index order: the lead post first, then the rest newest first
 * @param {number} [size]
 * @returns {{ number: number, total: number, lead: T | undefined, posts: T[] }[]}
 */
export function paginate(posts, size = GRID_SIZE) {
  const [lead, ...rest] = posts;
  const total = Math.max(1, Math.ceil(rest.length / size));
  return Array.from({ length: total }, (_, i) => ({
    number: i + 1,
    total,
    lead: i === 0 ? lead : undefined,
    posts: rest.slice(i * size, (i + 1) * size),
  }));
}

/** The URL of a page: page 1 is the blog's front page, the rest live under /page/. */
export const pagePath = (/** @type {string} */ base, /** @type {number} */ number) =>
  number === 1 ? base : `${base}page/${number}/`;
