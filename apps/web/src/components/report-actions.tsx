import { useQuery } from "@tanstack/react-query";
import { ApiError, api, type Report } from "../lib/api";
import { byoaApi } from "../lib/byoa-api";
import { bps } from "../lib/format";
import {
  FIX_KIND_LABELS,
  WITHHELD_TEXT,
  actionLine,
  breachLine,
  classChange,
  compareRuns,
  evidenceOf,
  fixesFor,
  scoreChange,
  surfaceLine,
  topFixes,
  type RatingCompare,
  type ReportFix,
} from "../lib/report-actions";
import { InlineCode } from "./code-block";
import { Collapsible } from "./collapsible";
import { CopyButton } from "./copy";
import { Badge, Loading } from "./ui";

/** One fix: what to change, and the line or setting to copy when it has one. */
function Fix({ fix, showCount = true }: { fix: ReportFix; showCount?: boolean }) {
  const copy = fix.promptLine;
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex flex-wrap items-center gap-2">
        <Badge tone="brand">{FIX_KIND_LABELS[fix.kind] ?? fix.kind}</Badge>
        <span className="font-semibold">{fix.title}</span>
        {showCount && (
          <span className="text-xs text-muted">
            would have stopped {fix.prevents} breach{fix.prevents === 1 ? "" : "es"}
          </span>
        )}
      </p>
      {fix.detail && <p className="text-soft">{fix.detail}</p>}
      {fix.setting && (
        <p className="text-xs text-muted">
          Mandate setting: <InlineCode>{fix.setting}</InlineCode>
        </p>
      )}
      {copy && (
        <div className="flex min-w-0 items-start gap-2">
          <code className="min-w-0 flex-1 rounded-lg bg-black/40 px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap text-soft">
            {copy}
          </code>
          <CopyButton text={copy} />
        </div>
      )}
    </div>
  );
}

/** The three fixes that would have stopped the most breaches in this rating. */
export function TopFixes({ report }: { report: Report | null | undefined }) {
  const fixes = topFixes(report);
  if (!fixes.length) return null;
  return (
    <section
      aria-labelledby="top-fixes"
      className="flex flex-col gap-4 border-t border-line pt-5 text-sm"
    >
      <div>
        <h3 id="top-fixes" className="font-semibold">
          Fix these first
        </h3>
        <p className="mt-0.5 text-xs text-muted">
          Counted from this rating's own breaches. The advice follows from each attack's class and
          the breach it caused; it isn't written by a model.
        </p>
      </div>
      <ol className="flex flex-col gap-4">
        {fixes.map((f, i) => (
          <li key={f.id} className="flex gap-3">
            <span className="font-mono text-xs text-muted" aria-hidden>
              {i + 1}.
            </span>
            <div className="min-w-0 flex-1">
              <Fix fix={f} />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * Each breached episode: what was planted where, the exact text the agent read, what it did,
 * the breach and its loss, and what would have stopped it.
 */
export function BreachEvidenceList({ report }: { report: Report | null | undefined }) {
  const evidence = evidenceOf(report);
  if (!evidence.length) return null;
  return (
    <Collapsible
      className="border-t border-line pt-4 text-sm"
      contentClassName="pt-4"
      summary={`What happened in each breach (${evidence.length})`}
    >
      <ul className="flex flex-col gap-5">
        {evidence.map((e, i) => {
          const fixes = fixesFor(e, report);
          return (
            <li
              key={e.episodeId ?? `${e.class}-${i}`}
              className="flex flex-col gap-2 border-t border-white/[0.06] pt-4 first:border-0 first:pt-0"
            >
              <p className="flex flex-wrap items-center gap-2">
                {e.class && <span className="font-mono text-xs text-muted">{e.class}</span>}
                <span className="font-semibold">{e.className ?? e.class ?? "Breach"}</span>
                {surfaceLine(e.surface) && (
                  <span className="text-xs text-muted">{surfaceLine(e.surface)}</span>
                )}
                {e.heldOut && <Badge>held-out</Badge>}
              </p>
              {e.plantedText ? (
                <figure className="flex flex-col gap-1">
                  <figcaption className="text-xs text-muted">What your agent read</figcaption>
                  <blockquote className="max-h-48 overflow-auto rounded-xl border-l-2 border-breach/60 bg-black/30 px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap text-soft">
                    {e.plantedText}
                  </blockquote>
                </figure>
              ) : e.withheld ? (
                <p className="text-xs text-muted">{WITHHELD_TEXT}</p>
              ) : (
                <p className="text-xs text-muted">
                  The planted text is shown once the rating has finished.
                </p>
              )}
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs [&_dt]:text-muted">
                <dt>What it did</dt>
                <dd className="font-mono break-all">{actionLine(e.action)}</dd>
                <dt>Breach</dt>
                <dd>
                  {breachLine(e.breachType)}
                  {e.blocked
                    ? ", blocked by Enforce mode"
                    : e.lossUsd > 0
                      ? `, a loss of ${e.lossUsd.toLocaleString("en-US")} tUSDG`
                      : ", no loss"}
                </dd>
              </dl>
              {fixes.length > 0 && (
                <div className="flex flex-col gap-3 border-l border-line-strong pl-3">
                  <p className="text-xs font-semibold text-soft">What would have stopped it</p>
                  {fixes.map((f) => (
                    <Fix key={f.id} fix={f} showCount={false} />
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Collapsible>
  );
}

/** Before and after: the API's comparison, or one worked out from the two runs. */
export function RatingCompareView({
  from,
  to,
  session,
}: {
  from: string;
  to: string;
  session?: string | undefined;
}) {
  const compare = useQuery({
    queryKey: ["compare", from, to, session],
    queryFn: async (): Promise<RatingCompare> => {
      try {
        return await byoaApi.compareRatings(from, to, session);
      } catch (e) {
        // An API without the compare endpoint yet: the two runs say enough.
        if (!(e instanceof ApiError) || e.status !== 404) throw e;
        const [a, b] = await Promise.all([api.run(from, session), api.run(to, session)]);
        return compareRuns(a, b);
      }
    },
    retry: false,
  });
  if (compare.isPending) return <Loading what="the comparison" />;
  if (!compare.data) return null;
  const c = compare.data;
  const up = c.from.score !== null && c.to.score !== null ? c.to.score - c.from.score : 0;
  return (
    <section aria-labelledby="before-after" className="flex flex-col gap-3 text-sm">
      <h3 id="before-after" className="font-semibold">
        Before and after
      </h3>
      <p className="flex flex-wrap items-baseline gap-3">
        <span className="text-muted">Insurance score</span>
        <span
          className={`font-serif text-4xl leading-none ${up > 0 ? "text-safe" : up < 0 ? "text-breach" : ""}`}
        >
          {scoreChange(c)}
        </span>
        {c.from.expectedLossBps != null && c.to.expectedLossBps != null && (
          <span className="text-muted">
            Expected loss {bps(c.from.expectedLossBps)} → {bps(c.to.expectedLossBps)} of cover a
            year
          </span>
        )}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[26rem] text-xs">
          <caption className="sr-only">Breaches by attack class, before and after</caption>
          <thead className="text-left text-muted">
            <tr>
              <th className="pb-2 font-medium">Attack class</th>
              <th className="pb-2 text-right font-medium">Before</th>
              <th className="pb-2 text-right font-medium">After</th>
              <th className="pb-2 text-right font-medium">Change</th>
            </tr>
          </thead>
          <tbody>
            {c.classes.map((d) => {
              const change = classChange(d);
              const cell = (x: typeof d.from) => (x ? `${x.breaches} of ${x.episodes}` : "not run");
              return (
                <tr key={d.class} className="border-t border-white/[0.06]">
                  <td className="py-2">{d.name}</td>
                  <td className="py-2 text-right font-mono">{cell(d.from)}</td>
                  <td className="py-2 text-right font-mono">{cell(d.to)}</td>
                  <td
                    className={`py-2 text-right ${change.tone === "safe" ? "text-safe" : change.tone === "breach" ? "text-breach" : "text-muted"}`}
                  >
                    {change.text}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">
        Each rating draws its own held-out attacks, so some change between two ratings is chance.
      </p>
    </section>
  );
}
