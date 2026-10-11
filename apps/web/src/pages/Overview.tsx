import type { ReactNode } from "react";
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
import { api } from "../lib/api";
import { totalPaid, useAgents, useClaims, useVaults, waterfall, type AgentRow } from "../lib/chain";
import { short, usd } from "../lib/format";
import { Badge, ScoreRing, Skeleton, TierBadge, buttonClass, linkClass } from "../components/ui";
import { TokenLogo, withTokens } from "../components/token";

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/** Where "Launch app" lands: your roles if a wallet is connected, a welcome if not. */
export function Overview() {
  const { address } = useAccount();
  return (
    <div className="flex flex-col gap-7">
      {address ? <Yours address={address} /> : <Welcome />}
      <AcrossBonded />
    </div>
  );
}

function Welcome() {
  const paths = [
    {
      to: "/vaults",
      title: "Back a rated agent",
      text: "Deposit into an agent's vault. If it's tricked into breaking its rules, you're paid back.",
      cta: "Browse vaults",
      icon: "M4 5h16v14H4zM9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0M4 9h2M4 15h2",
    },
    {
      to: "/agents/new",
      title: "Onboard your agent",
      text: "Give it a vault and a bond, get it rated in the Arena, and let depositors trust it.",
      cta: "Onboard an agent",
      icon: "M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4",
    },
    {
      to: "/underwrite",
      title: "Underwrite the pool",
      text: "Back the pool that pays claims and earn 80% of every premium.",
      cta: "Underwrite",
      icon: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5",
    },
  ];
  return (
    <section className="panel bg-[radial-gradient(ellipse_at_80%_0%,rgb(29_78_216/.3),transparent_55%)] p-7 sm:p-10">
      <p className="eyebrow">Welcome to Bonded</p>
      <h1 className="mt-3 max-w-2xl font-serif text-5xl leading-none sm:text-[56px]">
        Trust an AI agent with money, with your losses covered.
      </h1>
      <p className="mt-4 max-w-xl text-muted">
        Browse everything freely. Use Connect wallet at the top when you're ready to deposit,
        onboard an agent or underwrite.
      </p>
      <div className="mt-8 grid gap-3.5 md:grid-cols-3">
        {paths.map((p) => (
          <Link
            key={p.to}
            to={p.to}
            className="flex flex-col gap-1.5 rounded-[20px] border border-line bg-gradient-to-b from-white/[0.04] to-transparent p-5.5 transition hover:border-accent/40"
          >
            <span className="flex size-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
              <svg
                viewBox="0 0 24 24"
                className="size-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d={p.icon} />
              </svg>
            </span>
            <strong className="mt-2.5 text-[17px]">{p.title}</strong>
            <span className="text-sm leading-relaxed text-muted">{p.text}</span>
            <span className="mt-2 text-sm text-accent">{p.cta} →</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function RoleLabel({ children }: { children: ReactNode }) {
  return <p className="eyebrow">{children}</p>;
}

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
    .map((v, i) => ({
      vault: v.vault,
      agentId: v.agentId,
      amount: r[i]?.result as bigint | undefined,
    }))
    .filter((d) => d.amount && d.amount > 0n);
  const totalDeposits = deposits.reduce((s, d) => s + d.amount!, 0n);
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
    <>
      <header>
        <h1 className="font-serif text-5xl leading-none sm:text-[56px]">Overview</h1>
        <p className="mt-3 text-sm text-muted">
          Signed in as <span className="font-mono text-soft">{short(address)}</span>
          {roles.length ? ` · ${roles.join(" and ")}` : ""}
        </p>
      </header>

      {(frozenAgents.length > 0 || expired.length > 0) && (
        <section>
          <p className="eyebrow mb-2.5 !text-breach">Needs attention</p>
          <div className="flex flex-col gap-3">
            {frozenAgents.map((a) => (
              <Attention
                key={`f${a.agentId}`}
                title={`Agent ${a.agentId} is frozen after a breach`}
                text="Its vault stopped it acting. Check the claim, then unfreeze it from the vault page or get it re-rated first."
                to={`/vaults/${a.vault}`}
                cta="Open its vault"
              />
            ))}
            {expired.map((a) => (
              <Attention
                key={`e${a.agentId}`}
                title={`Agent ${a.agentId}'s score has expired`}
                text="New cover can't be priced until it's rated again."
                to={`/agents/${a.agentId}`}
                cta="Rate it again"
              />
            ))}
          </div>
        </section>
      )}

      <section className="grid gap-4 md:grid-cols-2">
        <div className="panel p-6">
          <div className="flex items-center justify-between">
            <RoleLabel>As a depositor</RoleLabel>
            <Link to="/vaults" className={`text-sm ${linkClass}`}>
              Vaults →
            </Link>
          </div>
          {loading ? (
            <Skeleton className="mt-4 h-24" />
          ) : deposits.length ? (
            <>
              <p className="mt-3.5 font-serif text-5xl leading-none">${usd(totalDeposits, 0)}</p>
              <p className="mt-1.5 text-sm text-muted">
                withdrawable from {deposits.length} vault{deposits.length === 1 ? "" : "s"}
              </p>
              <div className="mt-4 flex flex-col gap-2">
                {deposits.map((d) => (
                  <Link
                    key={d.vault}
                    to={`/vaults/${d.vault}`}
                    className="flex items-center gap-3 rounded-2xl bg-white/[0.04] p-3 hover:bg-white/[0.06]"
                  >
                    <TokenLogo symbol="tUSDG" size={28} />
                    <span className="flex-1">
                      <span className="block text-sm font-semibold">
                        Agent {d.agentId.toString()}'s vault
                      </span>
                      <span className="block font-mono text-[11px] text-muted">
                        {short(d.vault)}
                      </span>
                    </span>
                    <span className="font-mono text-sm">${usd(d.amount!, 0)}</span>
                  </Link>
                ))}
              </div>
            </>
          ) : (
            <p className="mt-3.5 text-sm text-muted">
              No deposits yet. Back a rated agent and you're paid back if it's tricked.{" "}
              <Link to="/vaults" className={linkClass}>
                Browse vaults
              </Link>
            </p>
          )}
        </div>

        <div className="panel p-6">
          <div className="flex items-center justify-between">
            <RoleLabel>As an operator</RoleLabel>
            <Link to="/agents?mine=1" className={`text-sm ${linkClass}`}>
              Your agents →
            </Link>
          </div>
          {!agents.data ? (
            <Skeleton className="mt-4 h-24" />
          ) : mine.length ? (
            <div className="mt-3.5 flex flex-col gap-3">
              {mine.slice(0, 3).map((a) => (
                <MyAgent key={String(a.agentId)} a={a} />
              ))}
            </div>
          ) : (
            <p className="mt-3.5 text-sm text-muted">You haven't onboarded an agent.</p>
          )}
          <Link to="/agents/new" className={`${buttonClass("primary")} mt-5 w-full`}>
            {mine.length ? "Onboard another agent" : "Onboard an agent"}
          </Link>
        </div>
      </section>

      {poolShares ? (
        <section className="panel p-6">
          <RoleLabel>As an underwriter</RoleLabel>
          <p className="mt-3.5 font-serif text-5xl leading-none">
            {poolValue !== undefined ? `$${usd(poolValue, 0)}` : "…"}
          </p>
          <p className="mt-1.5 text-sm text-muted">withdrawable from the cover pool now</p>
          <Link to="/underwrite" className={`${buttonClass("secondary")} mt-4`}>
            Manage underwriting
          </Link>
        </section>
      ) : (
        <Link
          to="/underwrite"
          className="panel flex flex-wrap items-center gap-x-4.5 gap-y-2 px-5.5 py-4 hover:border-accent/40"
        >
          <RoleLabel>As an underwriter</RoleLabel>
          <span className="flex-[1_1_260px] text-sm text-muted">
            Not underwriting yet. Back the cover pool and earn 80% of every premium.
          </span>
          <span className="text-sm text-accent">Underwrite the pool →</span>
        </Link>
      )}
    </>
  );
}

function Attention({
  title,
  text,
  to,
  cta,
}: {
  title: string;
  text: string;
  to: string;
  cta: string;
}) {
  return (
    <div className="panel flex flex-wrap items-center gap-4 border-breach/40 bg-gradient-to-r from-[rgb(70_16_10/.55)] to-transparent p-5">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-[14px] bg-breach/20 text-lg font-bold text-breach">
        !
      </span>
      <span className="flex-[1_1_300px]">
        <strong className="block">{title}</strong>
        <span className="mt-1 block text-sm text-soft">{text}</span>
      </span>
      <Link to={to} className={buttonClass("light")}>
        {cta}
      </Link>
    </div>
  );
}

function MyAgent({ a }: { a: AgentRow }) {
  return (
    <Link to={`/agents/${a.agentId}`} className="flex items-center gap-4">
      {a.score ? (
        <ScoreRing score={a.score.score} size={72} />
      ) : (
        <span className="flex size-[72px] items-center justify-center rounded-full border border-dashed border-line-strong text-xs text-muted">
          unrated
        </span>
      )}
      <span>
        <span className="block text-[17px] font-bold">Agent {a.agentId.toString()}</span>
        {a.score ? (
          <span className="mt-0.5 block text-sm text-muted">
            Tier {tierForScore(a.score.score).tier}
          </span>
        ) : (
          <span className="mt-0.5 block text-sm text-muted">Not rated yet</span>
        )}
      </span>
    </Link>
  );
}

function AcrossBonded() {
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
  const top = [...(agents.data ?? [])]
    .filter((a) => a.score)
    .sort((x, y) => y.score!.score - x.score!.score)
    .slice(0, 4);
  // Four rows don't need a live stream (each holds a database connection on the API): a small
  // page, refreshed every ten seconds, is enough.
  const recent = useQuery({
    queryKey: ["episodes", "recent"],
    queryFn: () => api.episodes({ limit: 4 }),
    refetchInterval: 10_000,
  });
  const feed = { cards: recent.data?.items ?? [] };
  const latest = claims.data?.[0];
  const w = latest ? waterfall(latest) : undefined;
  const stat = (label: string, value: string | undefined, hint: string) => (
    <div className="panel min-w-0 p-5">
      <p className="eyebrow">{label}</p>
      <p className="mt-2 font-serif text-[40px] leading-none tabular-nums">{value ?? "…"}</p>
      <p className="mt-1.5 text-xs text-muted">{withTokens(hint)}</p>
    </div>
  );
  return (
    <>
      <h2 className="mt-3 text-xl font-bold">Across Bonded</h2>
      <section className="-mt-3 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stat(
          "Cover pool",
          pool !== undefined ? `$${usd(pool, 0)}` : undefined,
          "tUSDG backing every policy",
        )}
        {stat(
          "Active cover",
          cover !== undefined ? `$${usd(cover, 0)}` : undefined,
          "across live vaults",
        )}
        {stat(
          "Agents",
          agentCount !== undefined ? String(agentCount) : undefined,
          vaultCount !== undefined ? `${vaultCount} vaults` : "",
        )}
        {stat(
          "Paid out",
          paid !== undefined ? `$${usd(paid, 0)}` : undefined,
          claims.data ? `${claims.data.length} claims, all automatic` : "",
        )}
      </section>
      <section className="grid items-stretch gap-4 md:grid-cols-2 xl:grid-cols-3">
        <div className="panel flex min-w-0 flex-col p-6 md:col-span-2 xl:col-span-1">
          <div className="flex items-center justify-between">
            <h3 className="text-[17px] font-bold">Top agents</h3>
            <Link to="/agents" className={`text-sm ${linkClass}`}>
              All agents →
            </Link>
          </div>
          <div className="mt-2 flex flex-1 flex-col">
            {top.length === 0 && <Skeleton className="mt-3 h-40" />}
            {top.map((a, n) => (
              <Link
                key={String(a.agentId)}
                to={`/agents/${a.agentId}`}
                className="-mx-2 grid grid-cols-[22px_minmax(0,1fr)_auto_auto] items-center gap-3 rounded-xl border-t border-white/[0.07] px-2 py-2.5 transition first:border-t-0 hover:bg-white/[0.035]"
              >
                <span className="font-mono text-xs text-muted">
                  {String(n + 1).padStart(2, "0")}
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-semibold">Agent {a.agentId.toString()}</span>
                  <span className="block text-xs text-muted">
                    {a.vault ? `Vault ${short(a.vault)}` : "No vault yet"}
                  </span>
                </span>
                <span className="font-serif text-[26px] leading-none">{a.score!.score}</span>
                <TierBadge score={a.score!.score} />
              </Link>
            ))}
          </div>
        </div>
        <div className="panel flex min-w-0 flex-col p-6">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-[17px] font-bold">
              <span className="size-[7px] rounded-full bg-breach-solid [animation:blink_1.4s_infinite]" />
              Arena now
            </h3>
            <Link to="/arena" className={`text-sm ${linkClass}`}>
              Watch →
            </Link>
          </div>
          {feed.cards.length === 0 ? (
            <p className="mt-3 text-sm text-muted">Waiting for the next episode…</p>
          ) : (
            feed.cards.slice(0, 4).map((c) => (
              <div
                key={c.eventId}
                className="flex items-center gap-3 border-t border-white/[0.07] py-2.5 text-sm first:border-t-0"
              >
                <span
                  className={`size-2 rounded-full ${c.breached ? "bg-breach-solid" : c.attackClass ? "bg-held" : "bg-[#5b6478]"}`}
                />
                <span className="w-8 font-mono text-xs text-muted">{c.attackClass ?? "—"}</span>
                <span className="min-w-0 flex-1 truncate">{c.attackId ?? "control"}</span>
                <Badge tone={c.breached ? "breach" : c.attackClass ? "brand" : "neutral"}>
                  {c.breached ? "Breach" : c.attackClass ? "Held" : "Control"}
                </Badge>
              </div>
            ))
          )}
        </div>
        <div className="panel flex min-w-0 flex-col p-6">
          <div className="flex items-center justify-between">
            <h3 className="text-[17px] font-bold">Latest claim</h3>
            <Link to="/claims" className={`text-sm ${linkClass}`}>
              All claims →
            </Link>
          </div>
          {latest && w ? (
            <div className="mt-4 flex flex-1 flex-col">
              <p className="font-serif text-[40px] leading-none">${usd(w.toVault, 0)} paid</p>
              <p className="mt-1.5 text-sm text-muted">
                to vault <span className="font-mono">{short(latest.vault)}</span>, no form filed
              </p>
              <p className="eyebrow mt-auto pt-6">How it was paid</p>
              <div className="mt-3 flex h-2 gap-[3px] overflow-hidden rounded-md">
                <span className="bg-brand-bright" style={{ flex: Number(w.fromBond) || 0.0001 }} />
                <span className="bg-[#9db5ff]" style={{ flex: Number(w.fromPool) || 0.0001 }} />
                <span className="bg-white/15" style={{ flex: Number(w.unpaid) || 0.0001 }} />
              </div>
              <div className="mt-2 flex justify-between text-xs text-muted">
                <span>Bond ${usd(w.fromBond, 0)}</span>
                <span>Pool ${usd(w.fromPool, 0)}</span>
                <span>Not covered ${usd(w.unpaid, 0)}</span>
              </div>
            </div>
          ) : claims.data ? (
            <p className="mt-3 text-sm text-muted">No claims yet.</p>
          ) : (
            <Skeleton className="mt-3 h-20" />
          )}
        </div>
      </section>
    </>
  );
}
