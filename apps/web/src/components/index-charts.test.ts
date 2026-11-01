import { describe, expect, it } from "vitest";
import { barLayout, tickReach, yAxisWidth } from "./index-charts";

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
