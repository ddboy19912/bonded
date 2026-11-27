import { useState } from "react";
import { Link, useParams } from "react-router";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { encodeFunctionData, isAddress, type Abi, type Address } from "viem";
import {
  SELF_SERVE_MAX_COVER_USD,
  coverManagerAbi,
  mandateVaultAbi,
  quoteMessage,
  testTokenAbi,
} from "@bondedhq/shared";
import { deployment } from "../config";
import { api, type SignedQuoteResponse } from "../lib/api";
import { useAgents, useClaims, usePolicies, waterfall } from "../lib/chain";
import { isRpcUnavailable } from "../lib/errors";
import { BREACH_TYPES, POLICY_STATUS, bps, parseUsd, short, usd, when } from "../lib/format";
import { positiveAmountError } from "../lib/validate";
import { BINDING_LABELS, policyCoverCap } from "../lib/byoa";
import {
  COVER_COVERS,
  COVER_EXCLUDES,
  COVER_EXCLUDES_MODULE,
  premiumPerYear,
  recommendedCover,
} from "../lib/bond-cover";
import { CoverWithoutTradesWarning } from "../components/health-panel";
import { tokenSymbol } from "../lib/tokens";
import {
  AddressLink,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorText,
  Input,
  LinkButton,
  Loading,
  Page,
  Term,
  TierBadge,
  TxLink,
  Unavailable,
  linkClass,
} from "../components/ui";
import { Token, TokenChip, withTokens } from "../components/token";
import { useSend } from "../components/wallet";

const ZERO = "0x0000000000000000000000000000000000000000";

/** "T1 unauthorized transfer" → "Unauthorized transfer". */
function breachLabel(type: number) {
  const raw = BREACH_TYPES[type] ?? `type ${type}`;
  const text = raw.replace(/^T\d\s+/, "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function Vault() {
  const param = useParams().address ?? "";
  if (!isAddress(param))
    return (
      <Page title="Vault" back={{ to: "/vaults", label: "All vaults" }}>
        <EmptyState title="That isn't a vault address" />
      </Page>
    );
  return <VaultView vault={param} />;
}

function VaultView({ vault }: { vault: Address }) {
  const { address: user } = useAccount();
  const who = user ?? ZERO;
  const v = { address: vault, abi: mandateVaultAbi } as const;
  const reads = useReadContracts({
    contracts: [
      { ...v, functionName: "totalAssets" },
      { ...v, functionName: "frozen" },
      { ...v, functionName: "agentId" },
      { ...v, functionName: "guardian" },
      { ...v, functionName: "agent" },
      { ...v, functionName: "breachCount" },
      { ...v, functionName: "maxWithdraw", args: [who] },
      { ...v, functionName: "mode" },
      {
        address: deployment.coverManager,
        abi: coverManagerAbi,
        functionName: "activePolicyOf",
        args: [vault],
      },
      { address: deployment.usdg, abi: testTokenAbi, functionName: "balanceOf", args: [who] },
    ],
    query: { refetchInterval: 15_000 },
  });
  const [total, frozen, agentId, guardian, agent, count, withdrawable, mode, activeId, wallet] =
    reads.data ?? [];
  const breachCount = Number(count?.result ?? 0n);
  const breaches = useReadContracts({
    contracts: Array.from({ length: breachCount }, (_, i) => ({
      ...v,
      functionName: "getBreach" as const,
      args: [BigInt(i)] as const,
    })),
    query: { enabled: breachCount > 0 },
  });
  const policies = usePolicies(vault);
  const claims = useClaims();
  const agents = useAgents();
  const back = { to: "/vaults", label: "All vaults" };

  if (reads.isLoading)
    return (
      <Page title={`Vault ${short(vault)}`} back={back}>
        <Card>
          <Loading what="vault" height="md" />
        </Card>
      </Page>
    );
  if (reads.isError || isRpcUnavailable(total?.error))
    return (
      <Page title={`Vault ${short(vault)}`} back={back}>
        <Unavailable error={reads.error ?? total?.error} onRetry={() => void reads.refetch()} />
      </Page>
    );
  if (total?.error)
    return (
      <Page title={`Vault ${short(vault)}`} back={back}>
        <EmptyState
          title="This address isn't a Bonded vault on this chain"
          action={<LinkButton to="/vaults">See all vaults</LinkButton>}
        />
      </Page>
    );

  const id = agentId?.result;
  const score = agents.data?.find((a) => a.agentId === id)?.score?.score;
  const isGuardian = Boolean(
    user && guardian?.result && user.toLowerCase() === guardian.result.toLowerCase(),
  );
  const isAgentKey = Boolean(
    user && agent?.result && user.toLowerCase() === agent.result.toLowerCase(),
  );
  const monitor = mode?.result === 0;
  const vaultClaims = claims.data?.filter((c) => c.vault.toLowerCase() === vault.toLowerCase());

  return (
    <Page
      title={id !== undefined ? `Agent ${id}'s vault` : `Vault ${short(vault)}`}
      back={back}
      intro={<span className="font-mono text-sm break-all">{vault}</span>}
      actions={
        <>
          {frozen?.result ? (
            <Badge tone="breach" dot>
              Agent frozen
            </Badge>
          ) : (
            <Badge tone="safe" dot>
              Active
            </Badge>
          )}
          {activeId?.result ? (
            <Badge tone="brand">Covered · policy {String(activeId.result)}</Badge>
          ) : (
            <Badge>No cover</Badge>
          )}
          <Badge>{monitor ? "Monitor mode" : "Enforce mode"}</Badge>
        </>
      }
    >
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-4">
          <section className="panel grid gap-6 p-6 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="eyebrow">Assets</p>
              <p className="mt-2 font-serif text-5xl leading-none tabular-nums">
                {total?.result !== undefined ? `$${usd(total.result, 0)}` : "…"}
              </p>
              <p className="mt-1 text-xs text-muted">
                <Token symbol="tUSDG" />
              </p>
            </div>
            <div>
              <p className="eyebrow">Agent</p>
              <p className="mt-3.5 text-lg font-bold">
                {id !== undefined ? (
                  <Link to={`/agents/${id}`} className={linkClass}>
                    Agent {id.toString()}
                  </Link>
                ) : (
                  "…"
                )}
              </p>
              {score !== undefined && (
                <p className="mt-1 flex items-center gap-2 text-xs text-muted">
                  Score {score} <TierBadge score={score} />
                </p>
              )}
            </div>
            <div>
              <p className="eyebrow">
                <Term term="breach">Breaches</Term>
              </p>
              <p
                className={`mt-2 font-serif text-5xl leading-none ${breachCount ? "text-breach" : ""}`}
              >
                {breachCount}
              </p>
              <p className="mt-1 text-xs text-muted">
                {breachCount ? "recorded on chain" : "stayed inside its mandate"}
              </p>
            </div>
            <CoverLeft activeId={activeId?.result} />
          </section>

          <Mandate vault={vault} guardian={guardian?.result} agentKey={agent?.result} />

          <Card title="History">
            {breachCount === 0 && !policies.data?.length ? (
              <EmptyState title="Nothing has happened here yet">
                Cover purchases, breaches and claims will show up here.
              </EmptyState>
            ) : (
              <ol className="flex flex-col gap-6 border-l border-line pl-5">
                {vaultClaims?.map((c) => {
                  const w = waterfall(c);
                  const pct = (x: bigint) => (w.loss > 0n ? Number((x * 1000n) / w.loss) / 10 : 0);
                  return (
                    <li key={c.txHash} className="relative">
                      <span className="absolute top-1 -left-[26px] size-[11px] rounded-full border-2 border-[#9db5ff] bg-paper" />
                      <div className="flex flex-wrap justify-between gap-2">
                        <strong>Claim paid · ${usd(w.toVault, 0)} to the vault</strong>
                        <TxLink hash={c.txHash} />
                      </div>
                      <div className="mt-3 flex h-2.5 gap-[3px] overflow-hidden rounded-md">
                        <span
                          className="bg-brand-bright"
                          style={{ width: `${pct(w.fromBond)}%` }}
                        />
                        <span className="bg-[#9db5ff]" style={{ width: `${pct(w.fromPool)}%` }} />
                        <span className="bg-white/15" style={{ width: `${pct(w.unpaid)}%` }} />
                      </div>
                      <div className="mt-2 flex flex-wrap gap-5 text-xs text-muted">
                        <span>Bond ${usd(w.fromBond, 0)}</span>
                        <span>Pool ${usd(w.fromPool, 0)}</span>
                        <span>
                          <Term term="deductible">Not covered</Term> ${usd(w.unpaid, 0)}
                        </span>
                      </div>
                    </li>
                  );
                })}
                {breaches.data
                  ?.map((b, i) => ({ b: b.result, i }))
                  .reverse()
                  .map(({ b, i }) =>
                    b ? (
                      <li key={i} className="relative">
                        <span className="absolute top-1 -left-[26px] size-[11px] rounded-full border-2 border-breach bg-paper" />
                        <div className="flex flex-wrap justify-between gap-2">
                          <strong>
                            Breach #{i} · {breachLabel(b.breachType)}
                          </strong>
                          <span className="text-xs text-muted">{when(b.timestamp)}</span>
                        </div>
                        <p className="mt-1.5 text-sm text-muted">
                          {b.blocked
                            ? "Blocked by the vault: no money moved."
                            : `Loss $${usd(b.lossUsd6)}. The vault froze the agent${b.claimed ? " and the claim was paid." : "."}`}
                        </p>
                      </li>
                    ) : null,
                  )}
                {policies.data?.map((p) => (
                  <PolicyEvent key={String(p)} id={p} />
                ))}
              </ol>
            )}
          </Card>
        </div>

        <div className="flex min-w-0 flex-[1_1_340px] flex-col gap-4 xl:sticky xl:top-24">
          <DepositWithdraw
            vault={vault}
            wallet={wallet?.result}
            withdrawable={withdrawable?.result}
            connected={Boolean(user)}
          />
          <BuyCover
            vault={vault}
            agentId={id}
            isGuardian={isGuardian}
            hasActive={Boolean(activeId?.result)}
            {...(total?.result !== undefined ? { holdings: total.result } : {})}
          />
          {isGuardian && Boolean(frozen?.result) && <Unfreeze vault={vault} />}
          {isAgentKey && (
            <SimulateBreach
              vault={vault}
              frozen={Boolean(frozen?.result)}
              monitor={monitor}
              covered={Boolean(activeId?.result)}
            />
          )}
        </div>
      </div>
    </Page>
  );
}

function usePolicy(id?: bigint) {
  return useReadContract({
    address: deployment.coverManager,
    abi: coverManagerAbi,
    functionName: "getPolicy",
    args: [id ?? 0n],
    query: { enabled: Boolean(id) },
  });
}

function CoverLeft({ activeId }: { activeId?: bigint }) {
  const p = usePolicy(activeId).data;
  return (
    <div>
      <p className="eyebrow">
        <Term term="cover">Cover left</Term>
      </p>
      <p className="mt-2 font-serif text-5xl leading-none tabular-nums">
        {!activeId ? "—" : p ? `$${usd(p.remainingCover, 0)}` : "…"}
      </p>
      <p className="mt-1 text-xs text-muted">
        {!activeId ? "no active policy" : p ? `of $${usd(p.coverAmount, 0)}` : ""}
      </p>
    </div>
  );
}

function PolicyEvent({ id }: { id: bigint }) {
  const p = usePolicy(id).data;
  if (!p) return null;
  return (
    <li className="relative">
      <span className="absolute top-1 -left-[26px] size-[11px] rounded-full border-2 border-white/30 bg-paper" />
      <div className="flex flex-wrap justify-between gap-2">
        <strong>
          Cover bought · ${usd(p.coverAmount, 0)} at {bps(p.premiumRateBps)} a year
        </strong>
        <span className="text-xs text-muted">{when(p.coveredFrom)}</span>
      </div>
      <p className="mt-1.5 text-sm text-muted">
        Policy {id.toString()}, priced at score {p.score}, covers breaches until {when(p.endsAt)}.
        Status: {POLICY_STATUS[p.status] ?? p.status}.
      </p>
    </li>
  );
}

/** The vault's rules, read from the contract. */
function Mandate(props: { vault: Address; guardian?: Address; agentKey?: Address }) {
  const v = { address: props.vault, abi: mandateVaultAbi } as const;
  const reads = useReadContracts({
    contracts: [
      { ...v, functionName: "getAssets" },
      { ...v, functionName: "maxTxNotionalUsd6" },
      { ...v, functionName: "maxDailyNotionalUsd6" },
      { ...v, functionName: "currentWindowNotionalUsd6" },
      { ...v, functionName: "maxDrawdownBps" },
      { ...v, functionName: "maxSlippageBps" },
    ],
  });
  const [assets, maxTx, maxDaily, used, drawdown, slippage] = (reads.data ?? []).map(
    (r) => r.result,
  );
  const daily = maxDaily as bigint | undefined;
  const usedNow = (used as bigint | undefined) ?? 0n;
  const usedPct = daily && daily > 0n ? Math.min(100, Number((usedNow * 1000n) / daily) / 10) : 0;
  const tokens = deployment as unknown as {
    usdg: string;
    tsla: string;
    amzn: string;
    nvda: string;
  };
  return (
    <Card
      title={<Term term="mandate">Mandate</Term>}
      actions={<span className="text-sm text-muted">Enforced on chain for every action</span>}
    >
      {reads.isPending ? (
        <Loading what="mandate" />
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <p className="eyebrow mb-2.5">May hold</p>
            <div className="flex flex-wrap gap-2">
              {((assets as readonly string[] | undefined) ?? []).map((a) => (
                <TokenChip key={a} symbol={tokenSymbol(a, tokens)} />
              ))}
            </div>
            <p className="eyebrow mt-6 mb-2">Guardian</p>
            <p className="text-sm">
              {props.guardian ? <AddressLink address={props.guardian} /> : "…"}
            </p>
            <p className="eyebrow mt-4 mb-2">
              <Term term="agentKey">Agent key</Term>
            </p>
            <p className="text-sm">
              {props.agentKey ? <AddressLink address={props.agentKey} /> : "…"}
            </p>
          </div>
          <div className="flex flex-col">
            <div className="border-t border-line py-3">
              <div className="flex justify-between text-sm">
                <span className="text-soft">Spent today</span>
                <span className="font-mono">
                  ${usd(usedNow, 0)} of ${daily !== undefined ? usd(daily, 0) : "…"}
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
                <div
                  className="h-1.5 rounded-full bg-gradient-to-r from-brand-bright to-[#9db5ff]"
                  style={{ width: `${usedPct}%` }}
                />
              </div>
            </div>
            {[
              ["Per trade", maxTx !== undefined ? `$${usd(maxTx as bigint, 0)}` : "…"],
              ["Max drawdown", drawdown !== undefined ? bps(Number(drawdown)) : "…"],
              ["Max slippage", slippage !== undefined ? bps(Number(slippage)) : "…"],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between border-t border-line py-3 text-sm">
                <span className="text-soft">{label}</span>
                <span className="font-mono">{value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function DepositWithdraw(props: {
  vault: Address;
  wallet?: bigint;
  withdrawable?: bigint;
  connected: boolean;
}) {
  const { address: user } = useAccount();
  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const tx = useSend();
  const value = parseUsd(amount);
  const limit = tab === "deposit" ? props.wallet : props.withdrawable;
  const over = value !== null && limit !== undefined && value > limit;
  const run = () => {
    if (!user || !value) return;
    if (tab === "deposit")
      void tx.send([
        {
          address: deployment.usdg,
          abi: testTokenAbi as Abi,
          functionName: "approve",
          args: [props.vault, value],
          label: "Approve tUSDG",
        },
        {
          address: props.vault,
          abi: mandateVaultAbi as Abi,
          functionName: "deposit",
          args: [value, user],
          label: "Deposit",
        },
      ]);
    else
      void tx.send([
        {
          address: props.vault,
          abi: mandateVaultAbi as Abi,
          functionName: "withdraw",
          args: [value, user, user],
          label: "Withdraw",
        },
      ]);
  };
  const setFraction = (f: number) =>
    limit !== undefined &&
    setAmount(usd((limit * BigInt(Math.round(f * 100))) / 100n).replaceAll(",", ""));
  return (
    <section className="panel border-accent/25 p-6">
      <div className="flex rounded-full bg-white/[0.06] p-1" role="tablist">
        {(["deposit", "withdraw"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`h-9 flex-1 rounded-full text-sm font-semibold capitalize ${tab === t ? "bg-ink text-paper" : "text-muted hover:text-ink"}`}
          >
            {t}
          </button>
        ))}
      </div>
      {!props.connected ? (
        <p className="mt-5 text-sm text-muted">
          Connect a wallet to {tab} <Token symbol="tUSDG" />.
        </p>
      ) : (
        <div className="mt-5 flex flex-col gap-3">
          <Input
            label={
              <span className="flex justify-between">
                <span>Amount</span>
                <span className="font-normal text-muted">
                  {tab === "deposit" ? "Wallet" : "Withdrawable"}:{" "}
                  {limit !== undefined ? usd(limit) : "…"} <Token symbol="tUSDG" />
                </span>
              </span>
            }
            value={amount}
            onChange={setAmount}
            placeholder="1,000"
            inputMode="decimal"
            suffix={<Token symbol="tUSDG" />}
            error={
              amount && !value
                ? "Enter a positive amount with at most 6 decimals."
                : over
                  ? `That's more than you have ${tab === "deposit" ? "in your wallet" : "to withdraw"}.`
                  : null
            }
          />
          <div className="flex gap-1.5">
            {[
              ["25%", 0.25],
              ["50%", 0.5],
              ["Max", 1],
            ].map(([label, f]) => (
              <button
                key={label}
                type="button"
                onClick={() => setFraction(f as number)}
                className="h-8 flex-1 rounded-full bg-white/[0.05] text-xs font-semibold text-muted hover:text-ink"
              >
                {label}
              </button>
            ))}
          </div>
          <Button disabled={!value || over || tx.busy} loading={tx.busy} onClick={run}>
            {value
              ? withTokens(`${tab === "deposit" ? "Deposit" : "Withdraw"} ${usd(value)} tUSDG`)
              : tab === "deposit"
                ? "Deposit"
                : "Withdraw"}
          </Button>
          {tab === "deposit" && (
            <p className="text-xs text-muted">
              Two steps: approve, then deposit. Need test <Token symbol="tUSDG" />? Get some on the{" "}
              <Link to="/underwrite" className={linkClass}>
                cover pool
              </Link>{" "}
              page.
            </p>
          )}
          {tx.view}
        </div>
      )}
    </section>
  );
}

export function BuyCover(props: {
  vault: Address;
  agentId?: bigint;
  isGuardian: boolean;
  hasActive: boolean;
  /** What the vault holds (6 decimals), for the recommended amount. */
  holdings?: bigint;
  /** Cover on a smart account's module, which doesn't pay deferred losses. */
  module?: boolean;
}) {
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<SignedQuoteResponse>();
  const [quoteError, setQuoteError] = useState<unknown>(null);
  const [quoting, setQuoting] = useState(false);
  const tx = useSend();
  const cover = parseUsd(amount);
  // An agent its owner runs has a cover cap by binding: underwriting policy, not the score.
  const id = props.agentId?.toString() ?? "";
  const self = useQuery({
    queryKey: ["self-agent", id],
    queryFn: () => api.selfAgent(id),
    enabled: Boolean(id),
  });
  const score = useQuery({
    queryKey: ["score", id],
    queryFn: () => api.score(id),
    enabled: self.data?.registered === true && self.data.kind === "remote",
    retry: false,
  });
  const policy = policyCoverCap(self.data, score.data?.binding);
  const policyBinds = policy !== undefined && policy.usd < SELF_SERVE_MAX_COVER_USD;
  // Checked as it's typed: testnet cover has a cap, and the quote would be refused over it.
  const coverError = positiveAmountError(amount, {
    value: BigInt(policyBinds ? policy.usd : SELF_SERVE_MAX_COVER_USD) * 1_000_000n,
    message: policyBinds
      ? `Underwriting policy: this agent's cover is capped at ${policy.usd.toLocaleString("en-US")} tUSDG while its binding is ${BINDING_LABELS[policy.binding].label.toLowerCase()}.`
      : `Testnet cover is capped at ${SELF_SERVE_MAX_COVER_USD.toLocaleString("en-US")} tUSDG.`,
  });
  const cap = policyBinds ? policy.usd : SELF_SERVE_MAX_COVER_USD;
  const recommended = recommendedCover({
    vaultBalanceUsd: props.holdings !== undefined ? Number(props.holdings / 1_000_000n) : undefined,
    testnetCapUsd: SELF_SERVE_MAX_COVER_USD,
    ...(policyBinds ? { policyCapUsd: policy.usd } : {}),
  });
  const own = self.data?.registered ? self.data : undefined;
  async function getQuote() {
    if (!cover || props.agentId === undefined) return;
    setQuoting(true);
    setQuoteError(null);
    setQuote(undefined);
    try {
      setQuote(
        await api.quote({
          agentId: props.agentId.toString(),
          vault: props.vault,
          coverAmount: cover.toString(),
        }),
      );
    } catch (e) {
      setQuoteError(e);
    } finally {
      setQuoting(false);
    }
  }
  const buy = async () => {
    if (!quote) return;
    const ok = await tx.send([
      {
        address: deployment.coverManager,
        abi: coverManagerAbi as Abi,
        functionName: "buyCover",
        args: [quoteMessage(quote.quote as Parameters<typeof quoteMessage>[0]), quote.signature],
        label: "Buy cover",
      },
    ]);
    if (ok) setQuote(undefined);
  };
  return (
    <Card title="Cover">
      {props.hasActive ? (
        <ActiveCover vault={props.vault} />
      ) : (
        <div className="flex flex-col gap-3">
          <CoverWithoutTradesWarning show={own?.coverWithoutVaultTrades} />
          <CoverExplained module={Boolean(props.module)} />
          <p className="text-sm text-muted">
            Quotes are priced from the agent's on-chain score and bond, and the premium streams from
            the vault. Only the guardian, who must also own the agent, can buy. Testnet cover is
            capped at {SELF_SERVE_MAX_COVER_USD.toLocaleString("en-US")} <Token symbol="tUSDG" />.
          </p>
          {policy && (
            <p className="text-sm text-muted">
              Underwriting policy, not the score: this agent runs on its owner's servers, so its
              cover is capped at {policy.usd.toLocaleString("en-US")} <Token symbol="tUSDG" /> in
              total while its binding is {BINDING_LABELS[policy.binding].label.toLowerCase()}
              {policy.binding === "declared" && self.data?.registered && self.data.coverCaps
                ? ` (${self.data.coverCaps.tee.toLocaleString("en-US")} when every episode proves a TEE)`
                : ""}
              .
            </p>
          )}
          <Input
            label="Cover amount"
            value={amount}
            onChange={(a) => (setAmount(a), setQuote(undefined))}
            placeholder="20,000"
            inputMode="decimal"
            suffix={<Token symbol="tUSDG" />}
            error={coverError}
          />
          {recommended && (
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
              Recommended: {recommended.amount.toLocaleString("en-US")} <Token symbol="tUSDG" />,{" "}
              {recommended.limitedBy === "vault"
                ? "what the vault holds: cover can't pay out more than is in it"
                : recommended.limitedBy === "policy"
                  ? `the most this agent's binding allows (${cap.toLocaleString("en-US")})`
                  : "the testnet cap"}
              .
              <button
                type="button"
                className={linkClass}
                onClick={() => (setAmount(String(recommended.amount)), setQuote(undefined))}
              >
                Use it
              </button>
            </p>
          )}
          <Button
            kind="secondary"
            disabled={!cover || Boolean(coverError)}
            loading={quoting}
            onClick={getQuote}
          >
            {quoting ? "Pricing…" : "Get a quote"}
          </Button>
          <ErrorText error={quoteError} />
          {quote && (
            <div className="flex flex-col gap-3 rounded-2xl border border-accent/30 bg-accent-soft p-4 text-sm">
              <p className="eyebrow">Your quote</p>
              <p className="font-serif text-4xl leading-none">
                {bps(quote.quote.premiumRateBps)}
                <span className="ml-1.5 font-sans text-sm text-muted">a year</span>
              </p>
              <p className="text-muted">
                for ${usd(BigInt(quote.quote.coverAmount), 0)} of cover, priced at score{" "}
                {quote.quote.score}. That's about{" "}
                {premiumPerYear(
                  Number(BigInt(quote.quote.coverAmount) / 1_000_000n),
                  quote.quote.premiumRateBps,
                ).toLocaleString("en-US")}{" "}
                <Token symbol="tUSDG" /> a year, streamed from the vault.
              </p>
              <Button disabled={!props.isGuardian || tx.busy} loading={tx.busy} onClick={buy}>
                Buy cover
              </Button>
              {!props.isGuardian && (
                <span className="text-xs text-muted">Connect the guardian's wallet to buy.</span>
              )}
            </div>
          )}
          {tx.view}
        </div>
      )}
    </Card>
  );
}

function ActiveCover({ vault }: { vault: Address }) {
  const active = useReadContract({
    address: deployment.coverManager,
    abi: coverManagerAbi,
    functionName: "activePolicyOf",
    args: [vault],
  }).data;
  const p = usePolicy(active).data;
  const owed = useReadContract({
    address: deployment.coverManager,
    abi: coverManagerAbi,
    functionName: "premiumOwed",
    args: [active ?? 0n],
    query: { enabled: Boolean(active), refetchInterval: 15_000 },
  }).data;
  if (!p) return <Loading what="policy" />;
  const left = p.coverAmount > 0n ? Number((p.remainingCover * 1000n) / p.coverAmount) / 10 : 0;
  return (
    <div className="text-sm">
      <div className="mb-1.5 flex justify-between">
        <span className="text-muted">Left</span>
        <span>
          ${usd(p.remainingCover, 0)} of ${usd(p.coverAmount, 0)}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
        <div
          className="h-1.5 rounded-full bg-gradient-to-r from-brand to-[#9db5ff]"
          style={{ width: `${left}%` }}
        />
      </div>
      <dl className="mt-4 grid grid-cols-[1fr_auto] gap-2">
        <dt className="text-muted">
          <Term term="premium">Premium</Term>
        </dt>
        <dd>{bps(p.premiumRateBps)} a year</dd>
        <dt className="text-muted">Premium owed</dt>
        <dd>{owed !== undefined ? `$${usd(owed)}` : "…"}</dd>
        <dt className="text-muted">Ends</dt>
        <dd>{when(p.endsAt)}</dd>
      </dl>
    </div>
  );
}

/** The guardian lets a frozen agent act again, e.g. after a claim has been paid. */
function Unfreeze({ vault }: { vault: Address }) {
  const tx = useSend();
  return (
    <section className="panel border-breach/35 p-6">
      <h2 className="text-lg font-bold">Agent frozen</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        A breach froze this vault's agent. As the guardian you can let it act again; any open claim
        is unaffected.
      </p>
      <div className="mt-4">
        <Button
          kind="secondary"
          loading={tx.busy}
          onClick={() =>
            void tx.send([
              {
                address: vault,
                abi: mandateVaultAbi as Abi,
                functionName: "unfreeze",
                args: [],
                label: "Unfreeze the agent",
              },
            ])
          }
        >
          Unfreeze the agent
        </Button>
      </div>
      {tx.view}
    </section>
  );
}

/** Where a simulated breach sends funds: the standard burn address, outside any mandate. */
const BURN = "0x000000000000000000000000000000000000dEaD";

/**
 * For testers whose wallet is the vault's agent key: send tUSDG out of the mandate, so the vault
 * records a breach and the keeper files the claim, exactly as if the agent had been tricked.
 */
function SimulateBreach(props: {
  vault: Address;
  frozen: boolean;
  monitor: boolean;
  covered: boolean;
}) {
  const [amount, setAmount] = useState("1000");
  const tx = useSend();
  const value = parseUsd(amount);
  const breach = () =>
    value &&
    void tx.send([
      {
        address: props.vault,
        abi: mandateVaultAbi as Abi,
        functionName: "execute",
        args: [
          deployment.usdg,
          encodeFunctionData({ abi: testTokenAbi, functionName: "transfer", args: [BURN, value] }),
        ],
        label: "Send tUSDG outside the mandate",
      },
    ]);
  return (
    <details className="panel p-5">
      <summary className="cursor-pointer text-sm font-semibold text-warn">Testing tools</summary>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        Your wallet is this vault's agent key, so you can act as a tricked agent: send{" "}
        <Token symbol="tUSDG" /> to the burn address, which no mandate allows. The vault records a
        breach and freezes the agent.
        {props.monitor
          ? props.covered
            ? " With cover active, the keeper files the claim within a minute: the operator's bond pays first, then the pool."
            : " Buy cover first if you want to see a claim paid."
          : " This vault is in Enforce mode, so the transfer is blocked: the breach is recorded with no loss, and nothing is claimed."}
      </p>
      {props.frozen ? (
        <p className="mt-3 text-sm text-muted">The agent is frozen after a breach.</p>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          <Input
            label="Amount"
            value={amount}
            onChange={setAmount}
            inputMode="decimal"
            suffix={<Token symbol="tUSDG" />}
            error={positiveAmountError(amount)}
          />
          <Button kind="danger" disabled={!value} loading={tx.busy} onClick={breach}>
            Simulate the breach
          </Button>
        </div>
      )}
      {tx.view}
    </details>
  );
}

/** What cover pays and what it doesn't, before anyone pays for it. */
function CoverExplained({ module }: { module: boolean }) {
  return (
    <details className="rounded-2xl border border-line-strong p-4 text-sm">
      <summary className="cursor-pointer font-medium">What cover pays, and what it doesn't</summary>
      <div className="mt-3 flex flex-col gap-3">
        <div>
          <p className="font-semibold text-safe">Covered</p>
          <ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-muted">
            {COVER_COVERS.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
        <div>
          <p className="font-semibold text-breach">Not covered</p>
          <ul className="mt-1 flex list-disc flex-col gap-1 pl-5 text-muted">
            {[...COVER_EXCLUDES, ...(module ? [COVER_EXCLUDES_MODULE] : [])].map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-muted">
          A claim is paid by the agent's operator bond first, then the cover pool, up to the cover
          left. The binding cap: an agent its owner runs (not in a TEE) can only be covered up to a
          lower limit, because nothing proves the code that trades is the code that was rated.
        </p>
      </div>
    </details>
  );
}
