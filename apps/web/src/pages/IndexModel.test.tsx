import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  type BondedIndex as BondedIndexData,
  type BondedIndexEntry,
  OFFCHAIN_LIBRARY_VERSION,
} from "@bondedhq/shared";
import { loadBondedIndex, modelPath, modelSlug } from "../lib/bonded-index";
import { IndexModelView } from "./IndexModel";

const row = (mandate: "shown" | "hidden", o1Fell: number, o4Fell: number) => ({
  mandate,
  attackEpisodes: 96,
  fell: o1Fell + o4Fell,
  manipulationRate: (o1Fell + o4Fell) / 96,
  interval: [0, 0.05] as [number, number],
  lossUsd: mandate === "hidden" ? 4320 : 1840,
  overpaidUsd: 0,
  tasksDone: 30,
  tasksTotal: 120,
  errors: 0,
  byClass: {
    O1: { episodes: 54, fell: o1Fell },
    O4: { episodes: 36, fell: o4Fell },
    O6: { episodes: 6, fell: 0 },
  },
});

const muse: BondedIndexEntry = {
  model: "muse-spark-1.3",
  label: "Muse Spark 1.3",
  provider: "Meta",
  family: "Muse Spark",
  version: "1.3",
  listed: null,
  vision: true,
  rail: "offchain",
  agent: "payables-agent",
  attacks: { seeds: 17, variants: 11, hash: "abcdef0123456789", notShown: [] },
  runsPerScenario: 3,
  ranAt: "2026-10-26T23:58:55.241Z",
  rows: [row("shown", 0, 1), row("hidden", 2, 1)],
  score: 96,
  scoreInterval: [91, 99],
  attacksTested: 192,
  riskCeiling: 0.0512,
  task: { score: 29, source: "parts", part: "twins" },
  provenance: "Library attacks: Index run of 26 Oct. New attacks: campaign of 29 Oct.",
  worst: "hidden",
  worstClass: { mandate: "hidden", class: "O1", episodes: 54, fell: 2 },
  attacker: { drafts: { attempts: 12, refused: 1 }, probe: { asked: 5, refused: 0, failed: 0 } },
  cost: { spentUsd: 6.55, estimated: true, episodes: 240, perThousandEpisodesUsd: 27.3 },
};

const maverick: BondedIndexEntry = {
  ...muse,
  model: "meta-llama/llama-4-maverick",
  label: "Llama 4 Maverick",
  rows: [
    { ...row("shown", 0, 0), lossUsd: 0 },
    { ...row("hidden", 0, 0), lossUsd: 0 },
  ],
  score: 100,
  task: { score: 82, source: "totals", part: "totals" },
  provenance: undefined,
  libraryVersion: OFFCHAIN_LIBRARY_VERSION,
};

const index: BondedIndexData = {
  version: 1,
  updatedAt: "2026-10-29T21:08:27.065Z",
  method: "docs/OFFCHAIN.md#the-bonded-index",
  entries: [muse, maverick],
};

afterEach(cleanup);

const view = (slug: string, data: BondedIndexData = index) =>
  render(
    <MemoryRouter>
      <IndexModelView index={data} slug={slug} />
    </MemoryRouter>,
  );

describe("a model's result page", () => {
  it("gives every model a short address of its own", () => {
    expect(modelPath(muse)).toBe("/index/muse-spark-1.3");
    expect(modelPath(maverick)).toBe("/index/llama-4-maverick");
    // Every committed model has its own address, and its page renders.
    const committed = loadBondedIndex();
    const slugs = committed.entries.map(modelSlug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      view(slug, committed);
      expect(screen.queryByText("Nothing on the Index at this address")).toBeNull();
      cleanup();
    }
  });

  it("shows Security and Task side by side, with no description lines under them", () => {
    view("muse-spark-1.3");
    expect(screen.getByRole("heading", { level: 1, name: "Muse Spark 1.3" })).toBeTruthy();
    expect(screen.getByTitle("Meta")).toBeTruthy();
    expect(screen.getByText("Security").nextElementSibling?.textContent).toBe("96");
    expect(screen.getByText("Task").nextElementSibling?.textContent).toBe("29");
    expect(screen.queryByText(/95% interval/)).toBeNull();
    expect(screen.queryByText(/^set by /)).toBeNull();
    expect(screen.queryByText("mostly didn't act")).toBeNull();
  });

  it("shows the dollars at risk, in all and per 1,000 runs", () => {
    view("muse-spark-1.3");
    // $1,840 + $4,320 lost over 240 runs: $25,666.67 per 1,000.
    expect(screen.getByText("Dollars at risk").nextElementSibling?.textContent).toBe("$6.2K");
    expect(screen.getByText("$6.2K lost · $0 overpaid")).toBeTruthy();
    expect(screen.getByText("Loss per 1,000 runs").nextElementSibling?.textContent).toBe("$26K");
    expect(screen.getByText("over 240 runs")).toBeTruthy();
    expect(screen.getByText("4 of 192")).toBeTruthy();
  });

  it("names the attack classes that broke it, with counts per briefing", () => {
    view("muse-spark-1.3");
    const card = screen.getByRole("heading", { name: "Attack classes" }).closest("section")!;
    expect(
      within(card).getByText(
        "Bank-detail change (2 of 108), Instructions in an attachment (2 of 72)",
      ),
    ).toBeTruthy();
    expect(
      within(card).getByTitle("Bank-detail change, rules hidden: 2 of 54 (3.7%)"),
    ).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Table" }));
    const live = within(card).getByRole("row", { name: /Live counterparty/ });
    expect(live.textContent).toContain("0 of 6 (0.0%)");
  });

  it("says which library version it was rated on, with no date line under it", () => {
    view("muse-spark-1.3");
    expect(screen.getByText("Attack library").nextElementSibling?.textContent).toBe("v1");
    expect(screen.queryByText(/^rated 2026/)).toBeNull();
    expect(
      screen.getByText(/Where these numbers come from: Library attacks: Index run of 26 Oct/),
    ).toBeTruthy();
    cleanup();
    view("llama-4-maverick");
    expect(screen.getByText("No attack class got through.")).toBeTruthy();
    expect(screen.queryByText(/Where these numbers come from/)).toBeNull();
  });

  it("links back to the Index", () => {
    view("muse-spark-1.3");
    expect(screen.getByRole("link", { name: /Bonded Index/ }).getAttribute("href")).toBe("/index");
  });

  it("says a model not on the Index hasn't been rated yet", () => {
    view("gpt-9");
    expect(screen.getByText("Nothing on the Index at this address")).toBeTruthy();
    expect(screen.getByRole("link", { name: "See the rated models" }).getAttribute("href")).toBe(
      "/index",
    );
  });

  it("reads the model from the address", async () => {
    const { IndexModel } = await import("./IndexModel");
    render(
      <MemoryRouter initialEntries={["/index/muse-spark-1.3"]}>
        <Routes>
          <Route path="/index/:model" element={<IndexModel />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Muse Spark 1.3" })).toBeTruthy();
  });
});
