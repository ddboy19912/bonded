import { useNavigate } from "react-router";
import type { RunRecord } from "../lib/api";
import type { PreviewRecord } from "../lib/byoa-api";
import {
  coverageRows,
  livenessLine,
  ratingFailure,
  untestedClasses,
  untestedLine,
} from "../lib/byoa";
import { codeSourceLabel, duration } from "../lib/connect";
import { Badge, Button, Note, ScoreRing, TierBadge } from "./ui";
import { BreachEvidenceList, RatingCompareView, TopFixes } from "./report-actions";

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
    <div className="flex flex-col gap-8 text-sm">
      {run.status === "failed" || !report ? (
        <Note tone="breach" role="alert" title="The preview didn't finish with a score.">
          {ratingFailure(run)}
        </Note>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-8 gap-y-5">
            <ScoreRing score={report.scoring.score} size={112} />
            <div className="flex min-w-64 flex-1 flex-col gap-2">
              <p className="flex flex-wrap items-center gap-2">
                <Badge tone="warn">Preview</Badge>
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
                  <th className="pb-2 text-right font-medium">Result</th>
                  <th className="pb-2 text-right font-medium">Exercised</th>
                </tr>
              </thead>
              <tbody>
                {report.classes.map((c) => (
                  <tr key={c.class} className="border-t border-line">
                    <td className="py-2.5 pr-4">{c.name}</td>
                    <td
                      className={`py-2.5 text-right font-mono text-xs ${c.breaches ? "text-breach" : "text-muted"}`}
                    >
                      {c.breaches
                        ? `${c.breaches} of ${c.episodes} breached`
                        : `held ${c.episodes}`}
                    </td>
                    <td
                      className={`py-2.5 pl-4 text-right font-mono text-xs ${untested.has(c.class) ? "text-warn" : "text-muted"}`}
                    >
                      {untested.has(c.class)
                        ? "untested"
                        : `${c.exercised ?? c.episodes} of ${c.episodes}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {previous?.ratingId && (
            <div className="border-t border-line pt-6">
              <RatingCompareView from={previous.ratingId} to={run.id} session={session} />
            </div>
          )}
          <TopFixes report={report} />
          <BreachEvidenceList report={report} />
          {(untestedLine(report) ||
            livenessLine(report.liveness) ||
            coverageRows(run.coverage ?? report.coverage ?? null).length > 0) && (
            <div className="flex max-w-prose flex-col gap-2 text-xs text-muted">
              {untestedLine(report) && <p>{untestedLine(report)}</p>}
              <CoverageLine coverage={run.coverage ?? report.coverage ?? null} />
              {livenessLine(report.liveness) && <p>{livenessLine(report.liveness)}</p>}
            </div>
          )}
        </>
      )}
      <div className="grid gap-8 border-t border-line pt-6 sm:grid-cols-2">
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

function CoverageLine({ coverage }: { coverage: Parameters<typeof coverageRows>[0] }) {
  const rows = coverageRows(coverage);
  if (!rows.length) return null;
  const unread = rows.filter((r) => r.read === 0);
  return (
    <p>
      {unread.length
        ? `Your agent never read ${unread.map((r) => r.label).join(", ")}, so attacks there couldn't reach it.`
        : "Your agent read every source that was attacked."}
    </p>
  );
}
