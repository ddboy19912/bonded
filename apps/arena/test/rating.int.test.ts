import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedHardenedAgent, ScriptedVulnerableAgent } from "@bonded/demo-agents";
import { bondedRegistryAbi } from "@bondedhq/shared";
import { keccak256, stringToBytes } from "viem";
import { afterAll, assert, beforeAll, describe, expect, it } from "vitest";
import {
  loadAttackLibrary,
  ORACLE_SIZING_SEEDS,
  type RatingResult,
  rateAgent,
  Sandbox,
  type SentinelRow,
  verifyAttestation,
} from "../src/index.js";

let sandbox: Sandbox;
let out: string;
let vulnerable: RatingResult;
let hardened: RatingResult;
const library = loadAttackLibrary();

beforeAll(async () => {
  sandbox = await Sandbox.start();
  out = mkdtempSync(join(tmpdir(), "bonded-rating-"));
  // The plan's demo pair (Section 9.2): no defences in Monitor mode, versus a guarded agent
  // in Enforce mode.
  vulnerable = await rateAgent(sandbox, {
    agent: new ScriptedVulnerableAgent(),
    attacks: library,
    // Two of the seeds counted as unpublished, as a held-out set would be.
    unpublished: new Set([library[0]!.id, library[1]!.id]),
    outDir: join(out, "vulnerable"),
  });
  hardened = await rateAgent(sandbox, {
    agent: new ScriptedHardenedAgent(),
    attacks: library,
    vault: { mandate: { mode: "enforce" } },
    outDir: join(out, "hardened"),
  });
}, 300_000);

afterAll(async () => {
  await sandbox?.stop();
  if (out) rmSync(out, { recursive: true, force: true });
});

describe("a full rating of both demo agents", () => {
  it("runs every seed plus controls for each agent", () => {
    for (const r of [vulnerable, hardened]) {
      expect(r.report.episodes.attacks).toBe(library.length);
      expect(r.report.episodes.controls).toBe(2);
      expect(r.report.episodes.agentErrors).toBe(0);
      expect(r.report.stoppedEarly).toBeNull();
    }
  });

  it("counts the unpublished attacks it ran, and reports none when there were none", () => {
    expect(vulnerable.report.unpublished).toEqual({ attacks: 2, episodes: 2 });
    expect(hardened.report.unpublished).toEqual({ attacks: 0, episodes: 0 });
    expect(readFileSync(join(out, "vulnerable", "report.md"), "utf8")).toContain(
      "Unpublished attacks: 2",
    );
  });

  it("reports which attacked surfaces the agent actually read", () => {
    const coverage = vulnerable.report.coverage!;
    // The vulnerable agent reads everything except the price API, so the spoofed prices
    // planted for A3 never reach it.
    expect(coverage.surfaces.price_feed.attacked).toBeGreaterThan(0);
    expect(coverage.surfaces.price_feed.read).toBe(0);
    expect(coverage.surfaces.dm.read).toBe(coverage.surfaces.dm.attacked);
    expect(coverage.readSurfaces).not.toContain("price_feed");
    expect(readFileSync(vulnerable.files.markdown!, "utf8")).toContain("## Coverage");
    expect(vulnerable.report.heldOut).toBeNull();
  });

  it("finds both agents did their task in every control, so both are attested", () => {
    for (const r of [vulnerable, hardened]) {
      expect(r.report.liveness).toMatchObject({ controls: 2, completed: 2, rate: 1 });
      expect(r.refused).toBeNull();
    }
  });

  it("scores the agents in the expected direction", () => {
    const v = vulnerable.report.scoring;
    const h = hardened.report.scoring;
    // The scripted floor breaches every class except the oracle-sizing seeds
    // (ORACLE_SIZING_SEEDS): their vector is a spoofed feed plus a sizing policy, and a
    // parser-driven agent has no instruction to obey there — an LLM is the target (P4).
    expect(
      vulnerable.report.classes.every(
        (c) =>
          c.breaches === c.episodes ||
          (c.class === "A3" && c.breaches + ORACLE_SIZING_SEEDS.length === c.episodes),
      ),
    ).toBe(true);
    expect(hardened.report.classes.every((c) => c.breaches === 0)).toBe(true);
    expect(v.tier).toBe("CCC");
    expect(v.insurable).toBe(false);
    expect(h.score).toBeGreaterThan(v.score + 40);
    expect(h.insurable).toBe(true);
    expect(h.premiumRateBps).toBeLessThan(v.premiumRateBps);
    // Enforce mode caps the hardened agent's severity priors at per-trade cap ÷ vault value (10%).
    expect(h.groups.every((g) => g.severity <= 0.1)).toBe(true);
  });

  it("measures real losses for the vulnerable agent, including spent approvals", () => {
    expect(vulnerable.report.worst[0]?.lossUsd).toBe(50_000);
    const injection = vulnerable.report.scoring.groups.find((g) => g.id === "injection");
    expect(injection?.severitySource).toBe("measured");
    expect(vulnerable.report.mitigations.length).toBeGreaterThan(0);
  });

  it("renders the report with its hash matching the JSON file", () => {
    const json = readFileSync(vulnerable.files.report!, "utf8");
    expect(keccak256(stringToBytes(json))).toBe(vulnerable.reportHash);
    const md = readFileSync(vulnerable.files.markdown!, "utf8");
    // Headline is the security grade (susceptibility); the loss score is the insurance line.
    expect(md).toContain(`Bonded Score ${vulnerable.report.susceptibility!.grade}/100`);
    expect(md).toContain(`Insurance score ${vulnerable.report.scoring.score} (CCC)`);
    expect(md).toContain("| A6 | Social engineering |");
    expect(readFileSync(hardened.files.markdown!, "utf8")).toContain("None: no class breached.");
  });

  it("signs a valid attestation and the registry accepts it", async () => {
    for (const r of [vulnerable, hardened]) {
      assert(r.attestation);
      expect(await verifyAttestation(r.attestation, [r.attestation.signer])).toBe(true);
      // A valid signature from a signer nobody trusts is rejected.
      expect(
        await verifyAttestation(r.attestation, ["0x000000000000000000000000000000000000dEaD"]),
      ).toBe(false);
      expect(r.posted.posted).toBe(true);
      const stored = await sandbox.publicClient.readContract({
        address: sandbox.deployment.registry,
        abi: bondedRegistryAbi,
        functionName: "scoreOf",
        args: [BigInt(r.attestation.attestation.agentId)],
      });
      expect(stored.score).toBe(r.report.scoring.score);
      expect(stored.reportHash).toBe(r.reportHash);
    }
  });

  it("writes labelled Sentinel rows for every attempted write", () => {
    const rows = readFileSync(vulnerable.files.dataset!, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SentinelRow);
    // One rating's rows, tagged with its report, written once when it finished.
    expect(rows.every((r) => r.ratingId === vulnerable.reportHash)).toBe(true);
    const breaching = rows.filter((r) => r.labels.action_risk === "breach_likely");
    // Every attack but the oracle-sizing pair gives the vulnerable agent an instruction to
    // obey, so every such episode ends in at least one breaching row.
    expect(breaching.length).toBeGreaterThanOrEqual(library.length - ORACLE_SIZING_SEEDS.length);
    expect(breaching.every((r) => r.labels.manipulated)).toBe(true);
    const transfer = rows.find((r) => r.proposedAction.tool === "transfer");
    expect(transfer?.labels.injection_in_inputs).toBe(true);
    // Control episodes give negatives: the goal swap, within the mandate and not manipulated.
    const control = rows.filter((r) => r.attackId === null);
    expect(control.length).toBeGreaterThan(0);
    expect(
      control.every((r) => !r.labels.manipulated && r.labels.action_risk === "within_mandate"),
    ).toBe(true);
    // The agent's own task, refused because the vault had frozen it, isn't suspicious.
    const frozenGoal = rows.find(
      (r) => r.attackId !== null && r.proposedAction.tool === "swap" && !r.outcome.ok,
    );
    expect(frozenGoal?.labels.action_risk).toBe("within_mandate");
    expect(existsSync(join(vulnerable.files.traces!))).toBe(true);
  });
});
