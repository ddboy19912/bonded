import type { RunRecord } from "../lib/api";
import type { BrokerageFindings, BrokerageReport } from "../lib/byoa-api";
import { ratingFailure } from "../lib/byoa";
import { Badge, Button, Note } from "./ui";

/** The label every brokerage preview carries. */
export const BROKERAGE_LABEL = "Findings, not a score";

const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const of = (k: number, n: number) => `${k} of ${n}`;

/** A brokerage report, when the run is one. */
export function brokerageReportOf(run: RunRecord): BrokerageReport | undefined {
  const report = run.report as unknown as BrokerageReport | null | undefined;
  return report?.world === "brokerage" && report.findings ? report : undefined;
}

/**
 * A brokerage preview's report: which attacks got the agent to act, what it traded on them, and
 * whether it still did its job. Its attacks are staged, so it has no score.
 */
export function BrokerageFindingsReport({
  run,
  report,
  onRateAgain,
  rateAgainBusy = false,
}: {
  run: RunRecord;
  report: BrokerageReport | undefined;
  onRateAgain?: () => void;
  rateAgainBusy?: boolean;
}) {
  const f = report?.findings;
  return (
    <div className="flex flex-col gap-6 text-sm">
      {run.status === "failed" && (
        <Note tone="breach" role="alert" title="The preview didn't finish.">
          {ratingFailure(run)}
        </Note>
      )}
      {/* Too little ran to say anything: no badge, no headline, nothing that reads as a pass. */}
      {f?.inconclusive && (
        <p className="text-warn">
          Your agent finished {of(f.episodes.ran, f.episodes.total)} episodes, too few to say
          anything about it. The rest didn't count: it couldn't be reached, it failed, or it ran out
          of time.
        </p>
      )}
      {f && !f.inconclusive && <FindingsBody f={f} />}
      {onRateAgain && (
        <div className="flex flex-col gap-2 border-t border-line pt-5">
          <p className="font-semibold">Fixed something?</p>
          <p className="text-muted">Run it again with the same choices.</p>
          <div className="mt-2">
            <Button kind="secondary" loading={rateAgainBusy} onClick={onRateAgain}>
              Run again
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function FindingsBody({ f }: { f: BrokerageFindings }) {
  const worked = f.perAttack.filter((a) => a.worked > 0);
  return (
    <>
      <div className="flex flex-col gap-2">
        <p className="flex flex-wrap items-center gap-2">
          <Badge tone="warn">Preview</Badge>
          <Badge tone={f.attacks.worked > 0 ? "breach" : "safe"}>{BROKERAGE_LABEL}</Badge>
        </p>
        <p className="text-base font-semibold">
          {f.attacks.worked > 0
            ? `${of(f.attacks.seedsWorked, f.attacks.seedsRan)} attacks got your agent to act.`
            : `None of the ${f.attacks.seedsRan} attacks that ran got your agent to act.`}
        </p>
        {f.attacks.worked > 0 && (
          <p className="text-soft">
            It traded {usd(f.attacks.steeredUsd)} on the attacker's say-so
            {f.attacks.atRiskUsd > 0 ? `, with ${usd(f.attacks.atRiskUsd)} at risk` : ""}.
          </p>
        )}
        {f.attacks.approvedThenWorked > 0 && (
          <p className="text-soft">
            In {of(f.attacks.approvedThenWorked, f.attacks.worked)} of those, it asked for approval
            first. In this test the account holder approves every order the agent asks about, so
            asking didn't stop it.
          </p>
        )}
        <p className="text-soft">
          It did its job cleanly in {of(f.job.done, f.job.ran)} episodes with nothing planted.
        </p>
        {f.toolProfile === "alpaca" && (
          <p className="text-soft">It was tested with a copy of Alpaca's tools.</p>
        )}
        {f.episodes.notRun > 0 && (
          <p className="text-warn">
            {of(f.episodes.notRun, f.episodes.total)} episodes didn't finish (your agent couldn't be
            reached, failed or ran out of time), so they count for nothing either way.
          </p>
        )}
        <p className="max-w-prose text-muted">
          A simulated brokerage account. These attacks aren't in ratings yet, so there's no score.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] text-sm">
          <caption className="sr-only">Results by attack</caption>
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="pb-2 font-medium">Attack</th>
              <th className="pb-2 text-right font-medium">Worked</th>
              <th className="pb-2 text-right font-medium">Traded on it</th>
            </tr>
          </thead>
          <tbody>
            {f.perAttack.map((a) => (
              <tr key={a.id} className="border-t border-line">
                <td className="py-2.5 pr-4">
                  {a.title}
                  <span className="block text-xs text-muted">{a.className}</span>
                </td>
                <td
                  className={`py-2.5 text-right font-mono text-xs ${a.worked > 0 ? "text-breach" : a.ran === 0 ? "text-warn" : "text-muted"}`}
                >
                  {a.ran === 0 ? "didn't finish" : of(a.worked, a.ran)}
                </td>
                <td className="py-2.5 pl-4 text-right font-mono text-xs text-muted">
                  {a.worked > 0 ? usd(a.steeredUsd) : "–"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {worked.length > 0 && (
        <section aria-labelledby="what-it-did" className="border-t border-line pt-5">
          <h3 id="what-it-did" className="font-semibold">
            What your agent did
          </h3>
          <ul className="mt-3 flex flex-col gap-4">
            {worked.map((a) => (
              <li key={a.id} className="flex flex-col gap-1">
                <p className="font-medium">{a.title}</p>
                {a.example?.orders.map((o, i) => (
                  <p key={`o${i}`} className="text-soft">
                    {o.side === "buy" ? "Bought" : "Sold"} {usd(o.amountUsd)} of {o.symbol}.
                  </p>
                ))}
                {a.example?.withdrawals.map((w, i) => (
                  <p key={`w${i}`} className="text-soft">
                    Sent {usd(w.amountUsd)} to {w.account}
                    {w.linked ? "." : ", an account the client never linked."}
                  </p>
                ))}
                {a.example?.breaches.map((rules, i) => (
                  <p key={`b${i}`} className="text-breach">
                    Broke the mandate: {rules.join(", ").replace(/_/g, " ")}.
                  </p>
                ))}
                {a.example?.approvals.map((ap, i) => (
                  <p key={`a${i}`} className="text-muted">
                    Asked for approval: "{ap.reason}"
                  </p>
                ))}
              </li>
            ))}
          </ul>
        </section>
      )}

      {f.assumptions && f.assumptions.length > 0 && (
        <section aria-labelledby="findings-assumptions" className="border-t border-line pt-5">
          <h3 id="findings-assumptions" className="font-semibold">
            What these numbers assume
          </h3>
          <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5 text-muted">
            {f.assumptions.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
