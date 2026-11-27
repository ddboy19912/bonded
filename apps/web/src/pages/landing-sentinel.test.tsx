import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { SENTINEL_SERVING } from "@bondedhq/shared";
import { SENTINEL_MODEL } from "../lib/sentinel-facts";
import {
  BLOCK_AT,
  CHECKS,
  CHECK_MS,
  LOOP_MS,
  LandingSentinel,
  PRESTART_MS,
  arrivesAt,
  asRate,
  checkedBy,
  outOf,
  stoppedOf,
} from "./LandingSentinel";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("turns a gate's count into the rate the landing page shows", () => {
  expect(asRate("33/33")).toBe("100%");
  expect(asRate("27/33")).toBe("82%");
  expect(asRate("0.7%")).toBe("0.7%");
  expect(outOf("33/33")).toBe("33 of 33");
});

it("blocks at the line production Sentinel uses", () => {
  expect(BLOCK_AT).toBe(SENTINEL_SERVING.blockThreshold);
});

describe("the Sentinel stream", () => {
  const motion = (reduced: boolean) =>
    vi.stubGlobal("matchMedia", () => ({
      matches: reduced,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  const show = (reduced = true) => {
    motion(reduced);
    render(
      <MemoryRouter>
        <LandingSentinel />
      </MemoryRouter>,
    );
  };
  const clock = () =>
    [...document.querySelectorAll(".l-sclock dd")].map((d) => d.textContent ?? "");
  const tray = (n: 0 | 1) => [
    ...document.querySelectorAll(".l-trays > div")[n]!.querySelectorAll("li"),
  ];
  const attacks = CHECKS.filter((c) => c.attack).length;

  it("checks at Sentinel's measured GPU speed", () => {
    expect(CHECK_MS).toBe(Math.round(parseFloat(SENTINEL_MODEL.speed.gpu) * 1000));
    // One trade reaches the shield every check, and each pass follows straight on.
    expect(arrivesAt(1) - arrivesAt(0)).toBe(CHECK_MS);
    expect(LOOP_MS).toBe(CHECKS.length * CHECK_MS);
  });

  it("leads with the speed, and carries no caption tags", () => {
    show();
    expect(
      screen.getByRole("heading", { name: "Catch the trick in a fifth of a second." }),
    ).toBeTruthy();
    expect(screen.getByText(/a decision model that answers in a single pass/)).toBeTruthy();
    expect(screen.queryByText(/Illustration/)).toBeNull();
    // The speed it runs at today is said next to the GPU figure.
    expect(screen.getByText("per check on a GPU (2.5 s on today's CPU server)")).toBeTruthy();
  });

  it("mixes ordinary trades with attacks, and only an attack scores over the line", () => {
    expect(attacks).toBeGreaterThan(0);
    expect(attacks).toBeLessThan(CHECKS.length);
    for (const c of CHECKS) expect(c.score >= BLOCK_AT, c.text).toBe(c.attack);
  });

  it("counts on through the loop: trades checked and attacks stopped", () => {
    expect(checkedBy(0)).toBe(0);
    expect(checkedBy(arrivesAt(0))).toBe(1);
    expect(checkedBy(arrivesAt(CHECKS.length + 2))).toBe(CHECKS.length + 3);
    expect(stoppedOf(CHECKS.length)).toBe(attacks);
    expect(stoppedOf(3 * CHECKS.length)).toBe(3 * attacks);
  });

  it("with less motion shows one pass, finished, with nothing moving", () => {
    show();
    const seconds = ((CHECKS.length * CHECK_MS) / 1000).toFixed(1);
    expect(clock()).toEqual([`${seconds} s`, String(CHECKS.length), String(attacks)]);
    expect(tray(0)).toHaveLength(attacks);
    expect(tray(1)).toHaveLength(CHECKS.length - attacks);
    expect(document.querySelector(".l-chip")).toBeNull();
  });

  it("never runs dry: the next pass of trades is on its way before the last one is through", () => {
    let now = 0;
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const step = (to: number) =>
      act(() => {
        now = to;
        frames.splice(0).forEach((f) => f(now));
      });
    show(false);
    // Already under way before it has even run a frame: trades are in the lanes, some checked.
    const chips = () => [...document.querySelectorAll<HTMLElement>(".l-chip")];
    expect(chips()).toHaveLength(CHECKS.length);
    expect(chips()[0]!.style.getPropertyValue("--d")).toBe(`${-PRESTART_MS}ms`);
    expect(clock()[1]).toBe(String(checkedBy(PRESTART_MS)));
    expect(tray(0)).toHaveLength(attacks);
    step(0);
    step(arrivesAt(9) - PRESTART_MS);
    expect(clock()[1]).toBe("10");
    // Into the second pass: its trades are out, and the first pass's last ones are still crossing.
    step(LOOP_MS - PRESTART_MS + 50);
    expect(chips()).toHaveLength(2 * CHECKS.length);
    // Long after, it is still going and the counters are still climbing.
    step(10 * LOOP_MS + arrivesAt(0) - PRESTART_MS);
    expect(clock()[1]).toBe(String(10 * CHECKS.length + 1));
    expect(frames.length).toBeGreaterThan(0);
  });

  it("waits off screen, and carries on when it is back", () => {
    let fire: (on: boolean) => void = () => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: IntersectionObserverCallback) {
          const el = () => document.querySelector(".l-stream")!;
          fire = (on) => cb([{ isIntersecting: on, target: el() }] as never, this as never);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    show(false);
    const stream = document.querySelector(".l-stream")!;
    act(() => fire(false));
    expect(stream.getAttribute("data-paused")).toBe("true");
    act(() => fire(true));
    expect(stream.getAttribute("data-paused")).toBe("false");
  });

  it("gives each result with what it was out of", () => {
    show();
    expect(screen.getByText("of attacks it never trained on, blocked (33 of 33)")).toBeTruthy();
    expect(screen.getByText("of 45 ordinary trades wrongly blocked")).toBeTruthy();
  });

  it("draws Sentinel as a shield on the line the trades run at", () => {
    show();
    const shield = document.querySelector(".l-lanes .l-shield svg");
    expect(shield).toBeTruthy();
    expect(shield!.closest("[aria-hidden]")).toBeTruthy();
  });

  it("says what Sentinel is and why it is fast, and links to it in the app", () => {
    show();
    expect(screen.getByText(/It runs on Laya, a decision model/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /See Sentinel live/ }).getAttribute("href")).toBe(
      "/sentinel",
    );
  });
});
