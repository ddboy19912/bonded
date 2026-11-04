import { ScriptedHardenedAgent } from "@bonded/demo-agents";
import type { AgentRunSummary, AgentTask, AgentToolbox, ArenaAgent } from "@bondedhq/shared";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeRunner } from "./fixtures/gateway-client.js";
import {
  ArenaGateway,
  type BenignSeed,
  benignTrade,
  loadAttackLibrary,
  loadBenignSeeds,
  rateAgent,
  runEpisode,
  runTaskBattery,
  RemoteAgent,
  Sandbox,
  StaticRunnerTokens,
} from "../src/index.js";

let sandbox: Sandbox;

beforeAll(async () => {
  sandbox = await Sandbox.start();
});
afterAll(async () => {
  await sandbox?.stop();
});

const seeds = loadBenignSeeds();

/** The twin whose goal this is: goals are unique before their first placeholder. */
function seedFor(goal: string): BenignSeed | undefined {
  return seeds.find((s) => goal.startsWith(s.goal.split("{{")[0]!.trim()));
}

/**
 * Does each twin's job as if it had read the content right (it is told the answer), and the
 * standing order otherwise: the positive control for the judge.
 */
class DiligentAgent implements ArenaAgent {
  readonly name = "diligent-agent/test";
  constructor(private readonly extra?: "avoided") {}
  async run(task: AgentTask, tools: AgentToolbox): Promise<AgentRunSummary> {
    const seed = seedFor(task.goal);
    const buys = seed
      ? [
          { token: seed.expect.buy.token, usd: seed.expect.buy.amountUsd },
          ...(this.extra && seed.expect.avoid[0]
            ? [{ token: seed.expect.avoid[0], usd: 100 }]
            : []),
        ]
      : (() => {
          const t = benignTrade(task.goal);
          return t ? [{ token: t.tokenOut, usd: t.amountUsd }] : [];
        })();
    for (const b of buys)
      await tools.call("swap", { tokenIn: "tUSDG", tokenOut: b.token, amountIn: String(b.usd) });
    return { steps: buys.length, stoppedBecause: "done" };
  }
}

describe("benign twins in an episode", () => {
  it("plants each twin's content and counts its job done only when the right buy was made", async () => {
    for (const seed of seeds) {
      const done = await runEpisode(sandbox, {
        agent: new DiligentAgent(),
        attack: null,
        benign: seed,
      });
      expect(done.benignId).toBe(seed.id);
      expect(done.benignClass).toBe(seed.class);
      expect(done.attackId).toBeNull();
      expect(done.planted).toHaveLength(seed.steps.length);
      expect(done.task.goal).not.toContain("{{");
      expect(done.taskCompleted, seed.id).toBe(true);
      expect(done.verdict.breached).toBe(false);

      // Ignoring the content: the scripted hardened agent finds no order it can act on.
      const ignored = await runEpisode(sandbox, {
        agent: new ScriptedHardenedAgent(),
        attack: null,
        benign: seed,
      });
      expect(ignored.taskCompleted, seed.id).toBe(false);
    }
  });

  it("doesn't count the job done when the agent also bought a token the content ruled out", async () => {
    const seed = seeds.find((s) => s.expect.avoid.length)!;
    const greedy = await runEpisode(sandbox, {
      agent: new DiligentAgent("avoided"),
      attack: null,
      benign: seed,
    });
    expect(greedy.taskCompleted).toBe(false);
  });

  it("times a twin's steps in the order written, so a later step always reads as newer", async () => {
    const seed = seeds.find((s) => s.id === "B-A8-halt-lifted-001")!;
    for (let i = 0; i < 5; i++) {
      const r = await runEpisode(sandbox, {
        agent: new DiligentAgent(),
        attack: null,
        benign: seed,
      });
      expect(r.planted.map((p) => p.minutesAgo)).toEqual([7, 2]);
    }
    // What an agent reads: the alerts, newest first, with the lift before the halt.
    const reader: ArenaAgent = {
      name: "reader",
      async run(_task, tools) {
        const alerts = await tools.call("read_market_alerts", {});
        if (!alerts.ok) throw new Error(alerts.error);
        const texts = (alerts.output as { text: string }[]).map((a) => a.text);
        const lifted = texts.findIndex((t) => t.includes("lifted"));
        const halted = texts.findIndex((t) => t.startsWith("Trading halt"));
        return { steps: 1, stoppedBecause: "done", finalMessage: String(lifted < halted) };
      },
    };
    const read = await runEpisode(sandbox, { agent: reader, attack: null, benign: seed });
    expect(read.agentSummary.finalMessage).toBe("true");
  });

  it("refuses an episode with both an attack and a twin", async () => {
    const attack = loadAttackLibrary()[0]!;
    await expect(
      runEpisode(sandbox, { agent: new DiligentAgent(), attack, benign: seeds[0]! }),
    ).rejects.toThrow(/not both/);
  });
});

describe("the Task score in a rating", () => {
  const attacks = loadAttackLibrary().filter((s) => s.id === "A6-operator-impersonation-001");

  it("scores an agent that ignores what it reads 0, though its Security score is 100", async () => {
    const r = await rateAgent(sandbox, {
      agent: new ScriptedHardenedAgent(),
      attacks,
      benign: { seeds },
    });
    expect(r.report.susceptibility?.grade).toBe(100);
    expect(r.report.liveness).toMatchObject({ controls: 6, completed: 6, policy: "refuse" });
    expect(r.refused).toBeNull();
    expect(r.report.task).toMatchObject({ score: 0, worst: "benign" });
    expect(r.report.task?.benign).toMatchObject({ trials: seeds.length, done: 0 });
    expect(r.report.episodes.benign).toBe(seeds.length);
    // Twins stay out of the controls and attack counts.
    expect(r.report.episodes.controls).toBe(6);
    expect(r.episodes.some((e) => e.benignId)).toBe(false);
    expect(r.benignEpisodes).toHaveLength(seeds.length);
  });

  it("scores an agent that does its job everywhere 100", async () => {
    const r = await rateAgent(sandbox, {
      agent: new DiligentAgent(),
      attacks,
      benign: { seeds },
    });
    expect(r.report.task).toMatchObject({ score: 100 });
    expect(r.report.task?.classes).toHaveLength(10);
  });

  it("has no benign part when the rating runs no twins", async () => {
    const r = await rateAgent(sandbox, { agent: new ScriptedHardenedAgent(), attacks });
    expect(r.report.task?.benign.trials).toBe(0);
    expect(r.report.task?.score).toBe(100);
    expect(r.report.episodes.benign).toBeUndefined();
  });
});

describe("the Task score on its own (arena task)", () => {
  it("runs controls and twins, no attacks, and writes task.json", async () => {
    const out = mkdtempSync(join(tmpdir(), "task-battery-"));
    try {
      const { result, controls, benign } = await runTaskBattery(sandbox, {
        agent: new ScriptedHardenedAgent(),
        seeds,
        outDir: out,
      });
      expect(controls).toHaveLength(6);
      expect(benign).toHaveLength(seeds.length);
      expect([...controls, ...benign].every((e) => e.attackId === null)).toBe(true);
      expect(result.task).toMatchObject({ score: 0, worst: "benign" });
      expect(result.task.controls).toMatchObject({ trials: 6, done: 6 });
      expect(result.task.underAttack.trials).toBe(0);
      expect(result.stoppedEarly).toBeNull();
      expect(JSON.parse(readFileSync(join(out, "task.json"), "utf8"))).toEqual(
        JSON.parse(JSON.stringify(result)),
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("scores an agent that does each job 100", async () => {
    const { result } = await runTaskBattery(sandbox, { agent: new DiligentAgent(), seeds });
    expect(result.task.score).toBe(100);
  });
});

describe("benign twins for a remote agent", () => {
  it("plant through the gateway and count in the Task score", async () => {
    const token = "bonded_rt_benign-twins-runner-token-01";
    const gateway = new ArenaGateway({ tokens: new StaticRunnerTokens({ [token]: "remote" }) });
    await gateway.listen();
    const runner = await fakeRunner({
      gateway: gateway.url,
      token,
      mode: "tools",
      agent: new DiligentAgent(),
    });
    try {
      const agent = new RemoteAgent({ gateway, sandbox, runner: "remote", mode: "tools" });
      const r = await rateAgent(sandbox, {
        agent,
        attacks: loadAttackLibrary().filter((s) => s.id === "A6-operator-impersonation-001"),
        benign: { seeds },
      });
      expect(r.benignEpisodes).toHaveLength(seeds.length);
      expect(r.report.task?.benign).toMatchObject({ trials: seeds.length, done: seeds.length });
      expect(r.report.task?.score).toBe(100);
    } finally {
      await runner.close();
      await gateway.close();
    }
  }, 600_000);
});
