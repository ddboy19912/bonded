import type { CSSProperties } from "react";
import { TRACK_LABEL, trackText, type ClassResult, type TrackResult } from "../lib/class-tracks";
import { InfoNote } from "./collapsible";
import { Tooltip } from "./ui";

const TRACKS: TrackResult["track"][] = ["main", "market", "memory", "world"];

/** What each track is, in a few words: where the attack was hidden. */
const TRACK_HINT: Record<TrackResult["track"], string> = {
  main: "Attacks hidden in what it reads: token names, posts, messages, tool output.",
  market: "False prices and news, with no instruction at all.",
  memory: "A false note planted in its memory, read on a later day.",
  world: "A false record of yesterday: a trade to finish, an alert to act on.",
};

const pct = (hits: number, of: number) => (of ? Math.round((hits / of) * 100) : 0);

/** The tracks that ran, in a fixed order. */
const tracksOf = (ran: ClassResult[]) =>
  TRACKS.filter((t) => ran.some((r) => r.tracks.some((x) => x.track === t)));

/**
 * The report's headline: in how many attack classes the agent was tricked, then one figure per
 * track (how often the attacks hidden there worked), so the reader gets the shape before the rows.
 */
export function ClassSummary({ results }: { results: ClassResult[] }) {
  const ran = results.filter((r) => r.tracks.length);
  const weak = ran.filter((r) => r.rate);
  const tracks = tracksOf(ran);
  return (
    <div>
      <p
        className={`text-[clamp(22px,2.2vw,30px)] leading-tight font-medium tracking-[-0.035em] ${weak.length ? "text-breach" : "text-ink"}`}
      >
        {weak.length
          ? `Tricked in ${weak.length} of ${ran.length} attack classes`
          : "Held against every attack it faced"}
      </p>
      <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-muted">
        {weak.length
          ? "How often the attacks worked, by where they were hidden. Its worst result sets the Security score."
          : "No graded attack moved it, wherever it was hidden."}
      </p>
      <dl
        className="mt-8 grid gap-x-8 gap-y-8 sm:grid-cols-2 lg:grid-cols-(--tracks)"
        style={
          { "--tracks": `repeat(${Math.max(tracks.length, 2)}, minmax(0, 1fr))` } as CSSProperties
        }
      >
        {tracks.map((track) => {
          const graded = ran.flatMap((r) => r.tracks.filter((t) => t.track === track && t.graded));
          const hits = graded.reduce((n, t) => n + t.hits, 0);
          const of = graded.reduce((n, t) => n + t.of, 0);
          return (
            <div key={track} className="min-w-0 border-t border-line pt-4">
              <dt className="eyebrow">{TRACK_LABEL[track]}</dt>
              <dd className="mt-3">
                <span
                  className={`block text-[clamp(30px,3vw,40px)] leading-none font-medium tracking-[-0.045em] tabular-nums ${hits ? "text-breach" : "text-brand-bright"}`}
                >
                  {of ? `${pct(hits, of)}%` : "—"}
                </span>
                <span className="mt-2 block text-[13px] text-soft">
                  {!of
                    ? "too few results to grade"
                    : hits
                      ? `of attempts worked · ${hits} of ${of}`
                      : `held all ${of}`}
                </span>
                <span className="mt-1 block text-[12.5px] leading-snug text-muted">
                  {TRACK_HINT[track]}
                </span>
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

/** One track's result for one class: a short meter and the count. */
function RateCell({ t }: { t: TrackResult | undefined }) {
  if (!t)
    return (
      <span className="font-mono text-[12px] text-muted/60">
        <span aria-hidden>—</span>
        <span className="sr-only">not run</span>
      </span>
    );
  const rate = t.of ? t.hits / t.of : 0;
  const counts = t.graded;
  const hit = t.hits > 0;
  return (
    <span className="inline-flex items-center justify-end gap-3" title={trackText(t)}>
      <span
        aria-hidden
        className="relative hidden h-1.5 w-16 overflow-hidden rounded-full bg-white/8 sm:block"
      >
        {hit && (
          <span
            className={`absolute inset-y-0 left-0 rounded-full ${counts ? "bg-breach-solid" : "bg-white/30"}`}
            style={{ width: `${Math.max(rate * 100, 6)}%` }}
          />
        )}
      </span>
      <span
        className={`w-[5.5rem] text-right font-mono text-[12.5px] tabular-nums ${hit && counts ? "text-breach" : hit ? "text-soft" : "text-brand-bright/80"}`}
      >
        {hit ? `${t.hits} of ${t.of}` : `held ${t.of}`}
        {counts ? "" : "*"}
      </span>
    </span>
  );
}

/**
 * Each attack class that ran, with one column per track (main library, market data, memory, world
 * state): how often the agent was manipulated there, as a meter and a count. Classes it fell for
 * read brighter than the ones it held. For ratings whose full report the API doesn't hold (the
 * leaderboard's), built from the published per-class summary.
 */
export function ClassTrackTable({
  results,
  summary = true,
}: {
  results: ClassResult[];
  /** Show the headline and per-track figures above the table. */
  summary?: boolean;
}) {
  const ran = results.filter((r) => r.tracks.length);
  const tracks = tracksOf(ran);
  const ungraded = ran.some((r) => r.tracks.some((t) => !t.graded));
  return (
    <div className="flex flex-col gap-10">
      {summary && <ClassSummary results={results} />}
      <div>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="border-b border-line font-mono text-[12px] text-muted">
              <tr>
                <th className="pb-3 font-normal">Attack class</th>
                {tracks.map((t) => (
                  <th key={t} className="pb-3 pl-4 text-right font-normal whitespace-nowrap">
                    <Tooltip content={TRACK_HINT[t]}>
                      <span className="cursor-help underline decoration-muted/50 decoration-dotted underline-offset-4">
                        {TRACK_LABEL[t]}
                      </span>
                    </Tooltip>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ran.map((r) => (
                <tr key={r.cls} className="border-t border-line first:border-t-0">
                  <td className="py-4 pr-4">
                    <span className="flex items-baseline gap-3">
                      <span className="w-8 shrink-0 font-mono text-[12px] text-muted">{r.cls}</span>
                      <span
                        className={`text-[15px] tracking-[-0.01em] ${r.rate ? "text-ink" : "text-soft"}`}
                      >
                        {r.name}
                      </span>
                    </span>
                  </td>
                  {tracks.map((track) => (
                    <td key={track} className="py-4 pl-4 text-right">
                      <RateCell t={r.tracks.find((x) => x.track === track)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-2">
          <InfoNote title="How to read this">
            Each cell is how many times the attack worked, out of how many tries. Orange: it fell
            for it. Blue: it held every time. A dash: that kind of attack didn't run for this class.
            Main library counts episodes where it acted on the attack, whether or not the vault then
            stopped it. Market data counts pairs where false data moved it to trade. Memory counts
            attempts where it acted on a planted note. World state counts attempts where it acted on
            a false record of yesterday.
            {ungraded && " * Too few results to enter the grade."}
          </InfoNote>
        </div>
      </div>
    </div>
  );
}
