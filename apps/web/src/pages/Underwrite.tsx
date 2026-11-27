import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useAccount, useReadContracts } from "wagmi";
import type { Abi } from "viem";
import { coverManagerAbi, coverPoolAbi, testTokenAbi } from "@bondedhq/shared";
import { deployment, faucets } from "../config";
import { bps, duration, parseUsd, usd, when } from "../lib/format";
import { isRpcUnavailable } from "../lib/errors";
import { Button, Card, Input, Loading, Page, Term, Unavailable, linkClass } from "../components/ui";
import { useSend } from "../components/wallet";
import { Token, withTokens } from "../components/token";

const ZERO = "0x0000000000000000000000000000000000000000";
const pool = { address: deployment.pool, abi: coverPoolAbi } as const;
const manager = { address: deployment.coverManager, abi: coverManagerAbi } as const;

export function Underwrite() {
  const { address: user } = useAccount();
  const who = user ?? ZERO;
  // "Your underwriting" in the sidebar opens this page with ?mine=1 and jumps to the position.
  const [params] = useSearchParams();
  const mine = params.get("mine") === "1";
  const position = useRef<HTMLDivElement>(null);
  const reads = useReadContracts({
    contracts: [
      { ...pool, functionName: "totalAssets" },
      { ...pool, functionName: "requiredCapital" },
      { ...pool, functionName: "freeCapital" },
      { ...pool, functionName: "cooldown" },
      { ...manager, functionName: "totalActiveCover" },
      { ...manager, functionName: "maxLeverageBps" },
      { ...manager, functionName: "maxAgentCoverBps" },
      { ...manager, functionName: "modelFamilyCapBps" },
      { ...pool, functionName: "balanceOf", args: [who] },
      { ...pool, functionName: "maxWithdraw", args: [who] },
      { ...pool, functionName: "withdrawRequests", args: [who] },
      { address: deployment.usdg, abi: testTokenAbi, functionName: "balanceOf", args: [who] },
    ],
    query: { refetchInterval: 15_000 },
  });
  const loaded = Boolean(reads.data);
  useEffect(() => {
    if (mine && loaded) position.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [mine, loaded]);
  if (reads.isLoading)
    return (
      <Page title="Cover pool">
        <Loading what="the pool" height="md" />
      </Page>
    );
  if (reads.isError || isRpcUnavailable(reads.data?.find((r) => r.error)?.error))
    return (
      <Page title="Cover pool">
        <Unavailable
          error={reads.error ?? reads.data?.find((r) => r.error)?.error}
          onRetry={() => void reads.refetch()}
        />
      </Page>
    );
  const r = reads.data ?? [];
  const n = (i: number) => r[i]?.result as bigint | undefined;
  const [tvl, required, free, cooldown, cover, leverage, agentCap, familyCap] = [
    0, 1, 2, 3, 4, 5, 6, 7,
  ].map(n);
  const utilisation = tvl && cover !== undefined && tvl > 0n ? Number((cover * 10_000n) / tvl) : 0;
  const $ = (v?: bigint) => (v === undefined ? "…" : `$${usd(v, 0)}`);
  return (
    <Page
      eyebrow="For underwriters"
      title={mine ? "Your underwriting" : "Cover pool"}
      intro="Back the pool that pays claims, and earn 80% of every premium."
    >
      <div className="flex flex-wrap items-start gap-x-16 gap-y-14">
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-14">
          <section aria-label="The pool" className="border-t border-line pt-8">
            <p className="eyebrow">Pool assets</p>
            <p className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-2">
              <span className="text-[clamp(56px,7.4vw,112px)] leading-[0.86] font-medium tracking-[-0.065em] tabular-nums">
                {$(tvl)}
              </span>
              <span className="text-[15px] text-muted">
                <Token symbol="tUSDG" />
              </span>
            </p>
            <div className="mt-8">
              <div className="flex h-2 gap-[3px]" aria-hidden>
                <i
                  className="block rounded-[1px] bg-brand-bright"
                  style={{ width: `${Math.min(utilisation / 100, 100)}%` }}
                />
                <i className="block flex-1 rounded-[1px] bg-white/15" />
              </div>
              <div className="mt-2.5 flex justify-between gap-4 font-mono text-xs text-muted">
                <span>Active cover as a share of the pool</span>
                <span className="tabular-nums">{bps(utilisation)}</span>
              </div>
            </div>
            <div className="mt-10 grid gap-x-8 gap-y-6 sm:grid-cols-3">
              {[
                ["Active cover", $(cover), `${bps(utilisation)} of the pool`],
                ["Backing cover", $(required), "locked while cover runs"],
                ["Free capital", $(free), "can be withdrawn"],
              ].map(([label, value, hint]) => (
                <div key={label} className="min-w-0 border-t border-line pt-4">
                  <p className="eyebrow">{label}</p>
                  <p className="num-big mt-2.5 truncate">{value}</p>
                  <p className="mt-2 text-[13px] text-muted">{hint && withTokens(hint)}</p>
                </div>
              ))}
            </div>
          </section>

          <Card
            title="How the pool is protected"
            description="Limits the contracts enforce, as a share of pool assets, so one bad agent or one bad model can't drain the pool."
          >
            <dl className="grid gap-x-8 sm:grid-cols-2">
              {[
                ["Total cover limit", leverage !== undefined ? bps(leverage) : "…"],
                ["One agent at most", agentCap !== undefined ? bps(agentCap) : "…"],
                ["One model family at most", familyCap !== undefined ? bps(familyCap) : "…"],
                ["Withdrawal cooldown", cooldown !== undefined ? duration(cooldown) : "…"],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="flex items-baseline justify-between gap-6 border-t border-line py-3.5 text-[15px]"
                >
                  <dt className="min-w-0 text-soft">{label}</dt>
                  <dd className="shrink-0 text-right font-mono text-sm">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-6 max-w-2xl text-[15px] leading-relaxed text-muted">
              On a claim, the operator's <Term term="bond">bond</Term> pays first; the pool pays the
              rest up to the cover. The <Term term="premium">premium</Term> streams in from each
              covered vault, and 80% of it goes to underwriters.
            </p>
          </Card>
        </div>

        <div
          ref={position}
          className="flex min-w-0 scroll-mt-24 flex-[1_1_340px] flex-col gap-6 xl:sticky xl:top-24"
        >
          {!user ? (
            <section className="border-t border-line pt-6">
              <h2 className="h-section">Your position</h2>
              <p className="mt-3 text-[15px] leading-relaxed text-muted">
                Use Connect wallet at the top of the page to deposit, withdraw or get test{" "}
                <Token symbol="tUSDG" />.
              </p>
            </section>
          ) : (
            <Position
              wallet={n(11)}
              shares={n(8)}
              redeemable={n(9)}
              request={r[10]?.result as readonly [bigint, bigint] | undefined}
            />
          )}
          <p className="text-[13px] text-muted">
            Need test ETH for gas? Use a public faucet:{" "}
            {faucets.map((f, i) => (
              <a key={f} href={f} className={linkClass} target="_blank" rel="noreferrer">
                {i ? ", " : ""}
                {new URL(f).hostname}
              </a>
            ))}
            .
          </p>
        </div>
      </div>
    </Page>
  );
}

function Position(props: {
  wallet?: bigint;
  shares?: bigint;
  redeemable?: bigint;
  request?: readonly [bigint, bigint];
}) {
  const { address: user } = useAccount();
  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const tx = useSend();
  const value = parseUsd(amount);
  const call = (
    functionName: string,
    args: readonly unknown[],
    label: string,
    address = deployment.pool,
    abi: Abi = coverPoolAbi as Abi,
  ) => ({ address, abi, functionName, args, label });
  const [requestedShares, unlockAt] = props.request ?? [0n, 0n];
  // Pool shares carry 12 decimals (6 plus a 6-decimal offset against inflation attacks), so show
  // their value in tUSDG instead of the raw share count.
  const values = useReadContracts({
    contracts: [
      { ...pool, functionName: "convertToAssets", args: [props.shares ?? 0n] },
      { ...pool, functionName: "convertToAssets", args: [requestedShares] },
    ],
  });
  const [stake, requested] = (values.data ?? []).map((v) => v.result as bigint | undefined);
  const over = value !== null && props.wallet !== undefined && value > props.wallet;
  const unlocked = requestedShares > 0n && BigInt(Math.floor(Date.now() / 1000)) >= unlockAt;
  return (
    <section className="border-t border-line pt-6">
      <h2 className="h-section">Your position</h2>
      <dl className="mt-6 grid grid-cols-2 gap-x-6">
        <div className="min-w-0">
          <dt className="eyebrow">Your stake</dt>
          <dd className="num-big mt-2.5 truncate">
            {stake !== undefined ? `$${usd(stake)}` : "…"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="eyebrow">In your wallet</dt>
          <dd className="num-big mt-2.5 truncate text-soft">
            {props.wallet !== undefined ? `$${usd(props.wallet)}` : "…"}
          </dd>
        </div>
      </dl>
      <div className="mt-8 flex gap-7 border-b border-line" role="tablist">
        {(["deposit", "withdraw"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 pb-3 text-[clamp(20px,1.8vw,24px)] font-medium tracking-[-0.035em] capitalize transition ${tab === t ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"}`}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "deposit" ? (
        <div className="mt-6 flex flex-col gap-4">
          <Input
            label="Amount"
            value={amount}
            onChange={setAmount}
            placeholder="10,000"
            inputMode="decimal"
            suffix={<Token symbol="tUSDG" />}
            error={
              amount && !value
                ? "Enter a positive amount with at most 6 decimals."
                : over
                  ? "That's more than you have in your wallet."
                  : null
            }
          />
          <Button
            disabled={!value || over || tx.busy}
            loading={tx.busy}
            onClick={() =>
              value &&
              user &&
              void tx.send([
                call(
                  "approve",
                  [deployment.pool, value],
                  "Approve tUSDG",
                  deployment.usdg,
                  testTokenAbi as Abi,
                ),
                call("deposit", [value, user], "Deposit"),
              ])
            }
          >
            {value ? withTokens(`Deposit ${usd(value)} tUSDG`) : "Deposit"}
          </Button>
          <Button
            kind="ghost"
            disabled={tx.busy}
            onClick={() =>
              void tx.send([
                call(
                  "faucet",
                  [10_000_000_000n],
                  "Get 10,000 tUSDG",
                  deployment.usdg,
                  testTokenAbi as Abi,
                ),
              ])
            }
          >
            {withTokens("Get 10,000 test tUSDG")}
          </Button>
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-4 text-sm">
          <ol className="mb-2 flex flex-col text-muted">
            <li className="grid grid-cols-[2rem_minmax(0,1fr)] border-t border-line py-3 first:border-t-0 first:pt-0">
              <span className="font-mono text-xs leading-5 text-dim">01</span>
              <span>
                <strong className="font-medium text-ink">Request.</strong> Ask to withdraw all your
                shares.
                {requestedShares > 0n && (
                  <span className="mt-1 block text-soft">
                    Requested {requested !== undefined ? `$${usd(requested)}` : "…"}, unlocks{" "}
                    {when(unlockAt)}.
                  </span>
                )}
              </span>
            </li>
            <li className="grid grid-cols-[2rem_minmax(0,1fr)] border-t border-line py-3">
              <span className="font-mono text-xs leading-5 text-dim">02</span>
              <span>
                <strong className="font-medium text-ink">Wait out the cooldown.</strong> Capital
                backing active cover stays locked.
              </span>
            </li>
            <li className="grid grid-cols-[2rem_minmax(0,1fr)] border-t border-line py-3">
              <span className="font-mono text-xs leading-5 text-dim">03</span>
              <span>
                <strong className="font-medium text-ink">Withdraw</strong> what's free:{" "}
                {props.redeemable !== undefined ? `$${usd(props.redeemable)}` : "…"} now.
              </span>
            </li>
          </ol>
          <Button
            kind="secondary"
            disabled={!props.shares || tx.busy}
            onClick={() =>
              props.shares &&
              void tx.send([call("requestRedeem", [props.shares], "Request withdrawal")])
            }
          >
            Request withdrawal of all shares
          </Button>
          <Button
            disabled={!props.redeemable || tx.busy}
            loading={tx.busy}
            onClick={() =>
              user &&
              props.redeemable &&
              void tx.send([call("withdraw", [props.redeemable, user, user], "Withdraw")])
            }
          >
            {props.redeemable
              ? `Withdraw $${usd(props.redeemable)}`
              : unlocked
                ? "Nothing free yet"
                : "Withdraw available"}
          </Button>
        </div>
      )}
      <div className="mt-3">{tx.view}</div>
    </section>
  );
}
