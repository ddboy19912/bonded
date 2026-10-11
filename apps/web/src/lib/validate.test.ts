import { describe, expect, it } from "vitest";
import {
  addressError,
  amountOrZeroError,
  percentError,
  dailyLimitError,
  descriptionError,
  limitError,
  mandateFieldProblems,
  positiveAmountError,
} from "./validate";

describe("field checks", () => {
  it("limits are positive whole dollars, and the daily one covers a trade", () => {
    expect(limitError("5000")).toBeNull();
    expect(limitError("")).toMatch(/Enter a limit/);
    expect(limitError("5,000")).toMatch(/Whole dollars/);
    expect(limitError("5000.5")).toMatch(/Whole dollars/);
    expect(limitError("0")).toMatch(/more than 0/);
    expect(dailyLimitError("25000", "5000")).toBeNull();
    expect(dailyLimitError("1000", "5000")).toMatch(/at least the per-trade/);
    // A broken per-trade limit is its own field's problem, not the daily one's.
    expect(dailyLimitError("1000", "abc")).toBeNull();
  });

  it("mandate percentages fit in basis points, from the minimum to 100", () => {
    expect(percentError("3", { min: 0 })).toBeNull();
    expect(percentError("0.5", { min: 0.01 })).toBeNull();
    expect(percentError("0", { min: 0 })).toBeNull();
    expect(percentError("0", { min: 0.01 })).toBe("Must be more than 0.");
    expect(percentError("0.125", { min: 0 })).toMatch(/at most 2 decimals/);
    expect(percentError("101", { min: 0 })).toBe("At most 100%.");
    expect(percentError("", { min: 0 })).toBe("Enter a percentage.");
  });

  it("addresses, with an optional field allowed to stay empty", () => {
    expect(addressError(`0x${"ab".repeat(20)}`)).toBeNull();
    expect(addressError("0x123")).toMatch(/Not an address/);
    expect(addressError("", true)).toBeNull();
    expect(addressError("")).toMatch(/Enter an address/);
  });

  it("descriptions are 1 to 1,000 characters", () => {
    expect(descriptionError("An agent.")).toBeNull();
    expect(descriptionError("  ")).toMatch(/short description/);
    expect(descriptionError("x".repeat(1001))).toMatch(/this is 1001/);
  });

  it("amounts: the bond and deposit may be 0; cover and breaches must be positive", () => {
    expect(amountOrZeroError("0")).toBeNull();
    expect(amountOrZeroError("4000.123456")).toBeNull();
    expect(amountOrZeroError("4000.1234567")).toMatch(/6 decimals/);
    expect(positiveAmountError("")).toBeNull();
    expect(positiveAmountError("0")).toMatch(/positive/);
    const cap = { value: 20_000_000_000n, message: "Capped at 20,000." };
    expect(positiveAmountError("20000", cap)).toBeNull();
    expect(positiveAmountError("20000.01", cap)).toBe("Capped at 20,000.");
  });
});

describe("mandateFieldProblems", () => {
  const ok = {
    maxTx: "5000",
    maxDaily: "25000",
    drawdown: "15",
    slippage: "3",
    refund: "",
    description: "An agent",
  };

  it("has nothing to say about fields that are fine", () => {
    expect(mandateFieldProblems(ok)).toEqual([]);
  });

  it("names each wrong field, so a blank percentage is caught before it becomes 0", () => {
    expect(mandateFieldProblems({ ...ok, slippage: "" })).toEqual([
      "Maximum slippage: Enter a percentage.",
    ]);
    expect(mandateFieldProblems({ ...ok, drawdown: "  ", maxTx: "abc" })).toEqual([
      "Per-trade limit: Whole dollars only, no commas or cents.",
      "Maximum drawdown: Enter a percentage.",
    ]);
  });

  it("checks the daily limit against the per-trade one, the refund address and the description", () => {
    expect(mandateFieldProblems({ ...ok, maxDaily: "100" })).toEqual([
      "Daily limit: Must be at least the per-trade limit.",
    ]);
    expect(mandateFieldProblems({ ...ok, refund: "0x12", description: "" })).toEqual([
      "Refund address: Not an address: 0x followed by 40 hex characters.",
      "Description: Write a short description; it's part of the mandate.",
    ]);
  });
});
