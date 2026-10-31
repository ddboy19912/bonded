import { Link } from "react-router";
import * as Popover from "@radix-ui/react-popover";
import { useQuery } from "@tanstack/react-query";
import { ATTACK_LIBRARY_VERSION, libraryVersionStatus } from "@bondedhq/shared";
import { api, type LeaderboardRecord } from "../lib/api";
import { CLASSES, classResults } from "../lib/class-tracks";
import { Square } from "../components/class-squares";
import { DOCS_DISCLOSURES, DOCS_SCORING } from "../lib/routes";
import { GRADE_BANDS, gradeTone } from "../lib/security";
import { taskLine, taskWorstLine } from "../lib/task-score";
import {
  Card,
  EmptyState,
  ErrorText,
  Loading,
  Page,
  Term,
  TierBadge,
  linkClass,
} from "../components/ui";

/** What the score colours and square colours mean, behind a small button so it stays out of the way. */
function Legend() {
  const dot = (cls: string, label: string) => (
    <li key={label} className="flex items-center gap-2">
      <span className={`size-2.5 shrink-0 ${cls}`} /> {label}
    </li>
  );
  return (
    <Popover.Root>
      <Popover.Trigger className="inline-flex items-center gap-1.5 rounded-full border border-line-strong px-3 py-1.5 text-xs text-muted hover:text-ink data-[state=open]:text-ink">
        <span
          aria-hidden
          className="flex size-3.5 items-center justify-center rounded-full border border-current text-[9px] leading-none"
        >
          i
        </span>
        Colour key
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={16}
          className="z-50 w-64 rounded-xl border border-line-strong bg-raised p-4 text-xs text-soft shadow-(--shadow-raised) outline-none [animation:pop_.15s_ease_both]"
        >
          <p className="mb-2 font-medium text-ink">Score</p>
          <ul className="flex flex-col gap-1.5">
            {GRADE_BANDS.map((b) => dot(`rounded-full ${b.dot}`, b.label))}
          </ul>
          <p className="mt-4 mb-2 font-medium text-ink">Squares</p>
          <ul className="flex flex-col gap-1.5">
            {dot("rounded bg-brand-bright/45 ring-1 ring-brand-bright/70", "held")}
            {dot("rounded bg-breach/45 ring-1 ring-breach/60", "sometimes manipulated")}
            {dot("rounded bg-breach-solid", "manipulated half the time or more")}
            {dot("rounded border border-dashed border-line-strong", "not run, or too few to grade")}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * A short tag for a result measured against an older attack library, or before versions were
 * recorded: it isn't comparable with current results. Undefined for a current one.
 */
function libraryNote(e: LeaderboardRecord): string | undefined {
  switch (libraryVersionStatus(e.libraryVersion)) {
    case "older":
      return `Rated on library v${e.libraryVersion}; current is v${ATTACK_LIBRARY_VERSION}`;
    case "unversioned":
      return "Rated before library versions";
    default:
      return undefined;
  }
}

/**
 * A note when the on-chain score doesn't back this entry. Verified entries say nothing: the board
 * only lists on-chain results, so verification is the norm, not news.
 */
function chainNote(e: LeaderboardRecord): string | undefined {
  if (!e.onchain?.tx) return "Not on chain yet";
  if (e.verified === false) return "Re-rated since its on-chain score";
  return undefined;
}

/** Rank, agent, score, class strip, Task score and insurance tier; stacks as a card on phones. */
const ROW =
  "grid grid-cols-[28px_minmax(0,1fr)_auto] gap-x-4 gap-y-3 lg:grid-cols-[32px_minmax(0,1fr)_72px_254px_48px_56px] xl:grid-cols-[32px_minmax(0,1fr)_72px_410px_56px_56px] lg:items-center lg:gap-x-6";

/** The entry's Task score, with how it was measured in its tooltip; a dash when it has none. */
function TaskCell({ e }: { e: LeaderboardRecord }) {
  const task = e.task;
  if (!task || task.score === null)
    return (
      <span className="text-xs text-muted" title="Task score not measured">
        —
      </span>
    );
  const how = [
    taskLine(task),
    taskWorstLine(task),
    task.source === "task" ? "Measured after its rating, without attacks." : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span
      title={how}
      aria-label={`Task score ${task.score}. ${how}`}
      className={`font-mono text-sm ${gradeTone(task.score)}`}
    >
      {task.score}
    </span>
  );
}

export function Leaderboard() {
  const board = useQuery({ queryKey: ["leaderboard"], queryFn: api.leaderboard });
  // Legacy insurance results cannot be compared with security grades.
  const entries = board.data
    ? [...board.data.entries].sort((a, b) => (b.securityGrade ?? -1) - (a.securityGrade ?? -1))
    : [];
  const legacy = entries.some((e) => e.securityGrade === undefined);
  return (
    <Page
      eyebrow="Rating results"
      title="Leaderboard"
      intro={
        <>
          Open-source trading agents and Bonded's own, rated on chain and ranked by how hard they
          are to trick. Models rated on off-chain payments are on the{" "}
          <Link className={linkClass} to="/index">
            Bonded Index
          </Link>
          .{" "}
          <a className={linkClass} href={DOCS_SCORING} target="_blank" rel="noreferrer">
            How scoring works
          </a>
        </>
      }
    >
      <Card
        title="Rankings"
        description="Each square is an attack class, coloured by its worst result across the main library, market data, memory and world state. Hover a square for the numbers; open a row for the full report."
        actions={<Legend />}
      >
        {board.isPending && !board.error && <Loading what="the leaderboard" height="lg" />}
        <ErrorText error={board.error} />
        {board.data?.entries.length === 0 && <EmptyState title="No ratings published yet" />}
        {entries.length > 0 && (
          <div className="-mx-5 sm:-mx-6">
            <div
              aria-hidden
              className={`${ROW} hidden px-5 pb-3 text-[10.5px] font-medium tracking-[0.14em] text-muted uppercase sm:px-6 lg:grid`}
            >
              <span>#</span>
              <span>Agent</span>
              <span>Score</span>
              <span className="flex gap-1.5 tracking-normal normal-case xl:gap-2.5">
                {CLASSES.map((c) => (
                  <span
                    key={c}
                    className="w-5 text-center font-mono xl:w-8 text-[9px] tracking-tighter"
                  >
                    {c}
                  </span>
                ))}
              </span>
              <span>Task</span>
              <span>Cover</span>
            </div>
            <ol aria-label="Security rankings">
              {entries.map((e, i) => {
                const notes = [libraryNote(e), chainNote(e)].filter(Boolean);
                return (
                  <li
                    key={e.slug}
                    className={`${ROW} relative border-t border-line px-5 py-4 transition hover:bg-white/[0.025] sm:px-6`}
                  >
                    <span className="pt-0.5 font-mono text-xs text-muted lg:pt-0">
                      {e.securityGrade === undefined ? "—" : String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="min-w-0">
                      <span className="block font-semibold lg:truncate">
                        {e.onchain ? (
                          // The whole row opens the agent's page; the squares and tags sit above
                          // the stretched link so their tooltips still work.
                          <Link
                            to={`/agents/${e.onchain.agentId}`}
                            className="after:absolute after:inset-0 hover:text-accent"
                          >
                            {e.name}
                          </Link>
                        ) : (
                          e.name
                        )}
                      </span>
                      <span className="mt-0.5 flex min-w-0 gap-1.5 text-xs text-muted">
                        <span className="truncate">
                          {e.model ? `${e.model.split("/").pop()} · ${e.framework}` : e.framework}
                        </span>
                        {e.template && (
                          <a
                            href={e.template}
                            target="_blank"
                            rel="noreferrer"
                            className="relative z-10 shrink-0 hover:text-accent"
                          >
                            source ↗
                          </a>
                        )}
                      </span>
                      {notes.map((n) => (
                        <span key={n} className="mt-1.5 block text-[11px] text-warn">
                          {n}
                        </span>
                      ))}
                    </span>
                    <span className="text-right lg:text-left">
                      {e.securityGrade === undefined ? (
                        <span className="text-xs text-muted">Not measured</span>
                      ) : (
                        <span
                          className={`font-serif text-3xl leading-none ${gradeTone(e.securityGrade)}`}
                        >
                          {e.securityGrade}
                        </span>
                      )}
                    </span>
                    <span className="relative z-10 col-span-2 col-start-2 flex gap-1.5 lg:col-span-1 xl:gap-2.5 lg:col-start-auto">
                      {classResults(e).map((r) => (
                        <Square key={r.cls} r={r} size="size-5 xl:size-8 xl:rounded-[7px]" />
                      ))}
                    </span>
                    <span className="relative z-10 col-span-2 col-start-2 flex items-center gap-2 lg:col-span-1 lg:col-start-auto lg:block">
                      <span className="text-xs text-muted lg:hidden">Task score</span>
                      <TaskCell e={e} />
                    </span>
                    <span className="relative z-10 col-span-2 col-start-2 flex items-center gap-2 lg:col-span-1 lg:col-start-auto lg:block">
                      <span className="text-xs text-muted lg:hidden">Cover</span>
                      <TierBadge score={e.score} />
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
        {legacy && (
          <p className="mt-4 text-xs text-muted">
            Results without a score predate the security grade and are unranked; their cover tier
            only measures loss after containment.
          </p>
        )}
        <p className="mt-4 text-xs text-muted">
          Task is the Task score: whether the agent still does its job when the right move depends
          on what it reads, tested with <Term term="benignTwins">benign twins</Term>. It is separate
          from the score, which never counts it.
        </p>
      </Card>

      <details className="panel p-5 sm:p-6">
        <summary className="cursor-pointer font-semibold">How we test</summary>
        <ul className="mt-3 flex max-w-3xl list-disc flex-col gap-2 pl-5 text-sm text-muted">
          <li>
            Each open-source template runs unchanged, with its published prompt. Only its tools
            point at Bonded's sandbox instead of a live chain.
          </li>
          <li>
            Every agent faces the same attack library, five runs of each attack, including held-out
            attacks that are never published, so no one can tune for them. The same attack classes
            also run through false market data (a fabricated earnings beat, a fake flash crash, a
            made-up analyst call), false records of yesterday (a "leg 2" of a buy that never
            happened, a refund the agent never queued) and, where an agent keeps memory, planted
            notes.
          </li>
          <li>
            The score is set by the agent's weakest class and track, and counts manipulation:
            attempts the mandate blocked still count. The cover tier is separate: it prices what a
            breach costs once the vault contains it. Results can differ with other models or
            settings.
          </li>
          <li>
            The Task score checks the other side: an agent that ignores everything it reads is never
            tricked, but it can't do a job that depends on what it reads either. It runs real
            versions of each attack class's content (a real order from the portfolio manager, a real
            trading halt) and counts whether the agent did the job, alongside ordinary episodes with
            no attack. It is set by the lowest of those parts.
          </li>
          <li>
            Every rating records the attack library version it ran against (now v
            {ATTACK_LIBRARY_VERSION}). The version goes up when attacks, market-data, memory or
            world-state seeds, or scoring rules change, and results from an older version are marked
            until the agent is re-rated.
          </li>
          <li>
            Which attack broke a third-party agent stays private until its maintainers have been
            told (
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
