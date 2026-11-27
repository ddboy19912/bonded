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
 * Each bench's own colour, from the app's palette: Bonded's blue, and a light grey for AgentDojo,
 * far apart in lightness so they stay apart for every reader. Every bar also carries its bench's
 * logo and value, so colour never names it alone.
 */
const BENCH = {
  bonded: { name: "Bonded", color: "#3c6bff", mark: bondedMark },
  agentdojo: { name: "AgentDojo", color: "#c9ccd3", mark: spylabMark },
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
    <div className="min-w-0 border-t border-line pt-5">
      <div className="flex items-center gap-2.5">
        <BenchMark bench={bench} size={24} />
        <p className="text-[15px] font-medium text-ink">{BENCH[bench].name}</p>
        <p className="eyebrow">{maker}</p>
      </div>
      <p className="num-giant mt-5">{answer}</p>
      <p className="mt-3 text-[15px] text-soft">{detail}</p>
    </div>
  );
  return (
    <div>
      <div className="grid grid-cols-1 gap-x-10 gap-y-8 sm:grid-cols-2">
        {side(
          "bonded",
          "Payment attacks",
          `${count(fell)} of ${count(met)}`,
          <>
            attacks worked · <span className="text-breach">{dollars(moved)}</span> paid wrongly
          </>,
        )}
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
      </div>
      <p className="eyebrow mt-5">All {rows.length} runs below, added up.</p>
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
    <div className="flex flex-col gap-4 border-t border-line py-5">
      <div className="flex flex-col gap-3 sm:grid sm:grid-cols-[13rem_1fr] sm:items-center sm:gap-6">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={panel}
          className="group/model flex items-center gap-2 rounded-md text-left sm:items-start"
        >
          <span className="mt-0.5">
            <ProviderLogo provider={providerOf(row.model)} size={20} />
          </span>
          <span className="leading-tight">
            <span className="block text-[19px] font-medium tracking-[-0.03em] text-ink">
              {row.label}
            </span>
            <span className="mt-1 block font-mono text-[12px] text-muted">
              attack {DELIVERY[row.channels]}
            </span>
            <span className="mt-2 flex items-center gap-1 text-[13px] text-soft group-hover/model:text-ink">
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
        <div className="flex flex-col gap-2.5">
          {bars.map((bar) => (
            <div
              key={`${bar.bench}-${bar.measure ?? ""}`}
              className="group relative flex items-center gap-2"
              aria-label={`${row.label}, ${BENCH[bar.bench].name}${bar.measure ? ` (${bar.measure.toLowerCase()})` : ""}: ${pctLabel(bar.value)}, ${bar.count}`}
            >
              <BenchMark bench={bar.bench} size={18} />
              {bar.measure && (
                <span className="w-16 shrink-0 font-mono text-[11px] text-muted">
                  {bar.measure}
                </span>
              )}
              <div className="h-2 flex-1 bg-white/[0.07]">
                <div
                  className="h-full"
                  style={{
                    width: `max(${bar.value}%, 2px)`,
                    background: BENCH[bar.bench].color,
                    opacity: bar.faint ? 0.5 : 1,
                  }}
                />
              </div>
              <span className="w-32 shrink-0 text-right tabular-nums">
                <span className="text-[17px] font-medium tracking-[-0.02em] text-ink">
                  {pctLabel(bar.value)}
                </span>{" "}
                <span className="font-mono text-[11px] text-muted">{bar.count}</span>
              </span>
              <div
                role="tooltip"
                className="tip pointer-events-none absolute bottom-full left-8 z-10 mb-2 hidden max-w-72 group-hover:block"
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
    <div
      id={id}
      className="flex flex-col gap-3 border-l border-line pl-4 text-[13px] sm:ml-[14.5rem]"
    >
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
      <div className="flex flex-col border-b border-line">
        {rows.map((row) => (
          <ModelPair
            key={rowKey(row)}
            row={row}
            bars={barsFor(row, tab)}
            open={openKey === rowKey(row)}
            onToggle={() => setOpenKey((key) => (key === rowKey(row) ? null : rowKey(row)))}
          />
        ))}
      </div>
      {tab === "task" && (
        <p className="mt-4 max-w-2xl text-[13px] text-muted">
          Whole job counts every part, including real changes, so refusing everything scores badly.
          Paid right counts only the invoices, closer to how AgentDojo checks a task.
        </p>
      )}
    </ChartCard>
  );
}
