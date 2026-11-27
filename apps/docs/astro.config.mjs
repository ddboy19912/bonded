import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import mermaid from "astro-mermaid";
import { FOLDERS, PAGES, SIDEBAR_GROUPS } from "./scripts/pages.mjs";
import rehypeTables from "./scripts/rehype-tables.mjs";

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

// Served at the root of docs.bondedhq.xyz, as its own Vercel project (apps/docs/vercel.json).
export default defineConfig({
  site: "https://docs.bondedhq.xyz",
  trailingSlash: "always",
  // Tables become rows or cards where that reads better (scripts/rehype-tables.mjs).
  markdown: { rehypePlugins: [rehypeTables] },
  integrations: [
    mermaid({
      theme: "base",
      autoTheme: false,
      mermaidConfig: {
        theme: "base",
        fontFamily: "Geist Variable, Geist, sans-serif",
        // Natural size, scrolling sideways in the page, instead of shrinking wide diagrams.
        flowchart: { useMaxWidth: false, htmlLabels: true, curve: "basis" },
        sequence: { useMaxWidth: false },
        themeVariables: {
          darkMode: true,
          background: "#07080a",
          primaryColor: "#111317",
          primaryTextColor: "#f1f2f4",
          primaryBorderColor: "#3c6bff",
          secondaryColor: "#0c0d10",
          tertiaryColor: "#0a0b0d",
          lineColor: "#8a8f9a",
          textColor: "#c9ccd2",
          clusterBkg: "#0a0b0d",
          clusterBorder: "rgba(255,255,255,0.16)",
          edgeLabelBackground: "#0c0d10",
          noteBkgColor: "#111317",
          noteTextColor: "#c9ccd2",
          actorBkg: "#111317",
          actorBorder: "#3c6bff",
          actorTextColor: "#f1f2f4",
          signalColor: "#8a8f9a",
          signalTextColor: "#c9ccd2",
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
        { tag: "meta", attrs: { name: "theme-color", content: "#07080a" } },
        {
          // Click a diagram or an image in a page to open it full screen; click again or press
          // Escape to close. Images can also be opened from the keyboard (Tab, then Enter).
          tag: "script",
          content: `
            // Every image in a page but the home page's illustration.
            const IMG = ".sl-markdown-content img:not(.bn-hero img)";
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
        "@fontsource-variable/geist/index.css",
        "@fontsource-variable/jetbrains-mono/index.css",
        "./src/styles/bonded.css",
      ],
      components: {
        ThemeProvider: "./src/components/ThemeProvider.astro",
        ThemeSelect: "./src/components/ThemeSelect.astro",
        // Laid out as docs.busha.io: a header with section tabs, a sidebar for the tab you are on,
        // and a title with its group above it and a button to copy the page.
        Header: "./src/components/Header.astro",
        Sidebar: "./src/components/Sidebar.astro",
        PageTitle: "./src/components/PageTitle.astro",
        TableOfContents: "./src/components/TableOfContents.astro",
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
        ...FOLDERS.map((f) => ({
          label: f.index.title,
          collapsed: true,
          items: [{ autogenerate: { directory: f.slug } }],
        })),
      ],
    }),
  ],
});
