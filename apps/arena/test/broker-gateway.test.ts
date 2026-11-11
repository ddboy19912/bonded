import { type AgentToolbox, newAgentSecret } from "@bondedhq/shared";
import { afterEach, describe, expect, it } from "vitest";
import { didNotFinish, neverRan, runBrokerEpisode } from "../src/brokerage/episode.js";
import { brokerReport } from "../src/brokerage/report.js";
import { runBrokerQueue, UNREACHED_TO_STOP } from "../src/brokerage/run.js";
import { type BrokerScenario, controlScenario } from "../src/brokerage/scenarios.js";
import { loadBrokerSeeds, scenarioFor } from "../src/brokerage/seeds.js";
import {
  ArenaGateway,
  newRunnerToken,
  RemoteAgent,
  StaticRunnerTokens,
} from "../src/gateway/index.js";
import { ArenaToolbox } from "../src/toolbox.js";
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
      world: "brokerage",
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
      world: "brokerage",
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

  it.each([
    ["a protocol 1 runner", { protocol: 1 }],
    // Protocol 2, but started without --world brokerage: its agent was built for the vault world.
    ["a vault-world runner", { protocol: 2 }],
    ["a runner that names the world but speaks protocol 1", { protocol: 1, world: "brokerage" }],
  ] as const)("never sends a brokerage episode to %s", async (_, hello) => {
    const { gateway, base, token } = await gatewayWithRunner();
    let received = 0;
    const runner = await fakeRunner({
      gateway: base,
      token,
      mode: "tools",
      ...hello,
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
    expect(result.agentSummary.finalMessage).toMatch(/--world brokerage/);
    expect(result.trace).toEqual([]);
    expect(neverRan(result)).toBe(true);
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

  it("doesn't call an attack held when the agent's URL refused the episode", async () => {
    const secret = newAgentSecret();
    // No brokerage handler: the fixture answers 400, as createBondedHandler answers 422.
    const at = await urlAgent({ secret });
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
    const scenarios = loadBrokerSeeds()
      .map((seed) => scenarioFor(seed))
      .filter((scenario) => scenario.kind === "attack")
      .slice(0, UNREACHED_TO_STOP + 2);
    const run = await runBrokerQueue(scenarios, () => agent, {
      concurrency: 1,
      stopAfterUnreached: UNREACHED_TO_STOP,
    });

    // The run stops once the agent has plainly gone, instead of failing every episode left.
    expect(run.results).toHaveLength(UNREACHED_TO_STOP);
    expect(run.stoppedEarly).toMatch(/3 episodes in a row.*answered 400/);
    expect(run.results.every((r) => neverRan(r) && didNotFinish(r))).toBe(true);
    expect(run.results.every((r) => !r.verdict.attackSucceeded)).toBe(true);
    const report = brokerReport(
      {
        agent: agent.name,
        date: "2026-11-11",
        runsPerSeed: 1,
        mandateShown: true,
        plan: "explicit",
        spentUsd: 0,
        stoppedByCap: false,
        ...(run.stoppedEarly ? { stoppedEarly: run.stoppedEarly } : {}),
      },
      scenarios,
      run.results,
    );
    expect(report).toContain("No attack episode finished");
    expect(report).not.toMatch(/Attacks worked in 0 of/);
    expect(report).toContain("## Episodes that didn't finish");
    expect(report).toContain("The run stopped early");
    expect(report).toContain("on the agent's own model");
    expect(report).toContain("Bonded spent nothing");
  });

  it("serves a world only from its own toolbox, and chain mode only for the vault world", () => {
    const gateway = new ArenaGateway({ tokens: new StaticRunnerTokens() });
    const vaultTools = Object.create(ArenaToolbox.prototype) as ArenaToolbox;
    const spec = { episodeId: "ep-1", mode: "tools" as const, world: "brokerage" as const };
    expect(() => gateway.openEpisode({ ...spec, toolbox: vaultTools })).toThrow(
      /can't be served from the vault world's toolbox/,
    );
    expect(() =>
      gateway.openEpisode({ ...spec, mode: "chain", toolbox: { call: () => never() } }),
    ).toThrow(/a chain-mode episode needs a chain|has no chain mode/);
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

function never(): never {
  throw new Error("not called");
}
