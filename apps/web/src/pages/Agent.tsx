import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import {
  bondedRegistryAbi,
  coverManagerAbi,
  mandateModuleAbi,
  mandateVaultAbi,
  operatorBondAbi,
  testTokenAbi,
  tierForScore,
} from "@bondedhq/shared";
import type { Address } from "viem";
import { deployment } from "../config";
import { downloadReportJson, downloadReportPdf, type ReportContext } from "../lib/report";
import { ApiError, api, type SelfAgentRecord } from "../lib/api";
import { liveCheckView, teeView } from "../lib/tee";
import { isRpcUnavailable } from "../lib/errors";
import { apiLookups, isRegistered } from "../lib/agent";
import { moduleCoverNote, useAgents } from "../lib/chain";
import { tierMeaning } from "../lib/glossary";
import { OwnerTools } from "../components/owner-tools";
import { CoverWithoutTradesWarning, HealthPanel, VaultTrading } from "../components/health-panel";
import { UseYourVault } from "../components/framework-questions";
import { byoaApi } from "../lib/byoa-api";
import { BreachEvidenceList, TopFixes } from "../components/report-actions";
import { evidenceOf, topFixes } from "../lib/report-actions";
import { ModuleCover } from "../components/module-cover";
import { BindingLine } from "../components/connect-agent";
import { classCells, coverageRows, livenessLine, untestedClasses, untestedLine } from "../lib/byoa";
import { Token } from "../components/token";
import { bps, short, usd, when } from "../lib/format";
import {
  AddressLink,
  Badge,
  Card,
  EmptyState,
  ErrorText,
  LinkButton,
  Loading,
  Page,
  ScoreRing,
  Term,
  TxLink,
  Unavailable,
  buttonClass,
  linkClass,
  tierTone,
} from "../components/ui";

export function Agent() {
  const id = useParams().id ?? "";
  const valid = /^\d+$/.test(id);
  const agentId = valid ? BigInt(id) : 0n;
  const reads = useReadContracts({
    contracts: [
      {
        address: deployment.registry,
        abi: bondedRegistryAbi,
        functionName: "scoreOf",
        args: [agentId],
      },
      {
        address: deployment.registry,
        abi: bondedRegistryAbi,
        functionName: "agentOwner",
        args: [agentId],
      },
      { address: deployment.bond, abi: operatorBondAbi, functionName: "bondOf", args: [agentId] },
      {
        address: deployment.registry,
        abi: bondedRegistryAbi,
        functionName: "hasValidScore",
        args: [agentId],
      },
    ],
    query: { enabled: valid },
  });
  const [onchain, owner, bond, fresh] = reads.data ?? [];
  const a = onchain?.result;
  const lookups = apiLookups(a);
  const rated = lookups.rated;
  const score = useQuery({
    queryKey: ["score", id],
    queryFn: () => api.score(id),
    enabled: valid && lookups.score,
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  });
  const run = useQuery({
    queryKey: ["run", score.data?.runId],
    queryFn: () => api.run(score.data!.runId),
    enabled: Boolean(score.data?.runId),
  });
  const liveCheck = useQuery({
    queryKey: ["tee", id],
    queryFn: () => api.tee(id),
    enabled: valid && lookups.tee,
    refetchInterval: 60_000,
    retry: false,
  });
  const agents = useAgents();
  const row = agents.data?.find((r) => r.agentId === agentId);
  const vault = row?.vault;
  const guarded = row?.protected;
  const { address } = useAccount();
  const self = useQuery({
    queryKey: ["self-agent", id],
    queryFn: () => api.selfAgent(id),
    enabled: valid,
  });
  const ownRecord = self.data?.registered ? self.data : undefined;

  const back = { to: "/agents", label: "All agents" };
  if (!valid)
    return (
      <Page title="Agent" back={back}>
        <EmptyState title="That isn't an agent ID">Agent IDs are whole numbers.</EmptyState>
      </Page>
    );
  if (reads.isLoading)
    return (
      <Page title={`Agent ${id}`} back={back}>
        <Card>
          <Loading what={`agent ${id}`} height="md" />
        </Card>
      </Page>
    );
  const readError = reads.error ?? [onchain, owner, bond, fresh].find((r) => r?.error)?.error;
  if (reads.isError || isRpcUnavailable(readError))
    return (
      <Page title={`Agent ${id}`} back={back}>
        <Unavailable error={readError} onRetry={() => void reads.refetch()} />
      </Page>
    );
  if (owner?.error || !isRegistered(owner?.result))
    return (
      <Page title={`Agent ${id}`} back={back}>
        <EmptyState
          title={`No agent ${id} on this chain`}
          action={<LinkButton to="/agents">See all agents</LinkButton>}
        />
      </Page>
    );

  const report = run.data?.report;
  const tee = teeView(a?.teeMeasurement, report);
  const tier = rated && a ? tierForScore(a.score).tier : undefined;
  const weak = report?.classes.filter((c) => c.breaches > 0) ?? [];
  // Ratings that count only exercised trials (operator-run agents) report them per class.
  const exercisedShown = Boolean(report?.classes.some((c) => c.exercised !== undefined));
  const untested = new Set(untestedClasses(report));
  const classGrid = exercisedShown
    ? "grid grid-cols-[44px_minmax(0,1fr)_minmax(0,2fr)_64px_112px] items-center gap-3.5"
    : "grid grid-cols-[44px_minmax(0,1fr)_minmax(0,2fr)_74px] items-center gap-3.5";
  const tone = rated && a ? tierTone(a.score) : "neutral";
  const glow =
    tone === "brand"
      ? "rgb(127 160 255 / .14)"
      : tone === "warn"
        ? "rgb(255 179 71 / .12)"
        : "rgb(255 122 69 / .12)";

  return (
    <Page
      title={`Agent ${id}`}
      back={back}
      intro="Its latest safety score, read from the on-chain registry: the headline Bonded Score is how well it resisted manipulation. Cover for its vault is priced from the insurance score underneath, and every agent is scored on the same scale."
      actions={
        <>
          {vault && (
            <Link to={`/vaults/${vault}`} className={buttonClass("secondary")}>
              Open vault
            </Link>
          )}
          <Link to="/arena" className={buttonClass("light")}>
            Watch the Arena
          </Link>
        </>
      }
    >
      <div className="-mt-2 flex flex-wrap gap-2">
        {tier && <Badge tone={tone}>Insurance tier {tier}</Badge>}
        {rated &&
          (fresh?.result ? (
            <Badge tone="safe" dot>
              Score valid
            </Badge>
          ) : (
            <Badge tone="warn" dot>
              Score expired
            </Badge>
          ))}
        {report && <Badge>{report.mandateMode} mode</Badge>}
        {score.data?.superseded && (
          <Badge tone="breach" dot>
            Score superseded: no new cover until a complete rating
          </Badge>
        )}
        {report?.sentinel && (
          <Link to="/sentinel">
            <Badge tone="brand" dot>
              Rated with Sentinel on
            </Badge>
          </Link>
        )}
      </div>

      {rated && a ? (
        <section className="grid gap-4 lg:grid-cols-2">
          <div
            className="panel flex flex-wrap items-center gap-7 p-6"
            style={{
              backgroundImage: `radial-gradient(ellipse at 20% 0%, ${glow}, transparent 60%)`,
            }}
          >
            <ScoreRing score={a.securityScore} />
            <div className="min-w-0 flex-1">
              <p className="eyebrow">Bonded Score</p>
              <p className="mt-1 text-sm text-muted">
                how well the agent resisted manipulation — any trick it fell for pulls this down
              </p>
              <p className="mt-2 leading-relaxed text-soft">Insurance tier: {tierMeaning(tier!)}</p>
              <p className="mt-2.5 text-sm text-muted">
                Signed {when(a.issuedAt)} · valid until {when(a.expiresAt)}
              </p>
              <p className="mt-2.5 text-sm text-muted">
                Every agent faces the same attacks on the same scale, so this score is built to be
                the bar for agent safety: a number a platform can require and a builder can aim for.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Tile
              label="Insurance score"
              value={`${a.score} · ${tier}`}
              hint="prices cover, not the headline"
            />
            <Tile
              label={<Term term="expectedLoss">Expected loss</Term>}
              value={bps(a.expectedLossBps)}
              hint="of cover a year"
            />
            <Tile
              label={<Term term="bond">Operator bond</Term>}
              value={bond?.result !== undefined ? `$${usd(bond.result, 0)}` : "…"}
              hint="pays first on a claim"
            />
            <Tile
              label="Breached classes"
              value={report ? `${weak.length} of ${report.classes.length}` : "…"}
              hint={
                report
                  ? weak.length
                    ? weak.map((c) => c.name.toLowerCase()).join(", ")
                    : "held every attack class"
                  : "loading the report"
              }
            />
            <Tile
              label={<Term term="tee">Key custody</Term>}
              value={tee.inTee ? "TEE" : "Operator"}
              hint={tee.inTee ? "key made inside Intel TDX" : "key on the operator's server"}
            />
          </div>
        </section>
      ) : (
        <EmptyState title="Not rated yet">
          Its owner can ask for a rating from this page once it's registered for ratings.
        </EmptyState>
      )}

      {isOwnerOf(address, owner?.result) && ownRecord && (
        <HealthPanel agentId={id} record={self.data} />
      )}

      <OwnerTools
        // A new agent's page starts with fresh owner controls (its own token, rating, errors).
        key={`${deployment.chainId}:${id}`}
        agentId={id}
        owner={owner?.result}
        scoreExpired={Boolean(rated && fresh && fresh.result === false)}
      />

      {isOwnerOf(address, owner?.result) && ownRecord?.kind === "remote" && (vault || guarded) && (
        <UseYourVault vault={vault ?? guarded?.module ?? null} />
      )}

      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-4">
          {report ? (
            <Card
              title="Attack report"
              actions={
                <span className="text-sm text-muted">
                  {report.episodes.attacks} attacks · {report.episodes.controls} controls ·{" "}
                  {report.forked ? "fork of the live chain" : "local chain"}
                </span>
              }
            >
              {weak.length > 0 && (
                <div className="mb-5 flex gap-3.5 rounded-2xl border border-breach/35 bg-breach-soft p-4">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-breach/20 font-bold text-breach">
                    !
                  </span>
                  <span>
                    <strong className="block">
                      {weak.length === 1 ? "One weakness" : `${weak.length} weaknesses`}:{" "}
                      {weak.map((c) => c.name.toLowerCase()).join(", ")}
                    </strong>
                    <span className="mt-1 block text-sm text-soft">
                      {weak
                        .map((c) => `${c.class}: ${c.breaches} of ${c.episodes} episodes breached`)
                        .join(". ")}
                      . Every other class held.
                    </span>
                  </span>
                </div>
              )}
              {(topFixes(report).length > 0 || evidenceOf(report).length > 0) && (
                <div className="mb-5 flex flex-col gap-4">
                  <TopFixes report={report} />
                  <BreachEvidenceList report={report} />
                </div>
              )}
              <div className="flex flex-col">
                {exercisedShown && (
                  <div className={`${classGrid} pb-2 text-[11px] text-muted`}>
                    <span />
                    <span />
                    <span />
                    <span className="text-right">Exercised</span>
                    <span className="text-right">Result</span>
                  </div>
                )}
                {report.classes.map((c) => {
                  const held = c.episodes ? (c.episodes - c.breaches) / c.episodes : 1;
                  const cells = classCells(c);
                  return (
                    <div key={c.class} className={`${classGrid} border-t border-white/[0.06] py-3`}>
                      <span className="font-mono text-xs text-muted">{c.class}</span>
                      <span className="truncate text-sm">{c.name}</span>
                      <span className="flex h-2 overflow-hidden rounded-full bg-white/[0.06]">
                        <span
                          className="bg-gradient-to-r from-brand to-held"
                          style={{ width: `${held * 100}%` }}
                        />
                        <span
                          className="bg-breach-solid"
                          style={{ width: `${(1 - held) * 100}%` }}
                        />
                      </span>
                      {exercisedShown ? (
                        <>
                          <span
                            className={`text-right font-mono text-xs ${untested.has(c.class) || cells.result === "not reached" ? "text-warn" : "text-muted"}`}
                            title={
                              untested.has(c.class)
                                ? "Never tested the agent: priced as untested within its group"
                                : undefined
                            }
                          >
                            {cells.exercised}
                          </span>
                          <span
                            className={`text-right font-mono text-xs ${cells.tone === "breach" ? "text-breach" : cells.tone === "warn" ? "text-warn" : "text-muted"}`}
                          >
                            {cells.result}
                          </span>
                        </>
                      ) : (
                        <span
                          className={`text-right font-mono text-xs ${c.breaches ? "text-breach" : "text-muted"}`}
                        >
                          {c.breaches ? `${c.breaches} of ${c.episodes}` : `held ${c.episodes}`}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              {exercisedShown && (
                <p className="mt-3 text-xs text-muted">
                  Exercised: the attack episodes that tested the agent, because it was breached or
                  did its task anyway. For an agent its operator runs, only those count: an episode
                  in which it did nothing at all proves nothing.
                  {untestedLine(report) && ` ${untestedLine(report)}`}
                </p>
              )}
              <p className="mt-4 text-xs text-muted">
                {report.unpublished?.episodes
                  ? `${report.unpublished.episodes} of the attack episodes ran ${report.unpublished.attacks} unpublished attacks (held out, or accepted bounties) that the operator couldn't study in advance.`
                  : "Published attacks only: an in-library result, not a held-out evaluation."}
                {score.data?.heldOut &&
                  ` ${score.data.heldOut.attacks ?? "Its"} held-out attacks were made for this rating alone${score.data.heldOut.source === "rewrite" ? " (rewrites of published seeds)" : score.data.heldOut.model ? ` (drafted by ${score.data.heldOut.model})` : ""}, seed ${score.data.heldOut.seed}.`}
              </p>
              {score.data?.binding && (
                <div className="mt-4 flex flex-col gap-1.5 border-t border-white/[0.06] pt-4">
                  <span className="eyebrow">Binding</span>
                  <BindingLine binding={score.data.binding} />
                </div>
              )}
              <Coverage coverage={score.data?.coverage ?? report.coverage ?? null} />
              {livenessLine(report.liveness) && (
                <p className="mt-3 text-xs text-muted">{livenessLine(report.liveness)}</p>
              )}
            </Card>
          ) : rated ? (
            <Card title="Attack report">
              {run.isError || score.isError ? (
                <p className="text-sm text-muted">The full report isn't available right now.</p>
              ) : (
                <Loading what="the attack report" height="lg" />
              )}
            </Card>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-4">
          {vault && <VaultSummary vault={vault} agentId={id} record={ownRecord} />}
          {guarded && <AccountSummary module={guarded.module} account={guarded.account} />}
          {guarded && <ModuleCover agentId={agentId} module={guarded.module} />}
          <SentinelChecks agentId={id} ratedWith={Boolean(report?.sentinel)} />
          <Card title="Proof on chain">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm [&_dd]:text-right [&_dt]:text-muted">
              <dt>Owner</dt>
              <dd>{owner?.result ? <AddressLink address={owner.result} /> : "…"}</dd>
              {rated && a && (
                <>
                  <dt>
                    <Term term="reportHash">Report hash</Term>
                  </dt>
                  <dd className="truncate font-mono text-xs">{a.reportHash}</dd>
                  <dt>
                    <Term term="mandate">Mandate hash</Term>
                  </dt>
                  <dd className="truncate font-mono text-xs">{a.mandateHash}</dd>
                </>
              )}
              {tee.measurement && (
                <>
                  <dt>
                    <Term term="teeMeasurement">TEE measurement</Term>
                  </dt>
                  <dd className="truncate font-mono text-xs">{tee.measurement}</dd>
                  <dt>TEE live check</dt>
                  <dd>
                    <Badge
                      tone={
                        liveCheckView(liveCheck.data?.status, liveCheck.data?.blockingStatus).tone
                      }
                    >
                      {liveCheckView(liveCheck.data?.status, liveCheck.data?.blockingStatus).label}
                    </Badge>
                  </dd>
                </>
              )}
              {score.data && (
                <>
                  <dt>Posted in</dt>
                  <dd>
                    <TxLink hash={score.data.tx_hash} />
                  </dd>
                </>
              )}
            </dl>
            {score.data && (
              <ReportDownloads
                ctx={{
                  agentId: id,
                  runId: score.data.runId,
                  reportHash: a?.reportHash ?? score.data.signed.attestation.reportHash,
                  txHash: score.data.tx_hash,
                  ...(a?.mandateHash ? { mandateHash: a.mandateHash } : {}),
                }}
              />
            )}
            {score.error && !(score.error instanceof ApiError && score.error.status === 404) && (
              <ErrorText error={score.error} />
            )}
          </Card>
        </div>
      </div>
    </Page>
  );
}

/**
 * Which attack surfaces the agent actually read. An attack on a surface the agent never reads can't
 * reach it, so a clean result there says little: the reader should see that.
 */
function Coverage({ coverage }: { coverage: Parameters<typeof coverageRows>[0] }) {
  const rows = coverageRows(coverage);
  if (!rows.length) return null;
  const unread = rows.filter((r) => r.read === 0);
  return (
    <div className="mt-4 flex flex-col gap-2 border-t border-white/[0.06] pt-4">
      <span className="eyebrow">Coverage</span>
      <p className="text-xs text-muted">
        {unread.length
          ? `The agent never read ${unread.map((r) => r.label).join(", ")}, so attacks there couldn't reach it.`
          : "The agent read every surface that was attacked."}
      </p>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-4 gap-y-1 text-xs">
        <span className="text-muted">Surface</span>
        <span className="text-right text-muted">Attacked</span>
        <span className="text-right text-muted">Read</span>
        {rows.map((r) => (
          <span key={r.surface} className="contents">
            <span>{r.label}</span>
            <span className="text-right font-mono">{r.attacked}</span>
            <span className={`text-right font-mono ${r.read ? "" : "text-warn"}`}>{r.read}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Tile({ label, value, hint }: { label: ReactNode; value: ReactNode; hint: ReactNode }) {
  return (
    <div className="panel min-w-0 p-5">
      <p className="eyebrow">{label}</p>
      <p className="mt-2.5 truncate text-[28px] font-bold tracking-tight">{value}</p>
      <p className="mt-1 truncate text-xs text-muted">{hint}</p>
    </div>
  );
}

const isOwnerOf = (address?: string, owner?: string) =>
  Boolean(address && owner && address.toLowerCase() === owner.toLowerCase());

/** The agent's newest vault: what it holds, whether the agent trades through it, and its cover. */
function VaultSummary({
  vault,
  agentId,
  record,
}: {
  vault: Address;
  agentId: string;
  record?: Extract<SelfAgentRecord, { registered: true }> | undefined;
}) {
  // Whether the agent actually trades through it: from its record, or the chain's own events.
  const activity = useQuery({
    queryKey: ["vault-activity", agentId],
    queryFn: () => byoaApi.vaultActivity(agentId),
    enabled: record?.vaultActivity === undefined,
    retry: false,
    refetchInterval: 60_000,
  });
  const trades = record?.vaultActivity ?? activity.data;
  const reads = useReadContracts({
    contracts: [
      { address: vault, abi: mandateVaultAbi, functionName: "totalAssets" },
      {
        address: deployment.coverManager,
        abi: coverManagerAbi,
        functionName: "activePolicyOf",
        args: [vault],
      },
    ],
  });
  const [total, active] = reads.data ?? [];
  const policy = useReadContract({
    address: deployment.coverManager,
    abi: coverManagerAbi,
    functionName: "getPolicy",
    args: [active?.result ?? 0n],
    query: { enabled: Boolean(active?.result) },
  }).data;
  const left =
    policy && policy.coverAmount > 0n
      ? Number((policy.remainingCover * 1000n) / policy.coverAmount) / 10
      : 0;
  return (
    <Card
      title="Its vault"
      actions={
        <Link to={`/vaults/${vault}`} className={`text-sm ${linkClass}`}>
          Open →
        </Link>
      }
    >
      <p className="-mt-3 font-mono text-xs text-muted">{short(vault)}</p>
      <p className="mt-4 text-3xl font-bold tracking-tight">
        {total?.result !== undefined ? `$${usd(total.result)}` : "…"}
      </p>
      <p className="text-xs text-muted">
        <Token symbol="tUSDG" /> held for depositors
      </p>
      {policy ? (
        <>
          <div className="mt-4 mb-1.5 flex justify-between text-xs">
            <span className="text-muted">Cover left</span>
            <span>
              ${usd(policy.remainingCover, 0)} of ${usd(policy.coverAmount, 0)}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
            <div
              className="h-1.5 rounded-full bg-gradient-to-r from-brand to-[#9db5ff]"
              style={{ width: `${left}%` }}
            />
          </div>
          <p className="mt-2.5 text-xs text-muted">
            Premium {bps(policy.premiumRateBps)} a year, streamed from the vault.
          </p>
        </>
      ) : (
        <p className="mt-4 text-xs text-muted">No active cover.</p>
      )}
      {trades && (
        <div className="mt-4 border-t border-line pt-3">
          <VaultTrading activity={trades} />
        </div>
      )}
      {record?.coverWithoutVaultTrades && (
        <div className="mt-3">
          <CoverWithoutTradesWarning show />
        </div>
      )}
    </Card>
  );
}

/**
 * The agent's newest smart account protected by a MandateModule: the funds stay in the account,
 * the module checks the agent's actions, holds the breach log and the policy, and payouts go back
 * into the account.
 */
function AccountSummary({ module, account }: { module: Address; account: Address }) {
  const m = { address: module, abi: mandateModuleAbi } as const;
  const reads = useReadContracts({
    contracts: [
      { address: deployment.usdg, abi: testTokenAbi, functionName: "balanceOf", args: [account] },
      { ...m, functionName: "frozen" },
      { ...m, functionName: "breachCount" },
      { ...m, functionName: "installs" },
      { ...m, functionName: "mode" },
      {
        address: deployment.coverManager,
        abi: coverManagerAbi,
        functionName: "activePolicyOf",
        args: [module],
      },
    ],
  });
  const [held, frozen, breaches, installs, mode, active] = reads.data ?? [];
  const cover = mode?.result !== undefined ? moduleCoverNote(mode.result) : undefined;
  const policy = useReadContract({
    address: deployment.coverManager,
    abi: coverManagerAbi,
    functionName: "getPolicy",
    args: [active?.result ?? 0n],
    query: { enabled: Boolean(active?.result) },
  }).data;
  return (
    <Card title="Its smart account">
      <p className="-mt-3 text-xs text-muted">
        <AddressLink address={account} />
      </p>
      <p className="mt-4 text-3xl font-bold tracking-tight">
        {held?.result !== undefined ? `$${usd(held.result)}` : "…"}
      </p>
      <p className="text-xs text-muted">
        <Token symbol="tUSDG" /> in the account, guarded by a mandate module
      </p>
      <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm [&_dd]:text-right [&_dt]:text-muted">
        <dt>Module</dt>
        <dd>
          <AddressLink address={module} />
        </dd>
        <dt>Agent</dt>
        <dd>
          {installs?.result === 0n
            ? "module removed"
            : frozen?.result
              ? "frozen"
              : frozen?.result === false
                ? "active"
                : "…"}
        </dd>
        <dt>Mode</dt>
        <dd>{cover?.label ?? "…"}</dd>
        <dt>Breaches recorded</dt>
        <dd className="tabular-nums">{breaches?.result?.toString() ?? "…"}</dd>
        <dt>Cover left</dt>
        <dd className="tabular-nums">
          {policy
            ? `$${usd(policy.remainingCover, 0)} of $${usd(policy.coverAmount, 0)}`
            : cover && !cover.insurable
              ? "not insurable"
              : "no active cover"}
        </dd>
      </dl>
      <p className="mt-3 text-xs text-muted">
        Premiums are paid from the account and claims are paid back into it.
      </p>
    </Card>
  );
}

/** The report as a readable PDF, or as the original JSON whose hash is on chain. */
function ReportDownloads({ ctx }: { ctx: ReportContext }) {
  const [busy, setBusy] = useState<"pdf" | "json">();
  const [error, setError] = useState<string>();
  const run = async (kind: "pdf" | "json") => {
    setBusy(kind);
    setError(undefined);
    try {
      await (kind === "pdf" ? downloadReportPdf(ctx) : downloadReportJson(ctx));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The download failed. Try again.");
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div className="mt-5 flex flex-col gap-2">
      <button
        type="button"
        onClick={() => void run("pdf")}
        disabled={busy !== undefined}
        className={`${buttonClass("secondary")} w-full`}
      >
        {busy === "pdf" ? "Making the PDF…" : "Download the report (PDF)"}
      </button>
      <button
        type="button"
        onClick={() => void run("json")}
        disabled={busy !== undefined}
        className="text-center text-xs text-accent hover:underline disabled:opacity-60"
      >
        {busy === "json" ? "Downloading…" : "Original JSON (matches the on-chain hash)"}
      </button>
      {error && <p className="text-center text-xs text-breach">{error}</p>}
    </div>
  );
}

/**
 * The agent's Sentinel checks in the last 7 days (POST /sentinel/check). Shown when it has any,
 * or when it was rated with Sentinel on: then it should be asking before each trade.
 */
function SentinelChecks({ agentId, ratedWith }: { agentId: string; ratedWith: boolean }) {
  const checks = useQuery({
    queryKey: ["sentinel-agent", agentId],
    queryFn: () => api.sentinelAgent(agentId),
    refetchInterval: 60_000,
  });
  const week = checks.data?.last7d;
  if (!week || (week.checks === 0 && !ratedWith)) return null;
  return (
    <Card title="Sentinel checks">
      {week.checks === 0 ? (
        <p className="text-sm text-muted">
          Rated with Sentinel on, but it hasn't asked Sentinel about a trade in the last 7 days.{" "}
          <Link to="/sentinel" className={linkClass}>
            How to ask
          </Link>
        </p>
      ) : (
        <>
          <p className="text-sm text-muted">
            In the last 7 days this agent asked Sentinel about{" "}
            <span className="text-ink tabular-nums">{week.checks.toLocaleString()}</span>{" "}
            {week.checks === 1 ? "trade" : "trades"}, and{" "}
            <span className={week.blocked ? "text-breach tabular-nums" : "text-ink tabular-nums"}>
              {week.blocked.toLocaleString()}
            </span>{" "}
            {week.blocked === 1 ? "was" : "were"} flagged as manipulated.
          </p>
          {checks.data?.lastCheckAt && (
            <p className="mt-2 text-xs text-muted">
              Last check {when(Math.floor(Date.parse(checks.data.lastCheckAt) / 1000))}.
            </p>
          )}
        </>
      )}
    </Card>
  );
}
