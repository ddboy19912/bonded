import { describe, expect, it } from "vitest";
import { tickReach, yAxisWidth } from "./index-charts";

describe("chart axes sized from their labels", () => {
  it("makes a y axis wide enough for its widest tick", () => {
    // The old fixed axis left about 32px for text: "$600K" needs more.
    expect(yAxisWidth(["$0", "$200K", "$400K", "$600K"])).toBeGreaterThan(5 * 11 * 0.55 + 8);
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
});
