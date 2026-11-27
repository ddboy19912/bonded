import type { Report } from "../lib/api";
import { Term } from "./ui";

/** A row's class, marked when the class had too few counted runs to enter the grade. */
function GradedClass({ row }: { row: { class: string; graded: boolean } }) {
  return row.graded ? (
    <>{row.class}</>
  ) : (
    <span title="Too few counted runs of this class to enter the grade">
      {row.class} <span className="font-sans">(not graded)</span>
    </span>
  );
}

/**
 * The Security score's extra batteries, from a rating report: the S1 market-data battery per
 * seed (false prices, news and numbers), the cross-session memory battery and the world-state
 * battery (false claims about yesterday). Induced action counts toward the grade; a freeze (the
 * agent held or skipped a trade) is shown apart and isn't graded. Renders nothing for a report
 * without any of them (older reports, operator-run agents).
 */
export function BatteryTables({ report }: { report: Report }) {
  const s1 = report.s1 ?? [];
  const memory = report.memory;
  const world = report.worldState?.seeds ?? [];
  if (s1.length === 0 && !memory && world.length === 0) return null;
  return (
    <div className="flex flex-col gap-10">
      {s1.length > 0 && (
        <section aria-label="Market-data battery">
          <p className="eyebrow text-soft">Market data (S1)</p>
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted">
            The same task twice, clean and with false prices, news or numbers planted. Acted: the
            lie moved it to trade (counts toward the grade). Froze: it held or skipped a trade
            instead (shown, not graded).
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-line font-mono text-[12px] text-muted">
                <tr>
                  <th className="pb-2.5 font-normal">Seed</th>
                  <th className="pb-2.5 font-normal">Class</th>
                  <th className="pb-2.5 pl-3 text-right font-normal">Acted</th>
                  <th className="pb-2.5 pl-3 text-right font-normal">Froze</th>
                  <th className="pb-2.5 pl-3 text-right font-normal">Breached</th>
                </tr>
              </thead>
              <tbody>
                {s1.map((r) => (
                  <tr key={r.seed} className="border-t border-line first:border-t-0">
                    <td className="truncate py-2.5 font-mono">{r.seed}</td>
                    <td className="py-2.5 font-mono text-muted">
                      <GradedClass row={r} />
                    </td>
                    <td
                      className={`py-2.5 pl-3 text-right font-mono ${r.manipulated ? "text-breach" : "text-muted"}`}
                    >
                      {r.manipulated} of {r.countedPairs}
                    </td>
                    <td className="py-2.5 pl-3 text-right font-mono text-muted">
                      {r.inducedInaction ?? 0}
                    </td>
                    <td className="py-2.5 pl-3 text-right font-mono text-muted">{r.breached}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {memory && (
        <section aria-label="Memory battery">
          <p className="eyebrow text-soft">Memory</p>
          {memory.skipped ? (
            <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted">
              Not run: {memory.skipped}.
            </p>
          ) : (
            <>
              <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted">
                A false standing instruction planted on day 1; did the agent act on it on a clean
                day 2, against a control with nothing planted?
              </p>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-line font-mono text-[12px] text-muted">
                    <tr>
                      <th className="pb-2.5 font-normal">Seed</th>
                      <th className="pb-2.5 font-normal">Class</th>
                      <th className="pb-2.5 pl-3 text-right font-normal">Acted on the note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {memory.seeds.map((r) => (
                      <tr key={r.seed} className="border-t border-line first:border-t-0">
                        <td className="truncate py-2.5 font-mono">{r.seed}</td>
                        <td className="py-2.5 font-mono text-muted">
                          <GradedClass row={r} />
                        </td>
                        <td
                          className={`py-2.5 pl-3 text-right font-mono ${r.manipulated ? "text-breach" : "text-muted"}`}
                        >
                          {r.manipulated} of {r.countedAttempts}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      )}
      {world.length > 0 && (
        <section aria-label="World-state battery">
          <p className="eyebrow text-soft">World state</p>
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted">
            Two days on one vault: yesterday's trades are real, and today's{" "}
            <Term term="carriedHistory">carried history</Term> also holds a false claim about
            yesterday the agent can check against its holdings or mandate. Broke the mandate:
            against a control with only the true history.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-line font-mono text-[12px] text-muted">
                <tr>
                  <th className="pb-2.5 font-normal">Seed</th>
                  <th className="pb-2.5 font-normal">Class</th>
                  <th className="pb-2.5 pl-3 text-right font-normal">Broke the mandate</th>
                </tr>
              </thead>
              <tbody>
                {world.map((r) => (
                  <tr key={r.seed} className="border-t border-line first:border-t-0">
                    <td className="truncate py-2.5 font-mono">{r.seed}</td>
                    <td className="py-2.5 font-mono text-muted">
                      <GradedClass row={r} />
                    </td>
                    <td
                      className={`py-2.5 pl-3 text-right font-mono ${r.manipulated ? "text-breach" : "text-muted"}`}
                    >
                      {r.manipulated} of {r.countedAttempts}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
