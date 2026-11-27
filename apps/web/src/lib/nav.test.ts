import { describe, expect, it } from "vitest";
import { isNavActive, isOnChainPath } from "./nav";

describe("isNavActive", () => {
  it("keeps the pool link and the underwriting link apart", () => {
    expect(isNavActive("/underwrite", "/underwrite", "")).toBe(true);
    expect(isNavActive("/underwrite?mine=1", "/underwrite", "")).toBe(false);
    expect(isNavActive("/underwrite", "/underwrite", "?mine=1")).toBe(false);
    expect(isNavActive("/underwrite?mine=1", "/underwrite", "?mine=1")).toBe(true);
  });

  it("matches child pages unless end is set", () => {
    expect(isNavActive("/agents", "/agents/7", "")).toBe(true);
    expect(isNavActive("/agents", "/agents/7", "", true)).toBe(false);
    expect(isNavActive("/agents", "/agentsx", "")).toBe(false);
  });

  it("ignores other query parameters", () => {
    expect(isNavActive("/agents", "/agents", "?show=rated")).toBe(true);
  });
});

describe("isNavActive with child pages that have their own link", () => {
  it("keeps Agents quiet on Test your agent, and Payment gate quiet on Verify a receipt", () => {
    expect(isNavActive("/agents", "/agents/test", "", false, ["/agents/test"])).toBe(false);
    expect(isNavActive("/agents", "/agents/7", "", false, ["/agents/test"])).toBe(true);
    expect(isNavActive("/gate", "/gate/verify", "", false, ["/gate/verify"])).toBe(false);
    expect(isNavActive("/gate", "/gate/acct_1", "", false, ["/gate/verify"])).toBe(true);
  });
});

describe("isOnChainPath", () => {
  it("marks the chain's pages and nothing else", () => {
    for (const p of [
      "/agents",
      "/agents/7",
      "/vaults/0xabc",
      "/claims",
      "/underwrite",
      "/bounties",
      "/arena",
    ])
      expect(isOnChainPath(p), p).toBe(true);
    for (const p of [
      "/agents/test",
      "/gate",
      "/gate/verify",
      "/index",
      "/leaderboard",
      "/overview",
      "/sentinel",
      "/attacks",
    ])
      expect(isOnChainPath(p), p).toBe(false);
  });
});
