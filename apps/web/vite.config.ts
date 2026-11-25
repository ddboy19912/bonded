/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fontPreload } from "./build/font-preload";

// The deployment file lives in contracts/evm/deployments; Vite may read the whole repository.
export default defineConfig({
  plugins: [react(), tailwindcss(), fontPreload()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5173,
    fs: { allow: ["../.."] },
    // The blog (4322): run `pnpm --filter @bonded/blog dev` to see /blog locally. The docs are
    // their own site (docs.bondedhq.xyz); set VITE_DOCS_URL=http://localhost:4321 to link a local one.
    proxy: { "/blog": "http://localhost:4322" },
  },
  // RainbowKit's modal is slow to render the first time under jsdom; when every package's tests
  // run at once (pnpm test), the default 5 s timeout can run out.
  test: { environment: "jsdom", testTimeout: 15_000 },
});
