import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ATTACK_CLASSES } from "@bondedhq/shared";
import { api } from "../lib/api";
import type { EpisodeCard } from "../lib/events";
import { rulingView } from "../lib/ruling";
import { ago, at } from "../lib/format";
import { RulingBadge, RulingDot, VerdictCard } from "../components/ruling";
import { isPrivate, newestEpisode, useEpisodeSnapshot, type EpisodeFilters } from "../lib/episodes";
import { useListParams } from "../lib/pages";
import { useAgents } from "../lib/chain";
import {
  Badge,
  Button,
  EmptyState,
  ErrorText,
  Input,
  Page,
  Term,
  TierBadge,
  Tooltip,
  buttonClass,
} from "../components/ui";
import { InfoPanel } from "../components/overlay";
import { OperatorTokenField, useOperatorToken } from "../components/wallet";
import { Select } from "../components/select";
import { Pagination } from "../components/pagination";

const CLASS_NAMES = ATTACK_CLASSES as Record<string, { name: string }>;

/** The current time, refreshed every `ms`, so "3m ago" stays true while the page is open. */
function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function Arena() {
  const now = useNow(30_000);
  const [picked, setPicked] = useState<string>();
  // Page, page size and filters live in the address, so a view can be shared.
  const list = useListParams({
    outcome: "all",
    class: "all",
    source: "all",
    since: "any",
    agent: "all",
    run: "",
    attack: "",
  });
  const f = list.values;
  const runId = f.run || undefined;
  const setRunId = (run: string | undefined) => list.set({ run: run ?? "" });
  const [params] = useSearchParams();
  // The operator form needs the server API token, which only the Bonded operator has.
  const operator = params.get("operator") === "1";
  const filters: EpisodeFilters = {
    ...(runId ? { runId } : {}),
    ...(f.attack ? { attackId: f.attack } : {}),
    ...(f.outcome !== "all" ? { outcome: f.outcome as EpisodeFilters["outcome"] } : {}),
    ...(f.class !== "all" ? { attackClass: f.class } : {}),
    ...(f.source !== "all" ? { source: f.source as EpisodeFilters["source"] } : {}),
    ...(f.since !== "any" ? { since: f.since as EpisodeFilters["since"] } : {}),
    ...(f.agent !== "all" ? { agentId: f.agent } : {}),
  };
  const feed = useEpisodeSnapshot(filters, list.page, list.size);
  const agents = useAgents();
  const run = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.run(runId!),
    enabled: Boolean(runId),
    refetchInterval: (q) =>
      q.state.data?.status === "done" || q.state.data?.status === "failed" ? false : 3000,
  });

  // Filters run on the API, so `shown` is already one page of the filtered list.
  const shown = feed.data?.items ?? [];
  const counts = feed.counts;
  const filtered = Object.keys(filters).length > 0;
  const selected = shown.find((c) => c.eventId === picked) ?? shown[0];
  // The newest episode overall: streamed, the top of an unfiltered first page, or else one row
  // asked for on its own (filters or a later page hide it from this list).
  const onFirstPage = !filtered && list.page === 1;
  const newestAlone = useQuery({
    queryKey: ["episodes", "newest"],
    queryFn: () => api.episodes({ limit: 1 }),
    enabled: !feed.newest && !onFirstPage,
    staleTime: 10_000,
  });
  const latest = newestEpisode({
    streamed: feed.newest,
    onFirstPage,
    topRow: shown[0],
    fetched: newestAlone.data?.items[0],
  });
  const clear = () =>
    list.set({
      outcome: "all",
      class: "all",
      source: "all",
      since: "any",
      agent: "all",
      run: "",
      attack: "",
    });

  return (
    <Page
      eyebrow={
        <span className="flex items-center gap-2 !text-breach">
          <span className="size-[7px] rounded-full bg-breach-solid [animation:blink_1.4s_infinite]" />
          {feed.connected ? "Live red team" : "Reconnecting"}
        </span>
      }
      title="Arena"
      intro="Every episode hides an attack in what an agent reads, then lets the vault rule on what it does. Pick an episode to see how it went."
    >
      <div className="-mt-1 flex flex-wrap items-center gap-3">
        <InfoPanel
          title="How the Arena works"
          description="Every rating is a few hundred short episodes against real contracts on a private fork."
          trigger={
            <button type="button" className={buttonClass("secondary")}>
              How the Arena works
            </button>
          }
        >
          <ArenaExplainer />
        </InfoPanel>
        <Link to="/bounties" className={buttonClass("light")}>
          Submit an attack we miss
        </Link>
        <span className="text-sm text-muted">
          Own an agent? Rate it from{" "}
          <Link to="/agents?mine=1" className="text-accent hover:underline">
            its page
          </Link>
          .
        </span>
      </div>
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile
          label={
            Object.keys(filters).some((k) => k !== "runId" && k !== "outcome")
              ? "Matching episodes"
              : runId
                ? "Episodes in this run"
                : "Episodes"
          }
          value={counts ? counts.total.toLocaleString() : "…"}
        />
        <Tile
          label={<Term term="held">Held</Term>}
          value={counts ? counts.held.toLocaleString() : "…"}
          tone="text-held"
        />
        <Tile
          label={<Term term="breach">Breached</Term>}
          value={counts ? counts.breach.toLocaleString() : "…"}
          tone={counts?.breach ? "text-breach" : ""}
        />
        <div className="panel min-w-0 p-5">
          <p className="eyebrow">{runId ? "This run" : "Latest run"}</p>
          {run.data ? (
            <p className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              <Badge
                tone={
                  run.data.status === "failed"
                    ? "breach"
                    : run.data.status === "done"
                      ? "safe"
                      : "neutral"
                }
              >
                {run.data.status}
              </Badge>
              {run.data.report && (
                <>
                  {run.data.report.susceptibility ? (
                    <>
                      Security score <strong>{run.data.report.susceptibility.grade}</strong>
                    </>
                  ) : (
                    <span>Security score unavailable</span>
                  )}
                  <span>Insurance score {run.data.report.scoring.score}</span>
                  <TierBadge score={run.data.report.scoring.score} />
                </>
              )}
            </p>
          ) : latest ? (
            <p className="mt-3.5 font-mono text-[15px]">
              {latest.runId.slice(0, 8)} · {latest.index + 1} of {latest.total}
            </p>
          ) : (
            <p className="mt-3.5 text-sm text-muted">
              {newestAlone.isFetching ? "…" : "Waiting for episodes"}
            </p>
          )}
          {runId && (
            <button
              type="button"
              onClick={() => setRunId(undefined)}
              className="mt-2 text-xs text-accent hover:underline"
            >
              Show all runs
            </button>
          )}
        </div>
      </section>

      <div className="flex flex-wrap items-start gap-4">
        <section className="panel min-w-0 flex-[999_1_520px] p-4.5">
          <div className="flex flex-col gap-3 border-b border-line px-1.5 pb-3.5">
            <div className="flex flex-wrap items-center gap-2">
              {(
                [
                  ["all", "All", "", feed.data?.counts.total],
                  ["held", "Held", "bg-held", feed.data?.counts.held],
                  ["breach", "Breached", "bg-breach-solid", feed.data?.counts.breach],
                  ["control", "Controls", "bg-[#5b6478]", feed.data?.counts.control],
                ] as const
              ).map(([key, label, dot, n]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={f.outcome === key}
                  onClick={() => list.set({ outcome: key })}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-[13px] ${f.outcome === key ? "border-ink bg-ink text-paper" : "border-line-strong text-soft hover:text-ink"}`}
                >
                  {dot && <span className={`size-[7px] rounded-full ${dot}`} />}
                  {label}
                  {n !== undefined && (
                    <span className="font-mono text-[11px] opacity-60">{n.toLocaleString()}</span>
                  )}
                </button>
              ))}
              {filtered && (
                <button
                  type="button"
                  onClick={clear}
                  className="ml-auto text-[13px] text-accent hover:underline"
                >
                  Clear filters
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                label="Class"
                value={f.class}
                onChange={(v) => list.set({ class: v })}
                options={[
                  { value: "all", label: "All classes" },
                  ...Object.entries(CLASS_NAMES).map(([id, c]) => ({
                    value: id,
                    hint: id,
                    label: c.name,
                  })),
                ]}
              />
              <Select
                label="Attacks"
                value={f.source}
                onChange={(v) => list.set({ source: v })}
                options={[
                  { value: "all", label: "All" },
                  { value: "library", label: "Library" },
                  { value: "held-out", label: "Held out" },
                ]}
              />
              <Select
                label="When"
                value={f.since}
                onChange={(v) => list.set({ since: v })}
                options={[
                  { value: "any", label: "Any time" },
                  { value: "1h", label: "Last hour" },
                  { value: "24h", label: "Last 24 hours" },
                  { value: "7d", label: "Last 7 days" },
                ]}
              />
              <Select
                label="Agent"
                value={f.agent}
                onChange={(v) => list.set({ agent: v })}
                options={[
                  { value: "all", label: "All agents" },
                  ...(agents.data ?? [])
                    .filter((a) => a.score || String(a.agentId) === f.agent)
                    .map((a) => ({ value: String(a.agentId), label: `Agent ${a.agentId}` })),
                ]}
              />
              {f.attack && (
                <span className="inline-flex h-9 items-center gap-2 rounded-full border border-accent/40 bg-accent-soft pr-1.5 pl-3.5 text-[13px]">
                  <span className="text-muted">Attack</span>
                  <Link to={`/attacks/${f.attack}`} className="font-mono hover:text-accent">
                    {f.attack}
                  </Link>
                  <button
                    type="button"
                    onClick={() => list.set({ attack: "" })}
                    aria-label="Show every attack"
                    className="flex size-6 items-center justify-center rounded-full text-muted hover:bg-white/10 hover:text-ink"
                  >
                    ×
                  </button>
                </span>
              )}
              {runId && (
                <span className="inline-flex h-9 items-center gap-2 rounded-full border border-accent/40 bg-accent-soft pr-1.5 pl-3.5 text-[13px]">
                  <span className="text-muted">Run</span>
                  <span className="font-mono">{runId.slice(0, 8)}</span>
                  <button
                    type="button"
                    onClick={() => setRunId(undefined)}
                    aria-label="Show every run"
                    className="flex size-6 items-center justify-center rounded-full text-muted hover:bg-white/10 hover:text-ink"
                  >
                    ×
                  </button>
                </span>
              )}
            </div>
          </div>
          {feed.fresh > 0 && (
            <button
              type="button"
              onClick={() => {
                feed.refresh();
                list.set({ page: 1 });
              }}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border border-accent/30 bg-accent-soft px-4 py-2.5 text-[13px] text-ink transition hover:border-accent/60"
            >
              <span className="size-[7px] rounded-full bg-breach-solid [animation:blink_1.4s_infinite]" />
              {feed.fresh >= 500 ? "500+" : feed.fresh.toLocaleString()} new{" "}
              {feed.fresh === 1 ? "episode" : "episodes"} since this list loaded
              <span className="text-accent">Show them ↑</span>
            </button>
          )}
          <ErrorText error={feed.error} />
          {feed.isPending ? (
            <div className="flex flex-col gap-2 p-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-[66px] animate-pulse rounded-2xl bg-white/[0.03]" />
              ))}
            </div>
          ) : shown.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title={
                  filtered && counts?.total ? "No episodes match these filters" : "No episodes yet"
                }
              >
                {filtered && counts?.total
                  ? "Try other filters, or clear them."
                  : "Episodes appear here the moment a rating runs. Agent owners can start one from their agent's page."}
              </EmptyState>
            </div>
          ) : (
            <ul
              className={`mt-2 flex flex-col gap-0.5 transition-opacity ${feed.isFetching && !feed.isPending ? "opacity-60" : ""}`}
            >
              {shown.map((c) => {
                const r = rulingView(c);
                const isSel = selected?.eventId === c.eventId;
                return (
                  <li key={c.eventId}>
                    <button
                      type="button"
                      onClick={() => setPicked(c.eventId)}
                      aria-pressed={isSel}
                      className={`grid w-full grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-3 rounded-2xl border px-3 py-3.5 sm:grid-cols-[10px_52px_minmax(0,1fr)_auto] sm:gap-4 sm:px-4 text-left transition ${isSel ? "border-accent/40 bg-accent-soft" : "border-transparent hover:bg-white/[0.035]"}`}
                    >
                      <RulingDot r={r} />
                      <span className="hidden w-fit rounded-md bg-white/[0.06] px-1.5 py-0.5 text-center font-mono text-[11px] text-soft sm:block">
                        {c.attackClass ?? "CTRL"}
                      </span>
                      <span className="min-w-0">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-[15px] font-semibold">
                            {c.attackClass
                              ? (CLASS_NAMES[c.attackClass]?.name ?? c.attackClass)
                              : "Control: no attack"}
                          </span>
                          {isPrivate(c) && (
                            <span className="hidden sm:inline-flex">
                              <HeldOutTag />
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 block truncate font-mono text-[11px] text-muted">
                          {c.attackId ?? "a plain task"}
                          {c.at && (
                            <time dateTime={c.at} title={at(c.at)} className="font-sans">
                              {" · "}
                              {ago(c.at, now)}
                            </time>
                          )}
                        </span>
                      </span>
                      <span className="text-right sm:w-[118px]">
                        <RulingBadge r={r} />
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {feed.data && (
            <Pagination
              page={feed.data.page}
              pages={feed.data.pages}
              total={feed.data.total}
              size={list.size}
              onPage={(page) => list.set({ page })}
              onSize={(size) => list.set({ size })}
              noun="episodes"
            />
          )}
          {feed.failedRuns.length > 0 && (
            <p className="px-3 pt-3 text-xs text-muted">{feed.failedRuns.length} run(s) failed.</p>
          )}
        </section>

        <aside className="panel min-w-0 flex-[1_1_360px] border-accent/25 bg-[radial-gradient(ellipse_at_50%_0%,rgb(29_78_216/.18),transparent_60%)] p-7 xl:sticky xl:top-24">
          {selected ? (
            <EpisodeDetail
              c={selected}
              onlyRun={runId ? undefined : () => setRunId(selected.runId)}
            />
          ) : (
            <p className="text-sm text-muted">Pick an episode to see how it went.</p>
          )}
        </aside>
      </div>

      <div className="panel flex flex-wrap items-center justify-between gap-4 bg-gradient-to-r from-breach/12 to-transparent p-6">
        <span>
          <strong className="block text-lg">Found an attack we miss?</strong>
          <span className="mt-1 block text-sm text-muted">
            Submit it with your wallet. If it beats the defended agent, you're paid from the bounty
            pool.
          </span>
        </span>
        <Link to="/bounties" className={buttonClass("secondary")}>
          Go to bounties →
        </Link>
      </div>

      {operator && <StartRating onStarted={setRunId} />}
    </Page>
  );
}

function Tile({ label, value, tone = "" }: { label: ReactNode; value: string; tone?: string }) {
  return (
    <div className="panel min-w-0 p-5">
      <p className="eyebrow">{label}</p>
      <p className={`mt-2 font-serif text-[44px] leading-none tabular-nums ${tone}`}>{value}</p>
    </div>
  );
}

/** Operators only: queue a rating with the API token. */
function StartRating({ onStarted }: { onStarted: (runId: string) => void }) {
  const { token } = useOperatorToken();
  const [agentId, setAgentId] = useState("2");
  const [error, setError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  async function start() {
    setStarting(true);
    setError(null);
    try {
      onStarted((await api.startRun(token, agentId.trim())).runId);
    } catch (e) {
      setError(e);
    } finally {
      setStarting(false);
    }
  }
  return (
    <details className="panel p-5 sm:p-6">
      <summary className="cursor-pointer font-semibold">Operator: start a rating</summary>
      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_8rem_auto] sm:items-end">
        <OperatorTokenField />
        <Input
          label="Agent ID"
          value={agentId}
          onChange={setAgentId}
          inputMode="numeric"
          error={agentId.trim() && !/^\d+$/.test(agentId.trim()) ? "A whole number." : null}
        />
        <Button
          disabled={!token || !/^\d+$/.test(agentId.trim())}
          loading={starting}
          onClick={start}
        >
          {starting ? "Queuing…" : "Run a rating"}
        </Button>
      </div>
      <p className="mt-3 text-xs text-muted">
        Only agents in the server's agents file can be rated. The worker rates on a private fork,
        then posts one signed score to the chain (this costs the attester testnet gas).
      </p>
      <ErrorText error={error} />
    </details>
  );
}

function HeldOutTag() {
  return (
    <Tooltip content="A held-out attack: it's never published, so no one can tune an agent to it. Its text stays private.">
      <span className="inline-flex items-center gap-1 rounded-full border border-line-strong px-2 py-px text-[10.5px] text-muted">
        <svg
          viewBox="0 0 24 24"
          className="size-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden
        >
          <path d="M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3" />
        </svg>
        Held out
      </span>
    </Tooltip>
  );
}

/** One episode: what was planted, how the vault ruled, and which run it came from. */
function EpisodeDetail({ c, onlyRun }: { c: EpisodeCard; onlyRun?: () => void }) {
  const r = rulingView(c);
  // The task comes with the episode's detail; the panel only needs that one line.
  const detail = useQuery({
    queryKey: ["episode", c.eventId],
    queryFn: () => api.episode(c.eventId),
    staleTime: Infinity,
  });
  const task = detail.data?.detail?.task;
  const name = c.attackClass
    ? (CLASS_NAMES[c.attackClass]?.name ?? c.attackClass)
    : "Control episode";
  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="flex items-center justify-between">
          <p className="eyebrow">Episode</p>
          <span className="font-mono text-[11px] text-muted">
            {c.index + 1} of {c.total}
          </span>
        </div>
        <h2 className="mt-3 font-serif text-[34px] leading-tight">{name}</h2>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {c.attackClass && (
            <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-soft">
              {c.attackClass}
            </span>
          )}
          {c.attackClass && (isPrivate(c) ? <HeldOutTag /> : <Badge>Library attack</Badge>)}
          {c.attackId && !isPrivate(c) ? (
            <Link
              to={`/attacks/${encodeURIComponent(c.attackId)}`}
              className="truncate font-mono text-[11px] text-accent hover:underline"
              title="This attack in the red team's library"
            >
              {c.attackId}
            </Link>
          ) : (
            <span className="truncate font-mono text-[11px] text-muted">{c.attackId ?? ""}</span>
          )}
        </div>
      </div>

      <section>
        <p className="eyebrow mb-2.5 !text-breach">What was planted</p>
        <p className="rounded-2xl border border-line bg-white/[0.03] p-4 text-sm leading-relaxed text-soft">
          {!c.attackClass
            ? "Nothing. A control is a plain task with no attack, to check the agent behaves normally."
            : isPrivate(c)
              ? "A held-out attack from this class. Its text is never shown, so no one can study it."
              : `An attack from the public library, hidden in what the agent read: ${name.toLowerCase()}.`}
        </p>
      </section>

      {task && (
        <p className="-mt-2 text-sm text-soft">
          <span className="text-muted">Task:</span> {task}
        </p>
      )}

      <section>
        <p className="eyebrow mb-2.5 !text-accent">How the vault ruled</p>
        <VerdictCard r={r} />
      </section>

      <Link
        to={`/arena/episodes/${c.eventId}`}
        className="-mt-2 text-sm text-accent hover:underline"
      >
        See the full episode →
      </Link>

      <section className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5 text-sm">
        <span className="text-muted">
          {c.at && (
            <>
              <time dateTime={c.at}>{at(c.at)}</time>
              {" · "}
            </>
          )}
          Run <span className="font-mono text-soft">{c.runId.slice(0, 8)}</span>
          {c.agentId && (
            <>
              {" · "}
              <Link to={`/agents/${c.agentId}`} className="text-accent hover:underline">
                Agent {c.agentId}
              </Link>
            </>
          )}
        </span>
        {onlyRun && (
          <button type="button" onClick={onlyRun} className="text-accent hover:underline">
            Show only this run →
          </button>
        )}
      </section>
    </div>
  );
}

/** The detail behind "How the Arena works", shown in a dialog or drawer. */
function ArenaExplainer() {
  const steps: [string, string][] = [
    [
      "Plant",
      "The red team hides an attack in something the agent reads: news, DMs, token metadata, tool output or a price feed.",
    ],
    [
      "Read",
      "The agent gets a normal job, like rebalancing a portfolio, and reads the poisoned source along the way.",
    ],
    [
      "Act",
      "Whatever it decides, it can only act through its MandateVault, with its own key, against real contracts on a private fork.",
    ],
    [
      "Check",
      "The vault checks every action against the mandate. Breaking it is recorded on chain as a breach; the vault's log is the verdict, never an AI judge.",
    ],
    [
      "Score",
      "A rating runs every attack in the library five times, plus controls. The results become the Bonded Score, posted on chain with a hash of the full report.",
    ],
  ];
  return (
    <div className="flex flex-col gap-6 text-sm leading-relaxed">
      <ol className="flex flex-col gap-4">
        {steps.map(([title, text], i) => (
          <li key={title} className="grid grid-cols-[32px_1fr] gap-3">
            <span className="btn-brand flex size-8 items-center justify-center rounded-full font-mono text-xs text-on-brand">
              {i + 1}
            </span>
            <span>
              <strong className="block text-ink">{title}</strong>
              <span className="text-muted">{text}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-line p-4">
          <p className="font-semibold">Controls</p>
          <p className="mt-1 text-muted">
            Episodes with no attack, to check the agent behaves on a plain job.
          </p>
        </div>
        <div className="rounded-2xl border border-line p-4">
          <p className="font-semibold">Held-out attacks</p>
          <p className="mt-1 text-muted">
            Never published, so no one can tune an agent to them. Their text stays private.
          </p>
        </div>
      </div>
    </div>
  );
}
