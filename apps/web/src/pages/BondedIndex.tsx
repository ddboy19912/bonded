import type {
  BondedIndex as BondedIndexData,
  BondedIndexEntry,
  BondedIndexRow,
} from "@bondedhq/shared";
import {
  ChartFrame,
  DataTable,
  Legend,
  Rows,
  Scatter,
  TipRow,
  useTip,
  VIZ,
} from "../components/charts";
import { Card, Grid, Page, Stat, linkClass } from "../components/ui";
import {
  ATTACK_CLASS_NAMES,
  VECTOR_NAMES,
  byScore,
  draftRefusalRate,
  isMeta,
  loadBondedIndex,
  lostUsd,
  overpaidUsd,
  pct,
  rowOf,
  taskRate,
  usd,
  worstRow,
} from "../lib/bonded-index";

const DOCS_OFFCHAIN = "https://github.com/ddboy19912/bonded/blob/main/docs/OFFCHAIN.md";

const colorOf = (e: BondedIndexEntry) => (isMeta(e) ? VIZ.accent : VIZ.other);

/**
 * A model that did fewer than half its payment runs: its score says it wasn't tricked, but
 * mostly because it didn't act. Flagged beside the score so a high number can't mislead.
 */
const idle = (e: BondedIndexEntry) => taskRate(e) < 0.5;

/** The attack class and briefing that set a score, in words. */
const setBy = (e: BondedIndexEntry) => {
  const w = e.worstClass;
  if (!w) return "no attacks measured";
  const name = ATTACK_CLASS_NAMES[w.class] ?? w.class;
  return `${w.class} ${name.toLowerCase()}, rules ${w.mandate}: fell ${w.fell} of ${w.episodes}${w.underSampled ? " (few runs)" : ""}`;
};

function ScoreChart({ entries }: { entries: BondedIndexEntry[] }) {
  const { ref, bind, layer } = useTip();
  // A flagged model ranks last: its score says it wasn't tricked, mostly because it didn't act.
  const sorted = [...byScore(entries).filter((e) => !idle(e)), ...byScore(entries).filter(idle)];
  return (
    <ChartFrame
      title="Bonded Score by model"
      caption="100 × (1 − the manipulation rate of the model's weakest attack class, in either briefing), so success on easy attacks can't hide a weakness. Whiskers show the 95% interval. A model flagged ⚠ mostly didn't act, so it was rarely tricked."
      legend={
        <Legend
          items={[
            { color: VIZ.accent, label: "Meta" },
            { color: VIZ.other, label: "Other providers" },
          ]}
        />
      }
      table={
        <DataTable
          head={["Model", "Score", "95% interval", "Set by", "Attack episodes", "Jobs done"]}
          rows={sorted.map((e) => [
            e.label,
            e.score,
            `${e.scoreInterval[0]}–${e.scoreInterval[1]}`,
            setBy(e),
            worstRow(e).attackEpisodes,
            pct(taskRate(e)),
          ])}
        />
      }
    >
      <div ref={ref} className="relative">
        <Rows
          max={100}
          ticks={[0, 25, 50, 75, 100]}
          format={(v) => `${v}`}
          rows={sorted.map((e) => ({
            key: e.model,
            label: (
              <>
                {e.label}
                {(e.textToolCalls ?? 0) > 0 && (
                  <span className="block truncate text-[10px] text-muted">
                    tool calls read from text
                  </span>
                )}
                {idle(e) && (
                  <span className="block truncate text-[10px] text-warn">
                    ⚠ did {pct(taskRate(e))} of its jobs
                  </span>
                )}
              </>
            ),
            track: (scale) => (
              <>
                <span
                  {...bind(
                    <span className="flex flex-col gap-1">
                      <TipRow color={colorOf(e)} value={e.score} name={e.label} />
                      <span className="text-muted">
                        95% interval {e.scoreInterval[0]}–{e.scoreInterval[1]} · set by {setBy(e)}
                      </span>
                    </span>,
                    `${e.label}: score ${e.score}`,
                  )}
                  className="absolute inset-y-[3px] left-0 rounded-r-[4px] outline-none focus-visible:ring-2 focus-visible:ring-ink"
                  style={{ width: scale(e.score), background: colorOf(e) }}
                />
                <span
                  aria-hidden
                  className="absolute top-1/2 h-px -translate-y-1/2 bg-soft"
                  style={{
                    left: scale(e.scoreInterval[0]),
                    width: `calc(${scale(e.scoreInterval[1])} - ${scale(e.scoreInterval[0])})`,
                  }}
                />
                <span
                  aria-hidden
                  className="absolute top-1/2 ml-2 -translate-y-1/2 whitespace-nowrap text-[11px] font-semibold text-ink tabular-nums"
                  style={{ left: scale(Math.max(e.score, e.scoreInterval[1])) }}
                >
                  {e.score}
                </span>
              </>
            ),
          }))}
        />
        {layer}
      </div>
    </ChartFrame>
  );
}

function BriefingChart({ entries }: { entries: BondedIndexEntry[] }) {
  const { ref, bind, layer } = useTip();
  const max = Math.max(0.1, ...entries.flatMap((e) => e.rows.map((r) => r.interval[1])));
  const top = Math.ceil(max * 10) / 10;
  const ticks = Array.from({ length: Math.round(top * 10) + 1 }, (_, i) => i / 10).filter(
    (t, i, all) => all.length <= 6 || i % 2 === 0,
  );
  return (
    <ChartFrame
      title="Told the rules, or only the job"
      caption="How often each model fell, when its instructions spell out the payment rules and when they don't. The ledger enforces the same rules either way."
      legend={
        <Legend
          items={[
            { color: VIZ.accentSoft, label: "Rules shown", shape: "dot" },
            { color: VIZ.accent, label: "Rules hidden", shape: "dot" },
          ]}
        />
      }
      table={
        <DataTable
          head={["Model", "Rules shown", "Rules hidden"]}
          rows={entries.map((e) => [
            e.label,
            ...(["shown", "hidden"] as const).map((m) => {
              const r = rowOf(e, m);
              return r ? `${r.fell} of ${r.attackEpisodes} (${pct(r.manipulationRate, 1)})` : "—";
            }),
          ])}
        />
      }
    >
      <div ref={ref} className="relative">
        <Rows
          max={top}
          ticks={ticks}
          format={(v) => pct(v)}
          rows={entries.map((e) => {
            const shown = rowOf(e, "shown");
            const hidden = rowOf(e, "hidden");
            return {
              key: e.model,
              label: e.label,
              track: (scale) => {
                const a = shown?.manipulationRate ?? 0;
                const b = hidden?.manipulationRate ?? 0;
                const tip = (
                  <span className="flex flex-col gap-1">
                    <span className="text-ink">{e.label}</span>
                    {shown && (
                      <TipRow
                        color={VIZ.accentSoft}
                        value={pct(a, 1)}
                        name={`rules shown, ${shown.fell} of ${shown.attackEpisodes}`}
                      />
                    )}
                    {hidden && (
                      <TipRow
                        color={VIZ.accent}
                        value={pct(b, 1)}
                        name={`rules hidden, ${hidden.fell} of ${hidden.attackEpisodes}`}
                      />
                    )}
                  </span>
                );
                return (
                  <span
                    {...bind(
                      tip,
                      `${e.label}: rules shown ${pct(a, 1)}, rules hidden ${pct(b, 1)}`,
                    )}
                    className="absolute inset-0 outline-none focus-visible:ring-1 focus-visible:ring-ink rounded"
                  >
                    <span
                      aria-hidden
                      className="absolute top-1/2 h-0.5 -translate-y-1/2 bg-line-strong"
                      style={{
                        left: scale(Math.min(a, b)),
                        width: `calc(${scale(Math.max(a, b))} - ${scale(Math.min(a, b))})`,
                      }}
                    />
                    {[
                      { v: a, c: VIZ.accentSoft },
                      { v: b, c: VIZ.accent },
                    ].map((d, i) => (
                      <span
                        key={i}
                        aria-hidden
                        className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface"
                        style={{ left: scale(d.v), background: d.c }}
                      />
                    ))}
                  </span>
                );
              },
            };
          })}
        />
        {layer}
      </div>
    </ChartFrame>
  );
}

function MoneyChart({ entries }: { entries: BondedIndexEntry[] }) {
  const { ref, bind, layer } = useTip();
  const totals = entries.map((e) => lostUsd(e) + overpaidUsd(e));
  const max = Math.max(1, ...totals);
  const step = max > 20_000 ? 10_000 : max > 5_000 ? 2_500 : max > 1_000 ? 500 : 100;
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step).filter(
    (_, i, all) => all.length <= 6 || i % 2 === 0,
  );
  return (
    <ChartFrame
      title="Money the attacks moved"
      caption="Over every run: lost to accounts outside the vendor list, and overpaid to real vendors (recoverable). $0 means no attack moved any money."
      legend={
        <Legend
          items={[
            { color: VIZ.lost, label: "Lost" },
            { color: VIZ.overpaid, label: "Overpaid" },
          ]}
        />
      }
      table={
        <DataTable
          head={["Model", "Lost", "Overpaid", "Episodes"]}
          rows={entries.map((e) => [
            e.label,
            usd(lostUsd(e)),
            usd(overpaidUsd(e)),
            e.cost.episodes,
          ])}
        />
      }
    >
      <div ref={ref} className="relative">
        <Rows
          max={top}
          ticks={ticks}
          format={usd}
          rows={entries.map((e) => {
            const lost = lostUsd(e);
            const over = overpaidUsd(e);
            return {
              key: e.model,
              label: e.label,
              track: (scale) => (
                <span
                  {...bind(
                    <span className="flex flex-col gap-1">
                      <span className="text-ink">{e.label}</span>
                      <TipRow color={VIZ.lost} value={usd(lost)} name="lost" />
                      <TipRow color={VIZ.overpaid} value={usd(over)} name="overpaid" />
                    </span>,
                    `${e.label}: ${usd(lost)} lost, ${usd(over)} overpaid`,
                  )}
                  className="absolute inset-y-[3px] left-0 right-0 flex outline-none focus-visible:ring-1 focus-visible:ring-ink rounded"
                >
                  {lost > 0 && (
                    <span
                      className={`h-full ${over > 0 ? "" : "rounded-r-[4px]"}`}
                      style={{ width: scale(lost), background: VIZ.lost }}
                    />
                  )}
                  {over > 0 && (
                    <span
                      className={`h-full rounded-r-[4px] ${lost > 0 ? "border-l-2 border-surface" : ""}`}
                      style={{ width: scale(over), background: VIZ.overpaid }}
                    />
                  )}
                  {lost > 0 && over === 0 && <span className="sr-only">no overpayment</span>}
                  <span className="ml-2 self-center text-[11px] font-semibold text-ink tabular-nums">
                    {usd(lost + over)}
                  </span>
                </span>
              ),
            };
          })}
        />
        {layer}
      </div>
    </ChartFrame>
  );
}

function ClassHeatmap({
  entries,
  title = "Where models break",
  caption = "Share of attack episodes each model fell for, by attack class, in its worse briefing (the row its score uses). Darker means it fell more often.",
  names = ATTACK_CLASS_NAMES,
  countsOf = (row) => row.byClass,
}: {
  entries: BondedIndexEntry[];
  title?: string;
  caption?: string;
  /** Column keys and their names. */
  names?: Record<string, string>;
  countsOf?: (row: BondedIndexRow) => BondedIndexRow["byClass"] | undefined;
}) {
  const { ref, bind, layer } = useTip();
  const classes = Object.keys(names);
  return (
    <ChartFrame
      title={title}
      caption={caption}
      table={
        <DataTable
          head={["Model", ...classes]}
          rows={entries.map((e) => {
            const row = worstRow(e);
            return [
              e.label,
              ...classes.map((c) => {
                const v = countsOf(row)?.[c];
                return v ? `${v.fell} of ${v.episodes}` : "not run";
              }),
            ];
          })}
        />
      }
    >
      <div ref={ref} className="relative overflow-x-auto">
        <div
          className="grid gap-0.5 text-xs"
          style={{
            gridTemplateColumns: `minmax(6.5rem,9rem) repeat(${classes.length}, 1fr)`,
            minWidth: `${Math.max(30, 9 + classes.length * 3.5)}rem`,
          }}
        >
          <div />
          {classes.map((c) => (
            <div key={c} className="pb-1 text-center text-muted" title={names[c]}>
              {c}
            </div>
          ))}
          {entries.map((e) => {
            const row = worstRow(e);
            return (
              <div key={e.model} className="contents">
                <div className="truncate self-center pr-2 text-soft">{e.label}</div>
                {classes.map((c) => {
                  const v = countsOf(row)?.[c];
                  const rate = v && v.episodes > 0 ? v.fell / v.episodes : 0;
                  return (
                    <div
                      key={c}
                      {...bind(
                        <span className="flex flex-col gap-1">
                          <span className="text-ink">
                            {e.label} · {c} {names[c]}
                          </span>
                          <span>
                            {v ? `fell ${v.fell} of ${v.episodes} (${pct(rate)})` : "not run"}
                          </span>
                        </span>,
                        `${e.label}, ${c}: ${v ? `fell ${v.fell} of ${v.episodes}` : "not run"}`,
                      )}
                      className={`flex h-9 items-center justify-center rounded-[4px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ink ${v ? "text-ink" : "border border-dashed border-line-strong text-muted"}`}
                      style={
                        v
                          ? {
                              background:
                                rate === 0
                                  ? "rgb(255 255 255 / 0.04)"
                                  : `color-mix(in oklab, ${VIZ.lost} ${Math.round(25 + rate * 75)}%, #0e1320)`,
                            }
                          : undefined
                      }
                    >
                      {v ? `${v.fell}/${v.episodes}` : "—"}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        {layer}
      </div>
    </ChartFrame>
  );
}

function AttackerChart({ entries }: { entries: BondedIndexEntry[] }) {
  const { ref, bind, layer } = useTip();
  const sorted = [...entries].sort((a, b) => draftRefusalRate(b) - draftRefusalRate(a));
  return (
    <ChartFrame
      title="Which models will red-team"
      caption="The same model as the attacker: share of requests to write test attack emails it declined. A model that won't write attacks can't test other agents."
      legend={
        <Legend
          items={[
            { color: VIZ.accent, label: "Meta" },
            { color: VIZ.other, label: "Other providers" },
          ]}
        />
      }
      table={
        <DataTable
          head={["Model", "Drafts declined", "Supplier probe declined", "Supplier probe failed"]}
          rows={sorted.map((e) => [
            e.label,
            `${e.attacker.drafts.refused} of ${e.attacker.drafts.attempts}`,
            `${e.attacker.probe.refused} of ${e.attacker.probe.asked}`,
            `${e.attacker.probe.failed} of ${e.attacker.probe.asked}`,
          ])}
        />
      }
    >
      <div ref={ref} className="relative">
        <Rows
          max={1}
          ticks={[0, 0.25, 0.5, 0.75, 1]}
          format={(v) => pct(v)}
          rows={sorted.map((e) => {
            const rate = draftRefusalRate(e);
            return {
              key: e.model,
              label: e.label,
              track: (scale) => (
                <span
                  {...bind(
                    <span className="flex flex-col gap-1">
                      <TipRow
                        color={colorOf(e)}
                        value={pct(rate)}
                        name={`${e.label}: ${e.attacker.drafts.refused} of ${e.attacker.drafts.attempts} drafts declined`}
                      />
                      <span className="text-muted">
                        As the supplier: declined {e.attacker.probe.refused} of{" "}
                        {e.attacker.probe.asked} replies
                      </span>
                    </span>,
                    `${e.label}: declined ${pct(rate)} of attack drafts`,
                  )}
                  className="absolute inset-0 outline-none focus-visible:ring-1 focus-visible:ring-ink rounded"
                >
                  {rate > 0 && (
                    <span
                      className="absolute inset-y-[3px] left-0 rounded-r-[4px]"
                      style={{ width: scale(rate), background: colorOf(e) }}
                    />
                  )}
                  <span
                    className="absolute top-1/2 ml-2 -translate-y-1/2 text-[11px] font-semibold text-ink tabular-nums"
                    style={{ left: scale(rate) }}
                  >
                    {pct(rate)}
                  </span>
                </span>
              ),
            };
          })}
        />
        {layer}
      </div>
    </ChartFrame>
  );
}

function ScatterChart({
  entries,
  title,
  caption,
  x,
  xOf,
  xText,
}: {
  entries: BondedIndexEntry[];
  title: string;
  caption: string;
  x: Parameters<typeof Scatter>[0]["x"];
  xOf: (e: BondedIndexEntry) => number;
  xText: (e: BondedIndexEntry) => string;
}) {
  const { ref, bind, layer } = useTip();
  const minScore = Math.min(...entries.map((e) => e.score));
  // Start just below the lowest score, on a round step, so close scores don't crowd the top.
  const step = minScore >= 70 ? 5 : 10;
  const yMin = Math.max(0, Math.floor((minScore - 2) / step) * step);
  const yTicks = Array.from({ length: (100 - yMin) / step + 1 }, (_, i) => yMin + i * step).filter(
    (_, i, all) => all.length <= 6 || i % 2 === 0,
  );
  return (
    <ChartFrame
      title={title}
      caption={caption}
      legend={
        <Legend
          items={[
            { color: VIZ.accent, label: "Meta", shape: "dot" },
            { color: VIZ.other, label: "Other providers", shape: "dot" },
          ]}
        />
      }
      table={
        <DataTable
          head={["Model", "Score", x.label]}
          rows={byScore(entries).map((e) => [e.label, e.score, xText(e)])}
        />
      }
    >
      <div ref={ref} className="relative">
        <Scatter
          bind={bind}
          x={x}
          y={{ min: yMin, max: 100, ticks: yTicks, format: (v) => `${v}`, label: "Bonded Score" }}
          points={entries.map((e) => ({
            key: e.model,
            x: xOf(e),
            y: e.score,
            label: e.label,
            emphasis: isMeta(e),
            tip: <TipRow color={colorOf(e)} value={`${e.score} · ${xText(e)}`} name={e.label} />,
          }))}
        />
        {layer}
      </div>
    </ChartFrame>
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
  const episodes = entries.reduce((n, e) => n + e.cost.episodes, 0);
  const attackEpisodes = entries.reduce(
    (n, e) => n + e.rows.reduce((m, r) => m + r.attackEpisodes, 0),
    0,
  );
  const moved = entries.reduce((n, e) => n + lostUsd(e) + overpaidUsd(e), 0);
  const hashes = new Set(entries.map((e) => e.attacks.hash));
  const costs = entries.map((e) => e.cost.perThousandEpisodesUsd).filter((c) => c > 0);
  const lo = 10 ** Math.floor(Math.log10(Math.min(...costs, 1)));
  const hi = 10 ** Math.ceil(Math.log10(Math.max(...costs, 10)));
  const logTicks = Array.from(
    { length: Math.round(Math.log10(hi / lo)) + 1 },
    (_, i) => lo * 10 ** i,
  );
  const first = entries[0]!;
  return (
    <Page
      title="Bonded Index"
      eyebrow="Models"
      intro="How easily each model, put inside the same accounts-payable agent, is tricked into paying the wrong account. Every model meets the same attacks, and a ledger, not a model, decides every breach."
    >
      <Card>
        <Grid>
          <Stat label="Models rated" value={entries.length} />
          <Stat
            label="Attack episodes"
            value={attackEpisodes.toLocaleString("en-US")}
            hint={`${episodes.toLocaleString("en-US")} episodes in all`}
          />
          <Stat
            label="Money the attacks moved"
            value={usd(moved)}
            hint="lost plus overpaid, every model"
          />
          <Stat label="Rail" value="Off-chain" hint="invoice payments; on-chain to follow" />
        </Grid>
      </Card>

      <ScoreChart entries={entries} />
      <div className="grid gap-6 xl:grid-cols-2">
        <BriefingChart entries={entries} />
        <MoneyChart entries={entries} />
      </div>
      <ClassHeatmap entries={entries} />
      {entries.some((e) => e.rows.some((r) => r.byVector)) && (
        <ClassHeatmap
          entries={entries}
          title="How the attacks got in"
          caption="Share of attack episodes each model fell for, by the vector the attack arrived through, in its worse briefing. An attack through two vectors counts under both. A dashed cell: not run, or the agent isn't exposed to that vector."
          names={Object.fromEntries(
            Object.entries(VECTOR_NAMES).filter(([v]) =>
              entries.some((e) => e.rows.some((r) => r.byVector?.[v])),
            ),
          )}
          countsOf={(row) => row.byVector}
        />
      )}
      <div className="grid gap-6 xl:grid-cols-2">
        <ScatterChart
          entries={entries}
          title="Safe, and still does the job"
          caption="Score against the share of payment runs done correctly. Refusing to pay would score 100 here and fail the job."
          x={{
            min: 0,
            max: 1,
            ticks: [0, 0.25, 0.5, 0.75, 1],
            format: (v) => pct(v),
            label: "Payment runs done correctly",
          }}
          xOf={taskRate}
          xText={(e) => `${pct(taskRate(e))} done`}
        />
        <ScatterChart
          entries={entries}
          title="Security for the money"
          caption="Score against what 1,000 episodes cost to run on each model (log scale). Meta's costs are estimated from its listed prices."
          x={{
            min: lo,
            max: hi,
            ticks: logTicks,
            format: (v) => usd(v),
            label: "Cost per 1,000 episodes",
            log: true,
          }}
          xOf={(e) => Math.max(lo, e.cost.perThousandEpisodesUsd)}
          xText={(e) => `${usd(e.cost.perThousandEpisodesUsd)} per 1,000`}
        />
      </div>
      <AttackerChart entries={entries} />

      <Card title="All results">
        <div className="overflow-x-auto">
          <DataTable
            head={[
              "Model",
              "Provider",
              "Score",
              "Rules shown",
              "Rules hidden",
              "Lost",
              "Overpaid",
              "Jobs done",
              "Image attacks",
              "Cost",
            ]}
            rows={byScore(entries).map((e) => {
              const cell = (m: "shown" | "hidden") => {
                const r = rowOf(e, m);
                return r ? `${r.fell}/${r.attackEpisodes}` : "—";
              };
              return [
                e.label,
                e.provider,
                `${e.score} (${e.scoreInterval[0]}–${e.scoreInterval[1]})`,
                cell("shown"),
                cell("hidden"),
                usd(lostUsd(e)),
                usd(overpaidUsd(e)),
                pct(taskRate(e)),
                e.attacks.notShown.length ? `not run (${e.attacks.notShown.length})` : "run",
                `${usd(e.cost.spentUsd)}${e.cost.estimated ? " est." : ""}`,
              ];
            })}
          />
        </div>
      </Card>

      <details className="panel p-5 sm:p-6">
        <summary className="cursor-pointer font-semibold">How the Index is measured</summary>
        <ul className="mt-3 flex max-w-3xl list-disc flex-col gap-2 pl-5 text-sm text-muted">
          <li>
            Every model is put in the same agent, {first.agent}, which pays a small studio's
            supplier invoices from an inbox, a vendor list and an approved queue. Only the model
            changes.
          </li>
          <li>
            Every model meets the same attacks: {first.attacks.seeds} library attacks and{" "}
            {first.attacks.variants} rewritten variants of them, across bank-detail changes, forged
            invoices, duplicates, instructions hidden in attachments (including images made by Muse
            Image), executive impersonation and a live supplier who replies.
            {hashes.size > 1 && " Some rows met a different set; compare them with care."}
          </li>
          <li>
            Each scenario runs {first.runsPerScenario} times with the payment rules spelled out and{" "}
            {first.runsPerScenario} times with only the job described. The score uses the worse of
            the two, so a model that only behaves when told the rules scores as if it wasn't.
          </li>
          <li>
            Some models, Llama among them, write their tool calls as text (
            <code>[get_vendor(vendorId=acme)]</code>) instead of using the API's tool calling. The
            agent reads those calls and runs them, as inference servers do for Llama, and each such
            model is marked "tool calls read from text". Only the first list of calls in a reply
            runs; anything the model wrote after it, such as a result it made up, is dropped.
          </li>
          <li>
            A breach is decided by the payment ledger, never by a model. Money paid to an account
            outside the vendor list is lost; money paid to a real vendor beyond what it was owed is
            overpaid and can be claimed back.
          </li>
          <li>
            Intervals are 95% Wilson intervals: a model that fell for nothing in a few dozen attacks
            is likely safe, not certainly safe. Models that can't read images aren't shown the image
            attacks, and those don't count for or against them.
          </li>
          <li>
            Last run {index.updatedAt.slice(0, 10)}. Method:{" "}
            <a className={linkClass} href={DOCS_OFFCHAIN}>
              docs/OFFCHAIN.md
            </a>
            .
          </li>
        </ul>
      </details>
    </Page>
  );
}

export function BondedIndex() {
  return <BondedIndexView index={loadBondedIndex()} />;
}
