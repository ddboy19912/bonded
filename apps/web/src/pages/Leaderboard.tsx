import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api, type LeaderboardRecord } from "../lib/api";
import { DOCS_DISCLOSURES } from "../lib/routes";
import {
  Badge,
  Card,
  EmptyState,
  ErrorText,
  Loading,
  Page,
  ScoreRing,
  TierBadge,
  Tooltip,
  TxLink,
  linkClass,
} from "../components/ui";

const CLASSES = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10"];

/** One attack class as a small square, coloured by the share of its episodes that breached. */
function Square({ cls, c }: { cls: string; c?: LeaderboardRecord["classes"][number] }) {
  if (!c || c.episodes === 0)
    return (
      <Tooltip content={`${cls}: not run`}>
        <span className="block size-5 rounded-[5px] border border-dashed border-line-strong" />
      </Tooltip>
    );
  const rate = c.breaches / c.episodes;
  const tone =
    rate === 0
      ? "bg-brand-bright/45 ring-1 ring-inset ring-brand-bright/70"
      : rate < 0.5
        ? "bg-breach/45 ring-1 ring-inset ring-breach/60"
        : "bg-breach-solid";
  return (
    <Tooltip content={`${cls} ${c.name}: ${c.breaches} of ${c.episodes} episodes breached`}>
      <span className={`block size-5 rounded-[5px] ${tone}`} />
    </Tooltip>
  );
}

/** Totals across every attack class, for the one-line summary under the strip. */
function totals(e: LeaderboardRecord) {
  return e.classes.reduce(
    (t, c) => ({ breaches: t.breaches + c.breaches, episodes: t.episodes + c.episodes }),
    { breaches: 0, episodes: 0 },
  );
}

const DISCLOSURE: Record<LeaderboardRecord["disclosure"]["status"], string> = {
  "not-needed": "Bonded's own",
  pending: "maintainer notice pending",
  notified: "maintainers notified",
  published: "no findings withheld",
};

export function Leaderboard() {
  const board = useQuery({ queryKey: ["leaderboard"], queryFn: api.leaderboard });
  const h = board.data?.headline;
  // Legacy insurance results cannot be compared with security grades.
  const entries = board.data
    ? [...board.data.entries].sort((a, b) => (b.securityGrade ?? -1) - (a.securityGrade ?? -1))
    : [];
  const graded = entries.filter(
    (e): e is LeaderboardRecord & { securityGrade: number } => e.securityGrade !== undefined,
  );
  return (
    <Page
      eyebrow="Arena results"
      title="Leaderboard"
      intro="Popular open-source agents and Bonded's own, ranked by their security score. Legacy results without a security score are unranked; their insurance score only measures loss after containment."
    >
      {h && h.evaluations > 0 && (
        <section className="panel border-accent/25 bg-[radial-gradient(ellipse_at_0%_0%,rgb(29_78_216/.25),transparent_60%)] p-7 sm:p-9">
          <p className="eyebrow !text-accent">Headline</p>
          <p className="mt-3 max-w-4xl font-serif text-4xl leading-tight sm:text-5xl">
            {h.failingTemplates === 0
              ? `None of the ${h.templates} popular agent templates fell for basic prompt injection.`
              : `${h.failingTemplates} of ${h.templates} popular agent templates fall for basic prompt injection.`}
          </p>
          <p className="mt-4 max-w-3xl text-sm leading-relaxed text-muted">
            Across {h.evaluations} template and model pairs ({h.failingEvaluations} breached), on
            the injection classes A1, A2 and A7, with five runs of every attack, including held-out
            attacks that are never published. Results can differ with other models or settings. The
            security score measures manipulation, including attempts blocked by the mandate.
          </p>
        </section>
      )}

      {graded.length >= 3 && (
        <section className="grid gap-4 md:grid-cols-3">
          {graded.slice(0, 3).map((e, i) => (
            <div key={e.slug} className="panel flex items-center gap-5 p-5">
              <ScoreRing score={e.securityGrade} size={84} />
              <div className="min-w-0">
                <p className="font-mono text-[11px] text-muted">#{i + 1}</p>
                <p className="truncate font-semibold">{e.name}</p>
                <p className="truncate text-xs text-muted">
                  {e.framework}
                  {e.model ? ` · ${e.model}` : ""}
                </p>
                <div className="mt-1.5 flex items-center gap-2 text-xs text-muted">
                  Insurance <TierBadge score={e.score} />
                </div>
              </div>
            </div>
          ))}
        </section>
      )}

      <Card
        title="Rankings"
        description="One square per attack class, A1 to A10. Hover a square for its breaches and episodes."
        actions={
          <div className="flex flex-wrap items-center gap-3.5 text-xs text-muted">
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded bg-brand-bright/45 ring-1 ring-brand-bright/70" />{" "}
              held
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded bg-breach/45 ring-1 ring-breach/60" /> some breached
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded bg-breach-solid" /> half or more
            </span>
          </div>
        }
      >
        {board.isPending && !board.error && <Loading what="the leaderboard" height="lg" />}
        <ErrorText error={board.error} />
        {board.data?.entries.length === 0 && <EmptyState title="No ratings published yet" />}
        {entries.length > 0 && (
          <div className="-mx-5 overflow-x-auto sm:-mx-6">
            <div className="min-w-[860px]">
              <div className="grid grid-cols-[40px_minmax(0,1fr)_120px_268px_150px] items-end gap-6 px-5 pb-3 text-[10.5px] font-medium tracking-[0.14em] text-muted uppercase sm:px-6">
                <span>#</span>
                <span>Agent</span>
                <span>Security</span>
                <span className="flex gap-1.5 tracking-normal normal-case">
                  {CLASSES.map((c) => (
                    <span key={c} className="w-5 text-center font-mono text-[9px] tracking-tighter">
                      {c}
                    </span>
                  ))}
                </span>
                <span>On chain</span>
              </div>
              <ol aria-label="Security rankings">
                {entries.map((e, i) => {
                  const t = totals(e);
                  return (
                    <li
                      key={e.slug}
                      className="grid grid-cols-[40px_minmax(0,1fr)_120px_268px_150px] items-center gap-6 border-t border-line px-5 py-5 transition hover:bg-white/[0.025] sm:px-6"
                    >
                      <span className="font-mono text-xs text-muted">
                        {e.securityGrade === undefined ? "—" : String(i + 1).padStart(2, "0")}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">
                          {e.template ? (
                            <a
                              href={e.template}
                              className="hover:text-accent"
                              target="_blank"
                              rel="noreferrer"
                            >
                              {e.name}
                            </a>
                          ) : (
                            e.name
                          )}
                        </span>
                        <span className="mt-1 block truncate text-xs text-muted">
                          {e.framework}
                          {e.model ? ` · ${e.model}` : " · scripted"}
                        </span>
                        <span className="mt-1 block text-[11px] text-muted/80">
                          {DISCLOSURE[e.disclosure.status]}
                        </span>
                      </span>
                      <span className="flex flex-col items-start gap-2">
                        {e.securityGrade === undefined ? (
                          <span className="text-xs text-muted">Security not measured</span>
                        ) : (
                          <span className="font-serif text-3xl leading-none">
                            {e.securityGrade}
                          </span>
                        )}
                        <span className="text-xs text-muted">Insurance score {e.score}</span>
                        <TierBadge score={e.score} />
                      </span>
                      <span>
                        <span className="flex gap-1.5">
                          {CLASSES.map((c) => (
                            <Square key={c} cls={c} c={e.classes.find((x) => x.class === c)} />
                          ))}
                        </span>
                        <span className="mt-2 block text-[11px] text-muted">
                          {t.breaches === 0 ? (
                            <>No breaches in {t.episodes} episodes</>
                          ) : (
                            <span className="text-breach">
                              {t.breaches} {t.breaches === 1 ? "breach" : "breaches"} in{" "}
                              {t.episodes} episodes
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="flex flex-col items-start gap-1.5 text-xs">
                        {e.onchain ? (
                          <>
                            <Link to={`/agents/${e.onchain.agentId}`} className={linkClass}>
                              Agent {e.onchain.agentId} →
                            </Link>
                            {e.verified === true ? (
                              <Badge tone="safe" dot>
                                Verified
                              </Badge>
                            ) : e.verified === false ? (
                              <Badge>Re-rated since</Badge>
                            ) : !e.onchain.tx ? (
                              <Badge>Score pending</Badge>
                            ) : null}
                            {e.onchain.tx && (
                              <span className="text-muted">
                                tx <TxLink hash={e.onchain.tx} />
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-muted">Not posted</span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          </div>
        )}
      </Card>

      <details className="panel p-5 sm:p-6">
        <summary className="cursor-pointer font-semibold">How we test</summary>
        <ul className="mt-3 flex max-w-3xl list-disc flex-col gap-2 pl-5 text-sm text-muted">
          <li>
            Each open-source template runs unchanged, with its published prompt. Only its tools
            point at the Arena's sandbox instead of a live chain.
          </li>
          <li>
            Every agent faces the same attack library, five runs of each attack, including held-out
            attacks that are never published, so no one can tune for them.
          </li>
          <li>
            Results are shown per attack class. Which attack broke a third-party agent stays private
            until its maintainers have been told (
            <a className={linkClass} href={DOCS_DISCLOSURES}>
              disclosure policy
            </a>
            ).
          </li>
        </ul>
      </details>
    </Page>
  );
}
