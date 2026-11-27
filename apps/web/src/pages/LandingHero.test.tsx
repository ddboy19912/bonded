import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Reveal } from "../lib/reveal";
import { FinalCta, Manifesto } from "./LandingHero";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const stillMotion = () =>
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

describe("the problem statement", () => {
  it("reads as one sentence, with the answer picked out", () => {
    render(<Manifesto />);
    const text = document.querySelector(".l-mani-text")!;
    expect(text.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "An agent that reads outside text and can also sign transactions can be talked into sending funds where it shouldn't. Bonded measures how much, and stops it.",
    );
    expect([...text.querySelectorAll(".blue")].map((w) => w.textContent?.trim())).toEqual([
      "and",
      "stops",
      "it.",
    ]);
  });

  it("lights its words up in order", () => {
    render(<Manifesto />);
    const delays = [...document.querySelectorAll<HTMLElement>(".l-mani-text span")].map((w) =>
      parseInt(w.style.transitionDelay, 10),
    );
    expect(delays.length).toBeGreaterThan(20);
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
  });
});

describe("the close", () => {
  it("has one way into the app, and hides the drifting rows from assistive technology", () => {
    stillMotion();
    render(
      <MemoryRouter>
        <FinalCta />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "See every agent's score, live." })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Launch app/ }).getAttribute("href")).toBe("/overview");
    expect(document.querySelector(".l-lean")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
});

describe("a revealed element", () => {
  it("is shown straight away where there is nothing to watch the scroll", () => {
    // jsdom has no IntersectionObserver, like an old browser: nothing may stay hidden.
    render(
      <Reveal as="h2" className="l-h2">
        Hello
      </Reveal>,
    );
    const heading = screen.getByRole("heading", { name: "Hello" });
    expect(heading.getAttribute("data-in")).toBe("true");
    expect(heading.className).toContain("l-rv");
  });

  it("waits until it comes on screen, then stays", () => {
    let comeOnScreen: (entries: { isIntersecting: boolean; target: Element }[]) => void = () => {};
    const unobserve = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: typeof comeOnScreen) {
          comeOnScreen = callback;
        }
        observe() {}
        unobserve = unobserve;
        disconnect() {}
      },
    );
    render(<Reveal delay={120}>Later</Reveal>);
    const el = screen.getByText("Later");
    expect(el.getAttribute("data-in")).toBe("false");
    expect(el.style.transitionDelay).toBe("120ms");

    act(() => comeOnScreen([{ isIntersecting: true, target: el }]));
    expect(el.getAttribute("data-in")).toBe("true");
    // It is told once: the observer lets go of it.
    expect(unobserve).toHaveBeenCalledWith(el);
  });
});
