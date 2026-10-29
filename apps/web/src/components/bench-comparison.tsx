import { DataTable } from "./charts";
import { ProviderLogo } from "./index-charts";
import {
  attackExecuted,
  directAskOf,
  loadBenchComparison,
  money,
  pairsOf,
  utilityOf,
  type BenchComparison,
} from "../lib/bench-comparison";

const attackName = (id: string) => id.replaceAll("_", " ");

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

function Bench({
  name,
  suite,
  value,
  unit,
  detail,
  tone,
}: {
  name: string;
  suite: string;
  value: string;
  unit: string;
  detail: string;
  tone: "breach" | "held";
}) {
  return (
    <div className="flex-1 rounded-xl bg-sunken/60 p-4 ring-1 ring-line">
      <p className="text-xs font-medium text-soft">{name}</p>
      <p className="text-[11px] text-muted">{suite}</p>
      <p
        className={`mt-3 text-3xl font-semibold tabular-nums ${tone === "breach" ? "text-breach" : "text-ink"}`}
      >
        {value}
      </p>
      <p className="text-xs text-muted">{unit}</p>
      <p className="mt-2 text-xs text-soft">{detail}</p>
    </div>
  );
}

function Comparison({ row }: { row: BenchComparison }) {
  const ask = directAskOf(row.agentdojo);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row">
        <Bench
          name="Bonded"
          suite={row.bonded.suite}
          value={`${row.bonded.fell} of ${row.bonded.countedEpisodes}`}
          unit="attacks got money out"
          detail={`${money(row.bonded.lossUsd)} lost${row.bonded.overpaidUsd > 0 ? `, ${money(row.bonded.overpaidUsd)} overpaid` : ""}`}
          tone={row.bonded.fell > 0 ? "breach" : "held"}
        />
        <Bench
          name="AgentDojo"
          suite={row.agentdojo.suite}
          value={`${attackExecuted(row.agentdojo)} of ${pairsOf(row.agentdojo)}`}
          unit="hidden instructions carried out"
          detail={`Real task done on ${utilityOf(row.agentdojo)} of ${pairsOf(row.agentdojo)}${ask.total > 0 ? ` · asked outright, it did ${ask.done} of ${ask.total}` : ""}`}
          tone={attackExecuted(row.agentdojo) > 0 ? "breach" : "held"}
        />
      </div>
      {row.bonded.falls.length > 0 && (
        <DataTable
          head={["Attack that got through", "Briefing", "Fell", "Lost"]}
          rows={row.bonded.falls.map((fall) => [
            fall.name,
            fall.mandate === "shown" ? "rules shown" : "rules hidden",
            `${fall.fell} of ${fall.runs}`,
            money(fall.lossUsd),
          ])}
        />
      )}
    </div>
  );
}

function Notes({ row }: { row: BenchComparison }) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted hover:text-ink">
        Notes and AgentDojo detail
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        <DataTable
          head={["AgentDojo attack", "Hidden goal carried out", "Real task done"]}
          rows={row.agentdojo.attacks.map((attack) => [
            attackName(attack.id),
            `${attack.attackExecuted} of ${attack.pairs}`,
            `${attack.utility} of ${attack.pairs}`,
          ])}
        />
        <ul className="flex max-w-3xl list-disc flex-col gap-1.5 pl-5 text-muted">
          {[...row.bonded.notes, ...row.agentdojo.notes].map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>
    </details>
  );
}

/** The staged Bonded campaign beside AgentDojo, for the Index page. Not an Index score. */
export function BenchComparisonCard() {
  const data = loadBenchComparison();
  const headline = data.comparisons.find((row) => row.headline)!;
  const rest = data.comparisons.filter((row) => !row.headline);
  return (
    <section
      aria-labelledby="bench-comparison"
      className="min-w-0 rounded-2xl border border-line bg-surface/70 p-4 sm:p-6"
    >
      <h2 id="bench-comparison" className="flex items-center gap-2 text-lg font-semibold text-ink">
        <span aria-hidden className="size-2.5 rounded-[2px] bg-[#3987e5]" />
        Same model, two benches
      </h2>
      <p className="mt-1 text-xs text-muted">
        <span className="mr-1.5 inline-block align-[-4px]">
          <ProviderLogo provider={providerOf(headline.model)} size={16} />
        </span>
        {headline.label} on Bonded's payment attacks and AgentDojo's banking suite,{" "}
        {data.recordedOn} · a campaign record, not an Index score
      </p>
      <div className="mt-4 flex flex-col gap-4">
        <Comparison row={headline} />
        <Notes row={headline} />
        {rest.map((row) => (
          <details key={row.model} className="border-t border-line pt-4 text-sm">
            <summary className="cursor-pointer font-medium text-soft hover:text-ink">
              <span className="inline-flex items-center gap-2 align-middle">
                <ProviderLogo provider={providerOf(row.model)} size={16} />
                {row.label}, the smaller check
              </span>
            </summary>
            <div className="mt-4 flex flex-col gap-4">
              {row.scope && <p className="text-xs text-muted">{row.scope}</p>}
              <Comparison row={row} />
              <Notes row={row} />
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
