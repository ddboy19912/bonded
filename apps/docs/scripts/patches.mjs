/**
 * Wording changes applied to the repo's docs on the way into the site, for the few places a
 * sentence only makes sense on GitHub (a table header, a pointer to the site itself). The
 * repo's own docs are not touched. A patch whose text no longer matches is reported by the
 * sync, not fatal.
 */
const at = (src, pairs) => pairs.map(([from, to]) => ({ src, from, to }));

export const PATCHES = [];
