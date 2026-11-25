import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import mermaid from "astro-mermaid";
import { FOLDERS, PAGES, SIDEBAR_GROUPS } from "./scripts/pages.mjs";

const pages = (prefix) =>
  PAGES.filter((p) => p.slug.startsWith(`${prefix}/`) && p.slug.split("/").length === 2).map(
    (p) => ({ slug: p.slug, label: p.label }),
  );

/** A long section of the sidebar, split into the groups SIDEBAR_GROUPS names (pages left out follow). */
const grouped = (prefix) => {
  const items = pages(prefix);
  const groups = SIDEBAR_GROUPS[prefix] ?? [];
  const named = new Set(groups.flatMap((g) => g.slugs.map((s) => `${prefix}/${s}`)));
  return [
    ...groups
      .map((g) => ({
        label: g.label,
        items: g.slugs.flatMap((s) => items.filter((i) => i.slug === `${prefix}/${s}`)),
      }))
      .filter((g) => g.items.length),
    ...items.filter((i) => !named.has(i.slug)),
  ];
};

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

// Served at the root of docs.bondedhq.xyz, as its own Vercel project (apps/docs/vercel.json).
export default defineConfig({
  site: "https://docs.bondedhq.xyz",
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
        { tag: "link", attrs: { rel: "icon", href: "/brand/favicon.ico", sizes: "any" } },
        { tag: "meta", attrs: { name: "theme-color", content: "#05070d" } },
        {
          // Click a diagram or an image in a page to open it full screen; click again or press
          // Escape to close. Images can also be opened from the keyboard (Tab, then Enter).
          tag: "script",
          content: `
            const IMG = ".sl-markdown-content img";
            let opener = null;
            const close = () => {
              const overlay = document.querySelector(".diagram-overlay");
              if (!overlay) return false;
              overlay.remove();
              opener?.focus();
              opener = null;
              return true;
            };
            const open = (el, from) => {
              const overlay = document.createElement("div");
              overlay.className = "diagram-overlay" + (el.tagName === "IMG" ? " is-image" : "");
              overlay.setAttribute("role", "dialog");
              overlay.setAttribute("aria-label", el.getAttribute("alt") || "Diagram, enlarged");
              overlay.append(el.cloneNode(true));
              document.body.append(overlay);
              opener = from;
            };
            const target = (node) => {
              if (!(node instanceof Element)) return null;
              const img = node.closest(IMG);
              if (img) return img;
              return node.closest("pre.mermaid")?.querySelector("svg") ?? null;
            };
            document.addEventListener("click", (e) => {
              if (close()) return;
              const el = target(e.target);
              if (!el) return;
              e.preventDefault();
              open(el, el.tagName === "IMG" ? el : null);
            });
            document.addEventListener("keydown", (e) => {
              if (e.key === "Escape") return close();
              if ((e.key === "Enter" || e.key === " ") && document.activeElement?.matches?.(IMG)) {
                e.preventDefault();
                open(document.activeElement, document.activeElement);
              }
            });
            const ready = () => {
              for (const img of document.querySelectorAll(IMG)) {
                img.tabIndex = 0;
                img.setAttribute("role", "button");
                img.title = "Click to enlarge";
              }
            };
            if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
            else ready();
          `,
        },
        // Starlight already writes og:title, og:description, og:url and twitter:card per page.
        {
          tag: "meta",
          attrs: { property: "og:image", content: "https://www.bondedhq.xyz/brand/og.jpg" },
        },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        {
          tag: "meta",
          attrs: { name: "twitter:image", content: "https://www.bondedhq.xyz/brand/og.jpg" },
        },
        { tag: "meta", attrs: { name: "twitter:site", content: "@bonded_hq" } },
      ],
      social: [
        { icon: "rocket", label: "Open the app", href: "/" },
        { icon: "email", label: "Contact", href: "mailto:hello@bondedhq.xyz" },
      ],
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
        { label: "Concepts", items: grouped("concepts") },
        { label: "Guides", items: grouped("guides") },
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
        { label: "Internals", items: pages("internals") },
        ...FOLDERS.map((f) => ({
          label: f.index.title,
          collapsed: true,
          items: [{ autogenerate: { directory: f.slug } }],
        })),
      ],
    }),
  ],
});
