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
import { Badge, Loading, Table } from "./ui";

/** One fix: what to change, and the line or setting to copy when it has one. */
function Fix({ fix, showCount = true }: { fix: ReportFix; showCount?: boolean }) {
  const copy = fix.promptLine;
  return (
    <div className="flex flex-col gap-2">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-[15px] font-medium">{fix.title}</span>
        <Badge tone="brand">{FIX_KIND_LABELS[fix.kind] ?? fix.kind}</Badge>
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
        <div className="flex min-w-0 items-start gap-3 border-l-2 border-line-strong pl-4">
          <code className="min-w-0 flex-1 py-0.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-ink">
            {copy}
          </code>
          <span data-print-hide>
            <CopyButton text={copy} />
          </span>
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
      className="flex flex-col gap-6 border-t border-line pt-6 text-sm"
    >
      <div>
        <h3 id="top-fixes" className="text-xl font-medium tracking-[-0.03em]">
          Fix these first
        </h3>
        <p className="mt-2 max-w-2xl text-muted">
          Counted from this rating's own breaches. The advice follows from each attack's class and
          the breach it caused; it isn't written by a model.
        </p>
      </div>
      <ol className="flex max-w-3xl flex-col gap-6">
        {fixes.map((f, i) => (
          <li key={f.id} className="flex gap-4">
            <span
              className="w-5 shrink-0 text-2xl leading-none font-medium tracking-[-0.04em] text-muted tabular-nums"
              aria-hidden
            >
              {i + 1}
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
      className="border-t border-line pt-5 text-sm"
      contentClassName="pt-5"
      summary={`What happened in each breach (${evidence.length})`}
    >
      <ul className="flex flex-col divide-y divide-line">
        {evidence.map((e, i) => {
          const fixes = fixesFor(e, report);
          return (
            <li
              key={e.episodeId ?? `${e.class}-${i}`}
              className="flex flex-col gap-3 py-6 first:pt-0 last:pb-0"
            >
              <p className="flex flex-wrap items-center gap-2">
                {e.class && <span className="font-mono text-xs text-muted">{e.class}</span>}
                <span className="text-[15px] font-medium">
                  {e.className ?? e.class ?? "Breach"}
                </span>
                {surfaceLine(e.surface) && (
                  <span className="text-xs text-muted">{surfaceLine(e.surface)}</span>
                )}
                {e.heldOut && <Badge>held-out</Badge>}
              </p>
              {e.plantedText ? (
                <figure className="flex flex-col gap-1">
                  <figcaption className="eyebrow">What the agent read</figcaption>
                  <blockquote className="mt-1 max-h-48 overflow-auto border-l-2 border-breach/60 py-1 pl-4 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-soft">
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
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-1.5 text-xs [&_dt]:font-mono [&_dt]:text-muted">
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
                <div className="mt-1 flex flex-col gap-4">
                  <p className="eyebrow">What would have stopped it</p>
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
    <section aria-labelledby="before-after" className="flex flex-col gap-5 text-sm">
      <h3 id="before-after" className="text-xl font-medium tracking-[-0.03em]">
        Before and after
      </h3>
      <p className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <span className="eyebrow">Insurance score</span>
        <span className={`num-big ${up > 0 ? "text-safe" : up < 0 ? "text-breach" : ""}`}>
          {scoreChange(c)}
        </span>
        {c.from.expectedLossBps != null && c.to.expectedLossBps != null && (
          <span className="text-muted">
            Expected loss {bps(c.from.expectedLossBps)} → {bps(c.to.expectedLossBps)} of cover a
            year
          </span>
        )}
      </p>
      <Table>
        <caption className="sr-only">Breaches by attack class, before and after</caption>
        <thead>
          <tr>
            <th>Attack class</th>
            <th className="text-right!">Before</th>
            <th className="text-right!">After</th>
            <th className="text-right!">Change</th>
          </tr>
        </thead>
        <tbody>
          {c.classes.map((d) => {
            const change = classChange(d);
            const cell = (x: typeof d.from) => (x ? `${x.breaches} of ${x.episodes}` : "not run");
            return (
              <tr key={d.class}>
                <td className="py-3!">{d.name}</td>
                <td className="py-3! text-right font-mono text-xs whitespace-nowrap">
                  {cell(d.from)}
                </td>
                <td className="py-3! text-right font-mono text-xs whitespace-nowrap">
                  {cell(d.to)}
                </td>
                <td
                  className={`py-3! text-right text-xs whitespace-nowrap ${change.tone === "safe" ? "text-safe" : change.tone === "breach" ? "text-breach" : "text-muted"}`}
                >
                  {change.text}
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      <p className="text-xs text-muted">
        Each rating draws its own held-out attacks, so some change between two ratings is chance.
      </p>
    </section>
  );
}
