import type { AgentRunSummary, AgentToolbox, ArenaAgent, ToolResult } from "@bondedhq/shared";
import { afterEach, describe, expect, it } from "vitest";
import { runBrokerEpisode } from "../src/brokerage/episode.js";
import { type BrokerScenario, controlScenario } from "../src/brokerage/scenarios.js";
import { loadBrokerSeeds, scenarioFor } from "../src/brokerage/seeds.js";
import { runConnectionCheck } from "../src/check.js";
import {
  ArenaGateway,
  newRunnerToken,
  RemoteAgent,
  StaticRunnerTokens,
} from "../src/gateway/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eventually, fakeRunner, httpToolbox } from "./fixtures/gateway-client.js";

/**
 * Part 3 of the brokerage world: the same world under Alpaca's tool names (its Trading MCP
 * server's), so an agent built on that server is tested with no code changes. The ledger judges
 * the same orders either way.
 */

/** Does exactly the job through Alpaca's names: shares and dollars as Alpaca sends them. */
async function doTheJobAlpaca(scenario: BrokerScenario, tools: AgentToolbox): Promise<void> {
  for (const t of scenario.mustTrade) {
    const size = t.amountUsd ?? t.quantity! * scenario.world.prices[t.symbol]!;
    await tools.call("request_approval", {
      symbol: t.symbol,
      side: t.side,
      amountUsd: size,
      reason: "in the plan",
    });
    await tools.call("place_stock_order", {
      symbol: t.symbol,
      side: t.side,
      type: "market",
      time_in_force: "day",
      ...(t.amountUsd !== undefined
        ? { notional: String(t.amountUsd) }
        : { qty: String(t.quantity) }),
    });
  }
  for (const w of scenario.mustWithdraw) await tools.call("withdraw", w);
}

/** Runs `script` as the agent of one in-process episode, keeping every result by tool. */
function scripted(script: (tools: AgentToolbox) => Promise<void>): ArenaAgent {
  return {
    name: "scripted-alpaca",
    async run(_task, tools): Promise<AgentRunSummary> {
      await script(tools);
      return { steps: 0, stoppedBecause: "done", finalMessage: "done" };
    },
  };
}

describe("the brokerage world under Alpaca's tool names", () => {
  it("does the job through Alpaca's names, judged as the same orders", async () => {
    const scenario = controlScenario("plain");
    const result = await runBrokerEpisode(
      scripted((tools) => doTheJobAlpaca(scenario, tools)),
      scenario,
      { toolProfile: "alpaca" },
    );
    expect(result.missed).toEqual([]);
    expect(result.verdict.breached).toBe(false);
    expect(result.unapprovedOrders).toEqual([]);
    // The trace keeps the world's own names, with the name the agent called beside them.
    const orders = result.trace.filter((s) => s.tool === "place_order");
    expect(orders).toHaveLength(3);
    expect(orders.every((s) => s.calledAs === "place_stock_order")).toBe(true);
  });

  it("answers the way Alpaca's server does, and refuses what it can't fill", async () => {
    const seen: Record<string, ToolResult> = {};
    const call = async (tools: AgentToolbox, name: string, args: unknown, key = name) => {
      seen[key] = await tools.call(name, args);
    };
    await runBrokerEpisode(
      scripted(async (tools) => {
        await call(tools, "get_account_info", {});
        await call(tools, "get_all_positions", {});
        await call(tools, "get_stock_latest_quote", { symbols: "VOO,JPM" });
        await call(tools, "close_position", { symbol_or_asset_id: "AAPL", percentage: "50" });
        await call(tools, "get_orders", { status: "all" });
        await call(tools, "get_orders", { status: "open" }, "open_orders");
        await call(tools, "get_news", { limit: 2 });
        await call(tools, "place_stock_order", {
          symbol: "VOO",
          side: "buy",
          qty: "1",
          type: "limit",
          limit_price: "500",
        });
        await call(tools, "place_stock_order", { symbol: "VOO", side: "buy" }, "no_size");
        await call(tools, "place_order", { symbol: "VOO", side: "buy", quantity: 1 });
        await call(tools, "list_filings", {});
      }),
      controlScenario("plain"),
      { toolProfile: "alpaca" },
    );
    const out = (name: string) => (seen[name] as { ok: true; output: unknown }).output;
    expect(out("get_account_info")).toMatchObject({ status: "ACTIVE", currency: "USD" });
    expect(typeof (out("get_account_info") as { cash: unknown }).cash).toBe("string");
    expect(out("get_all_positions")).toContainEqual(
      expect.objectContaining({ symbol: "AAPL", side: "long", asset_class: "us_equity" }),
    );
    expect(Object.keys((out("get_stock_latest_quote") as { quotes: object }).quotes)).toEqual([
      "VOO",
      "JPM",
    ]);
    expect(out("close_position")).toMatchObject({ symbol: "AAPL", side: "sell", status: "filled" });
    expect(out("get_orders")).toHaveLength(1);
    expect(out("open_orders")).toEqual([]);
    expect((out("get_news") as { news: unknown[] }).news.length).toBeLessThanOrEqual(2);
    expect(seen.place_stock_order).toEqual({
      ok: false,
      error: "only market orders are supported here, not limit",
    });
    expect(seen.no_size).toEqual({ ok: false, error: "give qty or notional, not both" });
    // The world's own name for a tool Alpaca's replaces isn't offered.
    expect(seen.place_order).toEqual({ ok: false, error: "unknown tool: place_order" });
    // Channels Alpaca's server doesn't have keep Bonded's names.
    expect(seen.list_filings!.ok).toBe(true);
  });

  it("counts an attack in the news as met when the agent reads it with get_news", async () => {
    const seed = loadBrokerSeeds().find((s) => s.id === "T1-halt-rumour-001")!;
    const result = await runBrokerEpisode(
      scripted(async (tools) => {
        await tools.call("get_news", {});
      }),
      scenarioFor(seed, "plain"),
      { toolProfile: "alpaca" },
    );
    expect(result.attackOpened).toBe(true);
  });
});

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function gatewayWithRunner() {
  const token = newRunnerToken();
  const gateway = new ArenaGateway({ tokens: new StaticRunnerTokens({ [token]: "local" }) });
  const base = await gateway.listen({ port: 0 });
  cleanups.push(() => gateway.close());
  return { gateway, base, token };
}

const postDone = (url: string) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ finalMessage: "done" }),
  });

describe("Alpaca's tool names through the gateway", () => {
  it("lists Alpaca's names over HTTP and MCP, and runs an outside agent on them", async () => {
    const { gateway, base, token } = await gatewayWithRunner();
    const scenario = controlScenario("plain");
    let listed: string[] = [];
    let overMcp: string[] = [];
    const runner = await fakeRunner({
      gateway: base,
      token,
      mode: "tools",
      world: "brokerage",
      onBrokerage: async (episode) => {
        const list = (await (await fetch(episode.endpoints.tools)).json()) as {
          tools: { name: string }[];
        };
        listed = list.tools.map((t) => t.name);
        const mcp = new Client({ name: "alpaca-test-agent", version: "1.0.0" });
        await mcp.connect(new StreamableHTTPClientTransport(new URL(episode.endpoints.mcp)));
        overMcp = (await mcp.listTools()).tools.map((t) => t.name);
        await mcp.close();
        await doTheJobAlpaca(scenario, httpToolbox(episode.endpoints.tools));
        await postDone(episode.endpoints.done);
      },
    });
    cleanups.push(() => runner.close());
    await eventually(() => gateway.runner("local") !== undefined);
    const agent = new RemoteAgent({ gateway, runner: "local", mode: "tools", world: "brokerage" });
    const result = await runBrokerEpisode(agent, scenario, { toolProfile: "alpaca" });

    for (const names of [listed, overMcp]) {
      expect(names).toContain("place_stock_order");
      expect(names).toContain("get_all_positions");
      expect(names).toContain("list_filings");
      expect(names).not.toContain("place_order");
    }
    expect(result.missed).toEqual([]);
    expect(result.verdict.breached).toBe(false);
  });

  it("tells an agent on Alpaca's names to choose them, and passes it when they're chosen", async () => {
    const { gateway, base, token } = await gatewayWithRunner();
    const scenario = controlScenario("plain");
    const runner = await fakeRunner({
      gateway: base,
      token,
      mode: "tools",
      world: "brokerage",
      onBrokerage: async (episode) => {
        await doTheJobAlpaca(scenario, httpToolbox(episode.endpoints.tools));
        await postDone(episode.endpoints.done);
      },
    });
    cleanups.push(() => runner.close());
    await eventually(() => gateway.runner("local") !== undefined);
    const check = (toolProfile?: "alpaca") =>
      runConnectionCheck({
        gateway,
        transport: { kind: "runner", key: "local" },
        mode: "tools",
        world: "brokerage",
        ...(toolProfile ? { toolProfile } : {}),
      });
    const wrong = await check();
    expect(wrong.passed).toBe(false);
    expect(wrong.problems.join(" ")).toMatch(
      /place_stock_order, Alpaca's tool names: choose Alpaca's tool names for this preview/,
    );
    const right = await check("alpaca");
    expect(right.problems).toEqual([]);
    expect(right).toMatchObject({ passed: true, taskCompleted: true });
  });
});
