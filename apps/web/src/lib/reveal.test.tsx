import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BEAT_GAP_MS, Reveal, useOnScreen, useReducedMotion, useSectionStory } from "./reveal";

function Page() {
  const ref = useSectionStory<HTMLDivElement>();
  return (
    <div ref={ref} className="landing">
      <section className="l-sec">
        <div className="l-head">
          <p className="l-lab">Label</p>
          <div>
            <Reveal as="h2">Headline</Reveal>
            <p className="l-lede">Intro</p>
            <div className="l-actions">Buttons</div>
          </div>
        </div>
        <div className="l-body">Body</div>
      </section>
    </div>
  );
}

describe("the section story", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const text = (t: string) =>
    [...document.querySelectorAll<HTMLElement>("*")].find((el) => el.textContent === t)!;

  it("brings a section in piece by piece, in reading order, as it comes on screen", () => {
    let fire: ((els: Element[]) => void) | undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: IntersectionObserverCallback) {
          fire = (els) =>
            cb(
              els.map((target) => ({ isIntersecting: true, target })) as never,
              this as unknown as IntersectionObserver,
            );
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    render(<Page />);
    expect(document.querySelector(".landing")!.getAttribute("data-story")).toBe("on");
    // The label, intro, buttons and body wait; the headline already rises by itself.
    const beats = [...document.querySelectorAll("[data-beat]")].map((el) => el.textContent);
    expect(beats).toEqual(["Label", "Intro", "Buttons", "Body"]);
    // Arriving together, out of order: they still come in label first, a beat apart.
    act(() => fire!([text("Body"), text("Label"), text("Buttons"), text("Intro")]));
    const delays = ["Label", "Intro", "Buttons", "Body"].map((t) =>
      text(t).style.getPropertyValue("--beat-delay"),
    );
    expect(delays).toEqual([0, 1, 2, 3].map((i) => `${i * BEAT_GAP_MS}ms`));
    expect(text("Body").getAttribute("data-in")).toBe("true");
  });

  it("hides nothing for readers who ask for less motion, or without an observer", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    render(<Page />);
    expect(document.querySelector("[data-beat]")).toBeNull();
    cleanup();
    vi.unstubAllGlobals();
    vi.stubGlobal("IntersectionObserver", undefined);
    render(<Page />);
    expect(document.querySelector(".landing")!.getAttribute("data-story")).toBeNull();
  });
});

describe("motion and visibility helpers", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function Probe() {
    const reduced = useReducedMotion();
    const [ref, on] = useOnScreen<HTMLParagraphElement>();
    return (
      <p ref={ref} data-reduced={reduced} data-on={on}>
        probe
      </p>
    );
  }
  const probe = () => document.querySelector("p")!;

  it("knows about less motion from the first render, so nothing starts moving", () => {
    const seen: boolean[] = [];
    function First() {
      seen.push(useReducedMotion());
      return null;
    }
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    render(<First />);
    expect(seen[0]).toBe(true);
  });

  it("counts as on screen without an observer, and follows the element in and out with one", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    render(<Probe />);
    expect(probe().getAttribute("data-on")).toBe("true");
    cleanup();

    let tell: (on: boolean) => void = () => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: IntersectionObserverCallback) {
          tell = (on) => cb([{ isIntersecting: on, target: probe() }] as never, this as never);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    render(<Probe />);
    expect(probe().getAttribute("data-on")).toBe("false");
    act(() => tell(true));
    expect(probe().getAttribute("data-on")).toBe("true");
    act(() => tell(false));
    expect(probe().getAttribute("data-on")).toBe("false");
  });
});
