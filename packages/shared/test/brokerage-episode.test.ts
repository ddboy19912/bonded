import { describe, expect, it } from "vitest";
import {
  AgentUrlMessage,
  type BrokerageEpisodeMessage,
  episodeEnv,
  episodeWorld,
  HelloMessage,
  parseBrokerageEpisodeEnv,
  parseEpisodeEnv,
  parseRunnerMessage,
  runnerProtocolFor,
  ServerToRunner,
} from "../src/index.js";

const brokerage: BrokerageEpisodeMessage = {
  type: "episode",
  world: "brokerage",
  episodeId: "ep-b1",
  task: { goal: "Do this week's run.", mandate: "You manage Dana's account.", maxSteps: 40 },
  mode: "tools",
  endpoints: {
    mcp: "https://gw.example/e/tok/mcp",
    tools: "https://gw.example/e/tok/tools",
    openapi: "https://gw.example/e/tok/openapi.json",
    done: "https://gw.example/e/tok/done",
  },
  deadlineMs: 60_000,
};

describe("brokerage episodes (runner protocol 2)", () => {
  it("parses as a server message and an agent URL message, with no chain fields", () => {
    const parsed = parseRunnerMessage(ServerToRunner, JSON.stringify(brokerage));
    expect(parsed).toEqual(brokerage);
    expect(parsed && episodeWorld(parsed as { world?: "vault" | "brokerage" })).toBe("brokerage");
    expect(AgentUrlMessage.safeParse(brokerage).success).toBe(true);
  });

  it("is refused in chain mode", () => {
    const chain = { ...brokerage, mode: "chain" };
    expect(parseRunnerMessage(ServerToRunner, JSON.stringify(chain))).toBeUndefined();
  });

  it("reads a vault episode with no world as before", () => {
    const vault = {
      ...brokerage,
      world: undefined,
      chainId: 46630,
      vault: "0x00000000000000000000000000000000000000aa",
      contracts: { exchange: "0x4444444444444444444444444444444444444444", tokens: [] },
    };
    const parsed = parseRunnerMessage(ServerToRunner, JSON.stringify(vault));
    expect(parsed).toMatchObject({ type: "episode", chainId: 46630 });
    expect(episodeWorld(parsed as { world?: "vault" })).toBe("vault");
  });

  it("puts only the brokerage variables in the environment, and reads them back", () => {
    const env = episodeEnv(brokerage);
    expect(env.BONDED_WORLD).toBe("brokerage");
    expect(env).not.toHaveProperty("BONDED_VAULT");
    expect(env).not.toHaveProperty("BONDED_CHAIN_ID");
    const read = parseBrokerageEpisodeEnv(env);
    expect(read).toEqual({
      ok: true,
      episode: {
        world: "brokerage",
        episodeId: "ep-b1",
        task: brokerage.task,
        mode: "tools",
        endpoints: brokerage.endpoints,
        deadlineMs: 60_000,
      },
    });
  });

  it("keeps the task's tool list through the runner, an agent URL and the environment", () => {
    const withTools: BrokerageEpisodeMessage = {
      ...brokerage,
      task: { ...brokerage.task, tools: ["get_account", "place_order"] },
    };
    const tools = ["get_account", "place_order"];
    expect(parseRunnerMessage(ServerToRunner, JSON.stringify(withTools))).toMatchObject({
      task: { tools },
    });
    expect(AgentUrlMessage.parse(withTools)).toMatchObject({ task: { tools } });
    const read = parseBrokerageEpisodeEnv(episodeEnv(withTools));
    expect(read.ok && read.episode.task.tools).toEqual(tools);
    // A vault episode's task keeps it too.
    const vault = {
      ...withTools,
      world: undefined,
      chainId: 46630,
      vault: "0x00000000000000000000000000000000000000aa",
      contracts: { exchange: "0x4444444444444444444444444444444444444444", tokens: [] },
    };
    expect(parseRunnerMessage(ServerToRunner, JSON.stringify(vault))).toMatchObject({
      task: { tools },
    });
  });

  it("has a runner say the oldest protocol its world needs, and name a world that isn't vault", () => {
    expect(runnerProtocolFor("vault")).toBe(1);
    expect(runnerProtocolFor("brokerage")).toBe(2);
    const hello = { type: "hello", runnerVersion: "0.2.0", protocol: 2, mode: "tools" };
    expect(HelloMessage.parse({ ...hello, world: "brokerage" }).world).toBe("brokerage");
    // A protocol 1 runner names no world: it is a vault-world runner.
    expect(HelloMessage.parse({ ...hello, protocol: 1 }).world).toBeUndefined();
    expect(HelloMessage.safeParse({ ...hello, world: "casino" }).success).toBe(false);
  });

  it("isn't mistaken for a vault episode", () => {
    const parsed = parseEpisodeEnv(episodeEnv(brokerage));
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems[0]).toMatch(/brokerage episode/);
  });
});
