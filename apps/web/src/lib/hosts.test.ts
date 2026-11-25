import { describe, expect, it } from "vitest";
import {
  APP_ORIGIN,
  DOCS_ORIGIN,
  appHref,
  docsOrigin,
  docsUrl,
  onAppHost,
  onSiteHost,
  siteHref,
} from "./hosts";

describe("hosts", () => {
  it("knows the public site's hosts and the app's", () => {
    expect(onSiteHost("www.bondedhq.xyz")).toBe(true);
    expect(onSiteHost("bondedhq.xyz")).toBe(true);
    expect(onSiteHost("app.bondedhq.xyz")).toBe(false);
    expect(onAppHost("app.bondedhq.xyz")).toBe(true);
    expect(onAppHost("www.bondedhq.xyz")).toBe(false);
  });

  it("sends app links from the public site to app.bondedhq.xyz", () => {
    expect(appHref("/agents/test", "www.bondedhq.xyz")).toBe(`${APP_ORIGIN}/agents/test`);
    expect(appHref("/agents/test", "app.bondedhq.xyz")).toBe("/agents/test");
  });

  it("sends public-site links from the app to www.bondedhq.xyz", () => {
    expect(siteHref("/privacy", "app.bondedhq.xyz")).toBe("https://www.bondedhq.xyz/privacy");
    expect(siteHref("/privacy", "www.bondedhq.xyz")).toBe("/privacy");
  });

  it("keeps everything on one origin elsewhere (local development, Vercel previews)", () => {
    for (const host of ["localhost", "bonded-git-branch-team.vercel.app"]) {
      expect(appHref("/gate", host)).toBe("/gate");
      expect(siteHref("/blog/", host)).toBe("/blog/");
    }
  });

  it("uses docs.bondedhq.xyz unless VITE_DOCS_URL names a local docs server", () => {
    expect(docsOrigin(undefined)).toBe("https://docs.bondedhq.xyz");
    expect(docsOrigin("")).toBe("https://docs.bondedhq.xyz");
    expect(docsOrigin("http://localhost:4321/")).toBe("http://localhost:4321");
  });

  it("links docs pages at the docs origin, with no /docs prefix", () => {
    expect(docsUrl("/guides/payment-gate/")).toBe(`${DOCS_ORIGIN}/guides/payment-gate/`);
    expect(docsUrl()).toBe(`${DOCS_ORIGIN}/`);
  });
});
