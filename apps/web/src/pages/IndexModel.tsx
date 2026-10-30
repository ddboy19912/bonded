import {
  type BondedIndex as BondedIndexData,
  type BondedIndexEntry,
  OFFCHAIN_LIBRARY_VERSION,
} from "@bondedhq/shared";
import { useParams } from "react-router";
import { ChartCard, DataTable, ProviderLogo, fallFill } from "../components/index-charts";
import { EmptyState, LinkButton, Page } from "../components/ui";
import {
  IDLE_FLAG,
  classResults,
  entryBySlug,
  idle,
  loadBondedIndex,
  lossPerThousand,
  lostUsd,
  overpaidUsd,
  pct,
  runsOf,
  setBy,
  taskSetBy,
  taskText,
  usd,
  versionOf,
} from "../lib/bonded-index";
import { Kpi } from "./BondedIndex";

const BACK = { to: "/index", label: "Bonded Index" };

/** One of the two headline scores. Both always show, at the same size. */
function Score({
  label,
  value,
  lines,
  warn = false,
}: {
  label: string;
  value: string;
  lines: (string | null)[];
  warn?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-2xl border border-line bg-surface/70 p-4 sm:p-6">
      <p className="text-[11px] uppercase tracking-wider text-muted">{label}</p>
      <p
        className={`mt-2 text-5xl font-semibold leading-none sm:text-6xl ${warn ? "text-warn" : "text-ink"}`}
      >
        {value}
      </p>
      <div className="mt-3 flex flex-col gap-0.5 text-xs text-muted">
        {lines.filter(Boolean).map((l) => (
          <p key={l}>{l}</p>
        ))}
      </div>
    </div>
  );
}

/** Attacks that got through, of those run, in one briefing; empty when that briefing didn't meet the class. */
function Cell({ v, title }: { v?: { fell: number; episodes: number }; title: string }) {
  const rate = v && v.episodes > 0 ? v.fell / v.episodes : 0;
  return (
    <td
      title={title}
      className={`h-9 rounded-md text-center tabular-nums ${v ? "text-ink" : "border border-dashed border-line-strong text-muted"}`}
      style={v ? { background: fallFill(rate) } : undefined}
    >
      {v ? `${v.fell}/${v.episodes}` : "—"}
    </td>
  );
}

const count = (v?: { fell: number; episodes: number }) =>
  v ? `${v.fell} of ${v.episodes} (${pct(v.episodes ? v.fell / v.episodes : 0, 1)})` : "not run";

/** Each attack class it met, and how many got through with the rules shown and hidden. */
function AttackClasses({ e }: { e: BondedIndexEntry }) {
  const classes = classResults(e);
  const broke = classes.filter((c) => c.fell > 0);
  return (
    <ChartCard
      title="Attack classes"
      subtitle="Attacks that got through, with the payment rules spelled out or only the job described"
      intro={
        <p className="text-sm text-soft">
          {broke.length === 0 ? (
            "No attack class got through."
          ) : (
            <>
              Broke it:{" "}
              <span className="text-ink">
                {broke.map((c) => `${c.name} (${c.fell} of ${c.episodes})`).join(", ")}
              </span>
            </>
          )}
        </p>
      }
      table={
        <DataTable
          head={["Attack class", "Rules shown", "Rules hidden"]}
          rows={classes.map((c) => [c.name, count(c.shown), count(c.hidden)])}
        />
      }
    >
      <table className="w-full border-separate border-spacing-1 text-xs">
        <thead>
          <tr>
            <th className="w-1/2" />
            {["Rules shown", "Rules hidden"].map((h) => (
              <th key={h} scope="col" className="px-1 pb-1 text-center font-normal text-muted">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {classes.map((c) => (
            <tr key={c.class}>
              <th scope="row" className="pr-2 text-left font-normal text-soft">
                {c.name}
              </th>
              <Cell v={c.shown} title={`${c.name}, rules shown: ${count(c.shown)}`} />
              <Cell v={c.hidden} title={`${c.name}, rules hidden: ${count(c.hidden)}`} />
            </tr>
          ))}
        </tbody>
      </table>
    </ChartCard>
  );
}

/** One model's result: its two scores, the money at risk, what broke it, and what it was rated on. */
export function IndexModelView({ index, slug }: { index: BondedIndexData; slug: string }) {
  const e = entryBySlug(index.entries, slug);
  if (!e) {
    return (
      <Page title="Not rated yet" eyebrow="Bonded Index" back={BACK}>
        <EmptyState
          title="Nothing on the Index at this address"
          action={
            <LinkButton to="/index" kind="secondary">
              See the rated models
            </LinkButton>
          }
        >
          This model hasn't been rated yet, or the address is wrong.
        </EmptyState>
      </Page>
    );
  }
  const attacks = e.rows.reduce((n, r) => n + r.attackEpisodes, 0);
  const fell = e.rows.reduce((n, r) => n + r.fell, 0);
  const runs = runsOf(e);
  const version = versionOf(e);
  const older = version < OFFCHAIN_LIBRARY_VERSION;
  return (
    <Page
      title={e.label}
      eyebrow={
        <span className="flex items-center gap-2">
          <ProviderLogo provider={e.provider} size={18} />
          {e.provider}
        </span>
      }
      back={BACK}
      intro={`Fell for ${fell} of ${attacks} attacks inside the same payments agent every model on the Index runs in.`}
      actions={
        <span
          className="rounded-full border border-line-strong px-3 py-1 text-xs text-soft"
          title="Off-chain payments have no bond or cover pool behind them."
        >
          Rated, not insured
        </span>
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:gap-4">
        <Score
          label="Security"
          value={`${e.score}`}
          lines={[`95% interval ${e.scoreInterval[0]}–${e.scoreInterval[1]}`, `set by ${setBy(e)}`]}
        />
        <Score
          label="Task"
          value={taskText(e)}
          warn={idle(e)}
          lines={[idle(e) ? IDLE_FLAG : null, taskSetBy(e) ? `set by ${taskSetBy(e)}` : null]}
        />
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-5 border-y border-line py-5 sm:grid-cols-4">
        <Kpi
          label="Dollars at risk"
          value={usd(lostUsd(e) + overpaidUsd(e))}
          hint={`${usd(lostUsd(e))} lost · ${usd(overpaidUsd(e))} overpaid`}
        />
        <Kpi
          label="Loss per 1,000 runs"
          value={usd(lossPerThousand(e))}
          hint={`over ${runs.toLocaleString("en-US")} runs`}
        />
        <Kpi
          label="Attacks that got through"
          value={`${fell} of ${attacks}`}
          hint={
            e.riskCeiling === undefined
              ? "both briefings"
              : `above ${pct(e.riskCeiling, 1)} ruled out`
          }
        />
        <Kpi
          label="Attack library"
          value={`v${version}`}
          hint={`rated ${e.ranAt.slice(0, 10)}${older ? ` · current is v${OFFCHAIN_LIBRARY_VERSION}` : ""}`}
        />
      </div>

      <AttackClasses e={e} />

      {e.provenance && (
        <p className="max-w-3xl text-xs text-muted">
          Where these numbers come from: {e.provenance}
        </p>
      )}
    </Page>
  );
}

export function IndexModel() {
  const { model = "" } = useParams();
  return <IndexModelView index={loadBondedIndex()} slug={model} />;
}
