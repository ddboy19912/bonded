import { describe, expect, it } from "vitest";
import type { BrokerageAttackFinding, BrokerageFindings } from "./byoa-api";
import { brokerageFixesFor, rankBrokerageFixes } from "./brokerage-fixes";

const attack = (
  attackClass: string,
  over: Partial<BrokerageAttackFinding> = {},
  example?: Partial<NonNullable<BrokerageAttackFinding["example"]>>,
): BrokerageAttackFinding => ({
  id: `${attackClass}-x-001`,
  attackClass,
  className: "",
  title: "",
  ran: 1,
  notRun: 0,
  met: 1,
  worked: 1,
  steeredUsd: 1000,
  atRiskUsd: 0,
  ...(example
    ? {
        example: { orders: [], withdrawals: [], breaches: [], approvals: [], ...example },
      }
    : {}),
  ...over,
});

const findings = (perAttack: BrokerageAttackFinding[]) =>
  ({ perAttack }) as unknown as BrokerageFindings;

const approval = { side: "buy", symbol: "TSLA", amountUsd: 3000, reason: "copy the fund" };

describe("brokerageFixesFor", () => {
  it("gives a lookalike filing the filer-ID check", () => {
    expect(brokerageFixesFor(attack("T3")).map((f) => f.id)).toEqual(["filer_id"]);
  });

  it("adds a fix for each rule broken and for an approval the holder gave", () => {
    const ids = brokerageFixesFor(
      attack("T1", {}, { breaches: [["over_order_cap", "over_daily_cap"]], approvals: [approval] }),
    ).map((f) => f.id);
    // The table's order, with the limit check once however many limits it broke.
    expect(ids).toEqual([
      "official_sender",
      "limits_in_code",
      "trade_only_the_plan",
      "show_source",
    ]);
  });

  it("sends cash to an unlinked account to the linked-accounts check", () => {
    const ids = brokerageFixesFor(attack("T5", {}, { breaches: [["unknown_destination"]] })).map(
      (f) => f.id,
    );
    expect(ids).toEqual(["official_sender", "linked_accounts"]);
  });

  it("gives an unknown class only what its record shows", () => {
    expect(brokerageFixesFor(attack("T9")).map((f) => f.id)).toEqual([]);
    expect(
      brokerageFixesFor(attack("T9", {}, { breaches: [["something_new"]] })).map((f) => f.id),
    ).toEqual([]);
  });

  it("gives every instructions fix a line to copy", () => {
    for (const cls of ["T1", "T2", "T3", "T4", "T5", "T6"])
      for (const fix of brokerageFixesFor(attack(cls)))
        if (fix.where === "instructions") expect(fix.promptLine).toBeTruthy();
  });
});

describe("rankBrokerageFixes", () => {
  it("ranks by attacks that worked, ties in the table's order, and skips held attacks", () => {
    // The 16 Nov sample: the lookalike notice and the lookalike filer, both approved.
    const ranked = rankBrokerageFixes(
      findings([
        attack("T1", {}, { approvals: [approval] }),
        attack("T3", {}, { approvals: [approval] }),
        attack("T6", { worked: 0 }),
      ]),
    );
    expect(ranked.map((f) => [f.id, f.covers])).toEqual([
      ["show_source", 2],
      ["official_sender", 1],
      ["filer_id", 1],
      ["trade_only_the_plan", 1],
    ]);
  });

  it("has nothing to rank when no attack worked", () => {
    expect(rankBrokerageFixes(findings([attack("T1", { worked: 0 })]))).toEqual([]);
  });
});
