import { describe, expect, it } from "vitest";
import { loadBondedIndex, reproduceCapUsd, reproduceCommand, reproduceKeys } from "./bonded-index";

describe("reproducing an Index row", () => {
  it("names the keys each provider needs; every rerun needs OpenRouter for the counterparty", () => {
    expect(reproduceKeys("qwen/qwen3.7-flash")).toEqual(["OPENROUTER_API_KEY"]);
    expect(reproduceKeys("muse-spark-1.3")).toEqual(["OPENROUTER_API_KEY", "MODEL_API_KEY"]);
    expect(reproduceKeys("meta-models/muse-spark-open")).toEqual([
      "OPENROUTER_API_KEY",
      "BASETEN_API_KEY",
    ]);
    expect(reproduceKeys("claude-sonnet-5-5")).toEqual(["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"]);
  });

  it("gives every committed row a command for its own model, with a cap", () => {
    for (const e of loadBondedIndex().entries) {
      const lines = reproduceCommand(e).split("\n");
      expect(lines[0]).toBe("git clone https://github.com/ddboy19912/bonded && cd bonded");
      expect(lines[1]).toBe('pnpm install && pnpm --filter "@bonded/arena..." build');
      expect(lines[2]).toBe(
        `node apps/arena/dist/offchain/index-cli.js --models ${e.model} --max-usd ${reproduceCapUsd(e)}`,
      );
      expect(reproduceCapUsd(e)).toBeGreaterThanOrEqual(Math.max(2, e.cost.spentUsd));
    }
  });

  it("keeps a row's own run count when it isn't the default 3", () => {
    const e = loadBondedIndex().entries[0]!;
    expect(reproduceCommand({ ...e, runsPerScenario: 15 })).toMatch(/ --runs 15$/);
  });
});
