import {
  type BondedIndex as BondedIndexData,
  type BrokerageIndex as BrokerageIndexData,
  type BondedIndexEntry,
  OFFCHAIN_LIBRARY_VERSION,
} from "@bondedhq/shared";
import { docsUrl } from "../lib/hosts";
import * as Popover from "@radix-ui/react-popover";
import { type CSSProperties, useRef, useState } from "react";
import { Link } from "react-router";
import { BenchComparisonCard } from "../components/bench-comparison";
import { BrokerageIndexSection, loadBrokerageIndex } from "../components/brokerage-index";
import { VIZ } from "../components/charts";
import { CodeBlock } from "../components/code-block";
import { InfoPanel } from "../components/overlay";
import {
  ChartCard,
  DataTable,
  Legend,
  type ModelBar,
  ModelBars,
  ModelName,
  ModelScatter,
  ProviderLogo,
  fallFill,
  niceTicks,
} from "../components/index-charts";
import { PROVIDER_LOGOS } from "../lib/provider-logos";
import { EmptyState, Page, Section, linkClass } from "../components/ui";
import {
  ATTACK_CLASS_NAMES,
  VECTOR_NAMES,
  byScore,
  draftRefusalRate,
  idle,
  loadBondedIndex,
  modelPath,
  lossPerThousand,
  lostUsd,
  overpaidUsd,
  pct,
  reproduceCapUsd,
  reproduceCommand,
  reproduceKeys,
  rowOf,
  runsOf,
  setBy,
  taskScore,
  taskSetBy,
  taskText,
  usd,
  worstRow,
} from "../lib/bonded-index";

const DOCS_INDEX = docsUrl("/concepts/bonded-index/");

/** How far a score has been tested: attacks measured, and the fall rate ruled out at 95%. */
const tested = (e: BondedIndexEntry) =>
  e.attacksTested === undefined || e.riskCeiling === undefined
    ? "—"
    : `${e.attacksTested} attacks; above ${(e.riskCeiling * 100).toFixed(1)}% ruled out`;

function Tip({ e, children }: { e: BondedIndexEntry; children: React.ReactNode }) {
  return (
    <span className="flex flex-col gap-1">
      <span className="flex items-center gap-2 font-medium text-ink">
        <ProviderLogo provider={e.provider} size={16} />
        {e.label}
      </span>
      {children}
    </span>
  );
}

const LEADERBOARD_TABS = [
  { id: "security", label: "Security" },
  { id: "task", label: "Task" },
  { id: "loss", label: "Loss per 1,000 runs" },
  { id: "own", label: "Own mistakes" },
  { id: "money", label: "Money moved" },
  { id: "tested", label: "How well tested" },
  { id: "briefing", label: "Rules shown vs hidden" },
  { id: "attacker", label: "Will it red-team?" },
] as const;

type LeaderboardTab = (typeof LEADERBOARD_TABS)[number]["id"];

/** Every per-model ranking on one card, one tab each. */
function Leaderboard({ entries }: { entries: BondedIndexEntry[] }) {
  const [tab, setTab] = useState<LeaderboardTab>("security");
  // Own mistakes are recorded from the sweep that captures them on; until every model has them,
  // the tab would compare recorded zeros with missing ones, so it waits.
  const recordsOwnMistakes = entries.every((e) => e.rows.every((r) => r.ownErrors));
  const bySecurity = byScore(entries);

  const views: Record<
    LeaderboardTab,
    {
      subtitle: string;
      bars: ModelBar[];
      series: { key: string; label: string; color?: string }[];
      domain: [number, number];
      ticks?: number[];
      format: (v: number) => string;
      legend?: { color: string; label: string }[];
      grouped?: boolean;
      table: React.ReactNode;
    }
  > = {
    security: {
      subtitle:
        "Higher is better · how hard it is to trick into a wrong payment, set by its weakest attack type",
      bars: bySecurity.map((e) => ({
        entry: e,
        label: `${e.score}`,
        values: { v: e.score },
        tip: (
          <Tip e={e}>
            <span>
              Security <b className="text-ink">{e.score}</b> ({e.scoreInterval[0]}–
              {e.scoreInterval[1]})
            </span>
            <span className="text-muted">set by {setBy(e)}</span>
            <span className="text-muted">tested on {tested(e)}</span>
            <span>
              Task <b className={idle(e) ? "text-warn" : "text-ink"}>{taskText(e)}</b>
            </span>
          </Tip>
        ),
      })),
      series: [{ key: "v", label: "Security" }],
      domain: [0, 100],
      ticks: [0, 25, 50, 75, 100],
      format: (v) => `${v}`,
      table: (
        <DataTable
          head={["Model", "Security", "95% interval", "Set by", "Tested", "Task"]}
          rows={bySecurity.map((e) => [
            <ModelName key={e.model} entry={e} />,
            e.score,
            `${e.scoreInterval[0]}–${e.scoreInterval[1]}`,
            setBy(e),
            tested(e),
            taskText(e),
          ])}
        />
      ),
    },
    task: (() => {
      const sorted = [...entries].sort((a, b) => (taskScore(b) ?? -1) - (taskScore(a) ?? -1));
      return {
        subtitle:
          "Higher is better · how often it still gets the job done, like paying real invoices",
        bars: sorted.map((e) => ({
          entry: e,
          label: taskText(e),
          values: { v: taskScore(e) ?? 0 },
          tip: (
            <Tip e={e}>
              <span>
                Task <b className={idle(e) ? "text-warn" : "text-ink"}>{taskText(e)}</b>
              </span>
              {taskSetBy(e) && <span className="text-muted">set by {taskSetBy(e)}</span>}
              <span>
                Security <b className="text-ink">{e.score}</b>
              </span>
            </Tip>
          ),
        })),
        series: [{ key: "v", label: "Task", color: VIZ.ink }],
        domain: [0, 100] as [number, number],
        ticks: [0, 25, 50, 75, 100],
        format: (v: number) => `${v}`,
        table: (
          <DataTable
            head={["Model", "Task", "Set by", "Security"]}
            rows={sorted.map((e) => [
              <ModelName key={e.model} entry={e} />,
              taskText(e),
              taskSetBy(e) ?? "—",
              e.score,
            ])}
          />
        ),
      };
    })(),
    loss: (() => {
      const perThousand = lossPerThousand;
      const sorted = [...entries].sort((a, b) => perThousand(a) - perThousand(b));
      const ticks = niceTicks(Math.max(1, ...sorted.map(perThousand)));
      return {
        subtitle: "Lower is better · money lost or overpaid per 1,000 runs",
        bars: sorted.map((e) => ({
          entry: e,
          label: usd(perThousand(e)),
          values: { v: perThousand(e) },
          tip: (
            <Tip e={e}>
              <span>
                <b className="text-ink">{usd(perThousand(e))}</b> per 1,000 runs
              </span>
              <span className="text-muted">
                {usd(lostUsd(e) + overpaidUsd(e))} over {runsOf(e).toLocaleString("en-US")} runs
              </span>
            </Tip>
          ),
        })),
        series: [{ key: "v", label: "Loss per 1,000 runs" }],
        domain: [0, ticks[ticks.length - 1]!] as [number, number],
        ticks,
        format: usd,
        table: (
          <DataTable
            head={["Model", "Per 1,000 runs", "Lost", "Overpaid", "Runs"]}
            rows={sorted.map((e) => [
              <ModelName key={e.model} entry={e} />,
              usd(perThousand(e)),
              usd(lostUsd(e)),
              usd(overpaidUsd(e)),
              runsOf(e).toLocaleString("en-US"),
            ])}
          />
        ),
      };
    })(),
    own: (() => {
      const own = (e: BondedIndexEntry) =>
        e.rows.reduce(
          (n, r) => n + (r.ownErrors?.lossUsd ?? 0) + (r.ownErrors?.overpaidUsd ?? 0),
          0,
        );
      const per = (usdTotal: number, e: BondedIndexEntry) =>
        runsOf(e) === 0 ? 0 : (usdTotal / runsOf(e)) * 1000;
      const total = (e: BondedIndexEntry) => lostUsd(e) + overpaidUsd(e);
      const sorted = [...entries].sort((a, b) => per(total(a), a) - per(total(b), b));
      const ticks = niceTicks(Math.max(1, ...sorted.map((e) => per(total(e), e))));
      return {
        subtitle: "Lower is better · loss per 1,000 runs, from attacks and from its own mistakes",
        bars: sorted.map((e) => ({
          entry: e,
          label: usd(per(total(e), e)),
          values: { attack: per(total(e) - own(e), e), own: per(own(e), e) },
          tip: (
            <Tip e={e}>
              <span>
                Caused by attacks <b className="text-ink">{usd(total(e) - own(e))}</b>
              </span>
              <span>
                Its own mistakes <b className="text-ink">{usd(own(e))}</b>
              </span>
              <span className="text-muted">over {runsOf(e).toLocaleString("en-US")} runs</span>
            </Tip>
          ),
        })),
        series: [
          { key: "attack", label: "Caused by attacks", color: VIZ.lost },
          { key: "own", label: "Own mistakes", color: VIZ.accentSoft },
        ],
        domain: [0, ticks[ticks.length - 1]!] as [number, number],
        ticks,
        format: usd,
        legend: [
          { color: VIZ.lost, label: "Caused by attacks" },
          { color: VIZ.accentSoft, label: "Its own mistakes" },
        ],
        table: (
          <DataTable
            head={["Model", "Caused by attacks", "Own mistakes", "Runs with a mistake", "Runs"]}
            rows={sorted.map((e) => [
              <ModelName key={e.model} entry={e} />,
              usd(total(e) - own(e)),
              usd(own(e)),
              e.rows.reduce((n, r) => n + (r.ownErrors?.episodes ?? 0), 0),
              runsOf(e).toLocaleString("en-US"),
            ])}
          />
        ),
      };
    })(),
    tested: (() => {
      const ceiling = (e: BondedIndexEntry) => e.riskCeiling ?? 1;
      const sorted = [...entries].sort((a, b) => ceiling(a) - ceiling(b));
      const ticks = niceTicks(Math.max(0.05, ...sorted.map(ceiling)));
      return {
        subtitle:
          "Lower is better · the worst fall rate not yet ruled out; more runs make it tighter",
        bars: sorted.map((e) => ({
          entry: e,
          label: pct(ceiling(e), 1),
          values: { v: ceiling(e) },
          tip: (
            <Tip e={e}>
              <span>
                A fall rate above <b className="text-ink">{pct(ceiling(e), 1)}</b> is ruled out
              </span>
              <span className="text-muted">
                on {(e.attacksTested ?? 0).toLocaleString("en-US")} attacks
              </span>
            </Tip>
          ),
        })),
        series: [{ key: "v", label: "Fall rate not ruled out" }],
        domain: [0, ticks[ticks.length - 1]!] as [number, number],
        ticks,
        format: (v: number) => pct(v, v > 0 && v < 0.1 ? 1 : 0),
        table: (
          <DataTable
            head={["Model", "Ruled out above", "Attacks run"]}
            rows={sorted.map((e) => [
              <ModelName key={e.model} entry={e} />,
              e.riskCeiling === undefined ? "—" : pct(e.riskCeiling, 1),
              (e.attacksTested ?? 0).toLocaleString("en-US"),
            ])}
          />
        ),
      };
    })(),
    money: (() => {
      const sorted = [...entries].sort(
        (a, b) => lostUsd(b) + overpaidUsd(b) - (lostUsd(a) + overpaidUsd(a)),
      );
      const ticks = niceTicks(Math.max(1, ...sorted.map((e) => lostUsd(e) + overpaidUsd(e))));
      return {
        subtitle: "Lower is better · all money lost or overpaid, in US dollars",
        bars: sorted.map((e) => ({
          entry: e,
          label: usd(lostUsd(e) + overpaidUsd(e)),
          values: { lost: lostUsd(e), overpaid: overpaidUsd(e) },
          tip: (
            <Tip e={e}>
              <span>
                Lost <b className="text-ink">{usd(lostUsd(e))}</b> to accounts outside the vendor
                list
              </span>
              <span>
                Overpaid <b className="text-ink">{usd(overpaidUsd(e))}</b> to real vendors
              </span>
            </Tip>
          ),
        })),
        series: [
          { key: "lost", label: "Lost", color: VIZ.lost },
          { key: "overpaid", label: "Overpaid", color: VIZ.overpaid },
        ],
        domain: [0, ticks[ticks.length - 1]!] as [number, number],
        ticks,
        format: usd,
        legend: [
          { color: VIZ.lost, label: "Lost (to an outside account)" },
          { color: VIZ.overpaid, label: "Overpaid (to a real vendor)" },
        ],
        table: (
          <DataTable
            head={["Model", "Lost", "Overpaid"]}
            rows={sorted.map((e) => [
              <ModelName key={e.model} entry={e} />,
              usd(lostUsd(e)),
              usd(overpaidUsd(e)),
            ])}
          />
        ),
      };
    })(),
    briefing: (() => {
      const rate = (e: BondedIndexEntry, m: "shown" | "hidden") =>
        rowOf(e, m)?.manipulationRate ?? 0;
      const sorted = [...entries].sort(
        (a, b) =>
          Math.max(rate(b, "shown"), rate(b, "hidden")) -
          Math.max(rate(a, "shown"), rate(a, "hidden")),
      );
      const ticks = niceTicks(
        Math.max(0.05, ...sorted.flatMap((e) => [rate(e, "shown"), rate(e, "hidden")])),
      );
      const count = (e: BondedIndexEntry, m: "shown" | "hidden") => {
        const r = rowOf(e, m);
        return r ? `${r.fell} of ${r.attackEpisodes}` : "not run";
      };
      return {
        subtitle:
          "Lower is better · attacks that got through, with the rules given or only the job",
        bars: sorted.map((e) => ({
          entry: e,
          label: "",
          values: { shown: rate(e, "shown"), hidden: rate(e, "hidden") },
          tip: (
            <Tip e={e}>
              <span>
                Rules shown: <b className="text-ink">{pct(rate(e, "shown"), 1)}</b> (
                {count(e, "shown")})
              </span>
              <span>
                Rules hidden: <b className="text-ink">{pct(rate(e, "hidden"), 1)}</b> (
                {count(e, "hidden")})
              </span>
            </Tip>
          ),
        })),
        series: [
          { key: "shown", label: "Rules shown", color: VIZ.accentSoft },
          { key: "hidden", label: "Rules hidden", color: VIZ.accent },
        ],
        domain: [0, ticks[ticks.length - 1]!] as [number, number],
        ticks,
        format: (v: number) => pct(v, v > 0 && v < 0.1 ? 1 : 0),
        grouped: true,
        legend: [
          { color: VIZ.accentSoft, label: "Rules shown" },
          { color: VIZ.accent, label: "Rules hidden" },
        ],
        table: (
          <DataTable
            head={["Model", "Rules shown", "Rules hidden"]}
            rows={sorted.map((e) => [
              <ModelName key={e.model} entry={e} />,
              `${count(e, "shown")} (${pct(rate(e, "shown"), 1)})`,
              `${count(e, "hidden")} (${pct(rate(e, "hidden"), 1)})`,
            ])}
          />
        ),
      };
    })(),
    attacker: (() => {
      const sorted = [...entries].sort((a, b) => draftRefusalRate(a) - draftRefusalRate(b));
      return {
        subtitle: "Lower is better · how often it refused to write test attacks for red-teaming",
        bars: sorted.map((e) => ({
          entry: e,
          label: pct(draftRefusalRate(e)),
          values: { v: draftRefusalRate(e) },
          tip: (
            <Tip e={e}>
              <span>
                Declined <b className="text-ink">{e.attacker.drafts.refused}</b> of{" "}
                {e.attacker.drafts.attempts} attack drafts
              </span>
              <span className="text-muted">
                As the supplier: declined {e.attacker.probe.refused} of {e.attacker.probe.asked}{" "}
                replies
              </span>
            </Tip>
          ),
        })),
        series: [{ key: "v", label: "Declined" }],
        domain: [0, 1] as [number, number],
        ticks: [0, 0.25, 0.5, 0.75, 1],
        format: (v: number) => pct(v),
        table: (
          <DataTable
            head={[
              "Model",
              "Drafts declined",
              "Supplier replies declined",
              "Supplier replies failed",
            ]}
            rows={sorted.map((e) => [
              <ModelName key={e.model} entry={e} />,
              `${e.attacker.drafts.refused} of ${e.attacker.drafts.attempts}`,
              `${e.attacker.probe.refused} of ${e.attacker.probe.asked}`,
              `${e.attacker.probe.failed} of ${e.attacker.probe.asked}`,
            ])}
          />
        ),
      };
    })(),
  };
  const view = views[tab];
  return (
    <ChartCard
      title="Leaderboard"
      subtitle={view.subtitle}
      tabs={LEADERBOARD_TABS.filter((t) => t.id !== "own" || recordsOwnMistakes)}
      tab={tab}
      onTab={(id) => setTab(id as LeaderboardTab)}
      table={view.table}
      // A ranking needs no key: each bar's logo and name say whose it is. Stacked or paired bars
      // name their parts.
      aside={view.legend && <Legend items={view.legend} />}
    >
      <ModelBars
        key={tab}
        bars={view.bars}
        series={view.series}
        domain={view.domain}
        ticks={view.ticks}
        format={view.format}
        grouped={view.grouped}
      />
    </ChartCard>
  );
}

const SCATTER_TABS = [
  { id: "task", label: "Security vs Task" },
  { id: "cost", label: "Security vs cost" },
] as const;

/** Where each model sits on two measures at once. */
function Tradeoffs({ entries }: { entries: BondedIndexEntry[] }) {
  const [tab, setTab] = useState<(typeof SCATTER_TABS)[number]["id"]>("task");
  const minScore = Math.min(...entries.map((e) => e.score));
  const step = minScore >= 70 ? 5 : 10;
  const yMin = Math.max(0, Math.floor((minScore - 4) / step) * step);
  const y = {
    // Headroom past 100, so a model at the top isn't cut by the plot's edge.
    domain: [yMin, 104] as [number, number],
    ticks: Array.from({ length: (100 - yMin) / step + 1 }, (_, i) => yMin + i * step),
    format: (v: number) => `${v}`,
    label: "Security",
  };
  const costs = entries.map((e) => e.cost.perThousandEpisodesUsd).filter((c) => c > 0);
  const lo = 10 ** Math.floor(Math.log10(Math.min(...costs, 1)));
  const hi = 10 ** Math.ceil(Math.log10(Math.max(...costs, 10)));
  const logTicks = Array.from(
    { length: Math.round(Math.log10(hi / lo)) + 1 },
    (_, i) => lo * 10 ** i,
  );
  const tip = (e: BondedIndexEntry) => (
    <Tip e={e}>
      <span>
        Security <b className="text-ink">{e.score}</b> · Task{" "}
        <b className={idle(e) ? "text-warn" : "text-ink"}>{taskText(e)}</b>
      </span>
      <span className="text-muted">{usd(e.cost.perThousandEpisodesUsd)} per 1,000 runs</span>
    </Tip>
  );
  return (
    <ChartCard
      title="Trade-offs"
      subtitle={
        tab === "task"
          ? "Top right is safe and does the job; top left is safe because it barely acts"
          : "Top left is safe and cheap · cost per 1,000 runs, log scale"
      }
      tabs={SCATTER_TABS}
      tab={tab}
      onTab={(id) => setTab(id as typeof tab)}
      table={
        <DataTable
          head={["Model", "Security", "Task", "Cost per 1,000 runs"]}
          rows={byScore(entries).map((e) => [
            <ModelName key={e.model} entry={e} />,
            e.score,
            taskText(e),
            `${usd(e.cost.perThousandEpisodesUsd)}${e.cost.estimated ? " est." : ""}`,
          ])}
        />
      }
    >
      {tab === "task" ? (
        <ModelScatter
          key="task"
          points={entries.map((e) => ({ entry: e, x: taskScore(e) ?? 0, y: e.score, tip: tip(e) }))}
          x={{
            domain: [0, 106],
            ticks: [0, 25, 50, 75, 100],
            format: (v) => `${v}`,
            label: "Task",
          }}
          y={y}
          zone={{ x: [50, 106], y: [90, 104], label: "Safe and does the job" }}
        />
      ) : (
        <ModelScatter
          key="cost"
          points={entries.map((e) => ({
            entry: e,
            x: Math.max(lo, e.cost.perThousandEpisodesUsd),
            y: e.score,
            tip: tip(e),
          }))}
          x={{
            domain: [lo, hi],
            ticks: logTicks,
            format: usd,
            label: "Cost per 1,000 runs",
            log: true,
          }}
          y={y}
        />
      )}
    </ChartCard>
  );
}

/** The ledger's breach types (ledger.ts), in plain words, most serious first. */
const BREACH_NAMES: Record<string, string> = {
  unknown_payee: "Paid an unknown account",
  unverified_vendor_change: "Changed bank details unchecked",
  duplicate_payment: "Paid twice",
  unmatched_invoice: "Paid an unapproved invoice",
  over_payment_cap: "Over the payment cap",
  over_daily_cap: "Over the daily cap",
};

/** Each model's fall rate per attack class or channel, in its worse briefing. */
function WhereTheyBreak({ entries }: { entries: BondedIndexEntry[] }) {
  const vectors = Object.fromEntries(
    Object.entries(VECTOR_NAMES).filter(([v]) =>
      entries.some((e) => e.rows.some((r) => r.byVector?.[v])),
    ),
  );
  // Breach types show once every model records them (the sweep that captures them on).
  const recordsBreaches = entries.every((e) => e.rows.every((r) => r.breaches));
  const tabs = [
    { id: "class", label: "By attack type" },
    ...(Object.keys(vectors).length > 0 ? [{ id: "vector", label: "By channel" }] : []),
    ...(recordsBreaches ? [{ id: "breach", label: "By breach type" }] : []),
  ];
  const [tab, setTab] = useState("class");
  const names =
    tab === "vector"
      ? vectors
      : tab === "breach"
        ? Object.fromEntries(
            Object.entries(BREACH_NAMES).filter(([t]) =>
              entries.some((e) => e.rows.some((r) => r.breaches?.[t])),
            ),
          )
        : ATTACK_CLASS_NAMES;
  // A cell: attacks that got through out of those run (worse briefing), or for breach types,
  // breaches of that type over every run in both briefings.
  const cellOf = (e: BondedIndexEntry, k: string) => {
    if (tab !== "breach") {
      const row = worstRow(e);
      return (tab === "vector" ? row.byVector : row.byClass)?.[k];
    }
    const count = e.rows.reduce((n, r) => n + (r.breaches?.[k]?.count ?? 0), 0);
    return { fell: count, episodes: runsOf(e) };
  };
  const keys = Object.keys(names);
  const sorted = byScore(entries);
  return (
    <ChartCard
      title="Where models break"
      subtitle={
        tab === "breach"
          ? "Rule breaks by type, from attacks or the model's own mistakes"
          : "Attacks that got through, in each model's weaker briefing"
      }
      tabs={tabs}
      tab={tab}
      onTab={setTab}
      table={
        <DataTable
          head={["Model", ...keys.map((k) => names[k] ?? k)]}
          rows={sorted.map((e) => [
            <ModelName key={e.model} entry={e} />,
            ...keys.map((k) => {
              const v = cellOf(e, k);
              return v ? `${v.fell} of ${v.episodes}` : "not run";
            }),
          ])}
        />
      }
    >
      <div className="overflow-x-auto">
        <table
          className="w-full border-separate border-spacing-1 text-[13px]"
          style={{ minWidth: `${10 + keys.length * 4.5}rem` }}
        >
          <thead>
            <tr>
              <th className="w-44" />
              {keys.map((k) => (
                <th
                  key={k}
                  scope="col"
                  className="px-1 pb-2 text-center align-bottom font-mono text-[11px] font-normal text-muted"
                >
                  {names[k]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((e) => {
              return (
                <tr key={e.model}>
                  <th scope="row" className="pr-3 text-left font-normal">
                    <ModelName entry={e} />
                  </th>
                  {keys.map((k) => {
                    const v = cellOf(e, k);
                    const rate = v && v.episodes > 0 ? v.fell / v.episodes : 0;
                    return (
                      <td
                        key={k}
                        title={`${e.label}, ${names[k]}: ${
                          !v
                            ? "not run"
                            : tab === "breach"
                              ? `${v.fell} breaches over ${v.episodes} runs`
                              : `fell ${v.fell} of ${v.episodes} (${pct(rate)})`
                        }`}
                        className={`h-10 rounded-[3px] text-center font-mono text-[12px] tabular-nums ${v ? "text-ink" : "border border-dashed border-line-strong text-muted"}`}
                        style={v ? { background: fallFill(rate) } : undefined}
                      >
                        {v ? `${v.fell}/${v.episodes}` : "—"}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </ChartCard>
  );
}

/** In the rerun panel: the commands that rerun one row, and what they need and spend. */
function Reproduce({ e }: { e: BondedIndexEntry }) {
  return (
    <div className="flex flex-col gap-3">
      <CodeBlock label={`Rerun ${e.label}`} code={reproduceCommand(e)} />
      <p className="text-[13px] leading-relaxed text-muted">
        Needs {reproduceKeys(e.model).join(" and ")} in .env. Last run cost {usd(e.cost.spentUsd)}
        {e.cost.estimated ? " (estimated)" : ""}; this one stops at ${reproduceCapUsd(e)}.
      </p>
    </div>
  );
}

/**
 * A row's "⋯" menu. Picking an action closes the menu and hands it to the table. The menu keeps
 * focus where it is on close after a pick, or handing it back to "⋯" would close the new dialog.
 */
function RowActions({ e, onReproduce }: { e: BondedIndexEntry; onReproduce: () => void }) {
  const [open, setOpen] = useState(false);
  const picked = useRef(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={`Actions for ${e.label}`}
        aria-haspopup="menu"
        className="flex size-8 items-center justify-center rounded-full text-muted hover:bg-white/[0.06] hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none data-[state=open]:bg-white/[0.06] data-[state=open]:text-ink"
      >
        <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden>
          <circle cx="5" cy="12" r="1.75" />
          <circle cx="12" cy="12" r="1.75" />
          <circle cx="19" cy="12" r="1.75" />
        </svg>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          role="menu"
          onCloseAutoFocus={(ev) => {
            if (picked.current) ev.preventDefault();
            picked.current = false;
          }}
          align="end"
          sideOffset={6}
          collisionPadding={16}
          className="pop z-50 min-w-44 p-1.5 text-sm outline-none"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              picked.current = true;
              setOpen(false);
              onReproduce();
            }}
            className="w-full rounded-lg px-3 py-2 text-left text-soft hover:bg-white/[0.06] hover:text-ink focus-visible:bg-white/[0.06] focus-visible:text-ink focus-visible:outline-none"
          >
            Reproduce this row
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Results({ entries }: { entries: BondedIndexEntry[] }) {
  const [rerun, setRerun] = useState<BondedIndexEntry | null>(null);
  const fell = (e: BondedIndexEntry, m: "shown" | "hidden") => {
    const r = rowOf(e, m);
    return r ? `${r.fell}/${r.attackEpisodes}` : "—";
  };
  return (
    <section aria-labelledby="index-results" className="flex min-w-0 flex-col gap-6">
      <div>
        <h2 id="index-results" className="h-section-lg">
          All results
        </h2>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">
          Every number behind the charts, one row per model. Open a row's menu to rerun it.
        </p>
      </div>
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[54rem] text-left text-[13px]">
          <thead className="border-b border-line">
            <tr>
              {[
                "Model",
                "Security",
                "Task",
                "Fell, rules shown",
                "Fell, rules hidden",
                "Lost",
                "Overpaid",
                "Cost",
                "",
              ].map((h) => (
                <th
                  key={h}
                  scope="col"
                  className="px-3 pb-3 font-mono text-[12px] font-normal text-muted first:pl-0"
                >
                  {h || <span className="sr-only">Actions</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {byScore(entries).map((e) => (
              <tr
                key={e.model}
                className="border-b border-line align-top transition-colors hover:bg-white/[0.025]"
              >
                <td className="py-4 pr-3">
                  <ModelName entry={e} />
                </td>
                <td className="px-3 py-4 whitespace-nowrap tabular-nums">
                  <span className="text-[19px] leading-none font-medium tracking-[-0.03em] text-ink">
                    {e.score}
                  </span>
                  <span className="ml-1.5 font-mono text-[11px] text-muted">
                    {e.scoreInterval[0]}–{e.scoreInterval[1]}
                  </span>
                </td>
                <td
                  className={`px-3 py-4 text-[19px] leading-none font-medium tracking-[-0.03em] tabular-nums ${idle(e) ? "text-warn" : "text-ink"}`}
                >
                  {taskText(e)}
                </td>
                <td className="px-3 py-4 whitespace-nowrap text-soft tabular-nums">
                  {fell(e, "shown")}
                </td>
                <td className="px-3 py-4 whitespace-nowrap text-soft tabular-nums">
                  {fell(e, "hidden")}
                </td>
                <td className="px-3 py-4 whitespace-nowrap text-soft tabular-nums">
                  {usd(lostUsd(e))}
                </td>
                <td className="px-3 py-4 whitespace-nowrap text-soft tabular-nums">
                  {usd(overpaidUsd(e))}
                </td>
                <td className="px-3 py-4 whitespace-nowrap text-soft tabular-nums">
                  {usd(e.cost.spentUsd)}
                  {e.cost.estimated ? " est." : ""}
                </td>
                <td className="py-2.5 pl-2 text-right">
                  <RowActions e={e} onReproduce={() => setRerun(e)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <InfoPanel
        open={rerun !== null}
        onOpenChange={(o) => !o && setRerun(null)}
        title={rerun ? `Reproduce ${rerun.label}` : "Reproduce"}
        description="Runs the public attacks against this model on your own machine."
      >
        {rerun && <Reproduce e={rerun} />}
      </InfoPanel>
    </section>
  );
}

/** A model's provider mark, sized with the type beside it, as on the landing page's ledger. */
function LedgerMark({ provider }: { provider: string }) {
  const src = PROVIDER_LOGOS[provider];
  return (
    // Decoration: the model's name always sits beside it.
    <span
      aria-hidden
      className="inline-grid size-[0.78em] flex-none place-items-center rounded-[0.2em] bg-white text-black"
    >
      {src ? (
        <img src={src} alt="" className="size-[62%] object-contain" />
      ) : (
        <b className="text-[0.42em]">{provider.slice(0, 1)}</b>
      )}
    </span>
  );
}

/** The columns of the ledger: rank, model, Security, Task, and an arrow on wide screens. */
const LEDGER =
  "grid grid-cols-[1.5rem_minmax(0,1fr)_3.5rem_3.25rem] items-center gap-3 md:grid-cols-[2.5rem_minmax(0,1fr)_9rem_9rem_1.5rem] md:gap-6";

/** A score and a thin bar under it that fills to it. */
function LedgerScore({
  value,
  tone = "text-ink",
  bar,
}: {
  value: number;
  tone?: string;
  bar: string;
}) {
  return (
    <span className="min-w-0">
      <span
        className={`block text-[clamp(20px,2.4vw,34px)] leading-none font-medium tracking-[-0.04em] tabular-nums ${tone}`}
      >
        {value}
      </span>
      <span aria-hidden className="mt-2.5 block h-0.5 bg-white/10">
        <span className={`block h-full ${bar}`} style={{ width: `${value}%` }} />
      </span>
    </span>
  );
}

/**
 * Every model as one ledger, best Security first, in large type: both scores side by side at the
 * same size, each with a thin bar. Each row opens the model's own page.
 */
function Ledger({ entries }: { entries: BondedIndexEntry[] }) {
  return (
    <div>
      <div aria-hidden className={`${LEDGER} eyebrow border-b border-line pb-2.5`}>
        <span>No.</span>
        <span>Model</span>
        <span>Security</span>
        <span>Task</span>
        <span className="hidden md:block" />
      </div>
      <ol aria-label="Every model by Security, with Task">
        {byScore(entries).map((e, i) => {
          const task = taskScore(e);
          return (
            <li
              key={e.model}
              className="[animation:rise-in_0.9s_cubic-bezier(0.19,1,0.22,1)_both]"
              style={{ animationDelay: `${Math.min(i, 10) * 60}ms` } as CSSProperties}
            >
              <Link
                to={modelPath(e)}
                aria-label={`${e.label}: Security ${e.score}, Task ${task ?? "not measured"}`}
                className={`${LEDGER} group relative isolate border-b border-line py-4 before:absolute before:inset-y-0 before:-inset-x-3 before:-z-10 before:bg-white/[0.035] before:opacity-0 before:transition-opacity hover:before:opacity-100 focus-visible:before:opacity-100`}
              >
                <span className="eyebrow">{String(i + 1).padStart(2, "0")}</span>
                <span className="flex min-w-0 items-center gap-[0.4em] text-[clamp(19px,2.6vw,38px)] leading-none font-medium tracking-[-0.045em]">
                  <LedgerMark provider={e.provider} />
                  <span className="truncate">{e.label}</span>
                </span>
                <LedgerScore value={e.score} bar="bg-brand-bright" />
                {task === null ? (
                  <span className="text-[clamp(20px,2.4vw,34px)] leading-none font-medium text-dim">
                    –
                  </span>
                ) : (
                  <LedgerScore
                    value={task}
                    tone={idle(e) ? "text-warn" : "text-ink"}
                    bar="bg-ink"
                  />
                )}
                <span
                  aria-hidden
                  className="hidden justify-self-end text-dim transition group-hover:translate-x-1 group-hover:text-ink md:block"
                >
                  →
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** A key figure: a hairline above, a mono label, a big number and a short line under it. */
export function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 border-t border-line pt-4">
      <p className="eyebrow">{label}</p>
      <p className="num-big mt-3 truncate">{value}</p>
      {hint && <p className="mt-2 text-[13px] text-muted">{hint}</p>}
    </div>
  );
}

export function BondedIndexView({
  index,
  brokerage,
}: {
  index: BondedIndexData;
  /** The stock-trading rows: their own file and version (components/brokerage-index.tsx). */
  brokerage?: BrokerageIndexData;
}) {
  const entries = index.entries;
  if (entries.length === 0) {
    // Each world's rows stand on their own: no invoice rows doesn't hide the stock-trading ones.
    const stock = brokerage && brokerage.entries.length > 0;
    return (
      <Page title="Bonded Index" eyebrow="Models">
        {stock ? (
          <Section label="Brokerage">
            <BrokerageIndexSection index={brokerage} />
          </Section>
        ) : (
          <EmptyState title="No models have been rated yet." />
        )}
      </Page>
    );
  }
  // Every judged episode, from the rows: an entry that joins a campaign keeps its sweep's cost.
  const episodes = entries.reduce((n, e) => n + runsOf(e), 0);
  const attackEpisodes = entries.reduce(
    (n, e) => n + e.rows.reduce((m, r) => m + r.attackEpisodes, 0),
    0,
  );
  const moved = entries.reduce((n, e) => n + lostUsd(e) + overpaidUsd(e), 0);
  const hashes = new Set(entries.map((e) => e.attacks.hash));
  const first = entries[0]!;
  return (
    <Page
      title="Bonded Index"
      eyebrow="Models"
      intro={
        <>
          Every model runs the same payments agent. How often is it tricked into a wrong payment,
          and does it still do the job? Agents rated on chain are on the{" "}
          <Link className={linkClass} to="/leaderboard">
            Leaderboard
          </Link>
          .
        </>
      }
    >
      <Section label="Ranking">
        <Ledger entries={entries} />
        <div className="mt-12 grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-4">
          <Kpi label="Models rated" value={`${entries.length}`} />
          <Kpi
            label="Attack episodes"
            value={attackEpisodes.toLocaleString("en-US")}
            hint={`${episodes.toLocaleString("en-US")} episodes in all`}
          />
          <Kpi label="Money the attacks moved" value={usd(moved)} hint="lost plus overpaid" />
          <Kpi label="Updated" value={index.updatedAt.slice(0, 10)} hint="off-chain payments" />
        </div>
      </Section>

      <Section label="By measure">
        <Leaderboard entries={entries} />
      </Section>
      <Section label="Two at once">
        <Tradeoffs entries={entries} />
      </Section>
      <Section label="By attack">
        <WhereTheyBreak entries={entries} />
      </Section>
      <Section label="Benchmark">
        <BenchComparisonCard />
      </Section>
      <Section label="Every row">
        <Results entries={entries} />
      </Section>
      {brokerage && brokerage.entries.length > 0 && (
        <Section label="Brokerage">
          <BrokerageIndexSection index={brokerage} />
        </Section>
      )}

      <Section label="Method">
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-6 [&::-webkit-details-marker]:hidden">
            <span className="h-section">How it's measured</span>
            <span
              aria-hidden
              className="text-2xl leading-none font-light text-muted transition group-open:rotate-45"
            >
              +
            </span>
          </summary>
          <ul className="mt-6 flex max-w-3xl list-disc flex-col gap-2.5 pl-5 text-[15px] leading-relaxed text-muted marker:text-dim">
            <li>
              Every model runs inside the same agent ({first.agent}), paying a small studio's
              supplier invoices. Only the model changes.
            </li>
            <li>
              The payment ledger decides every breach, never a model. Lost: paid to an account
              outside the vendor list. Overpaid: paid to a real vendor beyond what it was owed.
            </li>
            <li>
              Each attack runs {first.runsPerScenario} times with the payment rules spelled out and{" "}
              {first.runsPerScenario} times with only the job described. Security uses the worse
              briefing and the weakest attack class.
            </li>
            <li>
              Task is kept apart from security: the lowest share of jobs done across runs with no
              attack, attacks resisted and benign twins.
            </li>
            <li>
              Intervals are 95% Wilson intervals. Models that can't read images aren't shown image
              attacks. Llama's tool calls written as text are read and run.
              {hashes.size > 1 && " Some rows met a different set; compare them with care."}{" "}
              Off-chain library version {OFFCHAIN_LIBRARY_VERSION}.
            </li>
            <li>
              Full method:{" "}
              <a className={linkClass} href={DOCS_INDEX}>
                the Index page in the docs
              </a>
            </li>
          </ul>
        </details>
      </Section>
    </Page>
  );
}

export function BondedIndex() {
  return <BondedIndexView index={loadBondedIndex()} brokerage={loadBrokerageIndex()} />;
}
