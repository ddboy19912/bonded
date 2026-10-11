import type { Plugin } from "vite";

/**
 * The fonts the first screen needs, by file name in the built assets (Fontsource's latin
 * subsets). Their CSS arrives with the app bundle, so without a preload the browser only starts
 * fetching them after the JavaScript has run, and the page redraws when they land.
 */
export const PRELOAD_FONTS = [
  /geist-latin-wght-normal-[\w-]+\.woff2$/,
  /instrument-serif-latin-400-normal-[\w-]+\.woff2$/,
  /jetbrains-mono-latin-wght-normal-[\w-]+\.woff2$/,
];

/** The <link rel="preload"> tags for the built font files that match `PRELOAD_FONTS`. */
export function fontPreloadTags(fileNames: readonly string[], base = "/") {
  return fileNames
    .filter((name) => PRELOAD_FONTS.some((re) => re.test(name)))
    .map((name) => ({
      tag: "link",
      attrs: {
        rel: "preload",
        href: `${base}${name}`,
        as: "font",
        type: "font/woff2",
        // Fonts are always fetched in CORS mode, so the preload must be too, or it is wasted.
        crossorigin: "",
      },
      injectTo: "head" as const,
    }));
}

/** Adds the preload tags to index.html in production builds. */
export function fontPreload(): Plugin {
  let base = "/";
  return {
    name: "bonded-font-preload",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml(_html, ctx) {
      return fontPreloadTags(Object.keys(ctx.bundle ?? {}), base);
    },
  };
}
