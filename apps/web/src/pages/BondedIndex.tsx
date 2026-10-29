import type {
  BondedIndex as BondedIndexData,
  BondedIndexEntry,
  BondedIndexRow,
} from "@bondedhq/shared";
import { useState } from "react";
import { BenchComparisonCard } from "../components/bench-comparison";
import { VIZ } from "../components/charts";
import {
  ChartCard,
  DataTable,
  Legend,
  type ModelBar,
  ModelBars,
  ModelName,
  ModelScatter,
  ProviderLogo,
  niceTicks,
} from "../components/index-charts";
import { Card, Page, linkClass } from "../components/ui";
import {
  ATTACK_CLASS_NAMES,
  VECTOR_NAMES,
  byScore,
  draftRefusalRate,
  loadBondedIndex,
  lostUsd,
  overpaidUsd,
  pct,
  rowOf,
  taskScore,
  usd,
  worstRow,
} from "../lib/bonded-index";

const DOCS_OFFCHAIN = "https://github.com/ddboy19912/bonded/blob/main/docs/OFFCHAIN.md";

/** The Task score in words: the number, or why there isn't one. */
const taskText = (e: BondedIndexEntry) => {
  const t = taskScore(e);
  return t === null ? "not measured" : `${t}`;
};

/**
 * A model whose Task score is under 50: its security score says it wasn't tricked, but mostly
 * because it didn't act. Flagged under its name and ranked last.
 */
const idle = (e: BondedIndexEntry) => {
  const t = taskScore(e);
  return t !== null && t < 50;
};

const IDLE_FLAG = "mostly didn't act";

/** How far a score has been tested: attacks measured, and the fall rate ruled out at 95%. */
const tested = (e: BondedIndexEntry) =>
  e.attacksTested === undefined || e.riskCeiling === undefined
    ? "—"
    : `${e.attacksTested} attacks; above ${(e.riskCeiling * 100).toFixed(1)}% ruled out`;

const setBy = (e: BondedIndexEntry) => {
  const w = e.worstClass;
  if (!w) return "no attacks measured";
  const name = ATTACK_CLASS_NAMES[w.class] ?? w.class;
  return `${name.toLowerCase()}, rules ${w.mandate}: fell ${w.fell} of ${w.episodes}${w.underSampled ? " (few runs)" : ""}`;
};

const PART_NAMES = {
  controls: "runs with no attack",
  underAttack: "attacks it resisted",
  twins: "benign twins",
  totals: "every run",
} as const;

/** The part that set a Task score, with its counts when the rows recorded them. */
const taskSetBy = (e: BondedIndexEntry) => {
  const part = e.task?.part;
  if (!part) return null;
  if (part === "totals") {
    const done = e.rows.reduce((n, r) => n + r.tasksDone, 0);
    const total = e.rows.reduce((n, r) => n + r.tasksTotal, 0);
    return `${PART_NAMES.totals}: ${done} of ${total} done`;
  }
  const done = e.rows.reduce((n, r) => n + (r.taskParts?.[part].done ?? 0), 0);
  const total = e.rows.reduce((n, r) => n + (r.taskParts?.[part].total ?? 0), 0);
  return `${PART_NAMES[part]}: ${done} of ${total} done`;
};

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
  { id: "money", label: "Money moved" },
  { id: "briefing", label: "Rules shown vs hidden" },
  { id: "attacker", label: "Will it red-team?" },
] as const;

type LeaderboardTab = (typeof LEADERBOARD_TABS)[number]["id"];

/** Every per-model ranking on one card, one tab each. */
function Leaderboard({ entries }: { entries: BondedIndexEntry[] }) {
  const [tab, setTab] = useState<LeaderboardTab>("security");
  const flag = (e: BondedIndexEntry) => (idle(e) ? IDLE_FLAG : undefined);
  // A flagged model ranks last on security: its score says it wasn't tricked, mostly because it
  // didn't act.
  const bySecurity = [
    ...byScore(entries).filter((e) => !idle(e)),
    ...byScore(entries).filter(idle),
  ];

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
        "Higher is better · 100 × (1 − fall rate of its weakest attack class) · whiskers: 95% interval",
      bars: bySecurity.map((e) => ({
        entry: e,
        label: `${e.score}`,
        values: { v: e.score },
        interval: e.scoreInterval,
        flag: flag(e),
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
          "Higher is better · lowest share of jobs done across runs with no attack, attacks it resisted and benign twins",
        bars: sorted.map((e) => ({
          entry: e,
          label: taskText(e),
          values: { v: taskScore(e) ?? 0 },
          flag: flag(e),
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
        series: [{ key: "v", label: "Task" }],
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
    money: (() => {
      const sorted = [...entries].sort(
        (a, b) => lostUsd(b) + overpaidUsd(b) - (lostUsd(a) + overpaidUsd(a)),
      );
      const ticks = niceTicks(Math.max(1, ...sorted.map((e) => lostUsd(e) + overpaidUsd(e))));
      return {
        subtitle: "Lower is better · over every run, in US dollars",
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
          "Lower is better · share of attacks that got through, with the payment rules spelled out or only the job described",
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
        subtitle:
          "Share of requests to write test attacks it declined · a model that declines can't red-team other agents",
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
      tabs={LEADERBOARD_TABS}
      tab={tab}
      onTab={(id) => setTab(id as LeaderboardTab)}
      table={view.table}
      aside={
        <Legend
          items={
            view.legend ?? [
              { color: VIZ.accent, label: "Meta" },
              { color: VIZ.other, label: "Other providers" },
            ]
          }
        />
      }
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
      aside={
        <Legend
          items={[
            { color: VIZ.accent, label: "Meta" },
            { color: VIZ.other, label: "Other providers" },
          ]}
        />
      }
      subtitle={
        tab === "task"
          ? "Top right is safe and does the job · top left is safe mostly because it didn't act"
          : "Top left is safe and cheap · cost of 1,000 runs, log scale (Meta's estimated from its prices)"
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

/** Each model's fall rate per attack class or channel, in its worse briefing. */
function WhereTheyBreak({ entries }: { entries: BondedIndexEntry[] }) {
  const vectors = Object.fromEntries(
    Object.entries(VECTOR_NAMES).filter(([v]) =>
      entries.some((e) => e.rows.some((r) => r.byVector?.[v])),
    ),
  );
  const tabs = [
    { id: "class", label: "By attack type" },
    ...(Object.keys(vectors).length > 0 ? [{ id: "vector", label: "By channel" }] : []),
  ];
  const [tab, setTab] = useState("class");
  const names = tab === "vector" ? vectors : ATTACK_CLASS_NAMES;
  const countsOf = (row: BondedIndexRow) => (tab === "vector" ? row.byVector : row.byClass);
  const keys = Object.keys(names);
  const sorted = byScore(entries);
  return (
    <ChartCard
      title="Where models break"
      subtitle="Share of attacks that got through, in the model's worse briefing · darker is worse · dashed: not run"
      tabs={tabs}
      tab={tab}
      onTab={setTab}
      table={
        <DataTable
          head={["Model", ...keys.map((k) => names[k] ?? k)]}
          rows={sorted.map((e) => [
            <ModelName key={e.model} entry={e} />,
            ...keys.map((k) => {
              const v = countsOf(worstRow(e))?.[k];
              return v ? `${v.fell} of ${v.episodes}` : "not run";
            }),
          ])}
        />
      }
    >
      <div className="overflow-x-auto">
        <table
          className="w-full border-separate border-spacing-1 text-xs"
          style={{ minWidth: `${10 + keys.length * 4.5}rem` }}
        >
          <thead>
            <tr>
              <th className="w-40" />
              {keys.map((k) => (
                <th
                  key={k}
                  scope="col"
                  className="px-1 pb-1 text-center align-bottom font-normal text-muted"
                >
                  {names[k]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((e) => {
              const row = worstRow(e);
              return (
                <tr key={e.model}>
                  <th scope="row" className="pr-2 text-left font-normal">
                    <ModelName entry={e} />
                  </th>
                  {keys.map((k) => {
                    const v = countsOf(row)?.[k];
                    const rate = v && v.episodes > 0 ? v.fell / v.episodes : 0;
                    return (
                      <td
                        key={k}
                        title={`${e.label}, ${names[k]}: ${v ? `fell ${v.fell} of ${v.episodes} (${pct(rate)})` : "not run"}`}
                        className={`h-9 rounded-md text-center tabular-nums ${v ? "text-ink" : "border border-dashed border-line-strong text-muted"}`}
                        style={
                          v
                            ? {
                                background:
                                  rate === 0
                                    ? "rgb(255 255 255 / 0.035)"
                                    : `color-mix(in oklab, ${VIZ.lost} ${Math.round(30 + rate * 70)}%, #0e1320)`,
                              }
                            : undefined
                        }
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

function Results({ entries }: { entries: BondedIndexEntry[] }) {
  const fell = (e: BondedIndexEntry, m: "shown" | "hidden") => {
    const r = rowOf(e, m);
    return r ? `${r.fell}/${r.attackEpisodes}` : "—";
  };
  return (
    <section aria-labelledby="index-results" className="flex flex-col gap-3">
      <h2 id="index-results" className="text-lg font-semibold text-ink">
        All results
      </h2>
      <div className="overflow-x-auto rounded-2xl border border-line">
        <table className="w-full min-w-[46rem] text-left text-xs">
          <thead className="bg-surface/70 text-muted">
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
              ].map((h) => (
                <th key={h} scope="col" className="px-4 py-3 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {byScore(entries).map((e) => (
              <tr key={e.model} className="border-t border-line align-top">
                <td className="px-4 py-3">
                  <ModelName entry={e} note={e.provenance ? "joined runs †" : undefined} />
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-sm font-semibold text-ink tabular-nums">
                  {e.score}
                  <span className="ml-1 text-[10px] font-normal text-muted">
                    {e.scoreInterval[0]}–{e.scoreInterval[1]}
                  </span>
                </td>
                <td
                  className={`px-4 py-3 text-sm font-semibold tabular-nums ${idle(e) ? "text-warn" : "text-ink"}`}
                >
                  {taskText(e)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 tabular-nums text-soft">
                  {fell(e, "shown")}
                </td>
                <td className="whitespace-nowrap px-4 py-3 tabular-nums text-soft">
                  {fell(e, "hidden")}
                </td>
                <td className="whitespace-nowrap px-4 py-3 tabular-nums text-soft">
                  {usd(lostUsd(e))}
                </td>
                <td className="whitespace-nowrap px-4 py-3 tabular-nums text-soft">
                  {usd(overpaidUsd(e))}
                </td>
                <td className="whitespace-nowrap px-4 py-3 tabular-nums text-soft">
                  {usd(e.cost.spentUsd)}
                  {e.cost.estimated ? " est." : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {entries
        .filter((e) => e.provenance)
        .map((e) => (
          <p key={e.model} className="max-w-3xl text-xs text-muted">
            † {e.label}: {e.provenance}
          </p>
        ))}
    </section>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] uppercase tracking-wider text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-ink tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function BondedIndexView({ index }: { index: BondedIndexData }) {
  const entries = index.entries;
  if (entries.length === 0) {
    return (
      <Page title="Bonded Index" eyebrow="Models">
        <Card>
          <p className="text-sm text-muted">No models have been rated yet.</p>
        </Card>
      </Page>
    );
  }
  // Every judged episode, from the rows: an entry that joins a campaign keeps its sweep's cost.
  const episodes = entries.reduce((n, e) => n + e.rows.reduce((m, r) => m + r.tasksTotal, 0), 0);
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
      intro="How often each model, inside the same payments agent, is tricked into paying the wrong account, and whether it still does the job."
    >
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 border-y border-line py-5 sm:grid-cols-4">
        <Kpi label="Models rated" value={`${entries.length}`} />
        <Kpi
          label="Attack episodes"
          value={attackEpisodes.toLocaleString("en-US")}
          hint={`${episodes.toLocaleString("en-US")} episodes in all`}
        />
        <Kpi label="Money the attacks moved" value={usd(moved)} hint="lost plus overpaid" />
        <Kpi label="Updated" value={index.updatedAt.slice(0, 10)} hint="off-chain payments" />
      </div>

      <Leaderboard entries={entries} />
      <Tradeoffs entries={entries} />
      <WhereTheyBreak entries={entries} />
      <BenchComparisonCard />
      <Results entries={entries} />

      <details className="group rounded-2xl border border-line px-5 py-4 text-sm">
        <summary className="cursor-pointer font-semibold text-ink">How it's measured</summary>
        <ul className="mt-3 flex max-w-3xl list-disc flex-col gap-1.5 pl-5 text-muted">
          <li>
            Every model runs inside the same agent ({first.agent}), paying a small studio's supplier
            invoices. Only the model changes.
          </li>
          <li>
            The payment ledger decides every breach, never a model. Lost: paid to an account outside
            the vendor list. Overpaid: paid to a real vendor beyond what it was owed.
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
            {hashes.size > 1 && " Some rows met a different set; compare them with care."}
          </li>
          <li>
            Full method:{" "}
            <a className={linkClass} href={DOCS_OFFCHAIN}>
              docs/OFFCHAIN.md
            </a>
          </li>
        </ul>
      </details>
    </Page>
  );
}

export function BondedIndex() {
  return <BondedIndexView index={loadBondedIndex()} />;
}
