import { useState } from "react";
import {
  BROKERAGE_LIBRARY_VERSION,
  BrokerageIndex,
  type BrokerageIndexEntry,
} from "@bondedhq/shared";
import raw from "../../../../config/brokerage-index.json?raw";
import { ChartCard, DataTable, fallFill, ModelBars, ProviderLogo } from "./index-charts";

/**
 * The Index's stock-trading rows (config/brokerage-index.json, written by the Arena's
 * `brokerage-index` sweep). Their own file and library version, apart from the invoice rows, so a
 * release in one world never re-rates the other. Parsed with the shared schema at load.
 */
export function loadBrokerageIndex(text: string = raw): BrokerageIndex {
  return BrokerageIndex.parse(JSON.parse(text));
}

/** The brokerage attack classes (T1 to T6), as the page names them. */
export const BROKER_CLASS_NAMES: Record<string, string> = {
  T1: "Fake news or notice",
  T2: "Spoofed price move",
  T3: "Poisoned filing",
  T4: "Social media pump",
  T5: "Fake withdrawal",
  T6: "Instructions in research",
};

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const pct = (r: number) => `${Math.round(r * 100)}%`;

/** Attacks that worked over attacks counted, both briefings together. */
const worked = (e: BrokerageIndexEntry) => {
  const fell = e.rows.reduce((n, r) => n + r.fell, 0);
  return `${fell} of ${e.attacksTested}`;
};

const steered = (e: BrokerageIndexEntry) => e.rows.reduce((n, r) => n + r.steeredUsd, 0);
const notMet = (e: BrokerageIndexEntry) => e.rows.reduce((n, r) => n + r.notMet, 0);
const notFinished = (e: BrokerageIndexEntry) => e.rows.reduce((n, r) => n + r.notFinished, 0);

/** Security as shown: unmeasured when no attack counted, never 100. */
const securityText = (e: BrokerageIndexEntry) =>
  e.score === null ? "not measured" : `${e.score} (${e.scoreInterval[0]}–${e.scoreInterval[1]})`;

/** Rated on an older brokerage library: not comparable with current rows. */
const older = (e: BrokerageIndexEntry) => e.libraryVersion < BROKERAGE_LIBRARY_VERSION;

/** A class's counts over both briefings: how often it got through. */
function classCell(e: BrokerageIndexEntry, cls: string) {
  const counts = e.rows.map((r) => r.byClass[cls]).filter((c) => c !== undefined);
  if (counts.length === 0) return undefined;
  return {
    fell: counts.reduce((n, c) => n + c.fell, 0),
    episodes: counts.reduce((n, c) => n + c.episodes, 0),
  };
}

const TABS = [
  { id: "security", label: "Security" },
  { id: "task", label: "Task" },
  { id: "class", label: "Where models break" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const SUBTITLES: Record<Tab, string> = {
  security: "Higher is better · how hard it is to trick into a bad trade",
  task: "Higher is better · does it still do the job?",
  class: "Attacks that got through, both briefings together",
};

function ResultsTable({ entries }: { entries: BrokerageIndexEntry[] }) {
  return (
    <DataTable
      head={[
        "Model",
        "Security",
        "Task",
        "Attacks that worked",
        "Never read",
        "Didn't finish",
        "Traded on them",
        "Cost",
      ]}
      rows={entries.map((e) => [
        <span key={e.model} className="flex items-start gap-2">
          <span className="mt-px">
            <ProviderLogo provider={e.provider} />
          </span>
          <span className="min-w-0 text-ink">
            {e.label}
            {e.incomplete && (
              <span className="block text-[10px] text-warn">Incomplete: the run stopped early</span>
            )}
            {older(e) && (
              <span className="block text-[10px] text-muted">
                Older library (version {e.libraryVersion}): not in the charts
              </span>
            )}
          </span>
        </span>,
        securityText(e),
        e.task.score === null ? "—" : `${e.task.score}`,
        worked(e),
        `${notMet(e)}`,
        `${notFinished(e)}`,
        usd(steered(e)),
        `$${e.cost.spentUsd.toFixed(2)}${e.cost.estimated ? " est." : ""}`,
      ])}
    />
  );
}

/** Each model's attack types as a heat grid, like the invoice rows' "Where models break". */
function ClassGrid({ entries }: { entries: BrokerageIndexEntry[] }) {
  const keys = Object.keys(BROKER_CLASS_NAMES).filter((k) => entries.some((e) => classCell(e, k)));
  return (
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
                {BROKER_CLASS_NAMES[k]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.model}>
              <th scope="row" className="pr-2 text-left font-normal">
                <span className="flex items-center gap-2 text-ink">
                  <ProviderLogo provider={e.provider} />
                  {e.label}
                </span>
              </th>
              {keys.map((k) => {
                const v = classCell(e, k);
                const rate = v && v.episodes > 0 ? v.fell / v.episodes : 0;
                return (
                  <td
                    key={k}
                    title={`${e.label}, ${BROKER_CLASS_NAMES[k]}: ${
                      v ? `got through ${v.fell} of ${v.episodes} (${pct(rate)})` : "never read"
                    }`}
                    className={`h-9 rounded-md text-center tabular-nums ${v ? "text-ink" : "border border-dashed border-line-strong text-muted"}`}
                    style={v ? { background: fallFill(rate) } : undefined}
                  >
                    {v ? `${v.fell}/${v.episodes}` : "—"}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The stock-trading card: Security, Task and where models break, with the table behind it. */
export function BrokerageIndexSection({ index }: { index: BrokerageIndex }) {
  const [tab, setTab] = useState<Tab>("security");
  const all = index.entries;
  if (all.length === 0) return null;
  // The charts rank only rows on the current library; older ones stay in the table, marked.
  const current = all.filter((e) => !older(e));
  const entries = current.length > 0 ? current : all;
  const first = entries[0]!;
  const versions = new Set(entries.map((e) => e.libraryVersion));
  const byTask = [...entries].sort((a, b) => (b.task.score ?? -1) - (a.task.score ?? -1));
  // A model with no attack counted has no Security to chart; the table says "not measured".
  const measured = entries.filter((e) => e.score !== null);
  const bars = (list: BrokerageIndexEntry[], value: (e: BrokerageIndexEntry) => number | null) =>
    list.map((e) => ({
      entry: e,
      label: value(e) === null ? "—" : `${value(e)}`,
      values: { v: value(e) ?? 0 },
      tip: (
        <span className="flex flex-col gap-0.5">
          <b className="text-ink">{e.label}</b>
          <span>
            Security <b className="text-ink">{securityText(e)}</b> · Task{" "}
            <b className="text-ink">{e.task.score ?? "—"}</b>
          </span>
          <span className="text-muted">
            {worked(e)} attacks worked · {notMet(e)} never read
          </span>
        </span>
      ),
    }));
  return (
    <div className="flex flex-col gap-3">
      <ChartCard
        title="Stock trading"
        subtitle={SUBTITLES[tab]}
        tabs={TABS}
        tab={tab}
        onTab={(id) => setTab(id as Tab)}
        table={<ResultsTable entries={[...entries, ...all.filter(older)]} />}
      >
        {tab === "class" ? (
          <ClassGrid entries={entries} />
        ) : (
          <ModelBars
            key={tab}
            bars={
              tab === "task" ? bars(byTask, (e) => e.task.score) : bars(measured, (e) => e.score)
            }
            series={[{ key: "v", label: tab === "task" ? "Task" : "Security" }]}
            domain={[0, 100]}
            ticks={[0, 25, 50, 75, 100]}
            format={(v) => `${v}`}
          />
        )}
      </ChartCard>
      <p className="max-w-3xl text-xs text-muted">
        The same models running an investing agent at a broker: {first.attacks.seeds} attacks and{" "}
        {first.attacks.twins} genuine look-alikes, each run {first.runsPerScenario} times with the
        rules shown and {first.runsPerScenario} times without. Attacks a model never read aren't
        counted. Brokerage library version {[...versions].join(", ")}.
      </p>
    </div>
  );
}
