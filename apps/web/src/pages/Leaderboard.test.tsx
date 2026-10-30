import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { ATTACK_LIBRARY_VERSION } from "@bondedhq/shared";
import { api, type LeaderboardRecord } from "../lib/api";
import { Leaderboard } from "./Leaderboard";

const entry = (name: string, score: number, securityGrade?: number): LeaderboardRecord => ({
  slug: name,
  name,
  kind: "reference",
  framework: "scripted",
  model: null,
  ratedAt: "2026-10-01T12:00:00Z",
  ...(securityGrade === undefined ? {} : { securityGrade }),
  score,
  tier: "AA",
  expectedLossBps: 100,
  premiumRateBps: 200,
  insurable: true,
  episodes: { attacks: 5, controls: 1, controlBreaches: 0 },
  classes: [],
  reportHash: "0xabc",
  onchain: null,
  disclosure: { status: "not-needed" },
  verified: null,
});

const NO_HEADLINE = { templates: 0, failingTemplates: 0, evaluations: 0, failingEvaluations: 0 };

async function renderBoard(entries: LeaderboardRecord[], headline = NO_HEADLINE) {
  vi.spyOn(api, "leaderboard").mockResolvedValue({ headline, entries });
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>
        <Leaderboard />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  const rows = within(await screen.findByRole("list", { name: "Security rankings" })).getAllByRole(
    "listitem",
  );
  return (name: string) => rows.find((r) => r.textContent?.includes(name))!;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("leaderboard rankings", () => {
  it("ranks security grades, including zero, and leaves legacy insurance results unranked", async () => {
    vi.spyOn(api, "leaderboard").mockResolvedValue({
      headline: NO_HEADLINE,
      entries: [entry("Legacy", 100), entry("Weak", 99, 0), entry("Strong", 40, 90)],
    });
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient()}>
          <Leaderboard />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    await screen.findByText("Strong");
    const rows = within(screen.getByRole("list", { name: "Security rankings" })).getAllByRole(
      "listitem",
    );
    expect(
      rows.map((row) =>
        ["Strong", "Weak", "Legacy"].find((name) => row.textContent?.includes(name)),
      ),
    ).toEqual(["Strong", "Weak", "Legacy"]);
    expect(within(rows[0]!).getByText("01")).toBeTruthy();
    // Scores are coloured by severity band.
    expect(within(rows[0]!).getByText("90").className).toContain("text-safe");
    expect(within(rows[1]!).getByText("0").className).toContain("text-breach-solid");
    // Unranked: a dash where the rank goes.
    expect(rows[2]!.firstElementChild?.textContent).toBe("—");
    expect(within(rows[2]!).getByText("Not measured")).toBeTruthy();
    // The legacy note only shows when a legacy result is on the board.
    expect(screen.getByText(/predate the security grade and are unranked/)).toBeTruthy();
  });

  it("leaves out the legacy note and the podium when there's nothing to explain", async () => {
    await renderBoard([entry("A", 50, 90), entry("B", 50, 80), entry("C", 50, 70)]);
    expect(screen.queryByText(/predate the security grade/)).toBeNull();
    expect(screen.queryByText("#1")).toBeNull();
    // No headline stats; the scoring docs open in a new tab.
    expect(screen.queryByRole("region", { name: "Headline" })).toBeNull();
    const docs = screen.getByRole("link", { name: "How scoring works" });
    expect(docs.getAttribute("target")).toBe("_blank");
    expect(docs.getAttribute("rel")).toBe("noreferrer");
  });

  it("links to the Index for off-chain ratings, with no rail tag on the rows", async () => {
    const row = await renderBoard([entry("A", 50, 90), entry("B", 50, 80)]);
    for (const name of ["A", "B"]) expect(within(row(name)).queryByText("On chain")).toBeNull();
    expect(screen.getByRole("link", { name: "Bonded Index" }).getAttribute("href")).toBe("/index");
  });

  it("keeps the colour key in a popover until it's opened", async () => {
    await renderBoard([entry("A", 50, 90)]);
    expect(screen.queryByText("80–100: resisted")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Colour key/ }));
    const key = await screen.findByRole("dialog");
    expect(within(key).getByText("80–100: resisted")).toBeTruthy();
    expect(within(key).getByText("sometimes manipulated")).toBeTruthy();
  });

  it("colours each class square by its worst graded track and names the weakest", async () => {
    const row = await renderBoard([
      {
        ...entry("Graded", 81, 25),
        worstClass: "A8",
        worstTrack: "s1",
        classes: [
          { class: "A2", name: "Injection via content", episodes: 10, manipulated: 3, breaches: 1 },
        ],
        s1Classes: [
          {
            class: "A8",
            counted: 12,
            manipulated: 9,
            inducedInaction: 2,
            breaches: 4,
            graded: true,
          },
          {
            class: "A2",
            counted: 8,
            manipulated: 1,
            inducedInaction: 0,
            breaches: 0,
            graded: true,
          },
          // Too few pairs to grade: listed, but it doesn't colour the square.
          {
            class: "A1",
            counted: 4,
            manipulated: 4,
            inducedInaction: 0,
            breaches: 0,
            graded: false,
          },
        ],
        memoryClasses: [{ class: "A2", counted: 5, manipulated: 1, graded: true }],
      },
    ]);
    const r = row("Graded");
    // Only the score: the squares show every weak class, so no single "weakest" line.
    expect(within(r).queryByText(/market data/)).toBeNull();
    // A8 only ran on market data (9 of 12, solid); A2 is worse on the main library (3 of 10)
    // than on market data (1 of 8) or memory (1 of 5); A1 is ungraded; A5 never ran.
    expect(within(r).getByRole("img", { name: "A8" }).className).toContain("bg-breach-solid");
    expect(within(r).getByRole("img", { name: "A2" }).className).toContain("bg-breach/45");
    expect(within(r).getByRole("img", { name: "A1" }).className).not.toContain("breach");
    expect(within(r).queryByRole("img", { name: "A5" })).toBeNull();
    // The tooltip lists each track on its own line.
    fireEvent.focus(within(r).getByRole("img", { name: "A2" }).parentElement!);
    const tip = (await screen.findByRole("tooltip")).textContent;
    expect(tip).toContain("Main library: manipulated in 3 of 10 episodes, 1 breached");
    expect(tip).toContain("Market data: false data moved it to act in 1 of 8 pairs");
    expect(tip).toContain("Memory: acted on a planted note in 1 of 5 attempts");
  });

  it("links the row to the agent's page and shows the model, source and chain status", async () => {
    const row = await renderBoard([
      {
        ...entry("AgentKit chatbot", 83, 33),
        kind: "framework",
        framework: "Coinbase AgentKit",
        model: "deepseek/deepseek-v4.1-flash",
        template: "https://example.com/agentkit",
        disclosure: { status: "pending" },
        onchain: { chain: "robinhood-testnet", agentId: "4", tx: "0x" + "1".repeat(64) },
        verified: true,
      },
      { ...entry("Unposted", 83, 50), verified: null },
    ]);
    const r = row("AgentKit chatbot");
    expect(within(r).getByRole("link", { name: "AgentKit chatbot" }).getAttribute("href")).toBe(
      "/agents/4",
    );
    expect(within(r).getByText("deepseek-v4.1-flash · Coinbase AgentKit")).toBeTruthy();
    expect(within(r).getByRole("link", { name: "source ↗" }).getAttribute("href")).toBe(
      "https://example.com/agentkit",
    );
    // Disclosure status isn't shown on the board.
    expect(within(r).queryByText("maintainer notice pending")).toBeNull();
    // Verified is the norm and says nothing; only an exception gets a note.
    expect(within(r).queryByText("Verified")).toBeNull();
    expect(within(r).queryByText(/on chain|on-chain/)).toBeNull();
    expect(within(row("Unposted")).getByText("Not on chain yet")).toBeTruthy();
    expect(within(row("Unposted")).queryByRole("link", { name: "Unposted" })).toBeNull();
  });
});

describe("task score", () => {
  const task = (benignDone: number): NonNullable<LeaderboardRecord["task"]> => ({
    version: 1,
    score: Math.round((100 * benignDone) / 11),
    worst: benignDone < 11 ? "benign" : "controls",
    controls: { trials: 6, done: 6, graded: true },
    underAttack: { trials: 0, done: 0, graded: false },
    benign: { trials: 11, done: benignDone, graded: true },
    classes: [],
    measuredAt: "2026-10-25T10:00:00.000Z",
    source: "task",
  });

  it("shows each entry's Task score with how it was measured, and a dash without one", async () => {
    const row = await renderBoard([
      { ...entry("Hardened", 97, 100), task: task(0) },
      { ...entry("Template", 83, 33), task: task(11) },
      entry("Older", 80, 50),
    ]);
    const zero = within(row("Hardened")).getByLabelText(/^Task score 0\./);
    expect(zero.getAttribute("title")).toBe(
      "Did its job in 6 of 6 control episodes and 0 of 11 benign twins. Set by its benign twins. " +
        "Measured after its rating, without attacks.",
    );
    expect(within(row("Template")).getByLabelText(/^Task score 100\./)).toBeTruthy();
    expect(within(row("Older")).getByTitle("Task score not measured").textContent).toBe("—");
  });

  it("keeps ranking by the Bonded Score, never the Task score", async () => {
    await renderBoard([
      { ...entry("Template", 83, 33), task: task(11) },
      { ...entry("Hardened", 97, 100), task: task(0) },
    ]);
    const names = within(screen.getByRole("list", { name: "Security rankings" }))
      .getAllByRole("listitem")
      .map((r) => r.querySelector("a, .font-semibold")?.textContent);
    expect(names).toEqual(["Hardened", "Template"]);
  });
});

describe("attack library versions", () => {
  it("tags results from an older library or before versions, and not current ones", async () => {
    const row = await renderBoard([
      { ...entry("Current", 50, 90), libraryVersion: ATTACK_LIBRARY_VERSION },
      { ...entry("Older", 50, 95), libraryVersion: ATTACK_LIBRARY_VERSION - 1 },
      entry("Unversioned", 50, 85),
    ]);
    expect(within(row("Current")).queryByText(/library v/)).toBeNull();
    expect(
      within(row("Older")).getByText(
        `Rated on library v${ATTACK_LIBRARY_VERSION - 1}; current is v${ATTACK_LIBRARY_VERSION}`,
      ),
    ).toBeTruthy();
    expect(within(row("Unversioned")).getByText("Rated before library versions")).toBeTruthy();
  });
});
