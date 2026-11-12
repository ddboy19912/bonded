import { ScriptedVulnerableAgent } from "@bonded/demo-agents";
import { mandateVaultAbi } from "@bondedhq/shared";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  AgentUrlUnavailableError,
  ArenaGateway,
  episodeOutcome,
  loadAttackLibrary,
  rateAgent,
  type RatingProgress,
  RemoteAgent,
  type RemoteRunSummary,
  runEpisode,
  Sandbox,
  StaticRunnerTokens,
} from "../src/index.js";
import { eventually, type FakeRunner, fakeRunner } from "./fixtures/gateway-client.js";
import { paritySeeds, verdictOf } from "./fixtures/parity.js";
import { OWNER, TEST_SIGNER } from "./fixtures/agent-url-keys.js";
import { type UrlAgent, urlAgent } from "./fixtures/url-agent.js";

/**
 * Agent URL mode end to end: the gateway POSTs signed episodes to an agent's own HTTP endpoint,
 * the agent works through the episode's endpoints, and the result is judged like any other.
 */
const TOKEN = "bonded_rt_url-parity-runner-token-0001";

let sandbox: Sandbox;
let gateway: ArenaGateway;
const cleanup: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  sandbox = await Sandbox.start();
  gateway = new ArenaGateway({
    tokens: new StaticRunnerTokens({ [TOKEN]: "runner-agent" }),
    // The agent URLs here are on this machine.
    // The agent URLs here are all on this machine, so they share one host's rate limit.
    agentUrl: {
      allowLoopback: true,
      signer: TEST_SIGNER,
      limits: {
        callsPerMinute: 10_000,
        callBurst: 1_000,
        verifiesPerMinute: 10_000,
        verifyBurst: 1_000,
      },
    },
  });
  await gateway.listen();
});
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
afterAll(async () => {
  await gateway?.close();
  await sandbox?.stop();
});

async function agentAt(options: Parameters<typeof urlAgent>[0]): Promise<UrlAgent> {
  const agent = await urlAgent(options);
  cleanup.push(() => agent.close());
  return agent;
}

const remote = (url: string, fields: Partial<ConstructorParameters<typeof RemoteAgent>[0]> = {}) =>
  new RemoteAgent({
    gateway,
    sandbox,
    transport: { kind: "url", url, owner: OWNER, registration: url },
    mode: "tools",
    ...fields,
  });

const spec = () => loadAttackLibrary().find((s) => s.id === "A6-operator-impersonation-001")!;

describe("Agent URL episodes", () => {
  it("POSTs the signed episode, and judges what the agent did from the vault", async () => {
    const at = await agentAt({ agent: new ScriptedVulnerableAgent() });
    const agent = remote(at.url);
    expect(agent.name).toBe("remote/127.0.0.1");
    const result = await runEpisode(sandbox, { agent, attack: spec() });
    expect(result.verdict.breached).toBe(true);
    expect(result.agentSummary.stoppedBecause).toBe("done");
    expect(at.refused).toBe(0);
    const sent = at.received[0]!;
    expect(sent).toMatchObject({ type: "episode", mode: "tools" });
    // The body is the runner's episode message: nothing about the attack.
    expect(JSON.stringify(sent)).not.toMatch(/"A6"|attack|impersonation/i);
    const record = (result.agentSummary as RemoteRunSummary).remote;
    expect(record).toMatchObject({ transport: "url", exitCode: null });
    expect(record.reads.dm).toBe(1);
  });

  it("fails the episode, as the agent's failure, when the POST fails", async () => {
    const at = await agentAt({ episodeStatus: 500 });
    const result = await runEpisode(sandbox, { agent: remote(at.url), attack: null });
    expect(episodeOutcome(result)).toBe("agent_error");
    expect(result.agentSummary.finalMessage).toBe("the agent's URL failed: Your URL answered 500");
    expect((result.agentSummary as RemoteRunSummary).remote.urlProblem).toBe(
      "Your URL answered 500",
    );
    // Nothing reached the agent's tools.
    expect(result.trace).toHaveLength(0);
    // A URL that refuses to connect fails the same way, at once.
    const closed = await runEpisode(sandbox, {
      agent: remote("http://127.0.0.1:1/agent"),
      attack: null,
    });
    expect(closed.agentSummary.finalMessage).toBe(
      "the agent's URL failed: Nothing accepted a connection at your URL",
    );
  });

  it("refuses a URL that isn't allowed without calling it", async () => {
    const result = await runEpisode(sandbox, {
      agent: remote(`${gateway.url}/healthz`),
      attack: null,
    });
    expect(result.agentSummary.finalMessage).toBe(
      "the agent's URL failed: Your URL is one of Bonded's own addresses",
    );
  });

  it("starts the deadline once the episode is delivered, not before", async () => {
    // The agent takes 1.5 s to answer, then finishes at once: within a 1 s deadline counted from
    // its answer, though not from the POST.
    const at = await agentAt({
      answerDelayMs: 1_500,
      onEpisode: async (episode) => {
        await fetch(`${episode.endpoints.tools}/read_inbox`, { method: "POST" });
        await fetch(episode.endpoints.done, { method: "POST" });
      },
    });
    const result = await runEpisode(sandbox, {
      agent: remote(at.url, { episodeTimeoutMs: 1_000 }),
      attack: null,
    });
    expect(result.agentSummary.stoppedBecause).toBe("done");
  });

  it("cancels an agent that runs out of time", async () => {
    const at = await agentAt({ onEpisode: () => {} });
    const result = await runEpisode(sandbox, {
      agent: remote(at.url, { episodeTimeoutMs: 800 }),
      attack: null,
    });
    expect(result.agentSummary).toMatchObject({
      stoppedBecause: "error",
      finalMessage: "timed out after 800 ms",
    });
    const episodeId = (result.agentSummary as RemoteRunSummary).remote.episodeId;
    await eventually(() => at.cancels.includes(episodeId));
  });

  it("works in chain mode: the session key travels in the signed body", async () => {
    const at = await agentAt({
      agent: new ScriptedVulnerableAgent(),
      transport: "chain",
    });
    const agent = remote(at.url, { mode: "chain" });
    const local = await runEpisode(sandbox, {
      agent: new ScriptedVulnerableAgent(),
      attack: spec(),
    });
    const through = await runEpisode(sandbox, { agent, attack: spec() });
    expect(verdictOf(through)).toEqual(verdictOf(local));
    const sent = at.received.find((m) => m.type === "episode")!;
    const key = sent.type === "episode" && sent.world !== "brokerage" ? sent.sessionKey : undefined;
    expect(key).toMatch(/^0x[0-9a-f]{64}$/);
    const vaultAgent = await sandbox.publicClient.readContract({
      address: through.vault,
      abi: mandateVaultAbi,
      functionName: "agent",
    });
    expect(vaultAgent).toBe(privateKeyToAccount(key!).address);
  });

  it("can't be used with a TEE (the runner fetches TEE evidence)", () => {
    expect(
      () =>
        new RemoteAgent({
          gateway,
          sandbox,
          transport: {
            kind: "url",
            url: "https://a.example",
            owner: OWNER,
            registration: "a",
          },
          mode: "tools",
          tee: { onEvidence: () => {} },
        }),
    ).toThrow(/through the runner/);
  });
});

describe("when Bonded's own rate limit is in the way", () => {
  it("doesn't count it against the agent: the rating stops as Bonded's problem", async () => {
    const tight = new ArenaGateway({
      tokens: new StaticRunnerTokens(),
      agentUrl: {
        allowLoopback: true,
        signer: TEST_SIGNER,
        limits: { callsPerMinute: 0.001, callBurst: 1, slotWaitMs: 100 },
      },
    });
    await tight.listen();
    cleanup.push(() => tight.close());
    const at = await agentAt({ agent: new ScriptedVulnerableAgent() });
    const transport = { kind: "url", url: at.url, owner: OWNER, registration: "busy" } as const;
    // Its one call a minute is spent.
    await tight.agentUrls.send(
      at.url,
      OWNER,
      { type: "cancel", episodeId: "x" },
      { registration: "busy" },
    );
    const agent = new RemoteAgent({ gateway: tight, sandbox, transport, mode: "tools" });
    const episode = await runEpisode(sandbox, { agent, attack: null });
    const record = (episode.agentSummary as RemoteRunSummary).remote;
    expect(record.bondedProblem).toMatch(/too often/);
    expect(record.urlProblem).toBeUndefined();
    expect(episode.agentSummary.finalMessage).toMatch(/not the agent's fault/);
    expect(at.received.filter((m) => m.type === "episode")).toHaveLength(0);
    await expect(
      rateAgent(sandbox, { agent, attacks: paritySeeds().slice(0, 1), controls: 0 }),
    ).rejects.toBeInstanceOf(AgentUrlUnavailableError);
    // Another registration on the same host is unaffected.
    const other = new RemoteAgent({
      gateway: tight,
      sandbox,
      transport: { ...transport, registration: "other" },
      mode: "tools",
    });
    const fine = await runEpisode(sandbox, { agent: other, attack: null });
    expect(fine.agentSummary.stoppedBecause).toBe("done");
  });
});

describe("a rating through an Agent URL", () => {
  let runner: FakeRunner;
  beforeAll(async () => {
    runner = await fakeRunner({
      gateway: gateway.url,
      token: TOKEN,
      mode: "tools",
      transport: "http",
      agent: new ScriptedVulnerableAgent(),
    });
    await eventually(() => gateway.runner("runner-agent") !== undefined);
  });
  afterAll(async () => {
    await runner?.close();
  });

  it("gets the runner's verdicts, episode by episode, and reports only progress counts", async () => {
    const at = await agentAt({ agent: new ScriptedVulnerableAgent() });
    const attacks = paritySeeds().slice(0, 3);
    const settings = { attacks, controls: 1, shuffle: false } as const;
    const progress: RatingProgress[] = [];
    const viaUrl = await rateAgent(sandbox, {
      agent: remote(at.url),
      ...settings,
      onProgress: (p) => void progress.push(p),
    });
    const viaRunner = await rateAgent(sandbox, {
      agent: new RemoteAgent({ gateway, sandbox, runner: "runner-agent", mode: "tools" }),
      ...settings,
    });
    const verdicts = (r: typeof viaUrl) =>
      r.episodes.map((e) => [e.attackId, verdictOf(e), e.taskCompleted]);
    expect(verdicts(viaUrl)).toEqual(verdicts(viaRunner));
    expect(viaUrl.report.scoring.score).toBe(viaRunner.report.scoring.score);
    expect(viaUrl.report.coverage).toEqual(viaRunner.report.coverage);

    // Progress: counts and an ETA, nothing else.
    const total = attacks.length + 1;
    expect(progress.map((p) => p.done)).toEqual([...Array(total + 1).keys()]);
    for (const p of progress) {
      expect(Object.keys(p).sort()).toEqual(["done", "etaSeconds", "startedAt", "total"]);
      expect(p.total).toBe(total);
    }
    expect(progress[0]!.etaSeconds).toBeNull();
    expect(progress.at(-1)!.etaSeconds).toBe(0);
    expect(progress[1]!.etaSeconds).toBeGreaterThanOrEqual(0);
  });
});
