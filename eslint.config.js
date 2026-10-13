import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "contracts/**", "**/.turbo/**", "**/.astro/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node scripts (.mjs) run outside the TypeScript projects, so name the globals they use.
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        AbortController: "readonly",
      },
    },
  },
);
