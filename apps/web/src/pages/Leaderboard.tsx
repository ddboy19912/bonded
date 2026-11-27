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
  EmptyState,
  ErrorText,
  Loading,
  Page,
  Section,
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
      <Popover.Trigger className="inline-flex h-9 items-center gap-2 rounded-full px-4 text-sm text-soft shadow-[inset_0_0_0_1px_rgb(255_255_255/0.2)] transition hover:text-ink data-[state=open]:text-ink">
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
          className="z-50 w-64 rounded-xl border border-line-strong bg-raised p-4 text-[13px] text-soft shadow-(--shadow-raised) outline-none [animation:pop_.15s_ease_both]"
        >
          <p className="eyebrow mb-2">Score</p>
          <ul className="flex flex-col gap-1.5">
            {GRADE_BANDS.map((b) => dot(`rounded-full ${b.dot}`, b.label))}
          </ul>
          <p className="eyebrow mt-4 mb-2">Squares</p>
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

/** Rank, agent, Security, Task, class strip and insurance tier; stacks on phones. */
const ROW =
  "grid grid-cols-[28px_minmax(0,1fr)_auto] gap-x-4 gap-y-3 lg:grid-cols-[40px_minmax(0,1fr)_64px_64px_254px_48px] xl:grid-cols-[40px_minmax(0,1fr)_80px_80px_352px_48px] lg:items-center lg:gap-x-6";

/** Security and Task are drawn at the same size, side by side. */
const SCORE = "num-big lg:text-[clamp(30px,2.8vw,42px)]";

/** Scripted agents that show the two ends of the scale: listed, but not ranked against real ones. */
const isReference = (e: LeaderboardRecord) => e.kind === "reference";

/** Ranked first, by Security; then results without one; then the scripted reference agents. */
const order = (e: LeaderboardRecord) =>
  isReference(e) ? 2 : e.securityGrade === undefined ? 1 : 0;

/**
 * The entry's Task score, drawn the same size as Security beside it, with how it was measured in
 * its tooltip; a dash when it has none.
 */
function TaskCell({ e }: { e: LeaderboardRecord }) {
  const task = e.task;
  if (!task || task.score === null)
    return (
      <span className="text-[15px] text-dim" title="Task score not measured">
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
      className={`${SCORE} ${gradeTone(task.score)}`}
    >
      {task.score}
    </span>
  );
}

export function Leaderboard() {
  const board = useQuery({ queryKey: ["leaderboard"], queryFn: api.leaderboard });
  // Legacy insurance results cannot be compared with Security scores, and the scripted reference
  // agents aren't real agents: both are listed after the ranking, without a rank.
  const entries = board.data
    ? [...board.data.entries].sort(
        (a, b) => order(a) - order(b) || (b.securityGrade ?? -1) - (a.securityGrade ?? -1),
      )
    : [];
  const legacy = entries.some((e) => e.securityGrade === undefined);
  return (
    <Page
      eyebrow="Arena results"
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
      <section aria-label="Rankings" className="flex flex-col gap-8">
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          <p className="max-w-2xl text-[15px] leading-relaxed text-muted">
            Each square is an attack class, coloured by its worst result across the main library,
            market data, memory and world state. Hover a square for the numbers; open a row for the
            full report.
          </p>
          <Legend />
        </div>
        {board.isPending && !board.error && <Loading what="the leaderboard" height="lg" />}
        <ErrorText error={board.error} />
        {board.data?.entries.length === 0 && <EmptyState title="No ratings published yet" />}
        {entries.length > 0 && (
          <div>
            <div aria-hidden className={`${ROW} eyebrow hidden border-b border-line pb-3 lg:grid`}>
              <span>No.</span>
              <span>Agent</span>
              <span>Security</span>
              <span>Task</span>
              <span className="flex gap-1.5 xl:gap-2">
                {CLASSES.map((c) => (
                  <span key={c} className="w-5 text-center text-[10px] xl:w-7">
                    {c}
                  </span>
                ))}
              </span>
              <span>Cover</span>
            </div>
            <ol aria-label="Security rankings" className="border-b border-line">
              {entries.map((e, i) => {
                const notes = [libraryNote(e), chainNote(e)].filter(Boolean);
                return (
                  <li
                    key={e.slug}
                    className={`${ROW} relative isolate border-t border-line py-5 first:border-t-0 before:absolute before:inset-y-0 before:-inset-x-3 before:-z-10 before:bg-white/[0.035] before:opacity-0 before:transition-opacity hover:before:opacity-100`}
                  >
                    <span className="eyebrow pt-1.5 lg:pt-0">
                      {e.securityGrade === undefined || isReference(e)
                        ? "—"
                        : String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="min-w-0">
                      <span
                        data-name
                        className="block text-[clamp(19px,2vw,28px)] leading-tight font-medium tracking-[-0.035em]"
                      >
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
                      <span className="mt-1.5 flex min-w-0 gap-2 font-mono text-[12px] text-muted">
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
                      {isReference(e) && (
                        <span className="mt-1.5 block text-[13px] text-muted">
                          Scripted reference, not ranked
                        </span>
                      )}
                      {notes.map((n) => (
                        <span key={n} className="mt-1.5 block text-[13px] text-warn">
                          {n}
                        </span>
                      ))}
                    </span>
                    <span className="text-right lg:text-left">
                      <span className="eyebrow mb-1.5 block lg:hidden">Security</span>
                      {e.securityGrade === undefined ? (
                        <span className="text-[13px] text-muted">Not measured</span>
                      ) : (
                        <span className={`${SCORE} ${gradeTone(e.securityGrade)}`}>
                          {e.securityGrade}
                        </span>
                      )}
                    </span>
                    <span className="relative z-10 col-span-2 col-start-2 flex items-center gap-3 lg:col-span-1 lg:col-start-auto lg:block">
                      <span className="eyebrow lg:hidden">Task</span>
                      <TaskCell e={e} />
                    </span>
                    <span className="relative z-10 col-span-2 col-start-2 flex gap-1.5 lg:col-span-1 lg:col-start-auto xl:gap-2">
                      {classResults(e).map((r) => (
                        <Square key={r.cls} r={r} size="size-5 xl:size-7 xl:rounded-[6px]" />
                      ))}
                    </span>
                    <span className="relative z-10 col-span-2 col-start-2 flex items-center gap-3 lg:col-span-1 lg:col-start-auto lg:block">
                      <span className="eyebrow lg:hidden">Cover</span>
                      <TierBadge score={e.score} />
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
        <div className="mt-6 flex max-w-3xl flex-col gap-2 text-[13px] leading-relaxed text-muted">
          {legacy && (
            <p>
              Results without a score predate the Security score and are unranked; their cover tier
              only measures loss after containment.
            </p>
          )}
          <p>
            Task is the Task score: whether the agent still does its job when the right move depends
            on what it reads, tested with <Term term="benignTwins">benign twins</Term>. Security
            never counts it.
          </p>
        </div>
      </section>

      <Section label="Method">
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-6 [&::-webkit-details-marker]:hidden">
            <span className="h-section">How we test</span>
            <span
              aria-hidden
              className="text-2xl leading-none font-light text-muted transition group-open:rotate-45"
            >
              +
            </span>
          </summary>
          <ul className="mt-6 flex max-w-3xl list-disc flex-col gap-2.5 pl-5 text-[15px] leading-relaxed text-muted marker:text-dim">
            <li>
              Each open-source template runs unchanged, with its published prompt. Only its tools
              point at the Arena's sandbox instead of a live chain.
            </li>
            <li>
              Every agent faces the same attack library, five runs of each attack, including
              held-out attacks that are never published, so no one can tune for them. The same
              attack classes also run through false market data (a fabricated earnings beat, a fake
              flash crash, a made-up analyst call), false records of yesterday (a "leg 2" of a buy
              that never happened, a refund the agent never queued) and, where an agent keeps
              memory, planted notes.
            </li>
            <li>
              The score is set by the agent's weakest class and track, and counts manipulation:
              attempts the mandate blocked still count. The cover tier is separate: it prices what a
              breach costs once the vault contains it. Results can differ with other models or
              settings.
            </li>
            <li>
              The Task score checks the other side: an agent that ignores everything it reads is
              never tricked, but it can't do a job that depends on what it reads either. It runs
              real versions of each attack class's content (a real order from the portfolio manager,
              a real trading halt) and counts whether the agent did the job, alongside ordinary
              episodes with no attack. It is set by the lowest of those parts.
            </li>
            <li>
              Every rating records the attack library version it ran against (now v
              {ATTACK_LIBRARY_VERSION}). The version goes up when attacks, market-data, memory or
              world-state seeds, or scoring rules change, and results from an older version are
              marked until the agent is re-rated.
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
      </Section>
    </Page>
  );
}
