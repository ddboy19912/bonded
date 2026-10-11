import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { Accordion, Collapsible } from "./collapsible";

afterEach(cleanup);

describe("Collapsible", () => {
  it("is a button that says whether it is open, and opens and closes on click", () => {
    render(
      <Collapsible summary="More">
        <p>The detail.</p>
      </Collapsible>,
    );
    const trigger = screen.getByRole("button", { name: "More" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    // Closed content stays mounted, so it can animate and keeps its state, but is inert.
    const region = document.getElementById(trigger.getAttribute("aria-controls")!)!;
    expect(region.textContent).toContain("The detail.");
    expect(region.hasAttribute("inert")).toBe(true);
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(region.hasAttribute("inert")).toBe(false);
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("can start open", () => {
    render(
      <Collapsible summary="More" defaultOpen>
        <p>The detail.</p>
      </Collapsible>,
    );
    expect(screen.getByRole("button", { name: "More" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("follows its parent when controlled, and says when it is toggled", () => {
    const seen = vi.fn();
    function Parent() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open it from outside
          </button>
          <Collapsible
            summary="More"
            open={open}
            onOpenChange={(v) => {
              seen(v);
              setOpen(v);
            }}
          >
            <p>The detail.</p>
          </Collapsible>
        </>
      );
    }
    render(<Parent />);
    fireEvent.click(screen.getByRole("button", { name: "Open it from outside" }));
    expect(screen.getByRole("button", { name: "More" }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(seen).toHaveBeenCalledWith(false);
    act(() => {});
  });
});

describe("Accordion", () => {
  const items = [
    { id: "a", summary: "First", content: <p>One.</p> },
    { id: "b", summary: "Second", content: <p>Two.</p> },
    { id: "c", summary: "Third", content: <p>Three.</p> },
  ];
  const expanded = () =>
    screen
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-expanded") === "true")
      .map((b) => b.textContent);

  it("keeps one open at most, and starts with the one asked for", () => {
    render(<Accordion items={items} defaultOpen="b" />);
    expect(expanded()).toEqual(["Second"]);
    fireEvent.click(screen.getByRole("button", { name: "Third" }));
    expect(expanded()).toEqual(["Third"]);
    fireEvent.click(screen.getByRole("button", { name: "First" }));
    expect(expanded()).toEqual(["First"]);
  });

  it("starts with none open by default, and lets the open one close", () => {
    render(<Accordion items={items} />);
    expect(expanded()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Second" }));
    expect(expanded()).toEqual(["Second"]);
    fireEvent.click(screen.getByRole("button", { name: "Second" }));
    expect(expanded()).toEqual([]);
  });

  it("puts the chevron at the end, pointing down and turning up when open", () => {
    render(<Accordion items={items} defaultOpen="a" />);
    const open = screen.getByRole("button", { name: "First" });
    const closed = screen.getByRole("button", { name: "Second" });
    expect(open.lastElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(open.lastElementChild?.getAttribute("class")).toContain("rotate-180");
    expect(closed.lastElementChild?.getAttribute("class")).not.toContain("rotate-180");
  });
});
