import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("leaderboard security grades", () => {
  it("ranks security grades, including zero, and leaves legacy insurance results unranked", async () => {
    vi.spyOn(api, "leaderboard").mockResolvedValue({
      headline: { templates: 0, failingTemplates: 0, evaluations: 0, failingEvaluations: 0 },
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
    expect(within(rows[0]!).getByText("90")).toBeTruthy();
    expect(within(rows[1]!).getByText("0")).toBeTruthy();
    expect(within(rows[2]!).getByText("—")).toBeTruthy();
    expect(within(rows[2]!).getByText("Security not measured")).toBeTruthy();
    expect(within(rows[2]!).getByText("Insurance score 100")).toBeTruthy();
    expect(within(rows[2]!).queryByText("100")).toBeNull();
    // Three total results do not constitute a security podium when one is legacy.
    expect(screen.queryByText("#1")).toBeNull();
  });
});
