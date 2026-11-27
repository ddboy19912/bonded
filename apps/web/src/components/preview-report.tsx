import { useNavigate } from "react-router";
import type { RunRecord } from "../lib/api";
import type { PreviewRecord } from "../lib/byoa-api";
import { gradeTone, weakestRow } from "../lib/security";
import { taskLine } from "../lib/task-score";
import {
  classCells,
  coverageRows,
  livenessLine,
  ratingFailure,
  untestedClasses,
  untestedLine,
} from "../lib/byoa";
import { codeSourceLabel, duration } from "../lib/connect";
import { Badge, Button, Note, Table, Term, TierBadge } from "./ui";
import { BreachEvidenceList, RatingCompareView, TopFixes } from "./report-actions";

const TONE = { breach: "text-breach", warn: "text-warn", muted: "text-muted" } as const;

/** The label every preview carries, wherever its score shows. */
export const PREVIEW_LABEL = "Preview: private, not published";

/** What "Make it official" carries into onboarding. */
export interface OfficialPrefill {
  previewId: string;
  mode: PreviewRecord["mode"];
  connection: PreviewRecord["connection"];
  agentUrl: string | null;
  /** Onboarding fills a declared hash in; an automatic one is only shown, it is reported again. */
  codeHash: PreviewRecord["codeHash"];
  /** Its score, for the recommended bond. */
  score?: number | null;
}

export function prefillFrom(preview: PreviewRecord): OfficialPrefill {
  return {
    previewId: preview.id,
    mode: preview.mode,
    connection: preview.connection,
    agentUrl: preview.agentUrl?.url ?? null,
    codeHash: preview.codeHash,
    score: preview.rating?.score ?? null,
  };
}

/**
 * A preview's report: the same score and report an official rating computes, never attested or
 * posted, and labelled so. "Make it official" opens onboarding with the preview's choices. Without
 * `preview` (a report shared by link) it is read-only: no code hash and nothing to act on.
 */
export function PreviewReport({
  preview,
  run,
  previous,
  session,
  onRateAgain,
  rateAgainBusy = false,
  label = PREVIEW_LABEL,
}: {
  preview?: PreviewRecord | undefined;
  run: RunRecord;
  /** The wallet's preview before this one that finished with a score: the "before". */
  /** The account's previous finished preview, to compare against. */
  previous?: Pick<PreviewRecord, "ratingId"> | undefined;
  session?: string | undefined;
  /** Start a new preview with the same choices, after a fix. */
  onRateAgain?: () => void;
  rateAgainBusy?: boolean;
  /** The label under the score: a shared report's says it is no longer private. */
  label?: string;
}) {
  const navigate = useNavigate();
  const report = run.report;
  const official = () => {
    if (!preview) return;
    window.scrollTo?.({ top: 0 });
    void navigate(`/agents/new?preview=${encodeURIComponent(preview.id)}`, {
      state: { prefill: prefillFrom(preview) },
    });
  };
  const untested = new Set(untestedClasses(report));
  return (
    <div className="flex flex-col gap-12 text-sm">
      {run.status === "failed" || !report ? (
        <Note tone="breach" role="alert" title="The preview didn't finish with a score.">
          {ratingFailure(run)}
        </Note>
      ) : (
        <>
          <div className="flex flex-col gap-8">
            {/* The two scores side by side, at the same size: neither is the headline alone. */}
            <div className="grid grid-cols-2 gap-x-5 gap-y-8 sm:gap-x-10">
              <div className="min-w-0 border-t border-line pt-4">
                {report.susceptibility ? (
                  <>
                    <p className="eyebrow">Security score</p>
                    <p className="mt-3 flex items-baseline gap-2">
                      <span className={`num-giant ${gradeTone(report.susceptibility.grade)}`}>
                        {report.susceptibility.grade}
                      </span>
                      <span className="eyebrow" aria-hidden>
                        / 100
                      </span>
                    </p>
                    {weakestRow(report.susceptibility) && (
                      <p className="mt-3 max-w-sm text-soft">{weakestRow(report.susceptibility)}</p>
                    )}
                  </>
                ) : (
                  <>
                    <p className="eyebrow">Security score unavailable</p>
                    <p className="mt-3 num-giant text-dim" aria-hidden>
                      –
                    </p>
                  </>
                )}
              </div>
              {report.task && (
                <div className="min-w-0 border-t border-line pt-4">
                  <p className="eyebrow">Task score</p>
                  <p className="mt-3 flex items-baseline gap-2">
                    {report.task.score === null ? (
                      <>
                        <span className="num-giant text-dim" aria-hidden>
                          –
                        </span>
                        <span className="eyebrow">not measured</span>
                      </>
                    ) : (
                      <>
                        <span className={`num-giant ${gradeTone(report.task.score)}`}>
                          {report.task.score}
                        </span>
                        <span className="eyebrow" aria-hidden>
                          / 100
                        </span>
                      </>
                    )}
                  </p>
                  <p className="mt-3 max-w-sm text-soft">{taskLine(report.task)}</p>
                  {report.task.benign.trials > 0 && (
                    <p className="mt-1.5 text-xs text-muted">
                      <Term term="benignTwins">What is a benign twin?</Term>
                    </p>
                  )}
                </div>
              )}
            </div>
            <div className="flex flex-col gap-3">
              <p className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <Badge tone="warn">Preview</Badge>
                <span className="inline-flex items-center gap-2">
                  <span>Insurance score {report.scoring.score}</span>
                  <TierBadge score={report.scoring.score} />
                </span>
                <span className="text-muted">
                  {report.episodes.total} episodes ({report.episodes.attacks} attacks,{" "}
                  {report.episodes.controls} with no attack) in {duration(report.durationMs / 1000)}
                </span>
              </p>
              <div className="max-w-prose">
                <p className="font-medium text-ink">{label}</p>
                <p className="mt-1 text-muted">
                  Computed exactly as an official rating's score, but not signed or posted, and no
                  cover can be quoted from it.
                </p>
              </div>
              {preview?.codeHash && (
                <p className="text-xs text-muted">
                  Code hash{" "}
                  <span className="font-mono">{preview.codeHash.value.slice(0, 18)}…</span> from{" "}
                  {codeSourceLabel(preview.codeHash)}.
                </p>
              )}
            </div>
          </div>
          <Table>
            <caption className="eyebrow mb-3 caption-top text-left">
              Results by attack class
            </caption>
            <thead>
              <tr>
                <th>Attack class</th>
                <th className="text-right!">Exercised</th>
                <th className="text-right!">Result</th>
              </tr>
            </thead>
            <tbody>
              {report.classes.map((c) => {
                const cells = classCells(c);
                const notReached = untested.has(c.class) || cells.result === "not reached";
                return (
                  <tr key={c.class}>
                    <td className="py-3!">{c.name}</td>
                    <td
                      className={`py-3! text-right font-mono text-xs whitespace-nowrap ${notReached ? "text-warn" : "text-muted"}`}
                      title={
                        notReached
                          ? "No episode tested the agent: priced as untested within its group"
                          : undefined
                      }
                    >
                      {cells.exercised}
                    </td>
                    <td
                      className={`py-3! text-right font-mono text-xs whitespace-nowrap ${TONE[cells.tone]}`}
                    >
                      {cells.result}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          {previous?.ratingId && (
            <div className="border-t border-line pt-6">
              <RatingCompareView from={previous.ratingId} to={run.id} session={session} />
            </div>
          )}
          <TopFixes report={report} />
          <BreachEvidenceList report={report} />
          <ScoreNotes
            rows={[
              { label: "Untested classes", text: untestedLine(report) },
              {
                label: "Sources read",
                text: coverageText(run.coverage ?? report.coverage ?? null),
              },
              { label: "Task completion", text: livenessLine(report.liveness) },
            ]}
          />
        </>
      )}
      {preview && (
        <div className="grid gap-x-10 gap-y-8 border-t border-line pt-8 sm:grid-cols-2">
          {onRateAgain && (
            <div className="flex flex-col gap-2">
              <p className="text-lg font-medium tracking-[-0.02em]">Fixed something?</p>
              <p className="max-w-sm text-muted">
                Rate it again with the same choices, then see the two side by side. A new preview
                connects and checks again first.
              </p>
              <div className="mt-3">
                <Button kind="secondary" loading={rateAgainBusy} onClick={onRateAgain}>
                  Rate again
                </Button>
              </div>
            </div>
          )}
          <div className="flex flex-col gap-2">
            <p className="text-lg font-medium tracking-[-0.02em]">Ready for the real thing?</p>
            <p className="max-w-sm text-muted">
              Making it official registers the agent, creates its vault and stakes a bond, with
              these choices filled in. The official rating runs again, attested on chain.
            </p>
            <div className="mt-3">
              <Button onClick={official}>Make it official</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Why the score is what it is, one labelled row per note; nothing when there are none. */
function ScoreNotes({ rows }: { rows: { label: string; text: string | undefined }[] }) {
  const shown = rows.filter((r): r is { label: string; text: string } => Boolean(r.text));
  if (!shown.length) return null;
  return (
    <section aria-labelledby="score-notes" className="border-t border-line pt-6">
      <h3 id="score-notes" className="text-xl font-medium tracking-[-0.03em]">
        Notes on the score
      </h3>
      <p className="mt-2 max-w-2xl text-muted">
        Generated from this rating's results, not written by a model. They say what counted for or
        against the score.
      </p>
      <dl className="mt-5 divide-y divide-line border-t border-line">
        {shown.map((r) => (
          <div
            key={r.label}
            className="grid gap-1.5 py-4 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-6"
          >
            <dt className="eyebrow pt-px">{r.label}</dt>
            <dd className="text-soft">{r.text}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function coverageText(coverage: Parameters<typeof coverageRows>[0]): string | undefined {
  const rows = coverageRows(coverage);
  if (!rows.length) return undefined;
  const unread = rows.filter((r) => r.read === 0);
  return unread.length
    ? `The agent never read ${unread.map((r) => r.label).join(", ")}, so attacks there couldn't reach it.`
    : "The agent read every source that was attacked.";
}
