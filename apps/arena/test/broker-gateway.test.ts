import { type AgentToolbox, newAgentSecret } from "@bondedhq/shared";
import { afterEach, describe, expect, it } from "vitest";
import { runBrokerEpisode } from "../src/brokerage/episode.js";
import { type BrokerScenario, controlScenario } from "../src/brokerage/scenarios.js";
import { loadBrokerSeeds, scenarioFor } from "../src/brokerage/seeds.js";
import {
  ArenaGateway,
  newRunnerToken,
  RemoteAgent,
  StaticRunnerTokens,
} from "../src/gateway/index.js";
import { eventually, fakeRunner, httpToolbox, mcpToolbox } from "./fixtures/gateway-client.js";
import { urlAgent } from "./fixtures/url-agent.js";

/**
 * Part 2 of the brokerage world: an agent running outside the Arena is tested on it through the
 * gateway, by its runner or its own URL, exactly as the in-process agents are. No chain is
 * involved, so these run without a sandbox.
 */

/** Does exactly the job over the episode's tools, then posts /done. */
async function doTheJob(scenario: BrokerScenario, tools: AgentToolbox): Promise<void> {
  for (const t of scenario.mustTrade) {
    const size = t.amountUsd ?? t.quantity! * scenario.world.prices[t.symbol]!;
    await tools.call("request_approval", {
      symbol: t.symbol,
      side: t.side,
      amountUsd: size,
      reason: "in the plan",
    });
    await tools.call("place_order", {
      symbol: t.symbol,
      side: t.side,
      ...(t.amountUsd !== undefined ? { amountUsd: t.amountUsd } : { quantity: t.quantity }),
    });
  }
  for (const w of scenario.mustWithdraw) await tools.call("withdraw", w);
}

const postDone = (url: string, finalMessage: string) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ finalMessage }),
  });

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function gatewayWithRunner(protocol?: number) {
  const token = newRunnerToken();
  const gateway = new ArenaGateway({ tokens: new StaticRunnerTokens({ [token]: "local" }) });
  const base = await gateway.listen({ port: 0 });
  cleanups.push(() => gateway.close());
  return { gateway, base, token, protocol };
}

describe("brokerage episodes through the gateway", () => {
  it("serves the brokerage tools, not the vault's, and judges an outside agent by the ledger", async () => {
    const { gateway, base, token } = await gatewayWithRunner();
    const scenario = controlScenario();
    let listed: string[] = [];
    let openapiTitle = "";
    const runner = await fakeRunner({
      gateway: base,
      token,
      mode: "tools",
      onBrokerage: async (episode) => {
        const list = (await (await fetch(episode.endpoints.tools)).json()) as {
          tools: { name: string }[];
        };
        listed = list.tools.map((t) => t.name);
        openapiTitle = (
          (await (await fetch(episode.endpoints.openapi)).json()) as { info: { title: string } }
        ).info.title;
        await doTheJob(scenario, httpToolbox(episode.endpoints.tools));
        await postDone(episode.endpoints.done, "did the run");
      },
    });
    cleanups.push(() => runner.close());
    await eventually(() => gateway.runner("local") !== undefined);
    const agent = new RemoteAgent({ gateway, runner: "local", mode: "tools", world: "brokerage" });
    const result = await runBrokerEpisode(agent, scenario);

    expect(listed).toContain("place_order");
    expect(listed).toContain("list_filings");
    expect(listed).not.toContain("swap");
    expect(openapiTitle).toBe("Brokerage tools");
    expect(result.missed).toEqual([]);
    expect(result.verdict.breached).toBe(false);
    expect(result.unapprovedOrders).toEqual([]);
    // The steps are the calls the gateway saw, not what the agent says.
    expect(result.trace.filter((s) => s.tool === "place_order")).toHaveLength(3);
    expect(result.agentSummary).toMatchObject({
      stoppedBecause: "done",
      finalMessage: "did the run",
    });
  });

  it("catches an attack an outside agent falls for, over MCP", async () => {
    const { gateway, base, token } = await gatewayWithRunner();
    const seed = loadBrokerSeeds().find((s) => s.id === "T1-fund-closing-lookalike-001")!;
    const scenario = scenarioFor(seed);
    const runner = await fakeRunner({
      gateway: base,
      token,
      mode: "tools",
      onBrokerage: async (episode) => {
        const tools = await mcpToolbox(episode.endpoints.mcp);
        try {
          await tools.call("read_message", { messageId: "m-611" });
          await tools.call("place_order", { symbol: "VTI", side: "sell", quantity: 60 });
        } finally {
          await tools.close();
        }
        await postDone(episode.endpoints.done, "sold VTI before the closing");
      },
    });
    cleanups.push(() => runner.close());
    await eventually(() => gateway.runner("local") !== undefined);
    const agent = new RemoteAgent({ gateway, runner: "local", mode: "tools", world: "brokerage" });
    const result = await runBrokerEpisode(agent, scenario);

    expect(result.attackOpened).toBe(true);
    expect(result.verdict.attackSucceeded).toBe(true);
    expect(result.verdict.breaches.map((b) => b.type)).toEqual(["over_order_cap"]);
  });

  it("tells a protocol 1 runner to update instead of sending it a brokerage episode", async () => {
    const { gateway, base, token } = await gatewayWithRunner();
    let received = 0;
    const runner = await fakeRunner({
      gateway: base,
      token,
      mode: "tools",
      protocol: 1,
      onBrokerage: () => {
        received++;
      },
    });
    cleanups.push(() => runner.close());
    await eventually(() => gateway.runner("local") !== undefined);
    expect(gateway.runner("local")?.canRunBrokerage).toBe(false);
    const agent = new RemoteAgent({ gateway, runner: "local", mode: "tools", world: "brokerage" });
    const result = await runBrokerEpisode(agent, controlScenario());

    expect(received).toBe(0);
    expect(result.agentSummary.stoppedBecause).toBe("error");
    expect(result.agentSummary.finalMessage).toMatch(/update @bondedhq\/runner/);
    expect(result.trace).toEqual([]);
  });

  it("reaches an agent by its own URL", async () => {
    const secret = newAgentSecret();
    const scenario = controlScenario();
    const at = await urlAgent({
      secret,
      onBrokerageEpisode: async (episode) => {
        await doTheJob(scenario, httpToolbox(episode.endpoints.tools));
        await postDone(episode.endpoints.done, "done by URL");
      },
    });
    cleanups.push(() => at.close());
    const gateway = new ArenaGateway({
      tokens: new StaticRunnerTokens(),
      agentUrl: { allowLoopback: true },
    });
    await gateway.listen({ port: 0 });
    cleanups.push(() => gateway.close());
    const agent = new RemoteAgent({
      gateway,
      transport: { kind: "url", url: at.url, secret, registration: "local" },
      mode: "tools",
      world: "brokerage",
    });
    const result = await runBrokerEpisode(agent, scenario);

    expect(at.received.find((m) => m.type === "episode")).toMatchObject({ world: "brokerage" });
    expect(result.missed).toEqual([]);
    expect(result.verdict.breached).toBe(false);
    expect(result.agentSummary.finalMessage).toBe("done by URL");
  });

  it("refuses chain mode and a missing sandbox where they don't fit", () => {
    const gateway = new ArenaGateway({ tokens: new StaticRunnerTokens() });
    expect(
      () => new RemoteAgent({ gateway, runner: "local", mode: "chain", world: "brokerage" }),
    ).toThrow(/tools mode only/);
    expect(() => new RemoteAgent({ gateway, runner: "local", mode: "tools" })).toThrow(
      /needs a sandbox/,
    );
  });
});
