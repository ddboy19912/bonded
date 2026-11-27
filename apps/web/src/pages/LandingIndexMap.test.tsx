import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import type { BondedIndexEntry } from "@bondedhq/shared";
import { loadBondedIndex } from "../lib/bonded-index";
import { LandingIndex } from "./LandingOffchain";
import { at, corner, isGoal, mapPoints, placeCorners, placeLabels } from "./LandingIndexMap";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const entry = (model: string, label: string, score: number, task: number | null) =>
  ({
    ...loadBondedIndex().entries[0]!,
    model,
    label,
    score,
    task: { ...loadBondedIndex().entries[0]!.task!, score: task },
  }) as BondedIndexEntry;
const index = (entries: BondedIndexEntry[]) => ({ ...loadBondedIndex(), entries });
const show = (entries: BondedIndexEntry[]) => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  render(
    <MemoryRouter>
      <LandingIndex index={index(entries)} />
    </MemoryRouter>,
  );
};

type Box = { left: number; top: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
  a.left < b.left + b.width &&
  b.left < a.left + a.width &&
  a.top < b.top + b.height &&
  b.top < a.top + a.height;

describe("the Index map", () => {
  const points = mapPoints(loadBondedIndex().entries);

  it("names the corners by both scores, split at 50", () => {
    expect(corner(92, 100)).toBe("Hard to trick, still does the job");
    expect(corner(100, 29)).toBe("Safe because it refuses");
    expect(corner(29, 80)).toBe("Does the job, easy to trick");
    expect(corner(29, 5)).toBe("Easy to trick, little done");
    expect(isGoal({ security: 50, task: 50 })).toBe(true);
    expect(isGoal({ security: 100, task: 49 })).toBe(false);
  });

  it("keeps a dot clear of the plot's edges at both ends of the scale", () => {
    expect(at(0)).toBeGreaterThan(0);
    expect(at(100)).toBeLessThan(100);
  });

  it("plots only models with both scores", () => {
    const pts = mapPoints([entry("a", "A", 90, 80), entry("u", "U", 70, null)]);
    expect(pts.map((p) => p.entry.model)).toEqual(["a"]);
  });

  it("places every name inside the plot, clear of the others, on a wide screen and a phone", () => {
    for (const [width, height] of [
      [1300, 520],
      [310, 400],
    ] as const) {
      const labels = placeLabels(points, width, height);
      const font = width < 560 ? 13 : 15;
      const boxes = points.flatMap((p) => {
        const at = labels.get(p.entry.model);
        return at
          ? [{ ...at, width: p.entry.label.length * font * 0.55 + 4, height: font + 6 }]
          : [];
      });
      // On a wide screen every name on the published Index finds a spot. On a phone a name or two
      // whose markers sit almost on top of another's goes without (a tap shows it, and the ledger
      // above names every model).
      if (width > 560) expect(boxes).toHaveLength(points.length);
      else expect(boxes.length).toBeGreaterThanOrEqual(points.length - 2);
      for (const b of boxes) {
        expect(b.left).toBeGreaterThanOrEqual(0);
        expect(b.top).toBeGreaterThanOrEqual(0);
        expect(b.left + b.width).toBeLessThanOrEqual(width);
        expect(b.top + b.height).toBeLessThanOrEqual(height);
      }
      boxes.forEach((a, i) =>
        boxes.slice(i + 1).forEach((b) => expect(overlaps(a, b), `${i}`).toBe(false)),
      );
    }
  });

  it("slides a corner's name along its edge so no model's dot is hidden under it", () => {
    const width = 1300;
    const height = 520;
    // A model right in the goal corner, where the corner's name would otherwise sit.
    const crowded = [...points, ...mapPoints([entry("c", "Corner", 100, 100)])];
    for (const [w, h] of [
      [width, height],
      [310, 400],
    ] as const) {
      const marker = w < 560 ? 24 : 30;
      const boxes = placeCorners(crowded, w, h);
      for (const box of boxes) {
        if (!box) continue;
        for (const p of crowded) {
          const x = (at(p.security) / 100) * w;
          const y = h - (at(p.task) / 100) * h;
          const m = { left: x - marker / 2, top: y - marker / 2, width: marker, height: marker };
          expect(overlaps(box, m)).toBe(false);
        }
      }
      // On a wide screen every corner still finds room for its name.
      if (w === width) expect(boxes.every((b) => b !== null)).toBe(true);
    }
  });

  it("shows both scores for the dot pointed at, and lights its row in the ledger", () => {
    show([entry("a", "Model A", 95, 20), entry("b", "Model B", 60, 90)]);
    const dots = document.querySelectorAll(".l-dot");
    fireEvent.mouseEnter(dots[1]!);
    const tip = document.querySelector(".l-tip")!;
    expect(tip.querySelector("p")!.textContent).toBe("Model B");
    expect([...tip.querySelectorAll("dd")].map((d) => d.textContent)).toEqual(["60", "90"]);
    const row = screen.getByRole("rowheader", { name: "Model B" }).closest("tr")!;
    expect(row.getAttribute("data-active")).toBe("true");
    // The other dot steps back.
    expect(dots[0]!.parentElement!.getAttribute("data-dim")).toBe("true");
    fireEvent.mouseLeave(document.querySelector(".l-plot")!);
    expect(document.querySelector(".l-tip")).toBeNull();
  });

  it("lights a model's dot when its row is pointed at", () => {
    show([entry("a", "Model A", 95, 20), entry("b", "Model B", 60, 90)]);
    fireEvent.mouseEnter(screen.getByRole("rowheader", { name: "Model A" }).closest("tr")!);
    expect(document.querySelector(".l-tip p")!.textContent).toBe("Model A");
    expect(document.querySelector('[data-on="true"] > .l-dot')).toBeTruthy();
  });

  it("marks the goal corner's dots, and says when a model is listed but not plotted", () => {
    show([entry("a", "Model A", 95, 20), entry("b", "Model B", 60, 90), entry("u", "U", 70, null)]);
    const goals = [...document.querySelectorAll('[data-goal="true"] > .l-dot')];
    expect(goals).toHaveLength(1);
    expect(screen.getByText(/One model has no Task score yet/)).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(4);
  });
});
