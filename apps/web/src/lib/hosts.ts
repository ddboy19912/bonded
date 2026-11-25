/**
 * Where each part of Bonded lives in production:
 * - www.bondedhq.xyz: the public site (landing page, privacy, blog);
 * - app.bondedhq.xyz: the app (Overview, Test your agent, Payment gate and the rest);
 * - docs.bondedhq.xyz: the documentation site (apps/docs, its own Vercel project).
 * The web build is the same on www and app; vercel.json redirects a page asked for on the wrong
 * host, and these helpers keep in-page links from crossing hosts. On any other host (local
 * development, a Vercel preview) the site and the app share one origin, as before.
 */
export const SITE_ORIGIN = "https://www.bondedhq.xyz";
export const APP_ORIGIN = "https://app.bondedhq.xyz";
/** The docs site; a local docs server can stand in with VITE_DOCS_URL=http://localhost:4321. */
export const DOCS_ORIGIN =
  (import.meta.env.VITE_DOCS_URL as string | undefined)?.replace(/\/$/, "") ||
  "https://docs.bondedhq.xyz";

const SITE_HOSTS = new Set(["www.bondedhq.xyz", "bondedhq.xyz"]);
const APP_HOST = "app.bondedhq.xyz";

const currentHost = () => (typeof window === "undefined" ? "" : window.location.hostname);

/** Whether this page is on the public site's production host. */
export const onSiteHost = (host = currentHost()) => SITE_HOSTS.has(host);
/** Whether this page is on the app's production host. */
export const onAppHost = (host = currentHost()) => host === APP_HOST;

/** A link to an app page: absolute from the public site, a plain path everywhere else. */
export const appHref = (path: string, host = currentHost()) =>
  onSiteHost(host) ? `${APP_ORIGIN}${path}` : path;

/** A link to a public-site page: absolute from the app, a plain path everywhere else. */
export const siteHref = (path: string, host = currentHost()) =>
  onAppHost(host) ? `${SITE_ORIGIN}${path}` : path;

/** A docs page by its path on the docs site, e.g. `/guides/payment-gate/`. */
export const docsUrl = (path = "/") => `${DOCS_ORIGIN}${path}`;
