import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { LeaderboardRecord } from "../lib/api";
import { classResults } from "../lib/class-tracks";
import { ClassTrackTable } from "./class-track-table";

afterEach(cleanup);

const entry = (over: Partial<LeaderboardRecord>) =>
  ({
    classes: [
      { class: "A2", name: "Injection via content", episodes: 40, manipulated: 0, breaches: 0 },
      { class: "A8", name: "Volatility and panic", episodes: 35, manipulated: 0, breaches: 0 },
    ],
    ...over,
  }) as LeaderboardRecord;

describe("attack report from a leaderboard rating", () => {
  it("leads with how many classes tricked it and a figure per track, then one column per track", () => {
    render(
      <ClassTrackTable
        results={classResults(
          entry({
            s1Classes: [
              {
                class: "A8",
                counted: 12,
                manipulated: 8,
                inducedInaction: 2,
                breaches: 0,
                graded: true,
              },
              {
                class: "A5",
                counted: 4,
                manipulated: 1,
                inducedInaction: 0,
                breaches: 0,
                graded: false,
              },
            ],
          }),
        )}
      />,
    );
    expect(screen.getByText("Tricked in 1 of 3 attack classes")).toBeTruthy();
    // Market data: 8 of the 12 graded pairs worked (the ungraded A5 row doesn't count).
    expect(screen.getByText("67%")).toBeTruthy();
    expect(screen.getByText("of attempts worked · 8 of 12")).toBeTruthy();
    // Main library: held every one of its 75 episodes.
    expect(screen.getByText("held all 75")).toBeTruthy();
    const table = screen.getByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Attack class", "Main library", "Market data"]);
    const row = (cls: string) =>
      within(table)
        .getAllByRole("row")
        .find((r) => r.textContent?.startsWith(cls))!;
    expect(within(row("A8")).getByText("8 of 12").className).toContain("text-breach");
    expect(within(row("A8")).getByText("held 35")).toBeTruthy();
    // An ungraded track is marked, not counted as a weakness.
    expect(within(row("A5")).getByText("1 of 4*").className).not.toContain("text-breach");
    expect(within(row("A2")).getByText("not run")).toBeTruthy();
    expect(screen.getByText(/Too few results to enter the grade/)).toBeTruthy();
  });

  it("says so when nothing graded moved the agent", () => {
    render(<ClassTrackTable results={classResults(entry({}))} />);
    expect(screen.getByText("Held against every attack it faced")).toBeTruthy();
    expect(screen.queryByText(/Tricked in/)).toBeNull();
  });
});
