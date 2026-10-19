/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fontPreload } from "./build/font-preload";

// The deployment file lives in contracts/evm/deployments; Vite may read the whole repository.
export default defineConfig({
  plugins: [react(), tailwindcss(), fontPreload()],
  server: {
    port: 5173,
    fs: { allow: ["../.."] },
    // The documentation site (4321) and the blog (4322): run `pnpm --filter @bonded/docs dev` or
    // `pnpm --filter @bonded/blog dev` to see /docs or /blog locally.
    proxy: { "/docs": "http://localhost:4321", "/blog": "http://localhost:4322" },
  },
  // RainbowKit's modal is slow to render the first time under jsdom; when every package's tests
  // run at once (pnpm test), the default 5 s timeout can run out.
  test: { environment: "jsdom", testTimeout: 15_000 },
});
