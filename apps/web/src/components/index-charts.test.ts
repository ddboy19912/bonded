import { describe, expect, it } from "vitest";
import type { BondedIndexEntry } from "@bondedhq/shared";
import { barLayout, type ModelPoint, placeLabels, tickReach, yAxisWidth } from "./index-charts";

// The Index's model names, the longest first, and the widest tick labels its charts use.
const NAMES = [
  "Claude Sonnet 5.5",
  "Muse Spark Open",
  "DeepSeek V4.1 Flash",
  "Claude Haiku 5.5",
  "Llama 4 Maverick",
  "Muse Spark 1.3",
  "GLM-5.3 Flash",
  "Qwen3.7 Flash",
  "GLM-5.3",
];
const TICKS = ["$0", "$200K", "$400K", "$600K", "$1.2M"];

describe("chart axes sized from their labels", () => {
  it("makes a y axis wide enough for its widest tick", () => {
    // Digits render up to about 0.66 of the font size wide; Recharts sets labels 8px from the plot.
    expect(yAxisWidth(["$600K"])).toBeGreaterThanOrEqual(Math.ceil(5 * 11 * 0.66) + 8);
    expect(yAxisWidth(["$600K"])).toBeGreaterThan(yAxisWidth(["0", "100"]));
  });

  it("reaches further down and left for longer names, and further down when turned steeper", () => {
    const short = tickReach("GLM-5.3", false);
    const long = tickReach("Muse Spark Open", false);
    expect(long.below).toBeGreaterThan(short.below);
    expect(long.left).toBeGreaterThan(short.left);
    // Narrow charts turn names to 70 degrees: deeper, but less to the left.
    const narrow = tickReach("Claude Sonnet 5.5", true);
    const wide = tickReach("Claude Sonnet 5.5", false);
    expect(narrow.below).toBeGreaterThan(wide.below);
    expect(narrow.left).toBeLessThan(wide.left);
  });

  it("keeps every name inside the chart at every width, in any order", () => {
    for (let width = 240; width <= 1600; width += 20) {
      const narrow = width < 520;
      for (const names of [NAMES, [...NAMES].reverse(), NAMES.slice(0, 2), NAMES.slice(0, 1)]) {
        const { yWidth, xHeight, left, band, reach } = barLayout(names, TICKS, width, narrow);
        reach.forEach((r, i) => {
          const centre = left + yWidth + band * (i + 0.5);
          expect(centre - r.left, `${names[i]} at ${width}px`).toBeGreaterThanOrEqual(0);
          expect(r.below, `${names[i]} at ${width}px`).toBeLessThanOrEqual(xHeight);
        });
        expect(band, `bands at ${width}px`).toBeGreaterThan(0);
      }
    }
  });
});

describe("scatter names", () => {
  const point = (label: string, x: number, y: number): ModelPoint => ({
    entry: { model: label, label } as BondedIndexEntry,
    x,
    y,
    tip: null,
  });
  const place = (points: ModelPoint[]) =>
    placeLabels(
      points,
      (p) => ({ x: p.x, y: p.y }),
      { left: 0, right: 600, top: 0, bottom: 400 },
      11,
    );

  it("gives logos that touch on screen one shared name, even when their values differ", () => {
    // DeepSeek and Haiku: both 75, $3.99 and $3.87 per 1,000 runs, about a pixel apart.
    const labels = place([
      point("DeepSeek V4.1 Flash", 200, 100),
      point("Claude Haiku 5.5", 199, 100),
    ]);
    const named = [...labels.values()].filter((p) => p !== null);
    expect(named).toHaveLength(1);
    expect(named[0]!.lines).toEqual(["Claude Haiku 5.5", "DeepSeek V4.1 Flash"]);
  });

  it("finds room for a shared name among crowded neighbours, as on the cost chart", () => {
    // Pixel spots from the Security vs cost chart, where the pair went unnamed.
    const labels = placeLabels(
      [
        point("GLM-5.3", 328, 254),
        point("DeepSeek V4.1 Flash", 371, 305),
        point("Claude Haiku 5.5", 370, 305),
        point("Llama 4 Maverick", 410, 313),
        point("GLM-5.3 Flash", 355, 350),
      ],
      (p) => ({ x: p.x, y: p.y }),
      { left: 280, right: 798, top: 2, bottom: 470 },
      11,
    );
    const pair = [labels.get("DeepSeek V4.1 Flash"), labels.get("Claude Haiku 5.5")].find(Boolean);
    expect(pair?.lines).toEqual(["Claude Haiku 5.5", "DeepSeek V4.1 Flash"]);
    expect(labels.get("Llama 4 Maverick")).toBeTruthy();
  });

  it("names points apart from each other separately", () => {
    const labels = place([point("GLM-5.3", 100, 100), point("Qwen3.7 Flash", 300, 300)]);
    expect(labels.get("GLM-5.3")?.lines).toEqual(["GLM-5.3"]);
    expect(labels.get("Qwen3.7 Flash")?.lines).toEqual(["Qwen3.7 Flash"]);
  });
});
