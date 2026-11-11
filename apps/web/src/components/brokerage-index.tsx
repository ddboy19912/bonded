import { BrokerageIndex, type BrokerageIndexEntry } from "@bondedhq/shared";
import raw from "../../../../config/brokerage-index.json?raw";
import { ProviderLogo } from "./index-charts";

/**
 * The Index's stock-trading rows (config/brokerage-index.json, written by the Arena's
 * `brokerage-index` sweep). Their own file and library version, apart from the invoice rows, so a
 * release in one world never re-rates the other. Parsed with the shared schema at load.
 */
export function loadBrokerageIndex(text: string = raw): BrokerageIndex {
  return BrokerageIndex.parse(JSON.parse(text));
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** Attacks that worked over attacks counted, both briefings together. */
const worked = (e: BrokerageIndexEntry) => {
  const fell = e.rows.reduce((n, r) => n + r.fell, 0);
  return `${fell} of ${e.attacksTested}`;
};

const steered = (e: BrokerageIndexEntry) => e.rows.reduce((n, r) => n + r.steeredUsd, 0);

/** The stock-trading table: Security and Task side by side, as for the invoice rows. */
export function BrokerageIndexSection({ index }: { index: BrokerageIndex }) {
  const entries = index.entries;
  if (entries.length === 0) return null;
  const first = entries[0]!;
  const versions = new Set(entries.map((e) => e.libraryVersion));
  return (
    <section aria-labelledby="index-stock-trading" className="flex flex-col gap-3">
      <div>
        <h2 id="index-stock-trading" className="text-lg font-semibold text-ink">
          Stock trading
        </h2>
        <p className="mt-1 text-sm text-muted">
          The same models running an investing agent at a broker.
        </p>
      </div>
      <div className="overflow-x-auto rounded-2xl border border-line">
        <table className="w-full min-w-[40rem] text-left text-xs">
          <thead className="bg-surface/70 text-muted">
            <tr>
              {["Model", "Security", "Task", "Attacks that worked", "Traded on them", "Cost"].map(
                (h) => (
                  <th key={h} scope="col" className="px-4 py-3 font-medium">
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.model} className="border-t border-line align-top">
                <td className="px-4 py-3">
                  <span className="flex items-start gap-2">
                    <span className="mt-px">
                      <ProviderLogo provider={e.provider} />
                    </span>
                    <span className="min-w-0 text-ink">
                      {e.label}
                      {e.incomplete && (
                        <span className="block text-[10px] text-warn">
                          Incomplete: the run stopped early
                        </span>
                      )}
                    </span>
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-sm font-semibold text-ink tabular-nums">
                  {e.score}
                  <span className="ml-1 text-[10px] font-normal text-muted">
                    {e.scoreInterval[0]}–{e.scoreInterval[1]}
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-sm font-semibold text-ink tabular-nums">
                  {e.task.score ?? "—"}
                </td>
                <td className="whitespace-nowrap px-4 py-3 tabular-nums text-soft">{worked(e)}</td>
                <td className="whitespace-nowrap px-4 py-3 tabular-nums text-soft">
                  {usd(steered(e))}
                </td>
                <td className="whitespace-nowrap px-4 py-3 tabular-nums text-soft">
                  ${e.cost.spentUsd.toFixed(2)}
                  {e.cost.estimated ? " est." : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="max-w-3xl text-xs text-muted">
        {first.attacks.seeds} attacks and {first.attacks.twins} genuine look-alikes, each run{" "}
        {first.runsPerScenario} times with the rules shown and {first.runsPerScenario} times
        without. Attacks a model never saw aren't counted. Brokerage library version{" "}
        {[...versions].join(", ")}.
      </p>
    </section>
  );
}
