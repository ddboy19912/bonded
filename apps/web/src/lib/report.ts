import { keccak256 } from "viem";
import { apiUrl, explorerUrl, networkName } from "../config";
import type { Report } from "./api";
import { txUrl } from "./format";

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
const minutes = (ms: number) =>
  ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;

/**
 * Everything the PDF prints, as plain rows. Kept apart from the drawing so it can be tested
 * and so the PDF never says more than the report does.
 */
export function reportDocument(report: Report, ctx: ReportContext, verified: boolean) {
  const rated = new Date(report.startedAt);
  return {
    filename: `bonded-agent-${ctx.agentId}-report`,
    title: `Agent ${ctx.agentId}`,
    score: report.susceptibility?.grade,
    tier: report.scoring.tier,
    ratedOn: rated.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
    summary: [
      ["Agent", report.agent],
      [
        "Security score",
        report.susceptibility ? String(report.susceptibility.grade) : "Not measured",
      ],
      ["Insurance score", `${report.scoring.score} (${report.scoring.tier})`],
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
    classes: report.classes.map((c) => [
      c.class,
      c.name,
      String(c.episodes),
      String(c.breaches),
      pct(c.breaches, c.episodes),
      `$${c.lossUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    ]),
    proof: [
      ["Report hash", ctx.reportHash],
      ...(ctx.mandateHash ? [["Mandate hash", ctx.mandateHash]] : []),
      ...(ctx.txHash ? [["Posted in", ctx.txHash]] : []),
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

/**
 * Make and save a readable PDF of the report. jsPDF loads only when someone asks for a PDF,
 * so it stays out of the app's main bundle.
 */
export async function downloadReportPdf(ctx: ReportContext) {
  const bytes = await fetchReportBytes(ctx.runId);
  const report = JSON.parse(new TextDecoder().decode(bytes)) as Report;
  const doc = reportDocument(report, ctx, matchesHash(bytes, ctx.reportHash));
  const [{ jsPDF }, { autoTable }] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);

  const pdf = new jsPDF({ unit: "pt", format: "a4" });
  const W = pdf.internal.pageSize.getWidth();
  const M = 48;
  const ink: [number, number, number] = [15, 23, 42];
  const muted: [number, number, number] = [100, 110, 130];
  const brand: [number, number, number] = [29, 78, 216];

  // Header band.
  pdf.setFillColor(5, 7, 13);
  pdf.rect(0, 0, W, 112, "F");
  pdf.setTextColor(255, 255, 255);
  pdf.setFont("helvetica", "bold").setFontSize(13).text("Bonded", M, 44);
  pdf.setFont("helvetica", "normal").setFontSize(10).setTextColor(175, 196, 255);
  pdf.text("Arena attack report", M, 60);
  pdf.setTextColor(255, 255, 255).setFontSize(22).setFont("helvetica", "bold");
  pdf.text(doc.title, M, 92);
  pdf.setFontSize(10).setFont("helvetica", "normal").setTextColor(175, 196, 255);
  pdf.text(`Rated ${doc.ratedOn}`, W - M, 92, { align: "right" });

  // Score.
  let y = 160;
  pdf
    .setTextColor(...ink)
    .setFont("helvetica", "bold")
    .setFontSize(44);
  pdf.text(String(doc.score ?? "—"), M, y);
  pdf
    .setTextColor(...muted)
    .setFont("helvetica", "normal")
    .setFontSize(10);
  pdf.text(
    doc.score === undefined ? "Security score not measured" : "Bonded Score (security), out of 100",
    M,
    y + 18,
  );

  const table = {
    theme: "plain" as const,
    margin: { left: M, right: M },
    styles: { font: "helvetica", fontSize: 9.5, textColor: ink, cellPadding: 6 },
    headStyles: { fontStyle: "bold" as const, textColor: muted, fontSize: 8.5 },
    didDrawCell: (data: {
      row: { section: string };
      cell: { x: number; y: number; width: number; height: number };
    }) => {
      if (data.row.section !== "body") return;
      pdf.setDrawColor(226, 230, 238);
      pdf.line(
        data.cell.x,
        data.cell.y + data.cell.height,
        data.cell.x + data.cell.width,
        data.cell.y + data.cell.height,
      );
    },
  };
  const heading = (text: string, at: number) => {
    pdf
      .setTextColor(...ink)
      .setFont("helvetica", "bold")
      .setFontSize(12)
      .text(text, M, at);
    return at + 8;
  };
  const after = () =>
    (pdf as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;

  y = heading("Summary", y + 52);
  autoTable(pdf, {
    ...table,
    startY: y,
    body: doc.summary,
    columnStyles: { 0: { textColor: muted, cellWidth: 140 } },
  });

  y = heading("Results by attack class", after() + 30);
  autoTable(pdf, {
    ...table,
    startY: y,
    head: [["Class", "Attack", "Episodes", "Breaches", "Breach rate", "Loss"]],
    body: doc.classes,
    columnStyles: {
      0: { cellWidth: 44 },
      2: { halign: "right" },
      3: { halign: "right" },
      4: { halign: "right" },
      5: { halign: "right" },
    },
  });

  // Keep the proof, and the line saying whether it checked out, together on one page.
  y = after() + 30;
  const proofHeight = 40 + doc.proof.length * 24 + 60;
  if (y + proofHeight > pdf.internal.pageSize.getHeight() - 48) {
    pdf.addPage();
    y = 64;
  }
  y = heading("Proof on chain", y);
  autoTable(pdf, {
    ...table,
    startY: y,
    body: doc.proof,
    styles: { ...table.styles, font: "courier", fontSize: 8.5 },
    columnStyles: { 0: { font: "helvetica", textColor: muted, cellWidth: 100 } },
  });
  y = after() + 22;
  const colour: [number, number, number] = doc.verified ? [21, 128, 61] : [194, 65, 12];
  pdf
    .setTextColor(...colour)
    .setFont("helvetica", "normal")
    .setFontSize(9.5);
  pdf.text(pdf.splitTextToSize(doc.verification, W - 2 * M), M, y);
  if (doc.txLink) {
    pdf.setTextColor(...brand).textWithLink("View the transaction", M, y + 30, { url: doc.txLink });
  }

  // Footer on every page.
  const pages = pdf.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    pdf.setPage(i);
    const H = pdf.internal.pageSize.getHeight();
    pdf.setTextColor(...muted).setFontSize(8);
    pdf.text(
      "A readable copy. The JSON report is the original: its hash is the one posted on chain.",
      M,
      H - 28,
    );
    pdf.text(`${i} / ${pages}`, W - M, H - 28, { align: "right" });
  }
  pdf.save(`${doc.filename}.pdf`);
}
