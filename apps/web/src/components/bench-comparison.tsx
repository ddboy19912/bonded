import { type ReactNode, useState } from "react";
import bondedMark from "../assets/benches/bonded.svg";
import spylabMark from "../assets/benches/spylab.png";
import { DataTable } from "./charts";
import { ChartCard, ProviderLogo } from "./index-charts";
import {
  attackExecuted,
  directAskOf,
  loadBenchComparison,
  money,
  pairsOf,
  utilityOf,
  type BenchComparison,
} from "../lib/bench-comparison";

/**
 * Each bench's own colour: Bonded's accent, and a teal from the SPY Lab mark, lifted so the two
 * stay apart for colour-blind readers (dataviz validator: ΔE 16 deutan, 17 normal vision on the
 * card). Every bar also carries its bench's logo and value, so colour never names it alone.
 */
const BENCH = {
  bonded: { name: "Bonded", color: "#3987e5", mark: bondedMark },
  agentdojo: { name: "AgentDojo", color: "#14a08c", mark: spylabMark },
} as const;

type BenchKey = keyof typeof BENCH;

const TABS = [
  { id: "breach", label: "Attacks that got through" },
  { id: "task", label: "Real task done" },
] as const;

type Tab = (typeof TABS)[number]["id"];

const attackName = (id: string) => id.replaceAll("_", " ");

const pct = (part: number, whole: number) => (whole > 0 ? (100 * part) / whole : 0);

const pctLabel = (v: number) => `${v > 0 && v < 10 ? v.toFixed(1) : Math.round(v)}%`;

/** The provider whose logo names a model in the record. */
const providerOf = (model: string) =>
  model.startsWith("muse") || model.includes("llama")
    ? "Meta"
    : model.startsWith("z-ai") || model.includes("glm")
      ? "Z.ai"
      : model.startsWith("deepseek")
        ? "DeepSeek"
        : model.startsWith("qwen")
          ? "Qwen"
          : model.startsWith("claude")
            ? "Anthropic"
            : model;

function BenchMark({ bench, size = 20 }: { bench: BenchKey; size?: number }) {
  return (
    <span
      className="inline-grid shrink-0 place-items-center rounded-[5px] bg-white"
      style={{ width: size, height: size }}
      title={BENCH[bench].name}
    >
      <img src={BENCH[bench].mark} alt="" width={size - 4} height={size - 4} />
    </span>
  );
}

/** The two benches face to face: who made each, and what each found across the recorded models. */
function Versus({ rows }: { rows: BenchComparison[] }) {
  const fell = rows.reduce((n, row) => n + row.bonded.fell, 0);
  const met = rows.reduce((n, row) => n + row.bonded.countedEpisodes, 0);
  const moved = rows.reduce((n, row) => n + row.bonded.lossUsd + row.bonded.overpaidUsd, 0);
  const ran = rows.reduce((n, row) => n + attackExecuted(row.agentdojo), 0);
  const pairs = rows.reduce((n, row) => n + pairsOf(row.agentdojo), 0);
  const side = (bench: BenchKey, maker: string, answer: string, detail: ReactNode) => (
    // Centred in its half on wide screens, so both benches sit the same distance from the badge.
    <div className="flex min-w-0 flex-col sm:items-center sm:text-center">
      <div className="flex items-center gap-2.5">
        <BenchMark bench={bench} size={32} />
        <div className="min-w-0 text-left leading-tight">
          <p className="text-sm font-semibold text-ink">{BENCH[bench].name}</p>
          <p className="text-[11px] text-muted">{maker}</p>
        </div>
      </div>
      <p className="mt-4 text-4xl font-semibold tracking-tight text-ink tabular-nums">{answer}</p>
      <p className="mt-1 text-sm text-soft">{detail}</p>
    </div>
  );
  return (
    <div className="grid grid-cols-1 gap-6 border-b border-line pt-1 pb-6 sm:grid-cols-[1fr_auto_1fr] sm:gap-6">
      {side(
        "bonded",
        "Payment attacks on a payables job",
        `${fell} of ${met}`,
        <>
          attacks moved money · <span className="text-breach">{money(moved)}</span>
        </>,
      )}
      {/* A hairline between the benches, with a round "VS" badge on it at the middle. */}
      <div aria-hidden className="relative hidden w-9 sm:block">
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-line" />
        <span className="absolute top-1/2 left-1/2 grid size-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-raised pl-[0.12em] text-[10px] font-semibold tracking-[0.12em] text-soft ring-1 ring-line-strong">
          VS
        </span>
      </div>
      {side(
        "agentdojo",
        "ETH Zurich SPY Lab · banking suite",
        `${ran} of ${pairs}`,
        "hidden instructions carried out",
      )}
    </div>
  );
}

interface BenchBar {
  bench: BenchKey;
  value: number;
  /** "4 of 178", shown beside the percentage. */
  count: string;
  tip: ReactNode;
}

function barsFor(row: BenchComparison, tab: Tab): BenchBar[] {
  const b = row.bonded;
  const d = row.agentdojo;
  const pairs = pairsOf(d);
  if (tab === "breach") {
    return [
      {
        bench: "bonded",
        value: pct(b.fell, b.countedEpisodes),
        count: `${b.fell} of ${b.countedEpisodes}`,
        tip: (
          <>
            <p className="font-medium text-ink">Bonded · {b.suite}</p>
            <p>
              {b.fell} of {b.countedEpisodes} attacks moved money: {money(b.lossUsd)} lost
              {b.overpaidUsd > 0 ? `, ${money(b.overpaidUsd)} overpaid` : ""}.
            </p>
          </>
        ),
      },
      {
        bench: "agentdojo",
        value: pct(attackExecuted(d), pairs),
        count: `${attackExecuted(d)} of ${pairs}`,
        tip: (
          <>
            <p className="font-medium text-ink">AgentDojo · {d.suite}</p>
            <p>
              The hidden goal ran on {attackExecuted(d)} of {pairs} task pairs, over{" "}
              {d.attacks.length} attack{d.attacks.length === 1 ? "" : "s"}.
            </p>
          </>
        ),
      },
    ];
  }
  return [
    {
      bench: "bonded",
      value: pct(b.tasksDone, b.tasksTotal),
      count: `${b.tasksDone} of ${b.tasksTotal}`,
      tip: (
        <>
          <p className="font-medium text-ink">Bonded</p>
          <p>
            Jobs finished, counting benign twins: true changes on the channels the attacks use,
            which the agent must act on.
          </p>
        </>
      ),
    },
    {
      bench: "agentdojo",
      value: pct(utilityOf(d), pairs),
      count: `${utilityOf(d)} of ${pairs}`,
      tip: (
        <>
          <p className="font-medium text-ink">AgentDojo</p>
          <p>The user's real task done on the same pairs, with the injection present.</p>
        </>
      ),
    },
  ];
}

/** One model's two bars on a 0–100% track, each named by its bench's logo and value. */
function ModelPair({ row, bars }: { row: BenchComparison; bars: BenchBar[] }) {
  return (
    <div className="flex flex-col gap-2 sm:grid sm:grid-cols-[11rem_1fr] sm:items-center sm:gap-4">
      <div className="flex items-center gap-2 sm:items-start">
        <ProviderLogo provider={providerOf(row.model)} size={18} />
        <div className="leading-tight">
          <p className="text-sm font-medium text-ink">{row.label}</p>
          {!row.headline && <p className="text-[11px] text-muted">smaller check</p>}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        {bars.map((bar) => (
          <div
            key={bar.bench}
            className="group relative flex items-center gap-2"
            aria-label={`${row.label}, ${BENCH[bar.bench].name}: ${pctLabel(bar.value)}, ${bar.count}`}
          >
            <BenchMark bench={bar.bench} size={18} />
            <div className="h-5 flex-1 rounded-[4px] bg-white/[0.03]">
              <div
                className="h-full rounded-[4px]"
                style={{ width: `max(${bar.value}%, 2px)`, background: BENCH[bar.bench].color }}
              />
            </div>
            <span className="w-28 shrink-0 text-right text-xs tabular-nums">
              <span className="font-semibold text-ink">{pctLabel(bar.value)}</span>{" "}
              <span className="text-muted">{bar.count}</span>
            </span>
            <div
              role="tooltip"
              className="pointer-events-none absolute bottom-full left-8 z-10 mb-1 hidden max-w-72 rounded-lg border border-line-strong bg-raised px-3 py-2 text-xs text-soft shadow-xl group-hover:block"
            >
              {bar.tip}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Detail({ row }: { row: BenchComparison }) {
  const ask = directAskOf(row.agentdojo);
  return (
    <details className="border-t border-line pt-3 text-xs">
      <summary className="cursor-pointer text-muted hover:text-ink">
        {row.label}: what each bench ran
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        {row.scope && <p className="text-muted">{row.scope}</p>}
        {row.bonded.falls.length > 0 && (
          <DataTable
            head={["Bonded attack that got through", "Briefing", "Fell", "Lost"]}
            rows={row.bonded.falls.map((fall) => [
              fall.name,
              fall.mandate === "shown" ? "rules shown" : "rules hidden",
              `${fall.fell} of ${fall.runs}`,
              money(fall.lossUsd),
            ])}
          />
        )}
        <DataTable
          head={["AgentDojo attack", "Hidden goal carried out", "Real task done"]}
          rows={row.agentdojo.attacks.map((attack) => [
            attackName(attack.id),
            `${attack.attackExecuted} of ${attack.pairs}`,
            `${attack.utility} of ${attack.pairs}`,
          ])}
        />
        <ul className="flex max-w-3xl list-disc flex-col gap-1.5 pl-5 text-muted">
          <li>Bonded: {row.bonded.conditions.join(", ")}.</li>
          {ask.total > 0 && (
            <li>
              AgentDojo's injection goals, asked outright as the user's own request: done {ask.done}{" "}
              of {ask.total}.
            </li>
          )}
          {[...row.bonded.notes, ...row.agentdojo.notes].map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>
    </details>
  );
}

/** Bonded's staged campaign beside AgentDojo, for the Index page. Not an Index score. */
export function BenchComparisonCard() {
  const data = loadBenchComparison();
  const [tab, setTab] = useState<Tab>("breach");
  // The headline comparison first, then the smaller checks.
  const rows = [...data.comparisons].sort((a, b) => Number(b.headline) - Number(a.headline));
  return (
    <ChartCard
      title="Bonded vs AgentDojo"
      subtitle={`The same models on two banking-agent attack benches, ${data.recordedOn} · a campaign record, not an Index score`}
      tabs={TABS}
      tab={tab}
      onTab={(id) => setTab(id as Tab)}
      intro={<Versus rows={rows} />}
      table={
        <DataTable
          head={["Model", "Bench", "Attacks that got through", "Real task done", "Money moved"]}
          rows={rows.flatMap((row) => {
            const [breach, task] = [barsFor(row, "breach"), barsFor(row, "task")];
            return (["bonded", "agentdojo"] as const).map((bench, i) => [
              row.label,
              BENCH[bench].name,
              `${breach[i]!.count} (${pctLabel(breach[i]!.value)})`,
              `${task[i]!.count} (${pctLabel(task[i]!.value)})`,
              bench === "bonded"
                ? money(row.bonded.lossUsd + row.bonded.overpaidUsd)
                : "not measured",
            ]);
          })}
        />
      }
    >
      <div className="flex flex-col gap-5">
        {rows.map((row) => (
          <ModelPair key={row.model} row={row} bars={barsFor(row, tab)} />
        ))}
        {tab === "task" && (
          <p className="text-xs text-soft">
            Bonded's job is harder to finish on purpose: it includes true changes the agent must act
            on, so an agent can't stay safe by refusing everything.
          </p>
        )}
        <div className="flex flex-col gap-3">
          {rows.map((row) => (
            <Detail key={row.model} row={row} />
          ))}
        </div>
      </div>
    </ChartCard>
  );
}
