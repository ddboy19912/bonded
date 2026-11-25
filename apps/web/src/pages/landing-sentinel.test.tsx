import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  // Reduced motion shows each scenario finished, which is what there is to check.
  const show = () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    render(
      <MemoryRouter>
        <LandingSentinel />
      </MemoryRouter>,
    );
  };

  it("lets an ordinary trade go ahead, with a score under the line", () => {
    show();
    expect(
      screen.getByRole("button", { name: /Ordinary trade/ }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByText("Goes ahead")).toBeTruthy();
    expect(document.querySelector(".l-score")?.textContent).toBe("4%");
    expect(screen.getByText("blocks at 70%")).toBeTruthy();
  });

  it("blocks a planted instruction, with a score over the line", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: /Planted instruction/ }));
    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(document.querySelector(".l-score")?.textContent).toBe("93%");
    expect(screen.getByText(/drops the trade before signing it/)).toBeTruthy();
    expect(screen.getByText(/your payout address changed/)).toBeTruthy();
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
