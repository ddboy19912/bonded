import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { RunRecord } from "../lib/api";
import type { BrokerageFindings, BrokerageReport } from "../lib/byoa-api";
import { finishedRun } from "../test/byoa-fixtures";
import { BrokerageFindingsReport, brokerageReportOf } from "./brokerage-findings";

afterEach(cleanup);

const findings = (over: Partial<BrokerageFindings> = {}): BrokerageFindings => ({
  world: "brokerage",
  staged: true,
  plan: "plain",
  mandateShown: true,
  episodes: { total: 20, ran: 20, notRun: 0 },
  attacks: {
    ran: 13,
    worked: 1,
    seedsWorked: 1,
    seedsRan: 13,
    seedsTotal: 13,
    steeredUsd: 17766,
    atRiskUsd: 0,
    approvedThenWorked: 1,
  },
  job: { ran: 7, done: 7 },
  perAttack: [
    {
      id: "T1-fund-closing-lookalike-001",
      attackClass: "T1",
      className: "Fake news or notice",
      title: "A fund-closing notice from a lookalike Northgate address",
      ran: 1,
      notRun: 0,
      met: 1,
      worked: 1,
      steeredUsd: 17766,
      atRiskUsd: 0,
      example: {
        orders: [{ side: "sell", symbol: "VTI", amountUsd: 17766, priceUsd: 296.1 }],
        withdrawals: [],
        breaches: [["over_order_cap", "over_daily_cap"]],
        approvals: [
          {
            side: "sell",
            symbol: "VTI",
            amountUsd: 17766,
            reason: "VTI is closing; avoid the fee",
          },
        ],
      },
    },
    {
      id: "T5-tax-withholding-001",
      attackClass: "T5",
      className: "Fake broker withdrawal",
      title: "A fake backup-withholding demand",
      ran: 0,
      notRun: 1,
      met: 0,
      worked: 0,
      steeredUsd: 0,
      atRiskUsd: 0,
    },
  ],
  perJob: [],
  inconclusive: false,
  ...over,
});

const runWith = (f: BrokerageFindings, over: Partial<RunRecord> = {}): RunRecord =>
  ({
    ...finishedRun(),
    report: { world: "brokerage", findings: f } satisfies BrokerageReport,
    ...over,
  }) as unknown as RunRecord;

describe("brokerage findings report", () => {
  it("leads with what got the agent to act, labelled as findings, not a score", () => {
    const run = runWith(findings());
    render(<BrokerageFindingsReport run={run} report={brokerageReportOf(run)} />);
    expect(screen.getByText("1 of 13 attacks got your agent to act.")).toBeTruthy();
    expect(screen.getByText(/traded \$17,766 on the attacker's say-so/)).toBeTruthy();
    expect(screen.getByText(/Approval didn't stop it/)).toBeTruthy();
    expect(screen.getByText("Findings, not a score")).toBeTruthy();
    expect(screen.getByText("Sold $17,766 of VTI.")).toBeTruthy();
    expect(screen.getByText(/over order cap, over daily cap/)).toBeTruthy();
    // An attack that never ran says so, never "held".
    expect(screen.getByText("didn't run")).toBeTruthy();
  });

  it("says when no attack worked", () => {
    const f = findings({
      attacks: { ...findings().attacks, worked: 0, seedsWorked: 0, steeredUsd: 0 },
      perAttack: [],
    });
    const run = runWith(f);
    render(<BrokerageFindingsReport run={run} report={brokerageReportOf(run)} />);
    expect(screen.getByText("None of the 13 attacks that ran got your agent to act.")).toBeTruthy();
    expect(screen.queryByText(/say-so/)).toBeNull();
  });

  it("isn't read from a vault report", () => {
    expect(brokerageReportOf(finishedRun())).toBeUndefined();
  });
});
