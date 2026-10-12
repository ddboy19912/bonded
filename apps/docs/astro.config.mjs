import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import mermaid from "astro-mermaid";
import { FOLDERS, PAGES } from "./scripts/pages.mjs";

const pages = (prefix) =>
  PAGES.filter((p) => p.slug.startsWith(`${prefix}/`) && p.slug.split("/").length === 2).map(
    (p) => ({ slug: p.slug, label: p.label }),
  );

/** Wraps every table in a div so a wide table scrolls inside its own box. */
function rehypeWrapTables() {
  const wrap = (node) => {
    if (!node.children) return;
    node.children = node.children.map((child) => {
      if (child.type === "element" && child.tagName === "table") {
        return {
          type: "element",
          tagName: "div",
          properties: { className: ["table-wrap"] },
          children: [child],
        };
      }
      wrap(child);
      return child;
    });
  };
  return wrap;
}

// Served at /docs on the same domain as the web app (see apps/web/build/include-docs.mjs).
export default defineConfig({
  site: "https://www.bondedhq.xyz",
  base: "/docs",
  trailingSlash: "always",
  markdown: { rehypePlugins: [rehypeWrapTables] },
  integrations: [
    mermaid({
      theme: "base",
      autoTheme: false,
      mermaidConfig: {
        theme: "base",
        fontFamily: "Manrope Variable, Manrope, sans-serif",
        // Natural size, scrolling sideways in the page, instead of shrinking wide diagrams.
        flowchart: { useMaxWidth: false, htmlLabels: true, curve: "basis" },
        sequence: { useMaxWidth: false },
        themeVariables: {
          darkMode: true,
          background: "#05070d",
          primaryColor: "#151b2b",
          primaryTextColor: "#f4f6fb",
          primaryBorderColor: "#3c6bff",
          secondaryColor: "#0e1320",
          tertiaryColor: "#0a0e17",
          lineColor: "#8d96ab",
          textColor: "#c7d2ee",
          clusterBkg: "#0a0e17",
          clusterBorder: "rgba(255,255,255,0.16)",
          edgeLabelBackground: "#0e1320",
          noteBkgColor: "#151b2b",
          noteTextColor: "#c7d2ee",
          actorBkg: "#151b2b",
          actorBorder: "#3c6bff",
          actorTextColor: "#f4f6fb",
          signalColor: "#8d96ab",
          signalTextColor: "#c7d2ee",
        },
      },
    }),
    starlight({
      title: "Bonded Docs",
      description:
        "Documentation for Bonded: safety ratings and automatic cover for AI trading agents.",
      logo: { src: "./src/assets/logo.svg", alt: "Bonded", replacesTitle: true },
      favicon: "/brand/favicon.svg",
      head: [
        { tag: "link", attrs: { rel: "icon", href: "/docs/brand/favicon.ico", sizes: "any" } },
        { tag: "meta", attrs: { name: "theme-color", content: "#05070d" } },
        {
          // Click a diagram to open it full screen; click again or press Escape to close.
          tag: "script",
          content: `
            const close = () => document.querySelector(".diagram-overlay")?.remove();
            document.addEventListener("click", (e) => {
              if (document.querySelector(".diagram-overlay")) return close();
              const svg = e.target instanceof Element && e.target.closest("pre.mermaid")?.querySelector("svg");
              if (!svg) return;
              const overlay = document.createElement("div");
              overlay.className = "diagram-overlay";
              overlay.append(svg.cloneNode(true));
              document.body.append(overlay);
            });
            document.addEventListener("keydown", (e) => e.key === "Escape" && close());
          `,
        },
        {
          tag: "meta",
          attrs: { property: "og:image", content: "https://www.bondedhq.xyz/brand/og.png" },
        },
      ],
      social: [{ icon: "rocket", label: "Open the app", href: "/" }],
      customCss: [
        "@fontsource-variable/manrope/index.css",
        "@fontsource/instrument-serif/400.css",
        "@fontsource/instrument-serif/400-italic.css",
        "@fontsource-variable/jetbrains-mono/index.css",
        "./src/styles/bonded.css",
      ],
      components: {
        ThemeProvider: "./src/components/ThemeProvider.astro",
        ThemeSelect: "./src/components/ThemeSelect.astro",
      },
      lastUpdated: false,
      sidebar: [
        { label: "Overview", items: pages("overview") },
        { label: "Concepts", items: pages("concepts") },
        { label: "Guides", items: pages("guides") },
        { label: "Sentinel", items: pages("sentinel") },
        {
          label: "Security",
          items: [
            ...pages("security"),
            {
              label: "Disclosures",
              collapsed: true,
              items: PAGES.filter((p) => p.slug.startsWith("security/disclosures/")).map((p) => ({
                slug: p.slug,
                label: p.label,
              })),
            },
          ],
        },
        { label: "Reference", items: pages("reference") },
        ...FOLDERS.map((f) => ({
          label: f.index.title,
          collapsed: true,
          items: [{ autogenerate: { directory: f.slug } }],
        })),
      ],
    }),
  ],
});
