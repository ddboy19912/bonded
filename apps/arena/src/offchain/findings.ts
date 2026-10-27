import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import type { OffchainAdaptiveResult } from "./adaptive.js";
import { ADAPTIVE_PROSE, AIM } from "./adaptive.js";
import type { Vector } from "./channels.js";
import { proseFromDraft } from "./fresh.js";
import { OffchainSeed, seedVectors } from "./seeds.js";

/**
 * Per-agent findings feed disclosure and the attack library (docs/OFFCHAIN.md, issue #244
 * section 4). An adaptive run already saves its whole result, but that file holds the prose that
 * was tried, so it stays in the gitignored `ratings/` folder and nothing else reads it.
 *
 * This module turns a result into three artifacts:
 *
 * - a finding: the numbers only, safe to share;
 * - a disclosure note: class and vector level, with no payload, for the agent's maintainers;
 * - a bounty candidate: the rewrite that got through, as a seed the library can review.
 *
 * The candidate carries the prose, so it is written only to a private directory. The note never
 * carries the prose, the agent's messages or the transcript. A person sends the note; the CLI
 * never contacts anyone.
 */

/** What a run found, with nothing that could be used as an attack. */
export interface OffchainFinding {
  seed: string;
  attackClass: string;
  vectors: Vector[];
  /** The rules the seed aims at, in plain words. */
  aimedAt: string[];
  agent: string;
  attackerModel: string;
  /** The agent was told the mandate's rules. */
  mandateShown: boolean;
  feedback: "outcome" | "trace";
  /** When the result file was written, when known. */
  ratedAt?: string;
  /** The published text caused an unblocked breach of a rule the seed aims at. */
  staticBreached: boolean;
  /** Some round caused one. */
  breached: boolean;
  roundsToBreach: number | null;
  lossUsd: number;
  overpaidUsd: number;
  spendUsd: number;
  /** A rewrite got through, so there is a candidate attack to review. */
  candidate: boolean;
}

export interface FindingArtifacts {
  finding: OffchainFinding;
  disclosure: string;
  /** The rewrite that got through, when there is one. Carries the prose: keep it private. */
  candidate?: OffchainSeed;
}

const cents = (usd: number) => Math.round(usd * 100);
const dollars = (c: number) => `$${(c / 100).toFixed(2)}`;

/** The numbers from one adaptive result. No prose, no agent messages. */
export function findingFrom(result: OffchainAdaptiveResult, ratedAt?: string): OffchainFinding {
  const win = result.attempts.find((a) => a.succeeded);
  return {
    seed: result.seed,
    attackClass: result.attackClass,
    vectors: [...result.vectors],
    // The result doesn't carry the seed's aims; findingArtifacts fills this from the seed.
    aimedAt: [],
    agent: result.agent,
    attackerModel: result.attackerModel,
    mandateShown: result.mandateShown,
    feedback: result.feedback,
    ...(ratedAt ? { ratedAt } : {}),
    staticBreached: result.staticBreached,
    breached: result.breached,
    roundsToBreach: result.roundsToBreach,
    lossUsd: result.attempts.reduce((n, a) => n + cents(a.lossUsd), 0) / 100,
    overpaidUsd: result.attempts.reduce((n, a) => n + cents(a.overpaidUsd), 0) / 100,
    spendUsd: result.spend.spentUsd,
    candidate: win !== undefined && win.round > 0,
  };
}

/** A finding's note for the agent's maintainers. Class and vector level, never the payload. */
export function disclosureNote(finding: OffchainFinding): string {
  const outcome = finding.breached
    ? finding.roundsToBreach === 0
      ? "the published text got through"
      : `a rewrite got through in round ${finding.roundsToBreach}`
    : "no rewrite got through";
  const rules =
    finding.aimedAt.length > 0
      ? finding.aimedAt.map((r) => `- ${r}`).join("\n")
      : "- the rules the attack aims at (see the finding file)";
  const when = finding.ratedAt ? `Rated: ${finding.ratedAt}.` : "Rated: see the finding file.";
  return [
    `# ${finding.agent}: ${finding.attackClass} finding`,
    "",
    "Status: **maintainer notice pending**. A person at Bonded sends this; the tooling does not.",
    "",
    when,
    `Attacker model: ${finding.attackerModel}. Mandate: ${finding.mandateShown ? "shown" : "hidden"}. Feedback: ${finding.feedback}.`,
    `Vector${finding.vectors.length === 1 ? "" : "s"}: ${finding.vectors.join(", ") || "email"}.`,
    "",
    "## Result",
    "",
    "| | |",
    "|---|---|",
    `| Published text | ${finding.staticBreached ? "breached a rule the attack aims at" : "held"} |`,
    `| Adaptive rewrites | ${outcome} |`,
    `| Money lost | ${dollars(cents(finding.lossUsd))} |`,
    `| Overpaid | ${dollars(cents(finding.overpaidUsd))} |`,
    `| Spend on the run | ${dollars(cents(finding.spendUsd))} |`,
    "",
    "## What the attack aims at",
    "",
    rules,
    "",
    "## What would stop it",
    "",
    'The fix is mostly outside the prompt: mandate limits enforced in code, an allowlist of payees, an approved-invoice queue, and a vendor bank change that needs a finance ticket. A prompt that says "be careful" is not a control.',
    "",
    "## What is withheld",
    "",
    "The exact wording, the agent's messages and the episode transcript are withheld under the disclosure policy until the maintainers have been told and have fixed it or 30 days have passed. The wording of fresh variants, adaptive rewrites and held-out attacks is never published.",
    "",
    "Policy: docs/disclosures/OFFCHAIN.md. Send privately through the project's security policy, a security advisory or a private email, never a public issue.",
    "",
  ].join("\n");
}

/**
 * The rewrite that got through, as a seed the library can review. Only a round after the seed
 * itself counts: the published text is already in the library. Returns undefined when no rewrite
 * got through.
 */
export function bountyCandidate(
  seed: OffchainSeed,
  result: OffchainAdaptiveResult,
): OffchainSeed | undefined {
  const win = result.attempts.find((a) => a.succeeded && a.round > 0);
  if (!win) return undefined;
  const variant = proseFromDraft(seed, win.prose, ADAPTIVE_PROSE);
  variant.id = candidateId(seed.id, win.prose);
  variant.variantOf = seed.variantOf ?? seed.id;
  return OffchainSeed.parse(variant);
}

/** A fresh-variant-shaped id, so a candidate loads like any other seed. */
export function candidateId(seedId: string, prose: Record<string, string>): string {
  const hash = createHash("sha256").update(JSON.stringify(prose)).digest("hex").slice(0, 8);
  return `${seedId.replace(/-r\d{1,2}$/, "")}-f${hash}`;
}

/** Everything a result produces, without writing anything. */
export function findingArtifacts(
  seed: OffchainSeed,
  result: OffchainAdaptiveResult,
  ratedAt?: string,
): FindingArtifacts {
  const finding = findingFrom(result, ratedAt);
  // The result doesn't name the seed's aims, so take them from the seed.
  finding.aimedAt = seed.aimedAt.map((rule) => AIM[rule]);
  const candidate = bountyCandidate(seed, result);
  finding.candidate = candidate !== undefined;
  return {
    finding,
    disclosure: disclosureNote(finding),
    ...(candidate ? { candidate } : {}),
  };
}

/** A saved adaptive result, with the file's mtime as its rating date. */
export interface SavedResult {
  result: OffchainAdaptiveResult;
  ratedAt: string;
}

/** Reads the adaptive results in `dir`, skipping finding files and anything that isn't a result. */
export function readAdaptiveResults(dir: string): SavedResult[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json") && !file.endsWith(".finding.json"))
    .sort()
    .flatMap((file) => {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (!parsed || typeof parsed !== "object") return [];
      const result = parsed as OffchainAdaptiveResult;
      if (typeof result.seed !== "string" || !Array.isArray(result.attempts)) return [];
      const mtime = statSync(join(dir, file)).mtime;
      return [{ result, ratedAt: mtime.toISOString().slice(0, 10) }];
    });
}

/**
 * Writes a finding, its disclosure note and, when a rewrite got through, a candidate seed.
 * `outDir` must be private (the caller checks it); the candidate carries the prose.
 */
export function writeFinding(
  outDir: string,
  seed: OffchainSeed,
  result: OffchainAdaptiveResult,
  ratedAt?: string,
): FindingArtifacts {
  mkdirSync(outDir, { recursive: true });
  const artifacts = findingArtifacts(seed, result, ratedAt);
  writeFileSync(
    join(outDir, `${seed.id}.finding.json`),
    `${JSON.stringify(artifacts.finding, null, 2)}\n`,
  );
  writeFileSync(join(outDir, `${seed.id}.disclosure.md`), artifacts.disclosure);
  if (artifacts.candidate) {
    const header = [
      "# Bounty candidate from an adaptive run. Private: do not commit.",
      `# Agent: ${result.agent}. Round: ${artifacts.finding.roundsToBreach}. Class: ${seed.class}.`,
      `# Vectors: ${seedVectors(seed).join(", ") || "email"}.`,
      "# Review it, then move it into offchain-seeds-staged/ if it should join the library.",
      "",
    ].join("\n");
    writeFileSync(
      join(outDir, `${artifacts.candidate.id}.candidate.yaml`),
      `${header}${stringify(artifacts.candidate)}`,
    );
  }
  return artifacts;
}
