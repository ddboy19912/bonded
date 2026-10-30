import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ChatClient } from "@bondedhq/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { loadAttackLibrary } from "../src/attacks.js";
import {
  assertHeldOutOffMetaApi,
  HeldOutToMetaError,
  metaApiModels,
} from "../src/held-out-guard.js";
import { generateHeldOut, heldOutId, isHeldOutSpec } from "../src/held-out.js";
import { checkHeldOut, type RefreshPlan } from "../src/leaderboard-refresh.js";
import { draftHeldOut, isHeldOutSetDir } from "../src/offchain/held-out.js";
import { loadOffchainSeeds } from "../src/offchain/seeds.js";
import type { Sandbox } from "../src/sandbox.js";

const run = promisify(execFile);
const META_REFUSAL = /never go to Meta Model API/;

/** A client that fails the test if it is ever called. */
function untouchedClient() {
  const complete = vi.fn(async () => {
    throw new Error("a model was called");
  });
  return { client: { complete } as unknown as ChatClient, complete };
}

const dirs: string[] = [];
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("held-out attacks never go to Meta Model API", () => {
  it("refuses a muse-* model in any role and names it", () => {
    expect(() =>
      assertHeldOutOffMetaApi([
        { role: "the agent", model: "deepseek/deepseek-v4.1-flash" },
        { role: "O6's counterparty", model: "muse-spark-1.3" },
      ]),
    ).toThrow(HeldOutToMetaError);
    expect(() =>
      assertHeldOutOffMetaApi([{ role: "the attacker", model: "muse-wonder-1.0" }]),
    ).toThrow(/the attacker \(muse-wonder-1\.0\)/);
  });

  it("allows other providers, Muse Spark Open on Baseten, and roles with no model", () => {
    const allowed = [
      { role: "the agent", model: "deepseek/deepseek-v4.1-flash" },
      { role: "the agent", model: "meta-models/muse-spark-open" },
      { role: "the agent", model: "meta-llama/llama-4-maverick" },
      { role: "the Sentinel guard", model: undefined },
    ];
    expect(metaApiModels(allowed)).toEqual([]);
    expect(() => assertHeldOutOffMetaApi(allowed)).not.toThrow();
  });

  it("the on-chain drafter refuses a Meta model before calling it", async () => {
    const { client, complete } = untouchedClient();
    const library = loadAttackLibrary();
    await expect(
      generateHeldOut({
        client,
        model: "muse-spark-1.3",
        sandbox: {} as Sandbox,
        library,
        seeds: library.slice(0, 1),
        perClass: 1,
        maxUsd: 1,
      }),
    ).rejects.toThrow(META_REFUSAL);
    expect(complete).not.toHaveBeenCalled();
  });

  it("the off-chain drafter refuses a Meta model before calling it or writing the set", async () => {
    const { client, complete } = untouchedClient();
    const dir = join(tempDir("held-out-guard-"), "set");
    await expect(
      draftHeldOut({
        seeds: loadOffchainSeeds().slice(0, 1),
        perSeed: 1,
        client,
        model: "muse-spark-1.3",
        dir,
      }),
    ).rejects.toThrow(META_REFUSAL);
    expect(complete).not.toHaveBeenCalled();
    expect(existsSync(dir)).toBe(false);
  });

  it("a leaderboard refresh with a held-out set refuses a Meta model before rating anything", () => {
    const job = (slug: string, model: string | null, action: "rate" | "skip") =>
      ({
        entry: { slug },
        target: { agent: "hardened", brain: model ? "llm" : "scripted", model },
        dir: slug,
        action,
        estimateUsd: 0,
      }) as unknown as RefreshPlan["jobs"][number];
    const plan = (jobs: RefreshPlan["jobs"]): RefreshPlan => ({
      runDir: "run",
      jobs,
      spentUsd: 0,
      estimateUsd: 0,
    });
    const withMuse = plan([
      job("a", "deepseek/deepseek-v4.1-flash", "rate"),
      job("b", "muse-spark-1.3", "rate"),
    ]);
    expect(() => checkHeldOut(withMuse, "/held-out", false)).toThrow(
      /b's agent \(muse-spark-1\.3\)/,
    );
    // Without a held-out set, or when the Meta entry isn't re-rated, nothing is refused.
    expect(() => checkHeldOut(withMuse, null, true)).not.toThrow();
    expect(() =>
      checkHeldOut(plan([job("b", "muse-spark-1.3", "skip")]), "/held-out", false),
    ).not.toThrow();
  });

  it("knows a held-out attack and a held-out directory", () => {
    const spec = loadAttackLibrary()[0]!;
    expect(isHeldOutSpec(spec)).toBe(false);
    expect(isHeldOutSpec({ ...spec, id: heldOutId(spec.class, "x") })).toBe(true);
    expect(isHeldOutSpec({ ...spec, tags: ["held-out"] })).toBe(true);
    const dir = tempDir("held-out-dir-");
    expect(isHeldOutSetDir(dir)).toBe(false);
    writeFileSync(join(dir, "ledger.txt"), "");
    expect(isHeldOutSetDir(dir)).toBe(true);
  });
});

// The CLIs, built: each refuses before reading a key, starting a sandbox or calling a model.
describe("the CLIs refuse a held-out run on a Meta model", () => {
  // No Meta key, so a refusal that came after the key check would name the key instead.
  const env = { ...process.env, MODEL_API_KEY: "", OPENROUTER_API_KEY: "test-only" };
  const refused = { code: 1, stderr: expect.stringMatching(META_REFUSAL) };

  it("off-chain: --held-out, --draft-held-out and a held-out --replay", async () => {
    const cli = "dist/offchain/cli.js";
    const dir = tempDir("held-out-offchain-");
    const base = [cli, "--max-usd", "1", "--seeds", "O1-sms-001"];
    await expect(
      run(process.execPath, [...base, "--held-out", dir, "--model", "muse-spark-1.3"], {
        env,
        timeout: 30_000,
      }),
    ).rejects.toMatchObject(refused);
    await expect(
      run(
        process.execPath,
        [
          ...base,
          "--draft-held-out",
          "1",
          "--draft-only",
          "--held-out",
          dir,
          "--generator-model",
          "muse-spark-1.3",
        ],
        { env, timeout: 30_000 },
      ),
    ).rejects.toMatchObject(refused);
    await expect(
      run(
        process.execPath,
        [...base, "--held-out", dir, "--counterparty-model", "muse-spark-1.3"],
        { env, timeout: 30_000 },
      ),
    ).rejects.toMatchObject(refused);
    writeFileSync(join(dir, "spent.txt"), "");
    await expect(
      run(process.execPath, [...base, "--replay", dir, "--model", "muse-spark-1.3"], {
        env,
        timeout: 30_000,
      }),
    ).rejects.toMatchObject(refused);
  });

  it("on-chain: a rating with --held-out, and heldout:generate", async () => {
    const dir = tempDir("held-out-onchain-");
    const spec = loadAttackLibrary()[0]!;
    const held = { ...spec, id: heldOutId(spec.class, "guard test"), tags: ["held-out"] };
    writeFileSync(join(dir, `${held.id}.yaml`), stringify(held));
    await expect(
      run(
        process.execPath,
        ["dist/cli.js", "rate", "--brain", "llm", "--model", "muse-spark-1.3", "--held-out", dir],
        { env, timeout: 30_000 },
      ),
    ).rejects.toMatchObject(refused);
    await expect(
      run(
        process.execPath,
        ["dist/held-out-cli.js", "--max-usd", "1", "--model", "muse-spark-1.3", "--out", dir],
        { env, timeout: 30_000 },
      ),
    ).rejects.toMatchObject(refused);
  });
});
