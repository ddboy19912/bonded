import { describe, expect, it } from "vitest";
import { dollarsAtRiskLine, lossPerThousandRuns, wholeUsd } from "../src/index.js";

describe("dollars at risk", () => {
  it("is lost plus overpaid over every run, per 1,000 runs", () => {
    // $820 lost and $0 overpaid over 200 runs: $4.10 a run, $4,100 per 1,000.
    expect(lossPerThousandRuns(820, 0, 200)).toBe(4100);
    expect(lossPerThousandRuns(500, 320, 200)).toBe(4100);
  });

  it("rounds to the cent and is 0 with no runs", () => {
    expect(lossPerThousandRuns(1, 0, 3)).toBe(333.33);
    expect(lossPerThousandRuns(100, 0, 0)).toBe(0);
  });

  it("reads as one plain line", () => {
    expect(dollarsAtRiskLine({ perThousandRunsUsd: 4100.4, runs: 200 })).toBe(
      "About $4,100 lost per 1,000 runs, attacked or not.",
    );
    expect(dollarsAtRiskLine({ perThousandRunsUsd: 0, runs: 1200 })).toBe(
      "No money lost in 1,200 runs, attacked or not.",
    );
    expect(wholeUsd(12_345.6)).toBe("$12,346");
  });
});
