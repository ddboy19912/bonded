import { existsSync, readFileSync } from "node:fs";
import { getCodeBlock } from "../test/code";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  BringYourAgent,
  Faq,
  LatestPosts,
  LiveAgents,
  Roles,
  ScoreScale,
  WorksWith,
  claimSources,
} from "./LandingSections";

afterEach(cleanup);
const show = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "../../public");

describe("the works-with carousel", () => {
  it("names each integration once for assistive technology, though the row is shown twice", () => {
    show(<WorksWith />);
    const names = screen.getAllByRole("img").map((i) => i.getAttribute("aria-label"));
    expect(names).toHaveLength(11);
    expect(new Set(names).size).toBe(11);
    expect(names).toEqual(
      expect.arrayContaining(["ElizaOS", "Coinbase AgentKit", "Robinhood Chain", "Solana", "Safe"]),
    );
    // The copy that makes the loop seamless is hidden from them.
    expect(document.querySelectorAll(".logo-copy")).toHaveLength(2);
    expect(document.querySelector('.logo-copy[aria-hidden="true"]')).toBeTruthy();
  });

  it("only points at logo files that exist", () => {
    show(<WorksWith />);
    for (const el of document.querySelectorAll<HTMLElement>('[role="img"]')) {
      const url = /url\(["']?([^"')]+)/.exec(el.getAttribute("style") ?? "")?.[1];
      expect(url, el.getAttribute("aria-label") ?? "").toBeTruthy();
      expect(existsSync(join(publicDir, url!)), url).toBe(true);
    }
  });
});

describe("the carousel without motion", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "landing.css"), "utf8");
  // The media block that stops the marquee: it must make the row of logos itself wrap, since the
  // track is clipped. (Checked in a browser at 375px too: 11 of 11 logos visible, was 4.)
  const still = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));

  it("wraps the list that holds the logos, not only the track around it", () => {
    const copy = still.slice(
      still.indexOf(".logo-copy {"),
      still.indexOf("}", still.indexOf(".logo-copy {")),
    );
    expect(copy).toContain("flex-wrap: wrap");
    expect(copy).toContain("width: 100%");
    expect(still).toContain("animation: none");
  });

  it("hides the duplicate row, which only exists to loop the animation", () => {
    expect(still).toMatch(/\.logo-copy\[aria-hidden="true"\]\s*\{\s*display: none/);
  });
});

describe("who it is for", () => {
  it("sends each reader to the right place", () => {
    show(<Roles />);
    expect(screen.getByRole("link", { name: "Test your agent, free" }).getAttribute("href")).toBe(
      "/agents/test",
    );
    expect(screen.getByRole("link", { name: "Onboard an agent" }).getAttribute("href")).toBe(
      "/agents/new",
    );
    expect(screen.getByRole("link", { name: /Browse vaults/ }).getAttribute("href")).toBe(
      "/vaults",
    );
    expect(screen.getByRole("link", { name: /Underwrite the pool/ }).getAttribute("href")).toBe(
      "/underwrite",
    );
  });
});

describe("the score scale", () => {
  it("shows every tier with its range and the bond it needs, from the contracts' own rules", () => {
    show(<ScoreScale />);
    const tiers = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(tiers.map((t) => t.textContent)).toEqual([
      "AAA90 to 100Bond of at least 10% of the cover",
      "AA80 to 89Bond of at least 10% of the cover",
      "A70 to 79Bond of at least 10% of the cover",
      "BBB60 to 69Bond of at least 10% of the cover",
      "BB45 to 59Bond of at least 20% of the cover",
      "B25 to 44Bond of at least 30% of the cover",
      "CCC0 to 24Not insurable",
    ]);
  });
});

describe("bringing an agent", () => {
  it("gives the one command and lists every framework", () => {
    show(<BringYourAgent />);
    expect(getCodeBlock("npx @bondedhq/runner init")).toBeTruthy();
    for (const name of ["ElizaOS", "Coinbase AgentKit", "LangChain or LangGraph", "Python"])
      expect(screen.getByText(name)).toBeTruthy();
  });
});

describe("the questions", () => {
  const open = (name: string) =>
    screen.getByRole("button", { name }).getAttribute("aria-expanded") === "true";

  it("are an accordion: the first is open, and opening another closes it", () => {
    show(<Faq />);
    expect(open("Who decides whether I get paid?")).toBe(true);
    expect(open("What does the red team actually do?")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "What does the red team actually do?" }));
    expect(open("What does the red team actually do?")).toBe(true);
    expect(open("Who decides whether I get paid?")).toBe(false);
    // The open one can be closed again, leaving none open.
    fireEvent.click(screen.getByRole("button", { name: "What does the red team actually do?" }));
    expect(open("What does the red team actually do?")).toBe(false);
    expect(
      screen.getAllByRole("button").filter((b) => b.getAttribute("aria-expanded") === "true"),
    ).toHaveLength(0);
  });

  it("has these questions, in this order, and not the two that were taken out", () => {
    show(<Faq />);
    const questions = screen
      .getAllByRole("button")
      .map((b) => b.textContent)
      .filter(Boolean);
    expect(questions).toEqual([
      "Who decides whether I get paid?",
      "Is Bonded only for trading agents?",
      "What does the red team actually do?",
      "What counts as a breach, and what isn't covered?",
      "How fast is a claim paid, and how much?",
      "Can an agent game its score?",
      "Can I test my agent without a vault or tokens?",
      "Which chains does it use?",
    ]);
    expect(questions).not.toContain("Is this real money?");
    expect(questions).not.toContain("Has it been audited?");
    expect(questions).not.toContain("What does cover cost?");
  });

  it("answers whether it is only for trading agents", () => {
    show(<Faq />);
    fireEvent.click(screen.getByRole("button", { name: "Is Bonded only for trading agents?" }));
    expect(screen.getByText(/any AI agent that can move money/)).toBeTruthy();
  });

  it("points at the docs and the security policy", () => {
    show(<Faq />);
    expect(screen.getByRole("link", { name: /Read the docs/ }).getAttribute("href")).toBe("/docs/");
    expect(screen.getByRole("link", { name: /Security policy/ }).getAttribute("href")).toBe(
      "/docs/security/policy/",
    );
  });
});

const chain = vi.hoisted(() => ({
  agents: { data: undefined as unknown },
  claims: { data: undefined as unknown },
}));
vi.mock("../lib/chain", async (original) => ({
  ...(await original<typeof import("../lib/chain")>()),
  useAgents: () => chain.agents,
  useClaims: () => chain.claims,
}));

const nowSeconds = () => Math.floor(Date.now() / 1000);
const current = () => BigInt(nowSeconds() + 7 * 86_400);
const lapsed = () => BigInt(nowSeconds() - 86_400);
const agent = (id: number, score?: number, expiresAt = current(), securityScore = score) => ({
  agentId: BigInt(id),
  owner: "0x0000000000000000000000000000000000000001",
  ...(score === undefined
    ? {}
    : { score: { score, securityScore: securityScore!, expectedLossBps: 150, expiresAt } }),
});
const usd6 = (n: number) => BigInt(n) * 1_000_000n;
/** `payout` is the award; `netted` of it went to unpaid premium, and the bond and pool paid the rest. */
const claim = (payout: number, fromBond: number, fromPool: number, loss = payout, netted = 0) => ({
  lossBase: usd6(loss),
  payout: usd6(payout),
  fromBond: usd6(fromBond),
  fromPool: usd6(fromPool),
  premiumNetted: usd6(netted),
});

describe("claimSources", () => {
  it("says where the money came from, and leaves out a source that paid nothing", () => {
    expect(claimSources(usd6(4000), usd6(500))).toBe(
      "$4,000 from the operator's bond and $500 from the pool",
    );
    expect(claimSources(usd6(900), 0n)).toBe("all of it from the operator's bond");
    expect(claimSources(0n, usd6(300))).toBe("all of it from the pool");
    expect(claimSources(0n, 0n)).toBe("");
  });
});

describe("the live agents band", () => {
  afterEach(() => {
    chain.agents.data = undefined;
    chain.claims.data = undefined;
  });

  it("shows the four best rated agents, best first, and skips unrated ones", () => {
    chain.agents.data = [
      agent(1, 54),
      agent(2, 97),
      agent(3),
      agent(4, 81),
      agent(5, 70),
      agent(6, 12),
    ];
    show(<LiveAgents />);
    const names = screen.getAllByRole("link").map((l) => l.textContent);
    expect(names.map((n) => /Agent (\d+)/.exec(n!)?.[0])).toEqual([
      "Agent 2",
      "Agent 4",
      "Agent 5",
      "Agent 1",
    ]);
    expect(screen.getAllByText(/Insurance \d+ · loss/)).toHaveLength(4);
    expect(screen.getByRole("link", { name: /Agent 2/ }).getAttribute("href")).toBe("/agents/2");
  });

  it("names the biggest claim paid, with where the money came from", () => {
    chain.agents.data = [agent(1, 81)];
    chain.claims.data = [
      claim(900, 900, 0, 1000),
      claim(4500, 4000, 500, 5000),
      claim(600, 600, 0),
    ];
    show(<LiveAgents />);
    expect(screen.getByText(/Biggest claim paid, automatically:/)).toBeTruthy();
    expect(
      screen.getByText(
        /\$4,500 of a \$5,000 loss, \$4,000 from the operator's bond and \$500 from the pool/,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: /See every claim/ }).getAttribute("href")).toBe(
      "/claims",
    );
  });

  it("says what reached the vault, not the gross award, and explains unpaid premium netted off", () => {
    // A $4,500 award with $500 of premium netted: the bond paid $4,000 and the pool nothing.
    chain.agents.data = [agent(1, 81)];
    chain.claims.data = [claim(4500, 4000, 0, 5000, 500)];
    show(<LiveAgents />);
    expect(
      screen.getByText(/\$4,000 of a \$5,000 loss, all of it from the operator's bond\./),
    ).toBeTruthy();
    expect(
      screen.getByText(/The award was \$4,500; \$500 of unpaid premium was netted off it\./),
    ).toBeTruthy();
    expect(screen.queryByText(/\$4,500 of a/)).toBeNull();
  });

  it("picks the biggest claim by what reached the vault, so the figure shown is the one sorted on", () => {
    chain.agents.data = [agent(1, 81)];
    // The larger award is mostly netted premium; the smaller one paid more into the vault.
    chain.claims.data = [claim(4500, 500, 0, 5000, 4000), claim(3000, 3000, 0)];
    show(<LiveAgents />);
    expect(screen.getByText(/Biggest claim paid, automatically:/)).toBeTruthy();
    expect(
      screen.getByText(/\$3,000 of a \$3,000 loss, all of it from the operator's bond/),
    ).toBeTruthy();
  });

  it("shows only scores that are still current, and hides when none is", () => {
    chain.agents.data = [agent(1, 99, lapsed()), agent(2, 81), agent(3, 54, lapsed())];
    const { container, rerender } = show(<LiveAgents />);
    expect(screen.getAllByRole("link").map((l) => /Agent (\d+)/.exec(l.textContent!)?.[1])).toEqual(
      ["2"],
    );
    expect(screen.queryByText(/Agent 1\b/)).toBeNull();
    chain.agents.data = [agent(1, 99, lapsed())];
    rerender(
      <MemoryRouter>
        <LiveAgents />
      </MemoryRouter>,
    );
    expect(container.querySelector("section")).toBeNull();
  });

  it("calls a lone claim just a claim, not the biggest", () => {
    chain.agents.data = [agent(1, 81)];
    chain.claims.data = [claim(900, 900, 0, 1000)];
    show(<LiveAgents />);
    expect(screen.getByText(/Claim paid, automatically:/)).toBeTruthy();
    expect(screen.queryByText(/Biggest claim/)).toBeNull();
    expect(
      screen.getByText(/\$900 of a \$1,000 loss, all of it from the operator's bond/),
    ).toBeTruthy();
  });

  it("shows no claim line when there are no claims, and nothing at all when nothing is rated", () => {
    chain.agents.data = [agent(1, 81)];
    chain.claims.data = [];
    const { container, rerender } = show(<LiveAgents />);
    expect(screen.queryByText(/claim paid/i)).toBeNull();
    chain.agents.data = [agent(1)];
    rerender(
      <MemoryRouter>
        <LiveAgents />
      </MemoryRouter>,
    );
    expect(container.querySelector("section")).toBeNull();
  });

  it("waits for the data without claiming anything", () => {
    show(<LiveAgents />);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.getByRole("heading", { name: /Scores you can check/ })).toBeTruthy();
  });
});

describe("the light behind the page", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "landing.css"), "utf8");
  const wash = (id: string) => {
    const start = css.indexOf(`#${id}::before {\n  top`);
    return css.slice(start, css.indexOf("\n}", start));
  };

  it("is warm behind the attack walkthrough and cool behind what answers it", () => {
    const warm = "rgb(255 154 128";
    expect(wash("how")).toContain(warm);
    expect(wash("how")).toContain("rgb(60 107 255");
    for (const id of ["who", "score", "sentinel", "bring", "faq"])
      expect(wash(id), id).not.toContain(warm);
  });

  it("fades to nothing at its top and bottom, and is as wide as the screen", () => {
    const shared = css.slice(css.indexOf("#numbers::before,"), css.indexOf("#numbers::before {"));
    expect(shared).toContain("width: 100vw");
    expect(shared).toMatch(/mask-image: linear-gradient\(\s*to bottom,\s*transparent,/);
    expect(shared).not.toMatch(/width: \d+px/);
  });

  it("keeps its warm light off the walkthrough's cards", () => {
    // Each step has its own glow behind its card; a second light on that side would stack on it.
    const how = wash("how");
    const positions = [...how.matchAll(/ellipse at (\d+)%/g)].map((m) => Number(m[1]));
    expect(positions.length).toBeGreaterThan(0);
    for (const x of positions) expect(x, how).toBeLessThan(25);
  });

  it("sits behind the content and never moves", () => {
    expect(css).toContain("z-index: -1");
    expect(css).toContain("pointer-events: none");
    expect(css).not.toContain("night sky");
    expect(css).not.toContain("animation-timeline");
  });

  it("lets the body show it through on the landing page only", () => {
    expect(css).toContain("body:has(.landing)");
  });
});

describe("the latest blog posts", () => {
  const post = {
    title: "Sandboxed isn't safe",
    slug: "sandboxed-isnt-safe",
    description: "Locking an agent's keys stops it from stealing.",
    publishedAt: "2026-10-13",
    cover: "https://cdn.sanity.io/images/x/cover.jpg",
    alt: "The Herald",
  };
  const withClient = (ui: React.ReactElement) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return {
      client,
      ...render(
        <QueryClientProvider client={client}>
          <MemoryRouter>{ui}</MemoryRouter>
        </QueryClientProvider>,
      ),
    };
  };
  afterEach(() => vi.unstubAllGlobals());

  it("links each post to its page under /blog and the heading to the blog", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([post])));
    vi.stubGlobal("fetch", fetchMock);
    withClient(<LatestPosts />);
    const link = await screen.findByRole("link", { name: /Sandboxed isn't safe/ });
    expect((fetchMock.mock.calls as unknown[][])[0]?.[0]).toBe("/blog/latest.json");
    expect(link.getAttribute("href")).toBe("/blog/sandboxed-isnt-safe/");
    expect(screen.getByText("13 October 2026")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Read the blog/ }).getAttribute("href")).toBe("/blog/");
  });

  it("renders nothing when the request fails", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const { container, client } = withClient(<LatestPosts />);
    // The section is also absent while loading, so wait for the query to fail first. The hook
    // retries once (after a second), which its own options set, not this client's defaults.
    await vi.waitFor(() => expect(client.getQueryState(["blog", "latest"])?.status).toBe("error"), {
      timeout: 4000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector("#blog")).toBeNull();
  });
});
