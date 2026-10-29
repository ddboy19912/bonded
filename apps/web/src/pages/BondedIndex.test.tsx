import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { BondedIndex as BondedIndexData, BondedIndexEntry } from "@bondedhq/shared";
import { loadBondedIndex } from "../lib/bonded-index";
import { BondedIndexView } from "./BondedIndex";

function entry(
  over: Partial<BondedIndexEntry> & { label: string; model: string },
): BondedIndexEntry {
  const row = (mandate: "shown" | "hidden", fell: number, done = 28) => ({
    mandate,
    attackEpisodes: 78,
    fell,
    manipulationRate: fell / 78,
    interval: [0, 0.05] as [number, number],
    lossUsd: mandate === "hidden" && fell ? 612.4 : 0,
    overpaidUsd: mandate === "hidden" && fell ? 9_200 : 0,
    tasksDone: done,
    tasksTotal: 84,
    errors: 0,
    byClass: { O1: { episodes: 21, fell: Math.min(fell, 21) }, O3: { episodes: 12, fell: 0 } },
  });
  return {
    provider: "DeepSeek",
    family: "x",
    version: "1",
    listed: null,
    vision: true,
    rail: "offchain",
    agent: "payables-agent",
    attacks: { seeds: 17, variants: 11, hash: "abcdef0123456789", notShown: [] },
    runsPerScenario: 3,
    ranAt: "2026-10-27T10:00:00.000Z",
    rows: [row("shown", 0, 84), row("hidden", 6, 84)],
    score: 92,
    scoreInterval: [86, 96],
    worst: "hidden",
    worstClass: { mandate: "hidden", class: "O1", episodes: 21, fell: 6 },
    attacker: { drafts: { attempts: 12, refused: 1 }, probe: { asked: 5, refused: 0, failed: 0 } },
    cost: { spentUsd: 0.3, estimated: false, episodes: 168, perThousandEpisodesUsd: 1.8 },
    ...over,
  };
}

const index: BondedIndexData = {
  version: 1,
  updatedAt: "2026-10-27T10:00:00.000Z",
  method: "docs/OFFCHAIN.md#the-bonded-index",
  entries: [
    entry({
      model: "muse-spark-1.3",
      label: "Muse Spark 1.3",
      provider: "Meta",
      score: 100,
      scoreInterval: [95, 100],
    }),
    entry({ model: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash" }),
    entry({
      model: "meta-llama/llama-4-maverick",
      label: "Llama 4 Maverick",
      provider: "Meta",
      score: 100,
      rows: [
        { ...entry({ model: "a", label: "a" }).rows[0]!, tasksDone: 0 },
        { ...entry({ model: "a", label: "a" }).rows[0]!, mandate: "hidden", tasksDone: 0 },
      ],
    }),
  ],
};

afterEach(cleanup);

const view = (data: BondedIndexData = index) =>
  render(
    <MemoryRouter>
      <BondedIndexView index={data} />
    </MemoryRouter>,
  );

const section = (name: string) =>
  screen.getByRole("heading", { name }).closest("section") as HTMLElement;

const showTable = (card: HTMLElement) =>
  fireEvent.click(within(card).getByRole("button", { name: "Table" }));

describe("Bonded Index", () => {
  it("parses the committed data file", () => {
    expect(() => loadBondedIndex()).not.toThrow();
  });

  it("shows the staged campaign beside AgentDojo, apart from the Index score", () => {
    view();
    expect(screen.getByRole("heading", { name: "Same model, two benches" })).toBeTruthy();
    expect(screen.getByText("4 of 178")).toBeTruthy();
    expect(screen.getByText("0 of 576")).toBeTruthy();
    expect(screen.getByText(/not an Index score/)).toBeTruthy();
  });

  it("ranks models by security under their logos, and flags one that mostly didn't act, last", () => {
    view();
    const card = section("Leaderboard");
    // Each bar's name, logo and flag sit under the axis; the title says the whole name.
    const names = [...card.querySelectorAll("svg g > title")].map((t) => t.textContent);
    expect(names).toEqual([
      "Muse Spark 1.3",
      "DeepSeek V4.1 Flash",
      "Llama 4 Maverick: mostly didn't act",
    ]);
    // Every bar is named by its provider's logo.
    expect(card.querySelectorAll("svg image")).toHaveLength(3);
  });

  it("switches rankings by tab, each with a table view of its data", () => {
    view();
    const card = section("Leaderboard");
    fireEvent.click(within(card).getByRole("tab", { name: "Money moved" }));
    expect(
      within(card).getByRole("tab", { name: "Money moved" }).getAttribute("aria-selected"),
    ).toBe("true");
    showTable(card);
    const row = within(card).getByRole("row", { name: /DeepSeek V4.1 Flash/ });
    expect(row.textContent).toContain("$612.4");
    expect(row.textContent).toContain("$9.2K");
  });

  it("shows how far each security score was tested, and what set it", () => {
    const tested: BondedIndexData = {
      ...index,
      entries: index.entries.map((e) => ({ ...e, attacksTested: 156, riskCeiling: 0.047 })),
    };
    view(tested);
    const card = section("Leaderboard");
    showTable(card);
    expect(within(card).getByRole("columnheader", { name: "Tested" })).toBeTruthy();
    const row = within(card).getByRole("row", { name: /DeepSeek V4.1 Flash/ });
    expect(row.textContent).toContain("86–96");
    expect(row.textContent).toContain("bank-detail change, rules hidden: fell 6 of 21");
    expect(row.textContent).toContain("156 attacks; above 4.7% ruled out");
  });

  it("shows the Task score beside security, preferring the entry's own over pooled jobs", () => {
    const provenance =
      "Library attacks: Index run of 26 Oct. New attacks: campaign of 29 Oct, three runs joined.";
    const withTask: BondedIndexData = {
      ...index,
      entries: index.entries.map((e) =>
        e.model === "muse-spark-1.3"
          ? {
              ...e,
              task: { score: 14, source: "parts", part: "underAttack" },
              provenance,
              cost: { ...e.cost, episodes: 1 },
            }
          : e,
      ),
    };
    view(withTask);
    const card = section("Leaderboard");
    fireEvent.click(within(card).getByRole("tab", { name: "Task" }));
    showTable(card);
    // Its rows say every job was done; the parts say otherwise, and the parts win.
    const row = within(card).getByRole("row", { name: /Muse Spark 1.3/ });
    expect(row.textContent).toContain("14");
    const results = section("All results");
    expect(within(results).getByRole("columnheader", { name: "Task" })).toBeTruthy();
    expect(within(results).getByRole("row", { name: /Muse Spark 1.3/ }).textContent).toContain(
      "joined runs",
    );
    expect(within(results).getByText(new RegExp(`Muse Spark 1.3: ${provenance}`))).toBeTruthy();
    // An entry that joins a campaign keeps its sweep's cost, so the total counts the rows' runs.
    expect(screen.getByText("504 episodes in all")).toBeTruthy();
  });

  it("offers results by channel only when entries record them, with only the channels run", () => {
    view();
    expect(
      within(section("Where models break")).queryByRole("tab", { name: "By channel" }),
    ).toBeNull();
    const withVectors: BondedIndexData = {
      ...index,
      entries: index.entries.map((e) => ({
        ...e,
        rows: e.rows.map((r) => ({
          ...r,
          byVector: { email: { episodes: 20, fell: 2 }, voicemail: { episodes: 5, fell: 3 } },
        })),
      })),
    };
    cleanup();
    view(withVectors);
    const card = section("Where models break");
    fireEvent.click(within(card).getByRole("tab", { name: "By channel" }));
    expect(
      within(card).getByRole("columnheader", { name: "Voicemail (transcribed)" }),
    ).toBeTruthy();
    expect(within(card).queryByRole("columnheader", { name: "Supplier portal" })).toBeNull();
    showTable(card);
    expect(within(card).getByRole("row", { name: /DeepSeek V4.1 Flash/ }).textContent).toContain(
      "3 of 5",
    );
  });

  it("places every model on the trade-off chart, named beside its point", () => {
    view();
    const card = section("Trade-offs");
    const names = [...card.querySelectorAll("svg text")].map((t) => t.textContent);
    for (const name of ["Muse Spark 1.3", "DeepSeek V4.1 Flash", "Llama 4 Maverick"])
      expect(names.some((n) => n?.includes(name))).toBe(true);
  });

  it("ranks loss per 1,000 runs, from every run the model did", () => {
    view();
    const card = section("Leaderboard");
    fireEvent.click(within(card).getByRole("tab", { name: "Loss per 1,000 runs" }));
    showTable(card);
    // DeepSeek: $612.40 lost plus $9,200 overpaid over 168 runs.
    const row = within(card).getByRole("row", { name: /DeepSeek V4.1 Flash/ });
    expect(row.textContent).toContain("$58K");
    expect(row.textContent).toContain("168");
  });

  it("shows how far each score has been tested, by the fall rate it rules out", () => {
    const tested: BondedIndexData = {
      ...index,
      entries: index.entries.map((e, i) => ({
        ...e,
        attacksTested: 156 * (i + 1),
        riskCeiling: 0.047 / (i + 1),
      })),
    };
    view(tested);
    const card = section("Leaderboard");
    fireEvent.click(within(card).getByRole("tab", { name: "How well tested" }));
    showTable(card);
    const rows = within(card).getAllByRole("row").slice(1);
    // The tightest bound first.
    expect(rows[0]!.textContent).toContain("Llama 4 Maverick");
    expect(rows[0]!.textContent).toContain("1.6%");
    expect(rows[0]!.textContent).toContain("468");
  });

  it("draws a family's numbered versions in order, and says when they met different attacks", () => {
    const family = (version: string, hash: string, score: number) =>
      entry({
        model: `muse-spark-${version}`,
        label: `Muse Spark ${version}`,
        provider: "Meta",
        family: "Muse Spark",
        version,
        score,
        attacks: { seeds: 17, variants: 11, hash, notShown: [] },
      });
    view({
      ...index,
      entries: [
        family("1.3", "ffffffffffffffff", 96),
        family("1.1", "abcdef0123456789", 100),
        family("1.2", "abcdef0123456789", 86),
        // A tier, not a later version: left off the line.
        entry({
          model: "z-ai/glm-5.3-flash",
          label: "GLM-5.3 Flash",
          family: "GLM-5",
          version: "5.3 Flash",
        }),
        entry({ model: "z-ai/glm-5.3", label: "GLM-5.3", family: "GLM-5", version: "5.3" }),
      ],
    });
    const card = section("Across versions");
    expect(within(card).getByText("Muse Spark")).toBeTruthy();
    expect(within(card).queryByText("GLM-5")).toBeNull();
    expect(
      within(card).getByText(/Muse Spark 1.3 met more attacks than Muse Spark 1.1/),
    ).toBeTruthy();
    showTable(card);
    const order = within(card)
      .getAllByRole("row")
      .slice(1)
      .map((r) => r.querySelector("td")?.textContent);
    expect(order).toEqual(["Muse Spark 1.1", "Muse Spark 1.2", "Muse Spark 1.3"]);
  });

  it("splits loss into attacks and own mistakes, and breaches by type, once every model records them", () => {
    view();
    expect(within(section("Leaderboard")).queryByRole("tab", { name: "Own mistakes" })).toBeNull();
    expect(
      within(section("Where models break")).queryByRole("tab", { name: "By breach type" }),
    ).toBeNull();
    const recorded: BondedIndexData = {
      ...index,
      entries: index.entries.map((e) => ({
        ...e,
        rows: e.rows.map((r) => ({
          ...r,
          ownErrors:
            e.model === "deepseek/deepseek-v4.1-flash" && r.mandate === "hidden"
              ? { episodes: 2, lossUsd: 612.4, overpaidUsd: 0 }
              : { episodes: 0, lossUsd: 0, overpaidUsd: 0 },
          breaches:
            r.lossUsd + r.overpaidUsd > 0
              ? {
                  unknown_payee: { count: 1, lossUsd: r.lossUsd, overpaidUsd: 0 },
                  duplicate_payment: { count: 3, lossUsd: 0, overpaidUsd: r.overpaidUsd },
                }
              : {},
        })),
      })),
    };
    cleanup();
    view(recorded);
    const board = section("Leaderboard");
    fireEvent.click(within(board).getByRole("tab", { name: "Own mistakes" }));
    showTable(board);
    const row = within(board).getByRole("row", { name: /DeepSeek V4.1 Flash/ });
    // $9,812.40 in all: $612.40 its own, $9,200 caused by attacks.
    expect(row.textContent).toContain("$9.2K");
    expect(row.textContent).toContain("$612.4");
    const breaks = section("Where models break");
    fireEvent.click(within(breaks).getByRole("tab", { name: "By breach type" }));
    expect(within(breaks).getByRole("columnheader", { name: "Paid twice" })).toBeTruthy();
    expect(within(breaks).queryByRole("columnheader", { name: "Over the daily cap" })).toBeNull();
    showTable(breaks);
    expect(within(breaks).getByRole("row", { name: /DeepSeek V4.1 Flash/ }).textContent).toContain(
      "3 of 168",
    );
  });

  it("says so when no model has been rated", () => {
    view({ ...index, entries: [] });
    expect(screen.getByText("No models have been rated yet.")).toBeTruthy();
  });
});
