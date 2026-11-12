import { describe, expect, it } from "vitest";
import {
  ALPACA_BROKER_TOOLS,
  ALPACA_REPLACES,
  BROKER_TOOL_NAMES,
  brokerProfileTools,
  brokerToolDefinitions,
} from "../src/index.js";

describe("broker tool profiles", () => {
  it("offers the world's own tools by default, as before", () => {
    expect(brokerProfileTools().map((t) => t.name)).toEqual(BROKER_TOOL_NAMES);
    expect(brokerToolDefinitions().map((d) => d.function.name)).toEqual(BROKER_TOOL_NAMES);
  });

  it("offers Alpaca's names, and Bonded's only for what Alpaca's server doesn't have", () => {
    const names = brokerProfileTools("alpaca").map((t) => t.name);
    for (const name of Object.keys(ALPACA_BROKER_TOOLS)) expect(names).toContain(name);
    for (const name of ALPACA_REPLACES) expect(names).not.toContain(name);
    for (const kept of ["list_filings", "read_message", "request_approval", "withdraw"])
      expect(names).toContain(kept);
    expect(new Set(names).size).toBe(names.length);
  });

  it("takes Alpaca's argument names, with decimals as strings or numbers", () => {
    const order = ALPACA_BROKER_TOOLS.place_stock_order.input;
    expect(order.safeParse({ symbol: "VOO", side: "buy", notional: "2000.00" }).success).toBe(true);
    expect(order.safeParse({ symbol: "VOO", side: "buy", qty: 3 }).success).toBe(true);
    expect(order.safeParse({ symbol: "VOO", side: "buy", qty: "-3" }).success).toBe(false);
    const close = ALPACA_BROKER_TOOLS.close_position.input;
    expect(close.safeParse({ symbol_or_asset_id: "AAPL", percentage: "50" }).success).toBe(true);
    const quote = brokerToolDefinitions({}, "alpaca").find(
      (d) => d.function.name === "get_stock_latest_quote",
    )!;
    expect(quote.function.parameters).toMatchObject({ required: ["symbols"] });
  });
});
