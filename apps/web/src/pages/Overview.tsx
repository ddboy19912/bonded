import type { CSSProperties } from "react";
import { Link } from "react-router";
import { useAccount, useReadContracts } from "wagmi";
import type { Address } from "viem";
import { useQuery } from "@tanstack/react-query";
import {
  bondedRegistryAbi,
  coverManagerAbi,
  coverPoolAbi,
  mandateVaultAbi,
  mandateVaultFactoryAbi,
  tierForScore,
} from "@bondedhq/shared";
import { deployment } from "../config";
import { api, type LeaderboardRecord } from "../lib/api";
import { byScore, loadBondedIndex, modelPath, taskScore } from "../lib/bonded-index";
import { totalPaid, useAgents, useClaims, useVaults, waterfall, type AgentRow } from "../lib/chain";
import { outcomeOf, type EpisodeCard, type Outcome } from "../lib/events";
import { ago, short, usd } from "../lib/format";
import { useOwnCounts } from "../lib/own-counts";
import { PROVIDER_LOGOS } from "../lib/provider-logos";
import { useSectionStory } from "../lib/reveal";
import { TEST_AGENT } from "../lib/routes";
import { gradeTone } from "../lib/security";
import { CountUp } from "../components/count-up";
import { Skeleton, TierBadge } from "../components/ui";
import { withTokens } from "../components/token";
import "./overview.css";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/** A token amount (bigint) as a whole number of dollars, for the counters. */
const dollars = (amount: bigint) => Number(usd(amount, 0).replace(/,/g, ""));
const asUsd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Where "Launch app" lands, in the landing page's voice: the three ways in first, then a wallet's
 * own roles, how models hold up, the red team at work, and the state of the test chain. Each
 * section's label sits in a column on the left and its pieces rise into place as they come on
 * screen.
 */
export function Overview() {
  const { address } = useAccount();
  const ref = useSectionStory<HTMLDivElement>(".ov-sec");
  return (
    <div ref={ref} className="ov">
      <Hero />
      {address && <Yours address={address} />}
      <IndexTop />
      <RedTeam />
      <TestChain />
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- */

/** The three ways in, each a column under the headline. */
export const START = [
  {
    to: TEST_AGENT,
    title: "Test your agent, free",
    text: "Real attacks on your agent. A Security and a Task score.",
  },
  {
    to: "/gate",
    title: "Set up the payment gate",
    text: "Your rules, checked before your agent pays.",
  },
  {
    to: "/index",
    title: "See how models hold up",
    text: "The Index: the same attacks against every major model.",
  },
] as const;

/** The line in each way in's corner: the owner's own counts, and the model at the top. */
export function pathDetails(
  own: { tests?: number; accounts?: number },
  leader?: { label: string; score: number },
): (string | undefined)[] {
  return [
    own.tests ? `${plural(own.tests, "test")} so far` : undefined,
    own.accounts ? plural(own.accounts, "gate account") : undefined,
    leader ? `${leader.label} leads, ${leader.score}` : undefined,
  ];
}

function Hero() {
  const own = useOwnCounts();
  const leader = byScore(loadBondedIndex().entries)[0];
  const details = pathDetails(own, leader);
  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return (
    <section className="ov-hero" aria-labelledby="ov-title">
      <div className="ov-meta">
        <p className="ov-lab">Start here</p>
        <p className="ov-lab ov-live">
          <i aria-hidden />
          {today}
        </p>
      </div>
      <h1 id="ov-title" className="ov-h1">
        <span>
          <span>Test your agent.</span>
        </span>
        <span>
          <span className="ov-dim">Then hold it</span>
        </span>
        <span>
          <span className="ov-blue">to your rules.</span>
        </span>
      </h1>
      <ol className="ov-paths">
        {START.map((p, i) => (
          <li key={p.to} className="contents">
            <Link to={p.to} className="ov-path" data-main={i === 0}>
              <span className="ov-path-top">
                <span className="ov-lab">{String(i + 1).padStart(2, "0")}</span>
                {details[i] && <span className="ov-lab">{details[i]}</span>}
              </span>
              <strong className="ov-path-title">{p.title}</strong>
              <span className="ov-path-text">{p.text}</span>
              <span className="mt-auto flex justify-end pt-6">
                <span className="ov-arrow" aria-hidden>
                  →
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ---------------------------------------------------------------------------------------------- */

/** A wallet's on-chain roles: what it has deposited, the agents it runs, and its underwriting. */
function Yours({ address }: { address: Address }) {
  const agents = useAgents();
  const vaults = useVaults();
  const mine = agents.data?.filter((a) => a.owner.toLowerCase() === address.toLowerCase()) ?? [];
  const vaultList = vaults.data ?? [];
  const reads = useReadContracts({
    contracts: [
      ...vaultList.map((v) => ({
        address: v.vault,
        abi: mandateVaultAbi,
        functionName: "maxWithdraw" as const,
        args: [address] as const,
      })),
      ...mine.map((a) => ({
        address: a.vault ?? ZERO,
        abi: mandateVaultAbi,
        functionName: "frozen" as const,
      })),
      {
        address: deployment.pool,
        abi: coverPoolAbi,
        functionName: "maxWithdraw" as const,
        args: [address] as const,
      },
      {
        address: deployment.pool,
        abi: coverPoolAbi,
        functionName: "balanceOf" as const,
        args: [address] as const,
      },
    ],
    query: { enabled: Boolean(vaults.data && agents.data), refetchInterval: 30_000 },
  });
  const r = reads.data ?? [];
  const deposits = vaultList
    .map((v, i) => ({ vault: v.vault, agentId: v.agentId, amount: r[i]?.result as bigint }))
    .filter((d) => d.amount && d.amount > 0n);
  const totalDeposits = deposits.reduce((s, d) => s + d.amount, 0n);
  const frozenAgents = mine.filter((a, i) => a.vault && r[vaultList.length + i]?.result === true);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const expired = mine.filter((a) => a.score && a.score.expiresAt <= now);
  const poolShares = r[vaultList.length + mine.length + 1]?.result as bigint | undefined;
  const poolValue = r[vaultList.length + mine.length]?.result as bigint | undefined;
  const loading = !reads.data;
  const roles = [
    deposits.length ? "depositor" : "",
    mine.length ? "operator" : "",
    poolShares ? "underwriter" : "",
  ].filter(Boolean);

  return (
    <section className="ov-sec" aria-labelledby="ov-yours">
      <p className="ov-lab">Yours</p>
      <div data-beats>
        <div>
          <h2 id="ov-yours" className="ov-h2">
            Your on-chain roles
          </h2>
          <p className="ov-lede">
            Signed in as <span className="font-mono text-soft">{short(address)}</span>
            {roles.length ? `, ${roles.join(" and ")}` : ""}.
          </p>
        </div>

        {(frozenAgents.length > 0 || expired.length > 0) && (
          <div className="mt-8">
            {frozenAgents.map((a) => (
              <Alert
                key={`f${a.agentId}`}
                title={`Agent ${a.agentId} is frozen after a breach`}
                text="Its vault stopped it acting. Check the claim, then unfreeze it from the vault page or get it re-rated first."
                to={`/vaults/${a.vault}`}
                cta="Open its vault"
              />
            ))}
            {expired.map((a) => (
              <Alert
                key={`e${a.agentId}`}
                title={`Agent ${a.agentId} is due for a re-rating`}
                text="Ratings last 30 days. Its score still shows, but new cover waits for a fresh one."
                to={`/agents/${a.agentId}`}
                cta="Rate it again"
              />
            ))}
          </div>
        )}

        <div className="ov-roles">
          <div className="ov-role">
            <p className="ov-lab">Depositing</p>
            <div>
              {loading ? (
                <Skeleton className="h-12 w-40" />
              ) : deposits.length ? (
                <>
                  <CountUp
                    className="ov-role-value ov-num"
                    value={dollars(totalDeposits)}
                    format={asUsd}
                  />
                  <p className="ov-role-note">
                    Withdrawable from {plural(deposits.length, "vault")}:{" "}
                    {deposits.map((d, i) => (
                      <span key={d.vault}>
                        {i > 0 && ", "}
                        <Link to={`/vaults/${d.vault}`} className="text-soft hover:text-ink">
                          Agent {d.agentId.toString()}
                        </Link>
                      </span>
                    ))}
                  </p>
                </>
              ) : (
                <p className="ov-role-note !mt-0">
                  No deposits yet. Back a rated agent and you're paid back if it's tricked.
                </p>
              )}
            </div>
            <Link to="/vaults" className="ov-more !mt-0">
              Vaults <span aria-hidden>→</span>
            </Link>
          </div>

          <div className="ov-role">
            <p className="ov-lab">Operating</p>
            <div>
              {!agents.data ? (
                <Skeleton className="h-12 w-40" />
              ) : mine.length ? (
                <MyAgents agents={mine} />
              ) : (
                <p className="ov-role-note !mt-0">You haven't onboarded an agent.</p>
              )}
            </div>
            <Link to="/agents/new" className="ov-more !mt-0">
              {mine.length ? "Onboard another" : "Onboard an agent"} <span aria-hidden>→</span>
            </Link>
          </div>

          <div className="ov-role">
            <p className="ov-lab">Underwriting</p>
            <div>
              {poolShares ? (
                <>
                  {poolValue !== undefined ? (
                    <CountUp
                      className="ov-role-value ov-num"
                      value={dollars(poolValue)}
                      format={asUsd}
                    />
                  ) : (
                    <span className="ov-role-value">…</span>
                  )}
                  <p className="ov-role-note">Withdrawable from the cover pool now.</p>
                </>
              ) : (
                <p className="ov-role-note !mt-0">
                  Not underwriting yet. Back the cover pool and earn 80% of every premium.
                </p>
              )}
            </div>
            <Link to="/underwrite" className="ov-more !mt-0">
              {poolShares ? "Manage" : "Underwrite the pool"} <span aria-hidden>→</span>
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function Alert({ title, text, to, cta }: { title: string; text: string; to: string; cta: string }) {
  return (
    <div className="ov-alert">
      <div>
        <strong>{title}</strong>
        <p>{text}</p>
      </div>
      <Link to={to} className="ov-more !mt-0 text-breach">
        {cta} <span aria-hidden>→</span>
      </Link>
    </div>
  );
}

function MyAgents({ agents }: { agents: readonly AgentRow[] }) {
  return (
    <div className="ov-agents">
      {agents.slice(0, 4).map((a) => (
        <Link key={String(a.agentId)} to={`/agents/${a.agentId}`}>
          <span className="ov-role-value">Agent {a.agentId.toString()}</span>
          <span className="ov-lab">
            {a.score
              ? `Security ${a.score.securityScore} · tier ${tierForScore(a.score.score).tier}`
              : "Not rated yet"}
          </span>
        </Link>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------- */

function ProviderMark({ provider }: { provider: string }) {
  const src = PROVIDER_LOGOS[provider];
  return (
    // Decoration: the model's name always sits beside it.
    <span className="ov-plogo" aria-hidden>
      {src ? <img src={src} alt="" /> : <b>{provider.slice(0, 1)}</b>}
    </span>
  );
}

/** The Index's top models as one ledger, both scores side by side at the same size. */
function IndexTop() {
  const index = loadBondedIndex();
  const top = byScore(index.entries).slice(0, 5);
  if (top.length === 0) return null;
  const updated = new Date(index.updatedAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return (
    <section className="ov-sec" aria-labelledby="ov-index">
      <p className="ov-lab">Bonded Index</p>
      <div data-beats>
        <div>
          <h2 id="ov-index" className="ov-h2">
            Which models are hardest <span className="ov-dim">to trick into paying.</span>
          </h2>
          <p className="ov-lede">
            Every model runs the same invoice-paying agent against the same attacks. Security is how
            hard it is to trick; Task is whether it still pays the real bills. Updated {updated}.
          </p>
        </div>
        <div className="ov-ledger" role="table" aria-label="Top models by Security, with Task">
          <div className="ov-ledger-head ov-lab" role="row">
            <span role="columnheader">No.</span>
            <span role="columnheader">Model</span>
            <span role="columnheader">Security</span>
            <span role="columnheader">Task</span>
            <span aria-hidden className="hidden md:block" />
          </div>
          {top.map((e, i) => {
            const task = taskScore(e);
            return (
              <Link key={e.model} to={modelPath(e)} className="ov-ledger-row" role="row">
                <span className="ov-lab" role="cell">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="ov-model" role="rowheader">
                  <ProviderMark provider={e.provider} />
                  <span>{e.label}</span>
                </span>
                <span role="cell">
                  <span className="ov-score ov-num">{e.score}</span>
                  <Bar value={e.score} delay={i * 90} />
                </span>
                <span role="cell">
                  {task === null ? (
                    <span className="ov-score ov-dim">
                      <span aria-hidden>–</span>
                      <span className="sr-only">Not measured</span>
                    </span>
                  ) : (
                    <>
                      <span className="ov-score ov-num">{task}</span>
                      <Bar value={task} delay={i * 90 + 140} kind="task" />
                    </>
                  )}
                </span>
                <span className="ov-go" aria-hidden>
                  →
                </span>
              </Link>
            );
          })}
        </div>
        <Link to="/index" className="ov-more">
          See all {index.entries.length} models <span aria-hidden>→</span>
        </Link>
      </div>
    </section>
  );
}

function Bar({ value, delay, kind }: { value: number; delay: number; kind?: "task" }) {
  return (
    <span className="ov-bar" data-kind={kind} aria-hidden>
      <i style={{ "--v": value / 100, "--d": `${delay}ms` } as CSSProperties} />
    </span>
  );
}

/* ---------------------------------------------------------------------------------------------- */

const OUTCOME_WORD: Record<Outcome, string> = {
  held: "Held.",
  breach: "Breach.",
  control: "Control.",
};

/** Episodes oldest first, so the newest sits on the right of the pulse. */
export function pulseOf(cards: readonly EpisodeCard[]) {
  return [...cards].reverse().map((c) => ({ card: c, outcome: outcomeOf(c) }));
}

/** Of the episodes that met an attack, the share where the vault held. */
export function heldShare(counts: { held: number; breach: number }) {
  const attacked = counts.held + counts.breach;
  return attacked ? { attacked, pct: Math.round((counts.held / attacked) * 100) } : undefined;
}

function episodeLabel(c: EpisodeCard, outcome: Outcome) {
  const who = c.agentId ? `Agent ${c.agentId}` : "An agent";
  if (outcome === "control") return `${who}: a normal task with no attack`;
  return `${who} ${outcome === "breach" ? "was tricked by" : "held against"} ${c.attackId ?? c.attackClass}`;
}

/** The red team at work: the attack library as two giant numbers, and the Arena's pulse. */
function RedTeam() {
  const library = useQuery({ queryKey: ["library"], queryFn: api.library });
  const recent = useQuery({
    queryKey: ["episodes", "pulse"],
    queryFn: () => api.episodes({ limit: 60 }),
    refetchInterval: 10_000,
  });
  const cards = recent.data?.items ?? [];
  const pulse = pulseOf(cards);
  const share = recent.data ? heldShare(recent.data.counts) : undefined;
  const latest = pulse.at(-1);
  return (
    <section className="ov-sec" aria-labelledby="ov-red">
      <p className="ov-lab">Red team</p>
      <div data-beats>
        <div>
          <h2 id="ov-red" className="ov-h2">
            Attacks written to trick agents <span className="ov-dim">into paying.</span>
          </h2>
        </div>
        <div className="ov-figures">
          <div className="ov-figure">
            <p className="ov-lab !mt-0">Published</p>
            {library.data ? (
              <CountUp className="ov-giant ov-num" value={library.data.published} />
            ) : (
              <span className="ov-giant ov-dim">…</span>
            )}
            <p>Attacks anyone can read and run against their own agent.</p>
          </div>
          <div className="ov-figure">
            <p className="ov-lab !mt-0">Held back</p>
            {library.data ? (
              <CountUp className="ov-giant ov-num" value={library.data.heldOut.active} />
            ) : (
              <span className="ov-giant ov-dim">…</span>
            )}
            <p>Kept secret and used only in ratings, so no agent can be tuned to pass them.</p>
          </div>
          {share && (
            <div className="ov-figure">
              <p className="ov-lab !mt-0">Held in the Arena</p>
              <CountUp
                className="ov-giant ov-num ov-blue"
                value={share.pct}
                format={(n) => `${Math.round(n)}%`}
              />
              <p>Of {plural(share.attacked, "attacked episode")}, the vault stopped the payment.</p>
            </div>
          )}
        </div>
        <div className="ov-pulse">
          <div className="ov-pulse-head">
            <div>
              <p className="ov-lab">
                {latest ? `Arena · the last ${plural(pulse.length, "episode")}` : "Arena"}
              </p>
              {latest ? (
                <p className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="ov-verdict" data-outcome={latest.outcome}>
                    {OUTCOME_WORD[latest.outcome]}
                  </span>
                  <span className="text-[15px] text-muted">
                    {episodeLabel(latest.card, latest.outcome)}
                    {latest.card.at ? ` · ${ago(latest.card.at)}` : ""}
                  </span>
                </p>
              ) : (
                <p className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                  <span className="ov-verdict" data-outcome="none">
                    Quiet right now.
                  </span>
                  <span className="text-[15px] text-muted">
                    {recent.error
                      ? "Couldn't reach the Arena."
                      : "Every test plays out here, one episode at a time."}
                  </span>
                </p>
              )}
            </div>
            <Link to="/arena" className="ov-more !mt-0">
              Watch the Arena <span aria-hidden>→</span>
            </Link>
          </div>
          {pulse.length ? (
            <>
              <div className="ov-bars" aria-label="Recent episodes, oldest first">
                {pulse.map(({ card, outcome }, i) => (
                  <Link
                    key={card.eventId}
                    to={`/arena/episodes/${card.eventId}`}
                    data-outcome={outcome}
                    aria-label={episodeLabel(card, outcome)}
                    title={episodeLabel(card, outcome)}
                    style={{ "--i": i } as CSSProperties}
                  />
                ))}
              </div>
              <p className="ov-key ov-lab">
                <span>
                  <i className="bg-breach-solid" /> Breach: the agent was tricked
                </span>
                <span>
                  <i className="bg-brand-bright" /> Held: the vault stopped it
                </span>
                <span>
                  <i className="bg-[#4a4f59]" /> Control: no attack
                </span>
              </p>
            </>
          ) : (
            <div className="ov-flat" aria-hidden />
          )}
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------------------------------------- */

/**
 * The best agents by Security, the score the Index and the leaderboard rank by, each with its Task
 * score and its name on the leaderboard: the agents the leaderboard ranks (open-source templates),
 * so Bonded's own scripted agents (the reference agents and the operator's demo agents) never top
 * it.
 */
export function topAgents(
  agents: readonly AgentRow[],
  board: readonly LeaderboardRecord[] | undefined,
  n = 4,
) {
  const byId = new Map(
    (board ?? []).filter((e) => e.onchain).map((e) => [String(e.onchain!.agentId), e]),
  );
  return agents
    .flatMap((a) => {
      const e = byId.get(String(a.agentId));
      // The leaderboard's own grade, so both pages agree while a re-rating is on its way on
      // chain; the on-chain score still sets the cover tier.
      return a.score && e?.kind === "framework" && e.securityGrade !== undefined
        ? [{ agent: a, name: e.name, security: e.securityGrade, task: e.task?.score ?? null }]
        : [];
    })
    .sort((x, y) => y.security - x.security)
    .slice(0, n);
}

/** The test chain: the cover pool as one giant number, the rest beside it, the latest claim. */
function TestChain() {
  const reads = useReadContracts({
    contracts: [
      { address: deployment.pool, abi: coverPoolAbi, functionName: "totalAssets" },
      { address: deployment.coverManager, abi: coverManagerAbi, functionName: "totalActiveCover" },
      { address: deployment.registry, abi: bondedRegistryAbi, functionName: "totalAgents" },
      { address: deployment.factory, abi: mandateVaultFactoryAbi, functionName: "vaultCount" },
    ],
    query: { refetchInterval: 30_000 },
  });
  const [pool, cover, agentCount, vaultCount] = (reads.data ?? []).map(
    (x) => x.result as bigint | undefined,
  );
  const claims = useClaims();
  const paid = claims.data && totalPaid(claims.data);
  const agents = useAgents();
  // The same query the leaderboard page uses, for each agent's name and Task score.
  const board = useQuery({ queryKey: ["leaderboard"], queryFn: api.leaderboard });
  const top = topAgents(agents.data ?? [], board.data?.entries);
  const latest = claims.data?.[0];
  const w = latest ? waterfall(latest) : undefined;

  return (
    <section className="ov-sec" aria-labelledby="ov-chain">
      <p className="ov-lab">On-chain</p>
      <div data-beats>
        <div>
          <h2 id="ov-chain" className="ov-h2">
            On the test chain
          </h2>
          <p className="ov-lede">
            Vaults, cover and claims on the testnet. Test tokens only: nothing here has real value.
          </p>
        </div>

        <div className="ov-chain">
          <div className="ov-figure">
            <p className="ov-lab">Cover pool</p>
            {pool !== undefined ? (
              <CountUp className="ov-giant ov-num" value={dollars(pool)} format={asUsd} />
            ) : (
              <span className="ov-giant ov-dim">…</span>
            )}
            <p>
              {withTokens("tUSDG backing every policy, paid out when a covered agent is tricked.")}
            </p>
          </div>
          <div className="ov-stats">
            <Stat
              label="Active cover"
              value={cover !== undefined ? `$${usd(cover, 0)}` : undefined}
              note="across live vaults"
            />
            <Stat
              label="Agents"
              value={agentCount !== undefined ? String(agentCount) : undefined}
              note={vaultCount !== undefined ? plural(Number(vaultCount), "vault") : undefined}
            />
            <Stat
              label="Paid out"
              value={paid !== undefined ? `$${usd(paid, 0)}` : undefined}
              note={
                claims.data ? `${plural(claims.data.length, "claim")}, all automatic` : undefined
              }
            />
          </div>
        </div>

        <div className="ov-claim">
          <div className="flex flex-wrap items-baseline justify-between gap-4">
            <p className="ov-lab">Latest claim</p>
            <Link to="/claims" className="ov-more !mt-0">
              All claims <span aria-hidden>→</span>
            </Link>
          </div>
          {latest && w ? (
            <>
              <p className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-2">
                <span className="ov-verdict ov-num">${usd(w.toVault, 0)} paid</span>
                <span className="text-[15px] text-muted">
                  to vault <span className="font-mono">{short(latest.vault)}</span>, with no form
                  filed
                </span>
              </p>
              <div className="ov-fall" aria-hidden>
                <i style={{ flex: Number(w.fromBond) || 0.0001 }} />
                <i style={{ flex: Number(w.fromPool) || 0.0001 }} />
                <i style={{ flex: Number(w.unpaid) || 0.0001 }} />
              </div>
              <p className="ov-fall-key ov-lab">
                <span>Operator's bond ${usd(w.fromBond, 0)}</span>
                <span>Cover pool ${usd(w.fromPool, 0)}</span>
                <span>Not covered ${usd(w.unpaid, 0)}</span>
              </p>
            </>
          ) : claims.data ? (
            <p className="mt-4 text-[15px] text-muted">No claims yet.</p>
          ) : (
            <Skeleton className="mt-4 h-16" />
          )}
        </div>

        <div className="ov-agents-table">
          <div className="flex flex-wrap items-baseline justify-between gap-4">
            <p className="ov-lab">Top agents by Security</p>
            <Link to="/leaderboard" className="ov-more !mt-0">
              Leaderboard <span aria-hidden>→</span>
            </Link>
          </div>
          <div className="mt-4" role="table" aria-label="Top agents by Security, with Task">
            <div className="ov-agent-row ov-ledger-head ov-lab" role="row">
              <span role="columnheader">No.</span>
              <span role="columnheader">Agent</span>
              <span role="columnheader" className="text-right">
                Security
              </span>
              <span role="columnheader" className="text-right">
                Task
              </span>
              <span role="columnheader" className="ov-tier">
                Tier
              </span>
            </div>
            {top.length === 0 &&
              (agents.error || board.error ? (
                <p className="py-4 text-sm text-muted">Couldn't load the agents right now.</p>
              ) : agents.data && board.data ? (
                <p className="py-4 text-sm text-muted">No rated agents yet.</p>
              ) : (
                <Skeleton className="mt-3 h-40" />
              ))}
            {top.map(({ agent: a, name, security, task }, i) => (
              <Link
                key={String(a.agentId)}
                to={`/agents/${a.agentId}`}
                role="row"
                aria-label={`${name}, agent ${a.agentId}: Security ${security}, Task ${task ?? "not measured"}`}
                className="ov-agent-row"
              >
                <span className="ov-lab" role="cell">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="ov-agent-name" role="cell">
                  <strong>{name}</strong>
                  <span className="ov-lab">
                    Agent {a.agentId.toString()}
                    {a.vault ? ` · vault ${short(a.vault)}` : " · no vault yet"}
                  </span>
                </span>
                <span className={`ov-score ov-num ${gradeTone(security)}`} role="cell">
                  {security}
                </span>
                <span
                  className={`ov-score ov-num ${task === null ? "ov-dim" : gradeTone(task)}`}
                  role="cell"
                >
                  {task ?? "–"}
                </span>
                <span className="ov-tier" role="cell" title="Cover tier, from the insurance score">
                  <TierBadge score={a.score!.score} />
                </span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value, note }: { label: string; value?: string; note?: string }) {
  return (
    <div className="ov-stat">
      <p className="ov-lab">{label}</p>
      <div>
        <strong className="ov-num">{value ?? "…"}</strong>
        {note && <small>{note}</small>}
      </div>
    </div>
  );
}
