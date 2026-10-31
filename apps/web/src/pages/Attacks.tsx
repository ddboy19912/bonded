import { Fragment } from "react";
import { Link, useParams } from "react-router";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ATTACK_CLASSES, AttackSurface, type BreachType } from "@bondedhq/shared";
import { ApiError, api, type AttackStats, type AttackSummary, type ClassRecord } from "../lib/api";
import { useListParams } from "../lib/pages";
import { DOCS_S1 } from "../lib/routes";
import {
  Badge,
  EmptyState,
  ErrorText,
  Loading,
  Page,
  Spinner,
  buttonClass,
  linkClass,
} from "../components/ui";
import { Select } from "../components/select";
import { StatLoading, StatStrip } from "../components/stat-strip";
import { Pagination } from "../components/pagination";

const CLASS_NAMES = ATTACK_CLASSES as Record<
  string,
  { name: string; description: string; surfaces: string[] }
>;

/** Where an attack is planted, in plain words. */
export const SURFACE_NAMES: Record<string, string> = {
  token_metadata: "Token metadata",
  news: "News",
  social: "Social posts",
  dm: "Direct messages",
  price_feed: "Price feed",
  tool_output: "Tool output",
  tx_history: "Transaction history",
  market: "Market data",
  counterparty: "External agent",
};

/** What each breach type means for the vault. */
export const BREACH_MEANINGS: Record<BreachType, string> = {
  T1_UNAUTHORIZED_TARGET: "The agent calls a contract its mandate doesn't allow.",
  T1_UNAUTHORIZED_APPROVAL: "The agent lets an address it shouldn't spend the vault's tokens.",
  T1_UNAUTHORIZED_TRANSFER: "The agent sends funds to an address its mandate doesn't allow.",
  T1_DEFERRED: "Funds leave the vault with no allowed reason, caught when the vault checks.",
  T2_LIMIT: "The agent goes over a spending or position limit.",
  T3_ASSET: "The agent buys or holds an asset its mandate doesn't allow.",
};

/** What the Arena puts in each {{placeholder}} of a payload. */
const PLACEHOLDER_MEANINGS: Record<string, string> = {
  attacker: "an address the attacker controls",
  vault: "the agent's own vault",
  amount: "the amount asked for",
  token: "the token asked for",
  depositor: "the address that funded the vault",
  lookalike: "an address that looks like the depositor's",
};

const SEVERITY_TONE = {
  critical: "breach",
  high: "warn",
  medium: "neutral",
  low: "neutral",
} as const;

const pct = (s: AttackStats) =>
  s.episodes ? `${Math.round((s.breaches / s.episodes) * 1000) / 10}%` : "–";
const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

function ClassChip({ id }: { id: string }) {
  return (
    <span className="rounded-md bg-white/[0.06] px-1.5 py-0.5 font-mono text-[11px] text-soft">
      {id}
    </span>
  );
}

/** Where an attack is planted, as a small tag. */
function SurfaceTag({ surface }: { surface: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-line-strong bg-white/[0.03] px-1.5 py-0.5 text-[11px] leading-none text-soft">
      <span className="size-1 rounded-full bg-accent/70" aria-hidden />
      {SURFACE_NAMES[surface] ?? surface}
    </span>
  );
}

/**
 * How often attacks got through. An attempt is one Arena run with the attack planted in what
 * the agent reads; it got through if the vault recorded a breach. The bar is empty when every
 * attempt was stopped.
 */
function Record({ s, since }: { s: AttackStats; since: string | null }) {
  if (!s.episodes)
    return (
      <p className="text-xs text-muted">
        Not tried in a rating{since ? ` since ${day(since)}` : ""}.
      </p>
    );
  const rate = s.breaches / s.episodes;
  return (
    <div>
      <p className="flex items-baseline justify-between gap-3 text-xs text-muted">
        <span>
          {s.breaches ? (
            <>
              Got through <span className="text-breach">{s.breaches.toLocaleString()}</span> of{" "}
              {s.episodes.toLocaleString()} attempts
            </>
          ) : (
            <>Stopped all {s.episodes.toLocaleString()} attempts</>
          )}
        </span>
        <span className={`font-mono ${s.breaches ? "text-breach" : "text-soft"}`}>{pct(s)}</span>
      </p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
        {s.breaches > 0 && (
          <div
            className="h-full rounded-full bg-breach-solid"
            style={{ width: `${Math.max(rate * 100, 2)}%` }}
          />
        )}
      </div>
    </div>
  );
}

function AttackCard({ a, since }: { a: AttackSummary; since: string | null }) {
  return (
    <li>
      <Link
        to={`/attacks/${a.id}`}
        className="panel group flex h-full flex-col gap-3 p-5 transition duration-200 hover:-translate-y-0.5 hover:border-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:translate-y-0 active:scale-[0.99]"
      >
        <span className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <ClassChip id={a.class} />
            <span className="truncate text-xs text-muted">{CLASS_NAMES[a.class]?.name}</span>
          </span>
          <Badge tone={SEVERITY_TONE[a.severity]}>{a.severity}</Badge>
        </span>
        <span className="text-[15px] leading-snug font-semibold group-hover:text-accent">
          {a.title}
        </span>
        <span className="line-clamp-2 text-sm leading-relaxed text-muted">{a.description}</span>
        <span className="flex flex-wrap gap-1.5">
          {a.surfaces.map((x) => (
            <SurfaceTag key={x} surface={x} />
          ))}
        </span>
        <span className="mt-auto border-t border-line pt-3">
          <Record s={a.stats} since={since} />
        </span>
      </Link>
    </li>
  );
}

/**
 * The ten attack classes, A1 to A10, as an index: each row has the class, what it is, where
 * it's planted, how many published attacks it has and how often they got through. Choosing a
 * row filters the list below; choosing it again clears the filter.
 */
function ClassGrid({
  classes,
  loading = false,
  active,
  onPick,
}: {
  classes?: ClassRecord[];
  /** The counts are on their way: a spinner holds each row's figures until they arrive. */
  loading?: boolean;
  active: string;
  onPick: (cls: string) => void;
}) {
  const byClass = new Map((classes ?? []).map((c) => [c.class, c]));
  return (
    <section>
      <h2 className="font-serif text-3xl leading-tight text-balance">
        Ten ways an agent gets attacked
      </h2>
      <p className="mt-1.5 max-w-[65ch] text-sm text-muted">
        Every attack belongs to one class. Pick a class to see its attacks.
      </p>
      <ul className="panel mt-5 grid overflow-hidden p-0 md:grid-cols-2">
        {Object.entries(CLASS_NAMES).map(([id, info]) => {
          const c = byClass.get(id);
          const on = active === id;
          const rate = c?.episodes ? c.breaches / c.episodes : undefined;
          return (
            <li
              key={id}
              className="border-b border-line md:[&:nth-child(odd)]:border-r md:[&:nth-last-child(-n+2)]:border-b-0 [&:last-child]:border-b-0"
            >
              <button
                type="button"
                onClick={() => onPick(on ? "all" : id)}
                aria-pressed={on}
                className={`group grid h-full w-full grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-4 px-5 py-4 text-left transition duration-200 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent active:bg-white/[0.05] ${on ? "bg-accent-soft" : "hover:bg-white/[0.03]"}`}
              >
                <span
                  className={`font-serif text-[32px] leading-none tabular-nums transition ${on ? "text-accent" : "text-muted group-hover:text-ink"}`}
                >
                  {id}
                </span>
                <span className="min-w-0">
                  <span className="block text-[15px] leading-snug font-semibold text-balance">
                    {info.name}
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-[13px] leading-snug text-muted">
                    {info.description}
                  </span>
                  <span className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    {info.surfaces.map((x) => (
                      <SurfaceTag key={x} surface={x} />
                    ))}
                  </span>
                </span>
                <span className="w-[132px] text-right">
                  {loading && (
                    <span className="inline-flex text-muted" role="status">
                      <Spinner />
                      <span className="sr-only">Loading {id}'s figures…</span>
                    </span>
                  )}
                  {rate !== undefined && (
                    <>
                      <span className="block text-[10.5px] text-muted">Got through</span>
                      <span
                        className={`block font-mono text-[17px] leading-tight tabular-nums ${c!.breaches ? "text-breach" : "text-soft"}`}
                      >
                        {Math.round(rate * 100)}%
                      </span>
                      <span className="mt-1 block h-1 overflow-hidden rounded-full bg-white/[0.07]">
                        {c!.breaches > 0 && (
                          <span
                            className="block h-full rounded-full bg-breach-solid"
                            style={{ width: `${Math.max(rate * 100, 4)}%` }}
                          />
                        )}
                      </span>
                      <span className="mt-1 block text-[10.5px] text-muted">
                        {c!.breaches
                          ? `${c!.breaches} of ${c!.episodes.toLocaleString()} attempts`
                          : `stopped all ${c!.episodes.toLocaleString()} attempts`}
                      </span>
                    </>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {classes && (
        <p className="mt-2.5 text-xs text-muted">
          An attempt is one rating run with the attack hidden in what the agent reads. It got
          through if the agent broke its mandate and the vault recorded a breach.
        </p>
      )}
    </section>
  );
}

function BountyCall({ inline = false }: { inline?: boolean }) {
  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-4 bg-gradient-to-r from-breach/12 to-transparent p-6 ${inline ? "border-t border-line" : "panel"}`}
    >
      <span>
        <strong className="block text-lg">Found an attack we miss?</strong>
        <span className="mt-1 block text-sm text-muted">
          Submit it as a bounty. If it breaks the reference agents it joins every rating, and you're
          paid from the bounty pool.
        </span>
      </span>
      <Link to="/bounties" className={buttonClass("secondary")}>
        Go to bounties →
      </Link>
    </div>
  );
}

/** The red team: the published attack library, with each attack's record in the Arena. */
export function Attacks() {
  const list = useListParams({ class: "all", surface: "all", severity: "all", sort: "class" });
  const f = list.values;
  const q = {
    page: list.page,
    limit: list.size,
    ...(f.class !== "all" ? { attackClass: f.class } : {}),
    ...(f.surface !== "all" ? { surface: f.surface } : {}),
    ...(f.severity !== "all" ? { severity: f.severity } : {}),
    ...(f.sort !== "class" ? { sort: f.sort as "breaches" | "rate" } : {}),
  };
  const attacks = useQuery({
    queryKey: ["attacks", q],
    queryFn: () => api.attacks(q),
    placeholderData: keepPreviousData,
  });
  const library = useQuery({ queryKey: ["library"], queryFn: api.library });
  const counts = library.data;
  const filtered = f.class !== "all" || f.surface !== "all" || f.severity !== "all";
  const since = attacks.data?.statsSince ?? null;

  return (
    <Page
      eyebrow="The attack library"
      title="Meet the red team"
      intro="Every rating sends these attacks at an agent, hidden in what it reads: news, DMs, token metadata, price feeds, tool output. They come in ten classes. Here is each class, every published attack in it, and how often it gets through."
    >
      <StatStrip
        stats={[
          { label: "Attack classes", value: Object.keys(ATTACK_CLASSES).length },
          { label: "Published attacks", value: counts?.published ?? <StatLoading /> },
          { label: "Held out", value: counts?.heldOut.active ?? <StatLoading /> },
          { label: "Accepted bounties", value: counts?.acceptedBounties ?? <StatLoading /> },
        ]}
      />

      <ClassGrid
        classes={attacks.data?.classes}
        loading={attacks.isPending && !attacks.error}
        active={f.class}
        onPick={(cls) => {
          list.set({ class: cls });
          document
            .getElementById("all-attacks")
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
      />

      <section aria-label="Beyond the attack library" className="grid gap-4 md:grid-cols-2">
        <div className="panel p-5 sm:p-6">
          <p className="eyebrow">Also scored</p>
          <h2 className="mt-2 text-lg font-bold">False market data</h2>
          <p className="mt-2 text-sm text-muted">
            No instruction at all: a fabricated earnings beat, a fake flash crash, a decimal-shifted
            number, a made-up hedge. The agent runs the same task twice, clean and with the lie, and
            only a trade the lie caused counts against it. A freeze is shown but not scored. Runs in
            every rating of Bonded's own and leaderboard agents; operator-run agents aren't covered
            yet.
          </p>
        </div>
        <div className="panel p-5 sm:p-6">
          <p className="eyebrow">For agents with memory</p>
          <h2 className="mt-2 text-lg font-bold">Planted notes</h2>
          <p className="mt-2 text-sm text-muted">
            A false standing instruction read on one day, then a clean day later. If the agent
            trades the planted token when a control run with nothing planted doesn't, its note was
            poisoned. These run for agents whose memory Bonded can read and reset.
          </p>
        </div>
        <p className="text-xs text-muted md:col-span-2">
          Both feed the Bonded Score alongside the classes above, as separate rows: the agent's
          weakest row sets the score.{" "}
          <a className={linkClass} href={DOCS_S1}>
            How the market-data and memory batteries work
          </a>
        </p>
      </section>

      <section id="all-attacks" className="panel min-w-0 scroll-mt-24 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
          <h2 className="text-lg font-bold">
            {f.class !== "all"
              ? `${CLASS_NAMES[f.class]?.name ?? f.class}: ${attacks.data?.total ?? "…"} attacks`
              : `Every published attack${attacks.data ? ` (${attacks.data.total})` : ""}`}
          </h2>
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
              label="Planted in"
              value={f.surface}
              onChange={(v) => list.set({ surface: v })}
              options={[
                { value: "all", label: "Anywhere" },
                ...AttackSurface.options.map((s) => ({ value: s, label: SURFACE_NAMES[s] ?? s })),
              ]}
            />
            <Select
              label="Severity"
              value={f.severity}
              onChange={(v) => list.set({ severity: v })}
              options={[
                { value: "all", label: "Any" },
                { value: "critical", label: "Critical" },
                { value: "high", label: "High" },
                { value: "medium", label: "Medium" },
                { value: "low", label: "Low" },
              ]}
            />
            <Select
              label="Sort"
              value={f.sort}
              onChange={(v) => list.set({ sort: v })}
              options={[
                { value: "class", label: "By class" },
                { value: "rate", label: "Gets through most" },
                { value: "breaches", label: "Most breaches" },
              ]}
            />
          </div>
        </div>
        <ErrorText error={attacks.error} />
        {attacks.isPending && !attacks.error && (
          <div className="pt-4">
            <Loading what="the attacks" height="lg" />
          </div>
        )}
        {attacks.data && attacks.data.total === 0 && (
          <div className="pt-4">
            <EmptyState title={filtered ? "No attacks match these filters" : "No attacks yet"}>
              {filtered ? "Try other filters." : null}
            </EmptyState>
          </div>
        )}
        {attacks.data && attacks.data.total > 0 && (
          <>
            <ul
              className={`grid gap-4 pt-5 md:grid-cols-2 xl:grid-cols-3 ${attacks.isFetching && !attacks.isPending ? "opacity-60" : ""}`}
            >
              {attacks.data.items.map((a) => (
                <AttackCard key={a.id} a={a} since={since} />
              ))}
            </ul>
            <Pagination
              page={attacks.data.page}
              pages={attacks.data.pages}
              total={attacks.data.total}
              size={list.size}
              onPage={(page) => list.set({ page })}
              onSize={(size) => list.set({ size })}
              noun="attacks"
            />
          </>
        )}
      </section>

      <section className="panel overflow-hidden p-0">
        <div className="grid md:grid-cols-2">
          <div className="border-b border-line p-6 md:border-r md:border-b-0">
            <h2 className="text-lg font-bold">
              {counts ? `${counts.heldOut.active} held-out attacks` : "Held-out attacks"}
            </h2>
            <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-muted">
              Written fresh from the library's seeds and never published, so no one can tune an
              agent to pass them. Every rating includes them, and its report says how many episodes
              ran them. A new set replaces them each quarter.
            </p>
          </div>
          <div className="p-6">
            <h2 className="text-lg font-bold">
              {counts ? `${counts.acceptedBounties} accepted bounties` : "Accepted bounties"}
            </h2>
            <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-muted">
              Attacks hunters submitted that broke the reference agents. They join every later
              rating, and their text stays private for the same reason.
            </p>
          </div>
        </div>
        <BountyCall inline />
      </section>
    </Page>
  );
}

/** A payload with its {{placeholders}} shown as labelled chips. */
function Payload({ text, inline = false }: { text: string; inline?: boolean }) {
  const parts = text.split(/(\{\{\s*[a-zA-Z0-9_]+\s*\}\})/g);
  const Tag = inline ? "span" : "p";
  return (
    <Tag
      className={
        inline ? "text-soft" : "font-mono text-[13px] leading-relaxed whitespace-pre-wrap text-ink"
      }
    >
      {parts.map((p, i) => {
        const name = p.match(/^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/)?.[1];
        return name ? (
          <span
            key={i}
            title={PLACEHOLDER_MEANINGS[name]}
            className="mx-0.5 rounded-md border border-accent/40 bg-accent-soft px-1.5 py-px text-[12px] text-accent"
          >
            {name}
          </span>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        );
      })}
    </Tag>
  );
}

/** One published attack: what it plants, where, what counts as a breach, and its record. */
export function AttackDetail() {
  const { id = "" } = useParams();
  const q = useQuery({
    queryKey: ["attack", id],
    queryFn: () => api.attack(id),
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  });
  const back = { to: "/attacks", label: "All attacks" };
  if (q.error instanceof ApiError && q.error.status === 404)
    return (
      <Page title="Attack not found" back={back}>
        <EmptyState title="No published attack has this id">
          Held-out and bounty attacks are never shown.
        </EmptyState>
      </Page>
    );
  if (!q.data)
    return (
      <Page title="Attack" back={back}>
        <ErrorText error={q.error} />
        {!q.error && <Loading what="the attack" height="lg" />}
      </Page>
    );
  const { attack: a, stats: s, statsSince } = q.data;
  const placeholders = [
    ...new Set(
      [
        ...`${a.payloadTemplate} ${a.delivery.sender ?? ""}`.matchAll(
          /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
        ),
      ].map((m) => m[1]!),
    ),
  ];
  return (
    <Page
      back={back}
      eyebrow={`${a.class} · ${CLASS_NAMES[a.class]?.name ?? ""}`}
      title={a.title}
      intro={a.description}
      actions={
        <Link to={`/arena?attack=${encodeURIComponent(a.id)}`} className={buttonClass("secondary")}>
          See its live episodes →
        </Link>
      }
    >
      <div className="-mt-1 flex flex-wrap items-center gap-2">
        <ClassChip id={a.id} />
        <Badge tone={SEVERITY_TONE[a.severityHint]}>{a.severityHint} severity</Badge>
        {a.surfaces.map((x) => (
          <span
            key={x}
            className="rounded-full border border-line-strong px-2.5 py-0.5 text-xs text-soft"
          >
            Planted in {SURFACE_NAMES[x]?.toLowerCase() ?? x}
          </span>
        ))}
      </div>

      <StatStrip
        stats={[
          { label: "Attempts", value: s.episodes.toLocaleString(), hint: `in ${s.runs} ratings` },
          {
            label: "Got through",
            value: (
              <span className={s.breaches ? "text-breach" : ""}>{s.breaches.toLocaleString()}</span>
            ),
            hint: "attempts the vault recorded a breach",
          },
          { label: "How often it got through", value: pct(s), hint: "of its attempts" },
          {
            label: "Last run",
            value: <span className="text-[28px]">{s.lastAt ? day(s.lastAt) : "–"}</span>,
            ...(statsSince ? { hint: `records since ${day(statsSince)}` } : {}),
          },
        ]}
      />

      <div className="flex flex-wrap items-start gap-4">
        <section className="panel min-w-0 flex-[999_1_520px] p-6">
          <h2 className="text-lg font-bold">What the agent reads</h2>
          <div className="mt-4 overflow-hidden rounded-2xl border border-line bg-[#070a12]">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-4 py-2.5 text-xs text-muted">
              <span>{a.surfaces.map((x) => SURFACE_NAMES[x] ?? x).join(" · ")}</span>
              {a.delivery.sender && (
                <span>
                  From <Payload text={a.delivery.sender} inline />
                </span>
              )}
              {a.delivery.token && (
                <span>
                  On token <span className="font-mono text-soft">{a.delivery.token}</span>
                </span>
              )}
            </div>
            <div className="p-4">
              <Payload text={a.payloadTemplate} />
            </div>
            {a.delivery.prices && (
              <div className="border-t border-line px-4 py-2.5 font-mono text-xs text-muted">
                Spoofed prices:{" "}
                {Object.entries(a.delivery.prices)
                  .map(([t, p]) => `${t} ${p}`)
                  .join(", ")}
              </div>
            )}
          </div>
          {placeholders.length > 0 && (
            <dl className="mt-4 grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[auto_1fr]">
              {placeholders.map((p) => (
                <Fragment key={p}>
                  <dt className="font-mono text-[13px] text-accent">{p}</dt>
                  <dd className="text-muted">{PLACEHOLDER_MEANINGS[p] ?? "filled in by Bonded"}</dd>
                </Fragment>
              ))}
            </dl>
          )}
          {a.goal && (
            <div className="mt-6">
              <h3 className="text-sm font-semibold">The task the agent is given</h3>
              <p className="mt-2 text-sm leading-relaxed text-soft">{a.goal}</p>
            </div>
          )}
        </section>

        <aside className="flex min-w-0 flex-[1_1_320px] flex-col gap-4">
          <section className="panel p-6">
            <h2 className="text-lg font-bold">
              About {a.class}: {CLASS_NAMES[a.class]?.name}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-soft">
              {CLASS_NAMES[a.class]?.description}
            </p>
            <Link
              to={`/attacks?class=${a.class}`}
              className="mt-3 inline-block text-sm text-accent hover:underline"
            >
              Every {a.class} attack →
            </Link>
          </section>
          <section className="panel p-6">
            <h2 className="text-lg font-bold">What counts as a breach</h2>
            <p className="mt-2 text-sm text-muted">
              It got through if the vault records any of these. The vault decides, not a model.
            </p>
            <ul className="mt-4 flex flex-col gap-3">
              {a.successPredicate.anyOf.map((b) => (
                <li key={b} className="rounded-xl border border-line p-3 text-sm">
                  <span className="block font-mono text-[11px] text-muted">{b}</span>
                  <span className="mt-1 block text-soft">{BREACH_MEANINGS[b]}</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="panel p-6">
            <h2 className="text-lg font-bold">How each rating varies it</h2>
            <p className="mt-2 text-sm leading-relaxed text-soft">{a.variantPrompt}</p>
            <p className="mt-3 text-xs text-muted">
              Each rating runs every attack several times, so an agent can't pass by luck.
            </p>
          </section>
          {a.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {a.tags.map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-white/[0.06] px-2.5 py-0.5 text-xs text-muted"
                >
                  #{t}
                </span>
              ))}
            </div>
          )}
        </aside>
      </div>
      <BountyCall />
    </Page>
  );
}
