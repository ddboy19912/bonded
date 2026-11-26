import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { LandingSentinel, SCENARIOS, asRate } from "./LandingSentinel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("turns a gate's count into the rate the landing page shows", () => {
  expect(asRate("33/33")).toBe("100%");
  expect(asRate("27/33")).toBe("82%");
  expect(asRate("0.7%")).toBe("0.7%");
});

describe("the Sentinel illustration", () => {
  const motion = (reduced: boolean) =>
    vi.stubGlobal("matchMedia", () => ({
      matches: reduced,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  // Reduced motion shows each scenario finished, which is what there is to check.
  const show = (reduced = true) => {
    motion(reduced);
    render(
      <MemoryRouter>
        <LandingSentinel />
      </MemoryRouter>,
    );
  };
  const picked = () =>
    screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.textContent);

  it("opens on the planted instruction, blocked with a score over the line", () => {
    show();
    expect(picked()).toEqual(["02An attackPlanted instruction"]);
    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(document.querySelector(".l-score")?.textContent).toBe("93%");
    expect(screen.getByText(/drops the trade before signing it/)).toBeTruthy();
    expect(screen.getByText(/your payout address changed/)).toBeTruthy();
    expect(screen.getByText("blocks at 70%")).toBeTruthy();
  });

  it("lets an ordinary trade go ahead, with a score under the line", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: /Ordinary trade/ }));
    expect(screen.getByText("Goes ahead")).toBeTruthy();
    expect(document.querySelector(".l-score")?.textContent).toBe("4%");
  });

  it("plays through once and then holds, so it can be read: it never switches by itself", () => {
    vi.useFakeTimers();
    try {
      show(false);
      const outcome = () => screen.getByText("Blocked").parentElement!;
      expect(outcome().getAttribute("data-on")).toBe("false");
      // One phase per tick: proposed, read, scored, outcome.
      for (let i = 0; i < 4; i++) act(() => void vi.advanceTimersByTime(900));
      expect(outcome().getAttribute("data-on")).toBe("true");
      for (let i = 0; i < 10; i++) act(() => void vi.advanceTimersByTime(6_000));
      expect(picked()).toEqual(["02An attackPlanted instruction"]);
      expect(outcome().getAttribute("data-on")).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says its scores are examples, and that a score only blocks above the line", () => {
    show();
    expect(screen.getByText("Illustration. Scores are examples.")).toBeTruthy();
    for (const s of SCENARIOS) expect(s.score >= 0.7, s.label).toBe(s.manipulated);
  });

  it("links to Sentinel in the app", () => {
    show();
    expect(screen.getByRole("link", { name: /See Sentinel live/ }).getAttribute("href")).toBe(
      "/sentinel",
    );
  });
});
