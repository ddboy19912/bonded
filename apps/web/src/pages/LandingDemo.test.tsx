import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import {
  AttackDemo,
  DEMOS,
  IDLE,
  LAST_PHASE,
  PHASE_AT_MS,
  WAITING,
  streamAt,
  type Course,
} from "./LandingDemo";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** jsdom has no matchMedia: a stand-in whose answer can change, telling its listeners. */
const motion = (reduced: boolean) => {
  const listeners = new Set<() => void>();
  const query = {
    matches: reduced,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  vi.stubGlobal("matchMedia", () => query);
  return (next: boolean) => {
    query.matches = next;
    listeners.forEach((fn) => fn());
  };
};

const seconds = (phase: number) => PHASE_AT_MS[phase]! / 1000;
const course = (blocked: boolean): Course => ({ from: 0.25, agent: 0.46, vault: 0.86, blocked });

describe("the attack stream", () => {
  it("is dark before the attack is sent", () => {
    expect(streamAt(-0.1, course(true)).alpha).toBe(0);
  });

  it("leaves the message, reaches the agent as it starts to read, and waits there", () => {
    const run = course(true);
    expect(streamAt(0, run).front).toBeCloseTo(run.from);
    expect(streamAt(seconds(1), run).front).toBeCloseTo(run.agent);
    expect(streamAt((seconds(1) + seconds(2)) / 2, run).front).toBeCloseTo(run.agent);
  });

  it("only moves forward on its way to the vault, and is there when the checks start", () => {
    const run = course(true);
    let last = 0;
    for (let t = 0; t <= seconds(3); t += 0.05) {
      const { front, alpha } = streamAt(t, run);
      expect(front).toBeGreaterThanOrEqual(last - 1e-9);
      expect(alpha).toBe(1);
      last = front;
    }
    expect(streamAt(seconds(3), run).front).toBeCloseTo(run.vault);
  });

  it("dies at the vault in a flash when the vault blocks it", () => {
    const run = course(true);
    const flash = streamAt(seconds(4) + 0.15, run);
    expect(flash.front).toBeCloseTo(run.vault);
    expect(flash.hold).toBeCloseTo(1);
    const later = streamAt(seconds(4) + 3, run);
    expect(later.alpha).toBe(0);
    expect(later.hold).toBe(0);
  });

  it("runs on past the vault and off the edge in a breach, with no flash", () => {
    const run = course(false);
    const through = streamAt(seconds(4) + 1.2, run);
    expect(through.front).toBeGreaterThan(1);
    expect(through.alpha).toBe(1);
    expect(through.hold).toBe(0);
    expect(streamAt(seconds(4) + 5, run).alpha).toBe(0);
  });
});

describe("the attacks it can send", () => {
  it("each fail at least one of the vault's three rules, so each one is stopped or recorded", () => {
    for (const demo of DEMOS) {
      expect(demo.checks, demo.name).toHaveLength(3);
      expect(
        demo.checks.some(([, pass]) => !pass),
        demo.name,
      ).toBe(true);
    }
  });

  it("names the address the attacker wants in both the message and the action", () => {
    for (const demo of DEMOS)
      expect(demo.tries[1], demo.name).toContain(demo.message[1].slice(0, 6));
  });
});

describe("the attack demo", () => {
  const verdict = () => screen.getByText(/^(Blocked|Breach)$/).parentElement!;

  describe("with less motion", () => {
    beforeEach(() => motion(true));

    it("shows the finished answer as soon as an attack is picked", () => {
      render(<AttackDemo />);
      fireEvent.click(screen.getByRole("button", { name: /Honeypot token/ }));
      expect(screen.getByText(/tUSDG has migrated/)).toBeTruthy();
      expect(screen.getByText("Blocked")).toBeTruthy();
      expect(verdict().getAttribute("aria-hidden")).toBe("false");
      const failed = screen.getByText("Token is in the mandate").closest("li")!;
      expect(within(failed).getByText("no")).toBeTruthy();
      // Enforce mode stops the action and freezes the agent too, as the contracts do.
      expect(screen.getByText("Frozen")).toBeTruthy();
      expect(
        within(verdict()).getByText(/The agent is frozen, and the attempt is logged/),
      ).toBeTruthy();
    });

    it("blocks in Enforce mode and records a breach in Monitor mode", () => {
      render(<AttackDemo />);
      fireEvent.click(screen.getByRole("button", { name: /Panic message/ }));
      expect(screen.getByText("Blocked")).toBeTruthy();
      expect(within(verdict()).getByText(/No money moves/)).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "Monitor" }));
      expect(screen.getByText("Breach")).toBeTruthy();
      expect(within(verdict()).getByText(/\$30,000 leaves\. The agent is frozen/)).toBeTruthy();
      expect(screen.getByText("Frozen")).toBeTruthy();
      expect(screen.getByText("Recorded the breach")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Monitor" }).getAttribute("aria-pressed")).toBe(
        "true",
      );
    });

    it("reads the answer out once, with the rules it broke", () => {
      render(<AttackDemo />);
      fireEvent.click(screen.getByRole("button", { name: /Panic message/ }));
      const live = document.querySelector('[aria-live="polite"]')!;
      expect(live.textContent).toMatch(/^Panic message, Enforce mode: Blocked\./);
      expect(live.textContent).toContain(
        "Fails: Under the trade and daily limits, Payee is in the mandate.",
      );
      // The only live region: the checks and the verdict above it are not read twice.
      expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
    });

    it("lets the picture speak, with no caption under it", () => {
      render(<AttackDemo />);
      expect(screen.queryByText(/Illustration/)).toBeNull();
    });
  });

  describe("with motion", () => {
    beforeEach(() => {
      motion(false);
      vi.useFakeTimers();
    });

    it("plays once by itself, then walks through reading, acting, checking and the verdict", () => {
      render(<AttackDemo />);
      const lane = document.querySelector(".l-lane")!;
      // Before it plays, nothing is blank: the rules are listed, waiting, and the line where the
      // answer will land says it is waiting for an attack.
      const waiting = () => document.querySelector(".l-vw")!.textContent;
      expect(lane.getAttribute("data-phase")).toBe(String(IDLE));
      expect(waiting()).toBe(WAITING[IDLE]);
      expect(document.querySelectorAll(".l-out li")).toHaveLength(3);
      expect(verdict().getAttribute("aria-hidden")).toBe("true");
      const live = document.querySelector('[aria-live="polite"]')!;
      expect(live.textContent).toBe("");
      // It starts on its own shortly after it comes on screen, and says what is happening.
      act(() => void vi.advanceTimersByTime(500));
      expect(lane.getAttribute("data-phase")).toBe("0");
      expect(waiting()).toBe(WAITING[0]);
      expect(document.querySelector(".l-vbar")!.getAttribute("data-run")).toBe("true");
      PHASE_AT_MS.slice(1).forEach((ms, i) => {
        act(() => void vi.advanceTimersByTime(ms - PHASE_AT_MS[i]!));
        expect(lane.getAttribute("data-phase")).toBe(String(i + 1));
        if (i + 1 < LAST_PHASE) expect(waiting()).toBe(WAITING[i + 1]);
      });
      // The line gives way to the answer.
      expect(document.querySelector(".l-vwait")!.getAttribute("data-on")).toBe("false");
      expect(lane.getAttribute("data-phase")).toBe(String(LAST_PHASE));
      expect(verdict().getAttribute("aria-hidden")).toBe("false");
      expect(screen.getByText("Blocked")).toBeTruthy();
      expect(live.textContent).toMatch(/^Fake payout address, Enforce mode: Blocked\./);
    });

    it("jumps to the answer if the reader asks for less motion part-way through", () => {
      const ask = motion(false);
      render(<AttackDemo />);
      const lane = document.querySelector(".l-lane")!;
      fireEvent.click(screen.getByRole("button", { name: /Honeypot token/ }));
      act(() => void vi.advanceTimersByTime(PHASE_AT_MS[1]));
      expect(lane.getAttribute("data-phase")).toBe("1");
      act(() => ask(true));
      expect(lane.getAttribute("data-phase")).toBe(String(LAST_PHASE));
      expect(verdict().getAttribute("aria-hidden")).toBe("false");
      // The old run's timers are gone: nothing moves it back.
      act(() => void vi.advanceTimersByTime(10_000));
      expect(lane.getAttribute("data-phase")).toBe(String(LAST_PHASE));
    });

    it("starts again from the beginning when another attack is picked mid-run", () => {
      render(<AttackDemo />);
      const lane = document.querySelector(".l-lane")!;
      fireEvent.click(screen.getByRole("button", { name: /Fake payout address/ }));
      act(() => void vi.advanceTimersByTime(PHASE_AT_MS[2]));
      expect(lane.getAttribute("data-phase")).toBe("2");

      fireEvent.click(screen.getByRole("button", { name: /Honeypot token/ }));
      expect(lane.getAttribute("data-phase")).toBe("0");
      // The first run's timers are gone: nothing jumps ahead.
      act(() => void vi.advanceTimersByTime(PHASE_AT_MS[1] - 1));
      expect(lane.getAttribute("data-phase")).toBe("0");
      act(() => void vi.advanceTimersByTime(1));
      expect(lane.getAttribute("data-phase")).toBe("1");
    });

    it("jumps to the answer when the reader scrolls away mid-run", () => {
      let tell: (on: boolean) => void = () => {};
      vi.stubGlobal(
        "IntersectionObserver",
        class {
          constructor(cb: IntersectionObserverCallback) {
            tell = (on) =>
              cb(
                [{ isIntersecting: on, target: document.querySelector(".l-agent")! }] as never,
                this as never,
              );
          }
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      );
      render(<AttackDemo />);
      const lane = document.querySelector(".l-lane")!;
      act(() => tell(true));
      act(() => void vi.advanceTimersByTime(500 + PHASE_AT_MS[1]));
      expect(lane.getAttribute("data-phase")).toBe("1");
      act(() => tell(false));
      expect(lane.getAttribute("data-phase")).toBe(String(LAST_PHASE));
      // Scrolled past before it had time to start: it never starts, and keeps waiting.
      cleanup();
      render(<AttackDemo />);
      act(() => tell(true));
      act(() => void vi.advanceTimersByTime(200));
      act(() => tell(false));
      act(() => void vi.advanceTimersByTime(5_000));
      expect(document.querySelector(".l-lane")!.getAttribute("data-phase")).toBe(String(IDLE));
    });

    it("does not play by itself once the reader has picked an attack", () => {
      render(<AttackDemo />);
      fireEvent.click(screen.getByRole("button", { name: /Panic message/ }));
      act(() => void vi.advanceTimersByTime(500));
      expect(
        screen.getByRole("button", { name: /Panic message/ }).getAttribute("aria-pressed"),
      ).toBe("true");
    });
  });
});
