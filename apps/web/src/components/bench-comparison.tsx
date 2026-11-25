import { type ReactNode, useState } from "react";
import bondedMark from "../assets/benches/bonded.svg";
import spylabMark from "../assets/benches/spylab.png";
import { DataTable } from "./charts";
import { ChartCard, ProviderLogo } from "./index-charts";
import {
  attackExecuted,
  directAskOf,
  fallsBySeed,
  loadBenchComparison,
  metOf,
  money,
  movedOf,
  pairsOf,
  utilityOf,
  type BenchComparison,
  type BenchFall,
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
  { id: "breach", label: "Attacks that worked" },
  { id: "task", label: "Finished the job" },
] as const;

type Tab = (typeof TABS)[number]["id"];

/** AgentDojo's attack ids, as plain names. */
const ATTACK_NAMES: Record<string, string> = {
  direct: "Direct request",
  ignore_previous: '"Ignore previous instructions"',
  important_instructions: '"Important instructions"',
  tool_knowledge: "Tool knowledge",
};

const attackName = (id: string) => ATTACK_NAMES[id] ?? id.replaceAll("_", " ");

/** How the attack reached the agent, in plain words. */
const DELIVERY: Record<BenchComparison["channels"], string> = {
  pushed: "sent with the task",
  fetched: "found through its tools",
};

const rowKey = (row: BenchComparison) => `${row.model}-${row.channels}`;

/** Counts with thousands separators, for the big numbers. */
const count = (n: number) => n.toLocaleString("en-US");

/** Whole dollars for the big numbers; the tables keep the cents. */
const dollars = (usd: number) => money(Math.round(usd));

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

/** The two benches face to face, added up across every row: who made each, and what each found. */
function Versus({ rows }: { rows: BenchComparison[] }) {
  const sum = (part: (row: BenchComparison) => number) => rows.reduce((n, row) => n + part(row), 0);
  const fell = sum((row) => row.bonded.fell);
  const met = sum((row) => row.bonded.countedEpisodes);
  const moved = sum((row) => row.bonded.lossUsd + row.bonded.overpaidUsd);
  const ran = sum((row) => attackExecuted(row.agentdojo));
  const theirMet = sum((row) => metOf(row.agentdojo));
  const theirs = sum((row) => movedOf(row.agentdojo) ?? 0);
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
        "Payment attacks",
        `${count(fell)} of ${count(met)}`,
        <>
          attacks worked · <span className="text-breach">{dollars(moved)}</span> paid wrongly
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
        "ETH Zurich benchmark",
        `${count(ran)} of ${count(theirMet)}`,
        theirs > 0 ? (
          <>
            attacks worked · <span className="text-breach">{dollars(theirs)}</span> paid wrongly
          </>
        ) : (
          "attacks worked"
        ),
      )}
      <p className="text-xs text-muted sm:col-span-3 sm:text-center">
        All {rows.length} runs below, added up.
      </p>
    </div>
  );
}

interface BenchBar {
  bench: BenchKey;
  /** Which measure, when a bench shows more than one ("Whole job", "Paid right"). */
  measure?: string;
  /** A lighter fill for a bench's second measure. */
  faint?: boolean;
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
            <p className="font-medium text-ink">{b.suite}</p>
            <p>
              {money(b.lossUsd)} lost
              {b.overpaidUsd > 0 ? `, ${money(b.overpaidUsd)} overpaid` : ""}.
            </p>
          </>
        ),
      },
      {
        bench: "agentdojo",
        value: pct(attackExecuted(d), metOf(d)),
        count: `${attackExecuted(d)} of ${metOf(d)}`,
        tip: (
          <>
            <p className="font-medium text-ink">AgentDojo · {d.suite}</p>
            <p>
              {d.attacks.length} attack style{d.attacks.length === 1 ? "" : "s"}
              {movedOf(d) ? `, ${money(movedOf(d)!)} lost or overpaid` : ""}.
            </p>
          </>
        ),
      },
    ];
  }
  return [
    {
      bench: "bonded",
      measure: "Whole job",
      value: pct(b.tasksDone, b.tasksTotal),
      count: `${b.tasksDone} of ${b.tasksTotal}`,
      tip: (
        <>
          <p className="font-medium text-ink">Bonded · whole job</p>
          <p>Every part done: payments, replies, approvals and real changes.</p>
        </>
      ),
    },
    {
      bench: "bonded",
      measure: "Paid right",
      faint: true,
      value: pct(b.paymentsDone, b.tasksTotal),
      count: `${b.paymentsDone} of ${b.tasksTotal}`,
      tip: (
        <>
          <p className="font-medium text-ink">Bonded · paid right</p>
          <p>Every invoice paid in full to the right account, nothing to an attacker.</p>
        </>
      ),
    },
    {
      bench: "agentdojo",
      measure: "User task",
      value: pct(utilityOf(d), pairs),
      count: `${utilityOf(d)} of ${pairs}`,
      tip: (
        <>
          <p className="font-medium text-ink">AgentDojo</p>
          <p>The user's request, done despite the attack.</p>
        </>
      ),
    },
  ];
}

/**
 * One model's bars on a 0–100% track, each named by its bench's logo and value. The model's name
 * opens its details right under its bars, so they sit next to what they explain.
 */
function ModelPair({
  row,
  bars,
  open,
  onToggle,
}: {
  row: BenchComparison;
  bars: BenchBar[];
  open: boolean;
  onToggle: () => void;
}) {
  const panel = `bench-detail-${rowKey(row).replaceAll(/[^a-z0-9-]/gi, "-")}`;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:grid sm:grid-cols-[11rem_1fr] sm:items-center sm:gap-4">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={panel}
          className="group/model flex items-center gap-2 rounded-md text-left sm:items-start"
        >
          <ProviderLogo provider={providerOf(row.model)} size={18} />
          <span className="leading-tight">
            <span className="block text-sm font-medium text-ink">{row.label}</span>
            <span className="block text-[11px] text-muted">attack {DELIVERY[row.channels]}</span>
            <span className="mt-1 flex items-center gap-1 text-[11px] text-soft group-hover/model:text-ink">
              <svg
                aria-hidden
                viewBox="0 0 12 12"
                className={`size-2.5 transition-transform ${open ? "rotate-90" : ""}`}
              >
                <path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              </svg>
              {open ? "Hide details" : "Details"}
            </span>
          </span>
        </button>
        <div className="flex flex-col gap-1.5">
          {bars.map((bar) => (
            <div
              key={`${bar.bench}-${bar.measure ?? ""}`}
              className="group relative flex items-center gap-2"
              aria-label={`${row.label}, ${BENCH[bar.bench].name}${bar.measure ? ` (${bar.measure.toLowerCase()})` : ""}: ${pctLabel(bar.value)}, ${bar.count}`}
            >
              <BenchMark bench={bar.bench} size={18} />
              {bar.measure && (
                <span className="w-16 shrink-0 text-[11px] text-muted">{bar.measure}</span>
              )}
              <div className="h-5 flex-1 rounded-[4px] bg-white/[0.03]">
                <div
                  className="h-full rounded-[4px]"
                  style={{
                    width: `max(${bar.value}%, 2px)`,
                    background: BENCH[bar.bench].color,
                    opacity: bar.faint ? 0.5 : 1,
                  }}
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
      {open && <Detail id={panel} row={row} />}
    </div>
  );
}

/** One briefing's result for an attack: "2 of 3 · $3,680", or a dash when it never worked. */
function FallCell({ fall }: { fall?: BenchFall }) {
  if (!fall) return <span className="text-muted">–</span>;
  return (
    <>
      <span className="text-ink">
        {fall.fell} of {fall.runs}
      </span>
      <span className="text-muted"> · {dollars(fall.lossUsd + fall.overpaidUsd)}</span>
    </>
  );
}

function Detail({ id, row }: { id: string; row: BenchComparison }) {
  const ask = directAskOf(row.agentdojo);
  return (
    // Under the bars, on a hairline, so it reads as part of this model's row.
    <div id={id} className="flex flex-col gap-3 border-l border-line pl-4 text-xs sm:ml-[12rem]">
      <div className="flex flex-col gap-3">
        {row.scope && <p className="text-muted">{row.scope}</p>}
        {row.bonded.falls.length > 0 && (
          <DataTable
            head={["Bonded attack that worked", "Rules withheld", "Rules given"]}
            rows={fallsBySeed(row.bonded.falls).map((seed) => [
              seed.name,
              <FallCell key="hidden" fall={seed.hidden} />,
              <FallCell key="shown" fall={seed.shown} />,
            ])}
          />
        )}
        <DataTable
          head={["AgentDojo attack", "Worked", "Job done", "Lost or overpaid"]}
          rows={row.agentdojo.attacks.map((attack) => [
            attackName(attack.id),
            `${attack.attackExecuted} of ${attack.met ?? attack.pairs}`,
            `${attack.utility} of ${attack.pairs}`,
            attack.movedUsd === undefined ? "not measured" : money(attack.movedUsd),
          ])}
        />
        <ul className="flex max-w-3xl list-disc flex-col gap-1.5 pl-5 text-muted">
          <li>Bonded: {row.bonded.conditions.join(", ")}.</li>
          {ask.total > 0 && (
            <li>
              Asked openly, it did {ask.done} of {ask.total} of AgentDojo's attack goals.
            </li>
          )}
          {[...row.bonded.notes, ...row.agentdojo.notes].map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Bonded's staged campaign beside AgentDojo, for the Index page. Not an Index score. */
export function BenchComparisonCard() {
  const data = loadBenchComparison();
  const [tab, setTab] = useState<Tab>("breach");
  // One model's details open at a time.
  const [openKey, setOpenKey] = useState<string | null>(null);
  // The headline comparison first, then the rest in the record's order.
  const rows = [...data.comparisons].sort((a, b) => Number(b.headline) - Number(a.headline));
  const models = new Set(rows.map((row) => row.model)).size;
  return (
    <ChartCard
      title="Bonded vs AgentDojo"
      subtitle={`Same ${models === 1 ? "model" : "models"}, two attack tests`}
      tabs={TABS}
      tab={tab}
      onTab={(id) => setTab(id as Tab)}
      intro={<Versus rows={rows} />}
      table={
        <DataTable
          head={[
            "Model",
            "Attack",
            "Test",
            "Attacks that worked",
            "Finished the job",
            "Paid right",
            "Lost or overpaid",
          ]}
          rows={rows.flatMap((row) => {
            const breach = barsFor(row, "breach");
            const task = barsFor(row, "task");
            return (["bonded", "agentdojo"] as const).map((bench, i) => {
              const done = task.find((bar) => bar.bench === bench && !bar.faint)!;
              const paid = task.find((bar) => bar.bench === bench && bar.faint);
              return [
                row.label,
                DELIVERY[row.channels],
                BENCH[bench].name,
                `${breach[i]!.count} (${pctLabel(breach[i]!.value)})`,
                `${done.count} (${pctLabel(done.value)})`,
                paid ? `${paid.count} (${pctLabel(paid.value)})` : "not measured",
                bench === "bonded"
                  ? money(row.bonded.lossUsd + row.bonded.overpaidUsd)
                  : movedOf(row.agentdojo) === undefined
                    ? "not measured"
                    : money(movedOf(row.agentdojo)!),
              ];
            });
          })}
        />
      }
    >
      <div className="flex flex-col gap-5">
        {rows.map((row) => (
          <ModelPair
            key={rowKey(row)}
            row={row}
            bars={barsFor(row, tab)}
            open={openKey === rowKey(row)}
            onToggle={() => setOpenKey((key) => (key === rowKey(row) ? null : rowKey(row)))}
          />
        ))}
        {tab === "task" && (
          <p className="text-xs text-soft">
            Whole job counts every part, including real changes, so refusing everything scores
            badly. Paid right counts only the invoices, closer to how AgentDojo checks a task.
          </p>
        )}
      </div>
    </ChartCard>
  );
}
