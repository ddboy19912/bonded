import { type BondedIndex as BondedIndexData, type BondedIndexEntry } from "@bondedhq/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { ChartCard, DataTable, ProviderLogo, fallFill } from "../components/index-charts";
import { EmptyState, LinkButton, Page } from "../components/ui";
import {
  classResults,
  entryBySlug,
  idle,
  loadBondedIndex,
  lossPerThousand,
  lostUsd,
  overpaidUsd,
  pct,
  runsOf,
  taskText,
  usd,
  versionOf,
} from "../lib/bonded-index";
import { api, type LeaderboardRecord } from "../lib/api";
import { gradeTone } from "../lib/security";
import { Kpi } from "./BondedIndex";

const BACK = { to: "/index", label: "Bonded Index" };

/** One of the two headline scores. Both always show, at the same size. */
function Score({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="min-w-0 rounded-2xl border border-line bg-surface/70 p-4 sm:p-6">
      <p className="text-[11px] uppercase tracking-wider text-muted">{label}</p>
      <p
        className={`mt-2 text-5xl font-semibold leading-none sm:text-6xl ${warn ? "text-warn" : "text-ink"}`}
      >
        {value}
      </p>
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

/**
 * Leaderboard agents built on this model: the same model rated on chain, inside someone else's
 * trading agent. Hidden when there are none, or while the leaderboard loads.
 */
function OnChain({ agents }: { agents: LeaderboardRecord[] }) {
  if (agents.length === 0) return null;
  return (
    <section aria-labelledby="index-model-onchain" className="flex flex-col gap-3">
      <div>
        <h2 id="index-model-onchain" className="text-lg font-semibold text-ink">
          Also rated on chain
        </h2>
        <p className="mt-0.5 text-sm text-muted">Trading agents built on this model.</p>
      </div>
      <ul className="overflow-hidden rounded-2xl border border-line bg-surface/70">
        {agents.map((a) => (
          <li
            key={a.slug}
            className="relative flex items-center justify-between gap-4 border-t border-line px-5 py-4 first:border-t-0 hover:bg-white/[0.025]"
          >
            <span className="min-w-0">
              <span className="block truncate font-semibold text-ink">
                {a.onchain ? (
                  <Link
                    to={`/agents/${a.onchain.agentId}`}
                    className="after:absolute after:inset-0 hover:text-accent"
                  >
                    {a.name}
                  </Link>
                ) : (
                  a.name
                )}
              </span>
              <span className="block truncate text-xs text-muted">{a.framework}</span>
            </span>
            {a.securityGrade !== undefined && (
              <span className="shrink-0 text-right">
                <span className="block text-[11px] uppercase tracking-wider text-muted">
                  Security
                </span>
                <span
                  className={`text-3xl font-semibold leading-none tabular-nums ${gradeTone(a.securityGrade)}`}
                >
                  {a.securityGrade}
                </span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One model's result: its two scores, the money at risk, what broke it, and what it was rated on. */
export function IndexModelView({
  index,
  slug,
  leaderboard = [],
}: {
  index: BondedIndexData;
  slug: string;
  /** The on-chain leaderboard, to link agents built on this model. */
  leaderboard?: LeaderboardRecord[];
}) {
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
        <Score label="Security" value={`${e.score}`} />
        <Score label="Task" value={taskText(e)} warn={idle(e)} />
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
        <Kpi label="Attack library" value={`v${version}`} />
      </div>

      <AttackClasses e={e} />

      <OnChain
        agents={leaderboard
          .filter((a) => a.model === e.model)
          .sort((a, b) => (b.securityGrade ?? -1) - (a.securityGrade ?? -1))}
      />

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
  const board = useQuery({ queryKey: ["leaderboard"], queryFn: api.leaderboard });
  return (
    <IndexModelView index={loadBondedIndex()} slug={model} leaderboard={board.data?.entries} />
  );
}
