import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { useAccount, usePublicClient } from "wagmi";
import { gateAnchorAbi } from "@bondedhq/shared";
import type { Hex } from "viem";
import { deployment, explorerUrl } from "../config";
import { ago, short, txUrl } from "../lib/format";
import { useOwnerSession } from "../lib/owner-session";
import {
  gateApi,
  verifyDecision,
  type AnchorPost,
  type ChainRootQuery,
  type GateAccount,
  type GateDecision,
  type Verification,
  type VerifyStep,
} from "../lib/gate";
import { CopyButton } from "../components/copy";
import { ConnectButton } from "../components/wallet";
import {
  Badge,
  Button,
  Card,
  Details,
  EmptyState,
  ErrorText,
  Loading,
  Page,
  Table,
  Unavailable,
  linkClass,
} from "../components/ui";

/**
 * Reads a day's root from the app's own GateAnchor (`gateAnchor` in the deployment file): the
 * zero hash when none is posted, null when it can't be read here.
 */
export type ChainRoot = (at: ChainRootQuery) => Promise<Hex | null>;

const dollars = (usd: number) =>
  `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A hash in short form, with a button to copy it whole. */
function HashText({ hash }: { hash: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-mono text-[0.92em]" title={hash}>
        {short(hash, 6)}
      </span>
      <CopyButton text={hash} variant="icon" />
    </span>
  );
}

/** Where a hash is on chain: its transaction, "Posted", or "Not yet". */
function OnChain({ posted }: { posted: AnchorPost | null }) {
  if (!posted) return <span className="text-muted">Not yet</span>;
  if (posted.txHash && posted.chainId === deployment.chainId && explorerUrl)
    return (
      <a className={linkClass} href={txUrl(posted.txHash)} target="_blank" rel="noreferrer">
        Posted
      </a>
    );
  return <Badge tone="safe">Posted</Badge>;
}

const RESULT: Record<GateDecision["result"], { label: string; tone: "safe" | "breach" | "warn" }> =
  {
    allowed: { label: "Allowed", tone: "safe" },
    blocked: { label: "Blocked", tone: "breach" },
    refused: { label: "Refused", tone: "warn" },
  };

const STEPS: { key: keyof Verification; label: string }[] = [
  { key: "signature", label: "Bonded's signature" },
  { key: "input", label: "Input hash" },
  { key: "rules", label: "Rules, run again" },
  { key: "log", label: "Daily log root" },
];

function StepBadge({ step }: { step: VerifyStep }) {
  if (step.ok === true) return <Badge tone="safe">Passed</Badge>;
  if (step.ok === false) return <Badge tone="breach">Failed</Badge>;
  return <Badge>Not checked</Badge>;
}

/** Check one decision in the browser, and show which checks passed. */
export function VerifyPanel({
  decision,
  session,
  accountId,
  chainRoot,
}: {
  decision: GateDecision;
  session: string;
  accountId: string;
  chainRoot?: ChainRoot | undefined;
}) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Verification>();
  const run = async () => {
    setRunning(true);
    try {
      setResult(
        await verifyDecision(decision, {
          receiptKey: gateApi.receiptKey,
          proof: () => gateApi.proof(session, accountId, decision.id),
          ...(chainRoot ? { chainRoot } : {}),
        }),
      );
    } finally {
      setRunning(false);
    }
  };
  const failed = result ? STEPS.filter((s) => result[s.key].ok === false).length : 0;
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button size="sm" kind="secondary" loading={running} onClick={() => void run()}>
          {result ? "Verify again" : "Verify"}
        </Button>
      </div>
      {result && (
        <div
          aria-label="Verification"
          className="flex flex-col gap-2.5 rounded-2xl border border-line p-4"
        >
          <p className="text-sm font-semibold" role="status">
            {failed === 0
              ? "No check failed."
              : `${failed} ${failed === 1 ? "check" : "checks"} failed.`}
          </p>
          <ul className="flex flex-col gap-2.5">
            {STEPS.map((s) => (
              <li key={s.key} className="flex flex-wrap items-start gap-x-3 gap-y-1 text-sm">
                <span className="w-40 shrink-0 text-muted">{s.label}</span>
                <StepBadge step={result[s.key]} />
                <span className="min-w-0 flex-1 text-soft">{result[s.key].detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Rules({ account, session }: { account: GateAccount; session: string }) {
  const vendors = useQuery({
    queryKey: ["gate-vendors", session, account.id],
    queryFn: () => gateApi.vendors(session, account.id),
    retry: false,
  });
  return (
    <Card
      title="Rules"
      description="What every payment is checked against."
      actions={
        <div className="flex gap-2">
          <Badge tone={account.mode === "enforce" ? "brand" : "warn"}>
            {account.mode === "enforce" ? "Enforce" : "Monitor"}
          </Badge>
          {account.frozen && <Badge tone="breach">Frozen</Badge>}
        </div>
      }
    >
      <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm">
        {account.rules.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <h3 className="eyebrow mt-6 mb-2">Vendors</h3>
      {vendors.error ? (
        <ErrorText error={vendors.error} />
      ) : !vendors.data ? (
        <Loading what="vendors" />
      ) : !vendors.data.items.length ? (
        <p className="text-sm text-muted">
          No vendors yet, so every payment is to an unknown payee.
        </p>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Vendor</th>
              <th>Verified account</th>
            </tr>
          </thead>
          <tbody>
            {vendors.data.items.map((v) => (
              <tr key={v.id}>
                <td>
                  {v.name} <span className="text-muted">({v.id})</span>
                </td>
                <td className="font-mono text-[0.92em]">{v.account}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Details>
        <dt>Version</dt>
        <dd>{account.mandate.version}</dd>
        <dt>Hash</dt>
        <dd>
          <HashText hash={account.mandate.hash} />
        </dd>
      </Details>
    </Card>
  );
}

function History({ account, session }: { account: GateAccount; session: string }) {
  const versions = useQuery({
    queryKey: ["gate-mandates", session, account.id, account.mandate.version],
    queryFn: () => gateApi.mandates(session, account.id),
    retry: false,
  });
  return (
    <Card title="Changes" description="Each version of the rules, with its hash.">
      {versions.error ? (
        <Unavailable error={versions.error} onRetry={() => void versions.refetch()} />
      ) : !versions.data ? (
        <Loading what="the history" />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Version</th>
              <th>When</th>
              <th>Hash</th>
              <th>On chain</th>
            </tr>
          </thead>
          <tbody>
            {versions.data.items.map((v) => (
              <tr key={v.version}>
                <td>{v.version}</td>
                <td className="whitespace-nowrap text-muted">{ago(v.createdAt)}</td>
                <td>
                  <HashText hash={v.hash} />
                </td>
                <td>
                  <OnChain posted={v.posted} />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function Decisions({
  account,
  session,
  chainRoot,
}: {
  account: GateAccount;
  session: string;
  chainRoot?: ChainRoot | undefined;
}) {
  const first = useQuery({
    queryKey: ["gate-decisions", session, account.id],
    queryFn: () => gateApi.decisions(session, account.id),
    retry: false,
  });
  const [older, setOlder] = useState<{ items: GateDecision[]; next: string | null }>();
  const [loading, setLoading] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);
  const items = [...(first.data?.items ?? []), ...(older?.items ?? [])];
  const next = older ? older.next : (first.data?.next ?? null);
  const loadMore = async () => {
    if (!next) return;
    setLoading(true);
    setMoreError(null);
    try {
      const page = await gateApi.decisions(session, account.id, next);
      setOlder((o) => ({ items: [...(o?.items ?? []), ...page.items], next: page.next }));
    } catch (e) {
      setMoreError(e);
    } finally {
      setLoading(false);
    }
  };
  return (
    <Card
      title="Decisions"
      description="Every check, newest first, with its signed receipt. Verify checks it here, in your browser."
    >
      {first.error ? (
        <Unavailable error={first.error} onRetry={() => void first.refetch()} />
      ) : !first.data ? (
        <Loading what="decisions" />
      ) : !items.length ? (
        <EmptyState title="No checks yet">Your agent's checks show here.</EmptyState>
      ) : (
        <ul className="flex flex-col divide-y divide-line" aria-label="Decisions">
          {items.map((d) => (
            <li key={d.id} className="flex flex-col gap-2 py-4 text-sm">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Badge tone={RESULT[d.result].tone}>{RESULT[d.result].label}</Badge>
                <span className="font-semibold">
                  {d.kind === "bank_change"
                    ? `Bank change for ${d.vendorId}`
                    : `${d.kind === "refund" ? "Refund" : "Payment"} of ${dollars(d.amountUsd)}`}
                </span>
                <span className="font-mono text-[0.92em] text-muted">{d.payee}</span>
                {d.reference && <span className="text-muted">{d.reference}</span>}
                <time dateTime={d.createdAt} className="ml-auto text-xs text-muted">
                  {ago(d.createdAt)}
                </time>
              </div>
              <p className="text-soft">{d.message}</p>
              <VerifyPanel
                decision={d}
                session={session}
                accountId={account.id}
                chainRoot={chainRoot}
              />
            </li>
          ))}
        </ul>
      )}
      {next && (
        <div className="mt-4 flex flex-col items-start gap-2">
          <Button size="sm" kind="secondary" loading={loading} onClick={() => void loadMore()}>
            Load more
          </Button>
          <ErrorText error={moreError} />
        </div>
      )}
    </Card>
  );
}

/** The payment gate's rules page: the owner's mandate, its history and every decision. */
export function Gate() {
  const { isConnected } = useAccount();
  const owner = useOwnerSession();
  const session = owner.session?.session;
  const client = usePublicClient();
  const [params, setParams] = useSearchParams();
  const accounts = useQuery({
    queryKey: ["gate-accounts", session],
    queryFn: () => gateApi.accounts(session!),
    enabled: Boolean(session),
    retry: false,
  });
  const list = accounts.data?.items ?? [];
  const selected = list.find((a) => a.id === params.get("account")) ?? list[0];
  // The root posted on chain, read straight from the app's own GateAnchor: never from an address
  // the API names. Not read when the API says it was posted somewhere else.
  const anchor = deployment.gateAnchor;
  const chainRoot: ChainRoot | undefined =
    client && anchor
      ? async ({ accountKey, dayNumber, posted }) =>
          posted &&
          (posted.chainId !== deployment.chainId ||
            posted.contract.toLowerCase() !== anchor.toLowerCase())
            ? null
            : (
                await client.readContract({
                  address: anchor,
                  abi: gateAnchorAbi,
                  functionName: "logRootOf",
                  args: [accountKey, dayNumber],
                })
              ).hash
      : undefined;
  return (
    <Page
      title="Payment gate"
      intro="The rules that guard your agents' payments, every decision, and a way to check each one."
    >
      {!isConnected ? (
        <EmptyState title="Connect your wallet" action={<ConnectButton />}>
          The gate accounts your wallet owns show here.
        </EmptyState>
      ) : !session ? (
        <EmptyState
          title="Sign in to see them"
          action={
            <div className="flex flex-col items-center gap-2">
              <Button loading={owner.signingIn} onClick={() => void owner.signIn()}>
                {owner.signingIn ? "Sign in your wallet…" : "Sign in"}
              </Button>
              <ErrorText error={owner.error} />
            </div>
          }
        >
          One signature, no gas.
        </EmptyState>
      ) : accounts.isPending ? (
        <Card>
          <Loading what="your gate accounts" />
        </Card>
      ) : accounts.error ? (
        <Unavailable error={accounts.error} onRetry={() => void accounts.refetch()} />
      ) : !selected ? (
        <EmptyState title="No gate accounts yet">
          Make one with the API (POST /gate/accounts), then come back.
        </EmptyState>
      ) : (
        <>
          {list.length > 1 && (
            <nav aria-label="Gate accounts" className="flex flex-wrap gap-2">
              {list.map((a) => (
                <Button
                  key={a.id}
                  size="sm"
                  kind={a.id === selected.id ? "primary" : "secondary"}
                  onClick={() => setParams({ account: a.id }, { replace: true })}
                >
                  {a.name || short(a.id, 6)}
                </Button>
              ))}
            </nav>
          )}
          <div className="grid gap-6 xl:grid-cols-2">
            <Rules account={selected} session={session} />
            <History account={selected} session={session} />
          </div>
          <Decisions account={selected} session={session} chainRoot={chainRoot} />
        </>
      )}
    </Page>
  );
}
