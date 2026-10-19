import { defineConfig } from "astro/config";

// Served at /blog on the same domain as the web app (see apps/web/build/include-blog.mjs).
export default defineConfig({
  site: "https://www.bondedhq.xyz",
  base: "/blog",
  trailingSlash: "always",
  // The docs dev server also defaults to 4321; the web app proxies /blog here (apps/web/vite.config.ts).
  server: { port: 4322 },
});
