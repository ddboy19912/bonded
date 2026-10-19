import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { SpendingCap } from "../src/budget.js";

const mocks = vi.hoisted(() => ({ run: vi.fn(), stop: vi.fn(async () => {}) }));
vi.mock("@bonded/demo-agents", () => ({ DEFAULT_AGENT_MODEL: "test/model" }));
vi.mock("../src/env.js", () => ({ loadDotEnv: vi.fn() }));
vi.mock("../src/targets.js", () => ({ buildTarget: () => ({ name: "test-agent" }) }));
vi.mock("../src/attacks.js", () => ({
  loadAttackLibrary: () => [{ id: "A2-rotation-fill-001", goal: "Conditional task", delivery: {} }],
}));
vi.mock("../src/sandbox.js", () => ({ Sandbox: { start: async () => ({ stop: mocks.stop }) } }));
vi.mock("../src/s1.js", () => ({
  runS1Pair: mocks.run,
  S1BudgetExceeded: class extends Error {},
}));

it("persists completed pairs and failed-arm spend while retaining the error exit", async () => {
  const out = mkdtempSync(join(tmpdir(), "s1-cli-progress-"));
  const pair = {
    seed: "A2-rotation-fill-001",
    clean: { valueUsd: 50_000, tradeCount: 0 },
    manipulated: { valueUsd: 49_946, tradeCount: 1 },
    inducedLossUsd: 54,
    breached: false,
    controlBreached: false,
    changedBehavior: true,
  };
  mocks.run
    .mockImplementationOnce(async ({ budget }: { budget: SpendingCap }) => {
      budget.add({ inputTokens: 1, outputTokens: 1, costUsd: 0.01 });
      return pair;
    })
    .mockImplementationOnce(async ({ budget }: { budget: SpendingCap }) => {
      // The first pair must already be durable before this later attempt starts.
      const saved = JSON.parse(readFileSync(join(out, `${pair.seed}.json`), "utf8"));
      expect(saved.pairs).toEqual([pair]);
      budget.add({ inputTokens: 1, outputTokens: 1, costUsd: 0.02 });
      throw new Error("manipulated arm failed");
    });
  const originalArgv = process.argv;
  process.argv = ["node", "s1-cli", "--max-usd", "1", "--pairs", "2", "--out", out];
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as typeof process.exit);
  vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await import("../src/s1-cli.js");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(error).toHaveBeenCalledWith("manipulated arm failed");
    expect(mocks.stop).toHaveBeenCalledOnce();
    const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].pairCount).toBe(1);
    expect(summary.spend.spentUsd).toBeCloseTo(0.03);
  } finally {
    process.argv = originalArgv;
    vi.restoreAllMocks();
    rmSync(out, { recursive: true, force: true });
  }
});
