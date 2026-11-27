import { describe, expect, it } from "vitest";
import { isAddress } from "viem";
import { SEARCH_PAGES, searchResults, searchTarget, type SearchItem } from "./search";

const deps = { isAddress, explorerUrl: "https://explorer.example" };

describe("searchTarget", () => {
  it("sends an agent ID, with or without # or the word agent, to the agent page", () => {
    expect(searchTarget("11", deps)).toEqual({ href: "/agents/11", external: false });
    expect(searchTarget(" #11 ", deps)).toEqual({ href: "/agents/11", external: false });
    expect(searchTarget("Agent 3", deps)).toEqual({ href: "/agents/3", external: false });
  });
  it("sends an address to its vault page", () => {
    const vault = "0xbE32918715e9962F488BDed1e70fD8e782B4851c";
    expect(searchTarget(vault, deps)).toEqual({ href: `/vaults/${vault}`, external: false });
  });
  it("sends an attack id to its page, whatever the case", () => {
    expect(searchTarget("A4-honeypot-otc-004", deps)).toEqual({
      href: "/attacks/A4-honeypot-otc-004",
      external: false,
    });
    expect(searchTarget("a10-Counterparty-1", deps)?.href).toBe("/attacks/A10-counterparty-1");
  });

  it("opens a transaction hash on the explorer", () => {
    const tx = `0x${"a".repeat(64)}`;
    expect(searchTarget(tx, deps)).toEqual({
      href: `https://explorer.example/tx/${tx}`,
      external: true,
    });
  });
  it("finds nothing for anything else, or for a tx with no explorer", () => {
    expect(searchTarget("hello", deps)).toBeNull();
    expect(searchTarget(`0x${"a".repeat(64)}`, { ...deps, explorerUrl: "" })).toBeNull();
  });
});

describe("searchResults", () => {
  const items: SearchItem[] = [
    ...SEARCH_PAGES,
    {
      id: "agent:7",
      kind: "agent",
      title: "Agent 7",
      sub: "Security 33 · owner 0xd42F…A841",
      href: "/agents/7",
      keywords: ["#7", "0xd42fa5ae8949710479954ae78d1b12ff2e50a841"],
    },
    {
      id: "agent:9",
      kind: "agent",
      title: "Agent 9",
      sub: "Security 0 · owner 0xd42F…A841",
      href: "/agents/9",
      keywords: ["#9", "0xd42fa5ae8949710479954ae78d1b12ff2e50a841"],
    },
    {
      id: "model:claude",
      kind: "model",
      title: "Claude Sonnet 5.5",
      sub: "Anthropic · on the Index",
      href: "/index/claude-sonnet-5-5",
      keywords: ["anthropic"],
    },
  ];
  const titles = (q: string) =>
    searchResults(q, items, deps).map((g) => [g.label, g.items.map((i) => i.title)]);

  it("lists the pages for an empty query", () => {
    const [pages] = searchResults("", items, deps);
    expect(pages!.label).toBe("Pages");
    expect(pages!.items[0]!.title).toBe("Overview");
  });

  it("puts a direct jump first, named for where it goes", () => {
    expect(titles("7")).toEqual([
      ["Go to", ["Agent 7"]],
      ["Agents", ["Agent 7"]],
    ]);
  });

  it("matches titles, then the words a page is known by, then a provider", () => {
    expect(titles("claude")).toEqual([["Models", ["Claude Sonnet 5.5"]]]);
    expect(titles("anthropic")).toEqual([["Models", ["Claude Sonnet 5.5"]]]);
    expect(titles("insurance")).toEqual([["Pages", ["Cover pool"]]]);
    // A title that starts with the query ranks above one that only contains it.
    // "Red team" starts with it, "Verify a receipt" has a word that does, "Arena" only contains it.
    expect(titles("re")[0]).toEqual(["Pages", ["Red team", "Verify a receipt", "Arena"]]);
  });

  it("finds nothing for gibberish", () => {
    expect(searchResults("zzqx", items, deps)).toEqual([]);
  });
});
