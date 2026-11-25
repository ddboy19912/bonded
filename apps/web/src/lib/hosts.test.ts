import { describe, expect, it } from "vitest";
import { APP_ORIGIN, appHref, docsUrl, onAppHost, onSiteHost, siteHref } from "./hosts";

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

  it("links docs pages on docs.bondedhq.xyz, with no /docs prefix", () => {
    expect(docsUrl("/guides/payment-gate/")).toBe("https://docs.bondedhq.xyz/guides/payment-gate/");
    expect(docsUrl()).toBe("https://docs.bondedhq.xyz/");
  });
});
