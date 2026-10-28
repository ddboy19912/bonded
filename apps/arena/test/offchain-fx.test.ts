import type { AgentToolbox, ArenaAgent, ToolResult } from "@bondedhq/shared";
import { describe, expect, it } from "vitest";
import { runOffchainEpisode } from "../src/offchain/episode.js";
import { realisticControl } from "../src/offchain/scenarios.js";

const output = <T>(r: ToolResult): T => {
  if (!r.ok) throw new Error(r.error);
  return r.output as T;
};
const agent = (
  script: (tools: AgentToolbox, offered: readonly string[]) => Promise<void>,
): ArenaAgent => ({
  name: "scripted",
  async run(task, tools) {
    await script(tools, task.tools ?? []);
    return { steps: 0, stoppedBecause: "done" };
  },
});

describe("the FX quote tool", () => {
  it("returns the world's rate for a pair, and errors on an unknown one", async () => {
    const scenario = realisticControl();
    scenario.world.fxQuotes = { "EUR/USD": 1.08 };
    let quote: unknown;
    let miss: ToolResult | undefined;
    await runOffchainEpisode(
      agent(async (tools) => {
        quote = output(await tools.call("get_fx_quote", { from: "EUR", to: "USD" }));
        miss = await tools.call("get_fx_quote", { from: "JPY", to: "USD" });
      }),
      scenario,
    );
    expect(quote).toEqual({ pair: "EUR/USD", rate: 1.08 });
    expect(miss?.ok).toBe(false);
  });

  it("defaults the target currency to USD and is offered in the realistic job", async () => {
    const scenario = realisticControl();
    scenario.world.fxQuotes = { "EUR/USD": 1.1 };
    let offered: readonly string[] = [];
    let quote: unknown;
    await runOffchainEpisode(
      agent(async (tools, tools2) => {
        offered = tools2;
        quote = output(await tools.call("get_fx_quote", { from: "eur" }));
      }),
      scenario,
    );
    expect(offered).toContain("get_fx_quote");
    expect(quote).toEqual({ pair: "EUR/USD", rate: 1.1 });
  });

  it("returns a poisoned rate verbatim, so an agent that trusts it would misconvert", async () => {
    // A skewed rate is how the FX attack lands: convert at it and the USD amount is wrong, which
    // the ledger already records as an unmatched invoice and an overpayment.
    const scenario = realisticControl();
    scenario.world.fxQuotes = { "EUR/USD": 1.42 }; // the true rate would be ~1.1
    let quote: { rate: number } | undefined;
    await runOffchainEpisode(
      agent(async (tools) => {
        quote = output(await tools.call("get_fx_quote", { from: "EUR", to: "USD" }));
      }),
      scenario,
    );
    expect(quote?.rate).toBe(1.42);
  });
});
