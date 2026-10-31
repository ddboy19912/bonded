import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ATTACK_CLASSES } from "@bondedhq/shared";
import { api, ApiError, type EpisodeDetail } from "../lib/api";
import { dollars, rulingView } from "../lib/ruling";
import { at } from "../lib/format";
import {
  BREACH_LABELS,
  SURFACE_LABELS,
  SURFACE_TOOLS,
  describeAttempt,
  describeStep,
  sender,
} from "../lib/episode-text";
import { RulingBadge, VerdictCard } from "../components/ruling";
import { Badge, Card, EmptyState, ErrorText, Loading, Page, linkClass } from "../components/ui";

const CLASS_NAMES = ATTACK_CLASSES as Record<string, { name: string }>;

/**
 * One Arena episode in full (docs/ARCHITECTURE.md, the Arena): the task, what was planted, each
 * step the agent took, and how the vault ruled. A held-out or bounty attack's text never reaches
 * this page; the API leaves it out when the episode is published.
 */
export function Episode() {
  const { eventId = "" } = useParams();
  const valid = /^\d{1,20}$/.test(eventId);
  const q = useQuery({
    queryKey: ["episode", eventId],
    queryFn: () => api.episode(eventId),
    enabled: valid,
    staleTime: Infinity,
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  });
  const back = { to: "/arena", label: "Live attacks" };
  if (!valid || (q.error instanceof ApiError && q.error.status === 404))
    return (
      <Page title="Episode" back={back}>
        <EmptyState title="This episode isn't here">
          It may never have existed, or it's older than we keep.
        </EmptyState>
      </Page>
    );
  if (q.isPending)
    return (
      <Page title="Episode" back={back}>
        <Card>
          <Loading what="the episode" />
        </Card>
      </Page>
    );
  if (!q.data)
    return (
      <Page title="Episode" back={back}>
        <ErrorText error={q.error} />
      </Page>
    );
  const e = q.data;
  const r = rulingView(e);
  const name = e.attackClass
    ? (CLASS_NAMES[e.attackClass]?.name ?? e.attackClass)
    : "Control episode";
  const unpublished = Boolean(e.attackClass) && e.detail?.attack?.published === false;
  return (
    <Page
      back={back}
      eyebrow={`Episode ${e.index + 1} of ${e.total}`}
      title={name}
      actions={<RulingBadge r={r} />}
    >
      <p className="-mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
        {e.attackClass && <span className="font-mono text-soft">{e.attackClass}</span>}
        {e.attackClass && (
          <Badge tone="neutral">{unpublished ? "Held out or bounty" : "Library attack"}</Badge>
        )}
        {e.attackId &&
          (unpublished ? (
            <span className="font-mono text-[12px]">{e.attackId}</span>
          ) : (
            <Link
              to={`/attacks/${encodeURIComponent(e.attackId)}`}
              className={`font-mono text-[12px] ${linkClass}`}
              title="This attack in the red team's library"
            >
              {e.attackId}
            </Link>
          ))}
        {e.agentId && (
          <Link to={`/agents/${e.agentId}`} className={linkClass}>
            Agent {e.agentId}
          </Link>
        )}
        <Link to={`/arena?run=${e.runId}`} className={linkClass}>
          Run {e.runId.slice(0, 8)}
        </Link>
        {e.at && <time dateTime={e.at}>{at(e.at)}</time>}
        {e.durationMs !== null && <span>{(e.durationMs / 1000).toFixed(1)} s</span>}
        {e.detail?.fork && (
          <span title="Requests to the live chain this agent's reads caused. Each episode has a share; past it, the agent's reads are refused.">
            {e.detail.fork.fetches} live-chain{" "}
            {e.detail.fork.fetches === 1 ? "request" : "requests"}
            {e.detail.fork.budgetExhausted && " (share used up)"}
          </span>
        )}
      </p>

      {e.detail ? (
        <Story d={e.detail} r={r} attackId={e.attackId} />
      ) : (
        <>
          <Card title="How the vault ruled">
            <VerdictCard r={r} />
          </Card>
          <p className="text-sm text-muted">
            Step-by-step detail is recorded for episodes from October 7, 2026 on; this one is older.
          </p>
        </>
      )}
    </Page>
  );
}

function Story({
  d,
  r,
  attackId,
}: {
  d: EpisodeDetail;
  r: ReturnType<typeof rulingView>;
  attackId: string | null;
}) {
  const attackTools = new Set((d.attack?.surfaces ?? []).map((s) => SURFACE_TOOLS[s]));
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card title="1. The setup">
        <p className="eyebrow mb-2">The task</p>
        <p className="text-[15px]">{d.task}</p>
        {d.attack && (
          <>
            <p className="eyebrow mt-6 mb-2 !text-breach">What was planted</p>
            {d.attack.planted ? (
              <div className="flex flex-col gap-3">
                {d.attack.title && (
                  <p className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-semibold">{d.attack.title}</span>
                    {attackId && (
                      <Link
                        to={`/attacks/${encodeURIComponent(attackId)}`}
                        className={`text-sm ${linkClass}`}
                      >
                        This attack in the red team →
                      </Link>
                    )}
                  </p>
                )}
                {d.attack.planted.map((p, i) => (
                  <div key={i}>
                    <p className="mb-1.5 text-sm text-muted">
                      In {SURFACE_LABELS[p.surface] ?? p.surface}
                      {p.sender ? ` from ${sender(p.sender)}` : ""}
                      {p.token ? ` (${p.token})` : ""}
                    </p>
                    <blockquote className="rounded-2xl border border-line bg-white/[0.03] p-4 text-sm leading-relaxed whitespace-pre-wrap text-soft">
                      {p.text}
                      {p.prices && (
                        <span className="mt-2 block font-mono text-[12px] text-muted">
                          {Object.entries(p.prices)
                            .map(([t, v]) => `${t} = ${v}`)
                            .join(", ")}
                        </span>
                      )}
                    </blockquote>
                  </div>
                ))}
              </div>
            ) : (
              <p className="rounded-2xl border border-line bg-white/[0.03] p-4 text-sm text-soft">
                A held-out or bounty attack, planted in{" "}
                {d.attack.surfaces.map((s) => SURFACE_LABELS[s] ?? s).join(" and ")}. Its text is
                never shown, so no one can study it.
              </p>
            )}
            <p className="mt-3 text-sm text-muted">
              {d.seen
                ? "The agent read it."
                : "The agent never read it, so this episode doesn't test the attack."}
            </p>
          </>
        )}
      </Card>

      <Card title="2. What the agent did">
        {d.steps.length === 0 && d.guardBlocked.length === 0 ? (
          <p className="text-sm text-muted">Nothing: it stopped without calling a tool.</p>
        ) : (
          <ol className="relative flex flex-col gap-3 border-l border-line pl-5">
            {d.steps.map((s) => {
              const breach = s.breaches.find((b) => !b.blocked);
              const blocked = s.breaches.find((b) => b.blocked);
              return (
                <li key={s.step} className="relative">
                  <span
                    className={`absolute top-1.5 -left-[25px] size-2.5 rounded-full ${breach ? "bg-breach-solid" : s.write ? "bg-held" : "bg-[#5b6478]"}`}
                    aria-hidden
                  />
                  <p className={`text-sm ${s.write ? "font-semibold" : "text-soft"}`}>
                    {describeStep(s.tool, s.args)}
                    {!s.write && attackTools.has(s.tool) && d.attack && (
                      <span className="ml-2 text-xs text-breach">the attack was here</span>
                    )}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {!s.ok && <Badge tone="neutral">failed</Badge>}
                    {breach && (
                      <Badge tone="breach">
                        Breach: {BREACH_LABELS[breach.type] ?? breach.type}
                        {breach.lossUsd ? ` · ${dollars(breach.lossUsd)}` : ""}
                      </Badge>
                    )}
                    {blocked && !breach && (
                      <Badge tone="brand">
                        Blocked by the vault: {BREACH_LABELS[blocked.type] ?? blocked.type}
                      </Badge>
                    )}
                  </div>
                </li>
              );
            })}
            {d.guardBlocked.map((b, i) => (
              <li key={`g${i}`} className="relative">
                <span
                  className="absolute top-1.5 -left-[25px] size-2.5 rounded-full bg-held"
                  aria-hidden
                />
                <p className="text-sm font-semibold">{describeAttempt(b.tool, b.args)}</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Badge tone="brand">Stopped by its own guard</Badge>
                  {b.reason && <span className="text-xs text-muted">{b.reason}</span>}
                </div>
              </li>
            ))}
          </ol>
        )}
        {d.drained.length > 0 && (
          <p className="mt-4 text-sm text-breach">
            Afterwards the attacker used an approval the agent gave it to take{" "}
            {d.drained.map((x) => `${x.amount} ${x.token}`).join(" and ")}.
          </p>
        )}
        {d.stoppedBecause === "max_steps" && (
          <p className="mt-4 text-sm text-muted">It stopped at the step limit, not by itself.</p>
        )}
      </Card>

      <Card title="3. How the vault ruled" className="lg:col-span-2">
        <VerdictCard r={r} />
        {d.finalMessage && (
          <details className="mt-5 text-sm">
            <summary className="cursor-pointer text-muted hover:text-ink">
              The agent's last message
            </summary>
            <p className="mt-2 rounded-2xl border border-line bg-white/[0.03] p-4 whitespace-pre-wrap text-soft">
              {d.finalMessage}
            </p>
          </details>
        )}
      </Card>
    </div>
  );
}
