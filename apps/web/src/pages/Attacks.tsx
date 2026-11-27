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
  MoreLink,
  Page,
  Section,
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
    <span className="inline-flex rounded-full border border-line-strong px-2 py-px font-mono text-[11.5px] leading-[18px] text-soft">
      {id}
    </span>
  );
}

/** Where an attack is planted, as a small outlined tag. */
function SurfaceTag({ surface }: { surface: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[11.5px] leading-none text-muted">
      <span className="size-1 rounded-full bg-accent/70" aria-hidden />
      {SURFACE_NAMES[surface] ?? surface}
    </span>
  );
}

/** A thin bar for how often attacks got through: empty when every attempt was stopped. */
function RateBar({ rate, min = 2 }: { rate: number; min?: number }) {
  return (
    <span aria-hidden className="mt-2.5 block h-0.5 bg-white/10">
      {rate > 0 && (
        <span
          className="block h-full bg-breach-solid"
          style={{ width: `${Math.max(rate * 100, min)}%` }}
        />
      )}
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
      <p className="text-[13px] text-muted">
        Not tried in the Arena{since ? ` since ${day(since)}` : ""}.
      </p>
    );
  const rate = s.breaches / s.episodes;
  return (
    <div>
      <p
        className={`text-[clamp(22px,2vw,28px)] leading-none font-medium tracking-[-0.04em] tabular-nums ${s.breaches ? "text-breach" : "text-soft"}`}
      >
        {pct(s)}
      </p>
      <RateBar rate={rate} />
      <p className="mt-2 text-[13px] text-muted">
        {s.breaches ? (
          <>
            Got through <span className="text-breach">{s.breaches.toLocaleString()}</span> of{" "}
            {s.episodes.toLocaleString()} attempts
          </>
        ) : (
          <>Stopped all {s.episodes.toLocaleString()} attempts</>
        )}
      </p>
    </div>
  );
}

/** One published attack as an open row: its class, title and line, where it hides, and its record. */
function AttackCard({ a, since }: { a: AttackSummary; since: string | null }) {
  return (
    <li>
      <Link
        to={`/attacks/${a.id}`}
        className="group relative isolate grid gap-x-8 gap-y-4 border-t border-line py-6 before:absolute before:inset-y-0 before:-inset-x-3 before:-z-10 before:bg-white/[0.035] before:opacity-0 before:transition-opacity hover:before:opacity-100 focus-visible:before:opacity-100 md:grid-cols-[minmax(0,1fr)_13rem]"
      >
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <ClassChip id={a.class} />
            <span className="eyebrow truncate">{CLASS_NAMES[a.class]?.name}</span>
            <Badge tone={SEVERITY_TONE[a.severity]}>{a.severity}</Badge>
          </span>
          <span className="mt-3 block text-[clamp(19px,1.8vw,24px)] leading-snug font-medium tracking-[-0.03em] transition-colors group-hover:text-accent">
            {a.title}
          </span>
          <span className="mt-1.5 line-clamp-2 block max-w-2xl text-[15px] leading-relaxed text-muted">
            {a.description}
          </span>
          <span className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
            {a.surfaces.map((x) => (
              <SurfaceTag key={x} surface={x} />
            ))}
          </span>
        </span>
        <span className="md:pt-1">
          <Record s={a.stats} since={since} />
        </span>
      </Link>
    </li>
  );
}

/**
 * The ten attack classes, A1 to A10, as an index: each row has the class, what it is, where
 * it's planted, and how often its attacks got through. Choosing a row filters the list below;
 * choosing it again clears the filter.
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
    <Section
      label="Classes"
      title="Ten ways an agent gets attacked"
      intro="Every attack belongs to one class. Pick a class to see its attacks."
    >
      <ul className="border-b border-line">
        {Object.entries(CLASS_NAMES).map(([id, info]) => {
          const c = byClass.get(id);
          const on = active === id;
          const rate = c?.episodes ? c.breaches / c.episodes : undefined;
          return (
            <li key={id} className="border-t border-line">
              <button
                type="button"
                onClick={() => onPick(on ? "all" : id)}
                aria-pressed={on}
                className={`group relative isolate grid w-full grid-cols-[3.25rem_minmax(0,1fr)] items-start gap-x-5 gap-y-4 py-5 text-left before:absolute before:inset-y-0 before:-inset-x-3 before:-z-10 before:bg-white/[0.035] before:transition-opacity sm:grid-cols-[4.5rem_minmax(0,1fr)_9.5rem] sm:items-center ${on ? "before:opacity-100" : "before:opacity-0 hover:before:opacity-100"}`}
              >
                <span
                  className={`text-[clamp(26px,2.8vw,40px)] leading-none font-medium tracking-[-0.05em] tabular-nums transition-colors ${on ? "text-accent" : "text-dim group-hover:text-ink"}`}
                >
                  {id}
                </span>
                <span className="min-w-0">
                  <span
                    className={`block text-[clamp(18px,1.7vw,23px)] leading-snug font-medium tracking-[-0.03em] ${on ? "text-accent" : ""}`}
                  >
                    {info.name}
                  </span>
                  <span className="mt-1 line-clamp-2 block max-w-2xl text-[14px] leading-snug text-muted">
                    {info.description}
                  </span>
                  <span className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                    {info.surfaces.map((x) => (
                      <SurfaceTag key={x} surface={x} />
                    ))}
                  </span>
                </span>
                <span className="col-start-2 sm:col-start-auto sm:text-right">
                  {loading && (
                    <span className="inline-flex text-muted" role="status">
                      <Spinner />
                      <span className="sr-only">Loading {id}'s figures…</span>
                    </span>
                  )}
                  {rate !== undefined && (
                    <>
                      <span className="eyebrow block">Got through</span>
                      <span
                        className={`mt-1.5 block text-[clamp(22px,2vw,28px)] leading-none font-medium tracking-[-0.04em] tabular-nums ${c!.breaches ? "text-breach" : "text-soft"}`}
                      >
                        {Math.round(rate * 100)}%
                      </span>
                      <RateBar rate={rate} min={4} />
                      <span className="mt-1.5 block font-mono text-[11px] text-muted">
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
        <p className="mt-4 max-w-2xl text-[13px] leading-relaxed text-muted">
          An attempt is one Arena run with the attack hidden in what the agent reads. It got through
          if the agent broke its mandate and the vault recorded a breach.
        </p>
      )}
    </Section>
  );
}

/** The call to submit a missed attack: a line and a button, under a hairline. */
function BountyCall() {
  return (
    <div className="flex flex-wrap items-end justify-between gap-6 border-t border-line pt-8">
      <span className="max-w-2xl">
        <strong className="h-section block">Found an attack we miss?</strong>
        <span className="mt-3 block text-[15px] leading-relaxed text-muted">
          Submit it as a bounty. If it breaks the reference agents it joins the library's next
          release, and you're paid from the bounty pool.
        </span>
      </span>
      <Link to="/bounties" className={buttonClass("primary")}>
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

      <Section label="Beyond the library">
        <section
          aria-label="Beyond the attack library"
          className="grid gap-x-10 gap-y-10 md:grid-cols-2"
        >
          <div className="min-w-0">
            <p className="eyebrow">Also scored</p>
            <h2 className="h-section mt-3">False market data</h2>
            <p className="mt-3 text-[15px] leading-relaxed text-muted">
              No instruction at all: a fabricated earnings beat, a fake flash crash, a
              decimal-shifted number, a made-up hedge. The agent runs the same task twice, clean and
              with the lie, and only a trade the lie caused counts against it. A freeze is shown but
              not scored. Runs in every rating of Bonded's own and leaderboard agents; operator-run
              agents aren't covered yet.
            </p>
          </div>
          <div className="min-w-0">
            <p className="eyebrow">For agents with memory</p>
            <h2 className="h-section mt-3">Planted notes</h2>
            <p className="mt-3 text-[15px] leading-relaxed text-muted">
              A false standing instruction read on one day, then a clean day later. If the agent
              trades the planted token when a control run with nothing planted doesn't, its note was
              poisoned. These run for agents whose memory Bonded can read and reset.
            </p>
          </div>
        </section>
        <p className="mt-8 max-w-2xl text-[13px] leading-relaxed text-muted">
          Both feed the Security score alongside the classes above, as separate rows: the agent's
          weakest row sets the score.{" "}
          <a className={linkClass} href={DOCS_S1}>
            How the market-data and memory batteries work
          </a>
        </p>
      </Section>

      <Section
        id="all-attacks"
        className="scroll-mt-24"
        label="Library"
        title={
          f.class !== "all"
            ? `${CLASS_NAMES[f.class]?.name ?? f.class}: ${attacks.data?.total ?? "…"} attacks`
            : `Every published attack${attacks.data ? ` (${attacks.data.total})` : ""}`
        }
      >
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
        <ErrorText error={attacks.error} />
        {attacks.isPending && !attacks.error && (
          <div className="pt-4">
            <Loading what="the attacks" height="lg" />
          </div>
        )}
        {attacks.data && attacks.data.total === 0 && (
          <div className="pt-6">
            <EmptyState title={filtered ? "No attacks match these filters" : "No attacks yet"}>
              {filtered ? "Try other filters." : null}
            </EmptyState>
          </div>
        )}
        {attacks.data && attacks.data.total > 0 && (
          <>
            <ul
              className={`mt-6 border-b border-line transition-opacity ${attacks.isFetching && !attacks.isPending ? "opacity-60" : ""}`}
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
      </Section>

      <Section label="Kept private">
        <div className="grid gap-x-10 gap-y-10 md:grid-cols-2">
          <div className="min-w-0">
            <p className="num-giant">{counts ? counts.heldOut.active : "…"}</p>
            <h2 className="h-section mt-4">Held-out attacks</h2>
            <p className="mt-3 max-w-[60ch] text-[15px] leading-relaxed text-muted">
              Written fresh from the library's seeds and never published, so no one can tune an
              agent to pass them. Every rating includes them, and its report says how many episodes
              ran them. A new set replaces them each quarter.
            </p>
          </div>
          <div className="min-w-0">
            <p className="num-giant">{counts ? counts.acceptedBounties : "…"}</p>
            <h2 className="h-section mt-4">Accepted bounties</h2>
            <p className="mt-3 max-w-[60ch] text-[15px] leading-relaxed text-muted">
              Attacks hunters submitted that broke the reference agents. They join ratings in the
              library's next release, and their text stays private for the same reason.
            </p>
          </div>
        </div>
      </Section>

      <BountyCall />
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
            className="mx-0.5 rounded-full border border-accent/40 px-2 py-px text-[12px] text-accent"
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
          See its episodes in the Arena →
        </Link>
      }
    >
      <div className="-mt-4 flex flex-wrap items-center gap-2">
        <ClassChip id={a.id} />
        <Badge tone={SEVERITY_TONE[a.severityHint]}>{a.severityHint} severity</Badge>
        {a.surfaces.map((x) => (
          <Badge key={x}>Planted in {SURFACE_NAMES[x]?.toLowerCase() ?? x}</Badge>
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
            value: s.lastAt ? day(s.lastAt) : "–",
            ...(statsSince ? { hint: `records since ${day(statsSince)}` } : {}),
          },
        ]}
      />

      <Section label="The payload" title="What the agent reads">
        <div className="max-w-3xl">
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[12px] text-muted">
            <span>{a.surfaces.map((x) => SURFACE_NAMES[x] ?? x).join(" · ")}</span>
            {a.delivery.sender && (
              <span>
                From <Payload text={a.delivery.sender} inline />
              </span>
            )}
            {a.delivery.token && (
              <span>
                On token <span className="text-soft">{a.delivery.token}</span>
              </span>
            )}
          </p>
          <blockquote className="mt-4 border-l-2 border-breach-solid py-1 pl-5">
            <Payload text={a.payloadTemplate} />
            {a.delivery.prices && (
              <p className="mt-3 font-mono text-[12px] text-muted">
                Spoofed prices:{" "}
                {Object.entries(a.delivery.prices)
                  .map(([t, p]) => `${t} ${p}`)
                  .join(", ")}
              </p>
            )}
          </blockquote>
          {placeholders.length > 0 && (
            <dl className="mt-6 grid gap-x-6 gap-y-2 text-[14px] sm:grid-cols-[auto_1fr]">
              {placeholders.map((p) => (
                <Fragment key={p}>
                  <dt className="font-mono text-[13px] text-accent">{p}</dt>
                  <dd className="text-muted">
                    {PLACEHOLDER_MEANINGS[p] ?? "filled in by the Arena"}
                  </dd>
                </Fragment>
              ))}
            </dl>
          )}
          {a.goal && (
            <div className="mt-8 border-t border-line pt-5">
              <p className="eyebrow">The task the agent is given</p>
              <p className="mt-2.5 text-[15px] leading-relaxed text-soft">{a.goal}</p>
            </div>
          )}
        </div>
      </Section>

      <Section label="How it's judged">
        <div className="grid gap-x-10 gap-y-10 lg:grid-cols-3">
          <div className="min-w-0">
            <h2 className="h-section">
              About {a.class}: {CLASS_NAMES[a.class]?.name}
            </h2>
            <p className="mt-3 text-[15px] leading-relaxed text-muted">
              {CLASS_NAMES[a.class]?.description}
            </p>
            <div className="mt-5">
              <MoreLink to={`/attacks?class=${a.class}`}>Every {a.class} attack</MoreLink>
            </div>
          </div>
          <div className="min-w-0">
            <h2 className="h-section">What counts as a breach</h2>
            <p className="mt-3 text-[15px] text-muted">
              It got through if the vault records any of these. The vault decides, not a model.
            </p>
            <ul className="mt-5 border-b border-line">
              {a.successPredicate.anyOf.map((b) => (
                <li key={b} className="border-t border-line py-3.5 text-[14px]">
                  <span className="block font-mono text-[11.5px] text-breach">{b}</span>
                  <span className="mt-1 block text-soft">{BREACH_MEANINGS[b]}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="min-w-0">
            <h2 className="h-section">How the Arena varies it</h2>
            <p className="mt-3 text-[15px] leading-relaxed text-soft">{a.variantPrompt}</p>
            <p className="mt-3 text-[13px] text-muted">
              Each rating runs every attack several times, so an agent can't pass by luck.
            </p>
          </div>
        </div>
        {a.tags.length > 0 && (
          <div className="mt-10 flex flex-wrap gap-x-4 gap-y-1.5 font-mono text-[12px] text-muted">
            {a.tags.map((t) => (
              <span key={t}>#{t}</span>
            ))}
          </div>
        )}
      </Section>
      <BountyCall />
    </Page>
  );
}
