import { useNavigate } from "react-router";
import type { RunRecord } from "../lib/api";
import type { PreviewRecord } from "../lib/byoa-api";
import {
  classCells,
  coverageRows,
  livenessLine,
  ratingFailure,
  untestedClasses,
  untestedLine,
} from "../lib/byoa";
import { codeSourceLabel, duration } from "../lib/connect";
import { Badge, Button, Note, ScoreRing, TierBadge } from "./ui";
import { BreachEvidenceList, RatingCompareView, TopFixes } from "./report-actions";

const TONE = { breach: "text-breach", warn: "text-warn", muted: "text-muted" } as const;

/** The label every preview carries, wherever its score shows. */
export const PREVIEW_LABEL = "Preview: not on chain, not insurable";

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
 * posted, and labelled so. "Make it official" opens onboarding with the preview's choices.
 */
export function PreviewReport({
  preview,
  run,
  previous,
  session,
  onRateAgain,
  rateAgainBusy = false,
}: {
  preview: PreviewRecord;
  run: RunRecord;
  /** The wallet's preview before this one that finished with a score: the "before". */
  previous?: PreviewRecord | undefined;
  session?: string | undefined;
  /** Start a new preview with the same choices, after a fix. */
  onRateAgain?: () => void;
  rateAgainBusy?: boolean;
}) {
  const navigate = useNavigate();
  const report = run.report;
  const official = () => {
    window.scrollTo?.({ top: 0 });
    void navigate(`/agents/new?preview=${encodeURIComponent(preview.id)}`, {
      state: { prefill: prefillFrom(preview) },
    });
  };
  const untested = new Set(untestedClasses(report));
  return (
    <div className="flex flex-col gap-6 text-sm">
      {run.status === "failed" || !report ? (
        <Note tone="breach" role="alert" title="The preview didn't finish with a score.">
          {ratingFailure(run)}
        </Note>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-8 gap-y-5">
            {report.susceptibility ? (
              <div className="flex flex-col items-center gap-2">
                <ScoreRing score={report.susceptibility.grade} size={112} />
                <span className="text-xs text-muted">Security score</span>
              </div>
            ) : (
              <span className="text-muted">Security score unavailable</span>
            )}
            <div className="flex min-w-64 flex-1 flex-col gap-2">
              <p className="flex flex-wrap items-center gap-2">
                <Badge tone="warn">Preview</Badge>
                <span>Insurance score {report.scoring.score}</span>
                <TierBadge score={report.scoring.score} />
              </p>
              <p>
                {report.episodes.total} episodes ({report.episodes.attacks} attacks,{" "}
                {report.episodes.controls} with no attack) in {duration(report.durationMs / 1000)}
              </p>
              <p className="font-medium">{PREVIEW_LABEL}</p>
              <p className="max-w-prose text-muted">
                Computed exactly as an official rating's score, but not signed or posted, and no
                cover can be quoted from it.
              </p>
              {preview.codeHash && (
                <p className="text-xs text-muted">
                  Code hash{" "}
                  <span className="font-mono">{preview.codeHash.value.slice(0, 18)}…</span> from{" "}
                  {codeSourceLabel(preview.codeHash)}.
                </p>
              )}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-sm">
              <caption className="sr-only">Results by attack class</caption>
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="pb-2 font-medium">Attack class</th>
                  <th className="pb-2 text-right font-medium">Exercised</th>
                  <th className="pb-2 text-right font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {report.classes.map((c) => {
                  const cells = classCells(c);
                  const notReached = untested.has(c.class) || cells.result === "not reached";
                  return (
                    <tr key={c.class} className="border-t border-line">
                      <td className="py-2.5 pr-4">{c.name}</td>
                      <td
                        className={`py-2.5 text-right font-mono text-xs ${notReached ? "text-warn" : "text-muted"}`}
                        title={
                          notReached
                            ? "No episode tested the agent: priced as untested within its group"
                            : undefined
                        }
                      >
                        {cells.exercised}
                      </td>
                      <td
                        className={`py-2.5 pl-4 text-right font-mono text-xs ${TONE[cells.tone]}`}
                      >
                        {cells.result}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {previous?.ratingId && (
            <div className="border-t border-line pt-5">
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
      <div className="grid gap-6 border-t border-line pt-5 sm:grid-cols-2">
        {onRateAgain && (
          <div className="flex flex-col gap-2">
            <p className="font-semibold">Fixed something?</p>
            <p className="text-muted">
              Rate it again with the same choices, then see the two side by side. A new preview
              connects and checks again first.
            </p>
            <div className="mt-2">
              <Button kind="secondary" loading={rateAgainBusy} onClick={onRateAgain}>
                Rate again
              </Button>
            </div>
          </div>
        )}
        <div className="flex flex-col gap-2">
          <p className="font-semibold">Ready for the real thing?</p>
          <p className="text-muted">
            Making it official registers the agent, creates its vault and stakes a bond, with these
            choices filled in. The official rating runs again, attested on chain.
          </p>
          <div className="mt-2">
            <Button onClick={official}>Make it official</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Why the score is what it is, one labelled row per note; nothing when there are none. */
function ScoreNotes({ rows }: { rows: { label: string; text: string | undefined }[] }) {
  const shown = rows.filter((r): r is { label: string; text: string } => Boolean(r.text));
  if (!shown.length) return null;
  return (
    <section aria-labelledby="score-notes" className="border-t border-line pt-5">
      <h3 id="score-notes" className="font-semibold">
        Notes on your score
      </h3>
      <p className="mt-1 text-muted">
        Generated from this rating's results, not written by a model. They say what counted for or
        against the score.
      </p>
      <dl className="mt-3 divide-y divide-line">
        {shown.map((r) => (
          <div key={r.label} className="py-3">
            <dt className="text-xs font-semibold tracking-wide text-muted uppercase">{r.label}</dt>
            <dd className="mt-1.5 text-soft">{r.text}</dd>
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
    ? `Your agent never read ${unread.map((r) => r.label).join(", ")}, so attacks there couldn't reach it.`
    : "Your agent read every source that was attacked.";
}
