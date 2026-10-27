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

describe("Bonded Index", () => {
  it("parses the committed data file", () => {
    expect(() => loadBondedIndex()).not.toThrow();
  });

  it("ranks models by score, and flags one that mostly didn't do its job and ranks it last", () => {
    view();
    const chart = screen.getByRole("heading", { name: "Bonded Score by model" }).closest("figure")!;
    const labels = within(chart).getAllByText(
      /Muse Spark 1.3|DeepSeek V4.1 Flash|Llama 4 Maverick/,
    );
    // A flagged model's label carries its flag after the name.
    expect(labels.map((l) => l.textContent?.replace(/⚠.*/, ""))).toEqual([
      "Muse Spark 1.3",
      "DeepSeek V4.1 Flash",
      "Llama 4 Maverick",
    ]);
    expect(within(chart).getByText("⚠ did 0% of its jobs")).toBeTruthy();
    expect(within(chart).queryAllByText(/did \d+% of its jobs/)).toHaveLength(1);
  });

  it("gives every chart a table view, and every bar a keyboard tooltip", () => {
    view();
    const chart = screen
      .getByRole("heading", { name: "Money the attacks moved" })
      .closest("figure")!;
    fireEvent.click(within(chart).getByRole("button", { name: "Table" }));
    const row = within(chart).getByRole("row", { name: /DeepSeek V4.1 Flash/ });
    expect(row.textContent).toContain("$612.4");
    expect(row.textContent).toContain("$9.2K");

    const score = screen.getByRole("img", { name: "DeepSeek V4.1 Flash: score 92" });
    fireEvent.focus(score);
    expect(screen.getByRole("tooltip").textContent).toContain("95% interval 86–96");
    expect(screen.getByRole("tooltip").textContent).toContain(
      "set by O1 bank-detail change, rules hidden: fell 6 of 21",
    );
  });

  it("shows results by vector only when entries record them, with only the vectors run", () => {
    view();
    expect(screen.queryByRole("heading", { name: "How the attacks got in" })).toBeNull();
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
    const chart = screen
      .getByRole("heading", { name: "How the attacks got in" })
      .closest("figure")!;
    expect(within(chart).getByTitle("Voicemail (transcribed)")).toBeTruthy();
    expect(within(chart).queryByTitle("Supplier portal")).toBeNull();
    fireEvent.click(within(chart).getByRole("button", { name: "Table" }));
    const row = within(chart).getByRole("row", { name: /DeepSeek V4.1 Flash/ });
    expect(row.textContent).toContain("3 of 5");
  });

  it("says so when no model has been rated", () => {
    view({ ...index, entries: [] });
    expect(screen.getByText("No models have been rated yet.")).toBeTruthy();
  });
});
