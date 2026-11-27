import { dollarsAtRiskLine } from "@bondedhq/shared";
import { keccak256 } from "viem";
import { apiUrl, explorerUrl, networkName } from "../config";
import type { Report } from "./api";
import { txUrl } from "./format";
import { batteryName, gradeBand, manipulatedOf } from "./security";

/** What the PDF says about one rating, besides the report itself. */
export interface ReportContext {
  agentId: string;
  runId: string;
  /** The report hash the registry holds for this agent. */
  reportHash: string;
  mandateHash?: string;
  txHash?: string;
}

/** The original report file, byte for byte: the bytes the on-chain report hash was taken of. */
export async function fetchReportBytes(runId: string): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(`${apiUrl}/arena/runs/${runId}/report`);
  if (res.status !== 200) throw new Error("The full report isn't available yet.");
  return new Uint8Array(await res.arrayBuffer());
}

/** Whether these bytes hash to the on-chain report hash (keccak-256, as the Arena posts it). */
export const matchesHash = (bytes: Uint8Array, reportHash: string) =>
  keccak256(bytes).toLowerCase() === reportHash.toLowerCase();

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "–");
/** A battery row's class, marked when the class had too few counted runs to enter the grade. */
const graded = (r: { class: string; graded: boolean }) =>
  r.graded ? r.class : `${r.class} (not graded)`;
const minutes = (ms: number) =>
  ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;

/**
 * Everything the PDF prints, as plain rows. Kept apart from the drawing so it can be tested
 * and so the PDF never says more than the report does.
 */
export function reportDocument(report: Report, ctx: ReportContext, verified: boolean) {
  const rated = new Date(report.startedAt);
  // Older reports measured breaches only: their table keeps the breach columns rather than label
  // breaches as manipulation.
  const legacy = !report.classes.some((c) => c.manipulated !== undefined);
  const grade = report.susceptibility?.grade;
  const task = report.task?.score ?? null;
  const ran = report.classes.filter((c) => c.episodes > 0);
  const tricked = ran.filter((c) => (legacy ? c.breaches : manipulatedOf(c)) > 0).length;
  return {
    filename: `bonded-agent-${ctx.agentId}-report`,
    title: `Agent ${ctx.agentId}`,
    // Hosted reports come from on-chain ratings; off-chain models are rated on the Index.
    kind: "On-chain attack report",
    score: grade,
    tier: report.scoring.tier,
    /** The verdict beside each score, as the agent page words it. */
    securityVerdict: grade === undefined ? "Not measured" : gradeBand(grade).verdict,
    task,
    taskVerdict:
      task === null
        ? "Not measured"
        : task >= 80
          ? "Does the job"
          : task >= 50
            ? "Does some of the job"
            : "Rarely does the job",
    /** The attack report's headline, as on the agent page. */
    classesLine: tricked
      ? `Tricked in ${tricked} of ${ran.length} attack classes`
      : "Held against every attack it faced",
    ratedOn: rated.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
    summary: [
      ["Agent", report.agent],
      [
        "Security score",
        report.susceptibility ? String(report.susceptibility.grade) : "Not measured",
      ],
      ...(report.susceptibility?.worstClass && report.susceptibility.worstRate > 0
        ? [
            [
              "Weakest (sets the security score)",
              `${report.susceptibility.worstClass}, ${batteryName(report.susceptibility.worstTrack, report.susceptibility.worstSource)}: manipulated in ${pct(report.susceptibility.worstRate, 1)} of its episodes`,
            ],
          ]
        : []),
      ["Insurance score", `${report.scoring.score} (${report.scoring.tier})`],
      // Older reports have no dollars at risk: the row is left out, never shown as $0.
      ...(report.dollarsAtRisk
        ? [
            ["Dollars at risk", dollarsAtRiskLine(report.dollarsAtRisk)],
            ["Its assumptions", report.dollarsAtRisk.assumptions.join(" ")],
          ]
        : []),
      ["Model family", report.modelFamily],
      ["Mandate mode", report.mandateMode],
      ["Rated on", rated.toUTCString()],
      ["Run time", minutes(report.durationMs)],
      [
        "Episodes",
        `${report.episodes.total} (${report.episodes.attacks} attacks, ${report.episodes.controls} controls)`,
      ],
      ["Agent errors", String(report.episodes.agentErrors)],
      [
        "Control breaches",
        `${report.controls.breaches} of ${report.controls.episodes} plain tasks`,
      ],
      ...(report.unpublished
        ? [
            [
              "Unpublished attacks",
              `${report.unpublished.attacks} attacks in ${report.unpublished.episodes} episodes (held out or accepted bounties)`,
            ],
          ]
        : []),
      ["Runs in a TEE", report.tee ? `Yes (${report.tee.tcbStatus})` : "No"],
      [
        "Sentinel",
        report.sentinel
          ? `On: ${report.sentinel.model}` +
            (report.sentinel.revision ? ` at ${report.sentinel.revision.slice(0, 7)}` : "") +
            `, questions ${report.sentinel.questions}, blocks at ${report.sentinel.blockThreshold}` +
            (report.sentinel.fallback
              ? `; unsure cases (${report.sentinel.fallback.unsureBand.join("–")}) go to ${report.sentinel.fallback.model}` +
                (report.sentinel.pipelineHash ? `; pipeline ${report.sentinel.pipelineHash}` : "")
              : "")
          : "Off",
      ],
    ] as [string, string][],
    classHead: legacy
      ? ["Class", "Attack", "Episodes", "Breaches", "Breach rate", "Loss"]
      : ["Class", "Attack", "Episodes", "Manipulated", "Breaches", "Loss"],
    classes: report.classes.map((c) => [
      c.class,
      c.name,
      String(c.episodes),
      ...(legacy
        ? [String(c.breaches), pct(c.breaches, c.episodes)]
        : [
            `${c.manipulated ?? c.breaches} (${pct(c.manipulated ?? c.breaches, c.episodes)})`,
            String(c.breaches),
          ]),
      `$${c.lossUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    ]),
    /** The S1 market-data battery per seed: acted (graded), froze (not graded), breached. */
    s1: (report.s1 ?? []).map((r) => [
      r.seed,
      graded(r),
      `${r.manipulated} of ${r.countedPairs}`,
      String(r.inducedInaction ?? 0),
      String(r.breached),
    ]),
    /** The world-state battery per seed: broke the mandate on a false record of yesterday. */
    world: (report.worldState?.seeds ?? []).map((r) => [
      r.seed,
      graded(r),
      `${r.manipulated} of ${r.countedAttempts}`,
    ]),
    /** The memory battery per seed, or why it didn't run. */
    memory: report.memory?.skipped
      ? report.memory.skipped
      : (report.memory?.seeds ?? []).map((r) => [
          r.seed,
          graded(r),
          `${r.manipulated} of ${r.countedAttempts}`,
        ]),
    proof: [
      ["Report hash", ctx.reportHash],
      ...(ctx.mandateHash ? [["Mandate hash", ctx.mandateHash]] : []),
      ...(ctx.txHash ? [["Score posted in", ctx.txHash]] : []),
      ["Run", ctx.runId],
      ["Network", networkName],
    ] as [string, string][],
    txLink: ctx.txHash && explorerUrl ? txUrl(ctx.txHash) : undefined,
    verification: verified
      ? "Checked when this PDF was made: the report file's keccak-256 hash matches the report hash on chain."
      : "Warning: the report file's hash did not match the report hash on chain when this PDF was made.",
    verified,
  };
}

/** Save bytes as a file. */
function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Save the original report JSON, the file anyone can hash and compare with the chain. */
export async function downloadReportJson(ctx: ReportContext) {
  const bytes = await fetchReportBytes(ctx.runId);
  save(new Blob([bytes], { type: "application/json" }), `bonded-agent-${ctx.agentId}-report.json`);
}
