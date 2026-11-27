import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, type SelfAgentRecord } from "../lib/api";
import { byoaApi } from "../lib/byoa-api";
import { faucets, isLocal } from "../config";
import { ago, when } from "../lib/format";
import {
  COVER_TEXT,
  COVER_WITHOUT_TRADES,
  RUNNER_TEXT,
  coverTokens,
  gasNotice,
  scoreLine,
  vaultTradingLine,
  type AgentGas,
  type AgentHealth,
  type Tone,
  type VaultActivity,
} from "../lib/health";
import { messageCode } from "../lib/troubleshooting";
import { useOwnerSession } from "../lib/owner-session";
import { FixLink } from "./problem";
import { AddressLink, Badge, Button, Card, Loading, TxLink, linkClass } from "./ui";

const TEXT_TONE: Record<Tone, string> = {
  safe: "text-safe",
  warn: "text-warn",
  breach: "text-breach",
  neutral: "text-muted",
};

/** The low-gas notice, with how to top up: test ETH to the agent's key from a faucet. */
export function LowGasNotice({ gas }: { gas: AgentGas | null | undefined }) {
  const notice = gasNotice(gas);
  if (!notice) return null;
  return (
    <div role="alert" className="border-l-2 border-warn/60 pl-4 text-sm">
      <p>
        {notice} <FixLink code="low-gas" className="text-xs" />
      </p>
      <p className="mt-1 text-xs text-soft">
        To top up, send test ETH to the agent's key
        {gas?.address ? (
          <>
            {" "}
            (<AddressLink address={gas.address} />)
          </>
        ) : null}
        {!isLocal && faucets[0] ? (
          <>
            , or ask a{" "}
            <a className={linkClass} href={faucets[0]} target="_blank" rel="noreferrer">
              faucet
            </a>{" "}
            for it
          </>
        ) : null}
        . Until it has gas, its trades through the vault fail.
      </p>
    </div>
  );
}

/** Cover held while the agent doesn't trade through its vault: the cover would pay nothing. */
export function CoverWithoutTradesWarning({ show }: { show: boolean | undefined }) {
  if (!show) return null;
  return (
    <p role="alert" className="border-l-2 border-warn/60 pl-4 text-sm">
      {COVER_WITHOUT_TRADES} <FixLink code="cover-without-vault-trades" className="text-xs" />
    </p>
  );
}

/** The vault's trading in a line, with the last transaction. */
export function VaultTrading({ activity }: { activity: VaultActivity | null | undefined }) {
  const line = vaultTradingLine(activity);
  return (
    <p className={`${TEXT_TONE[line.tone]}`}>
      {line.text}
      {activity?.lastTxHash && (
        <>
          {" "}
          <TxLink hash={activity.lastTxHash} />
        </>
      )}
    </p>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="eyebrow border-t border-line py-3">{label}</dt>
      <dd className="min-w-0 border-t border-line py-3 text-[15px]">{children}</dd>
    </>
  );
}

/**
 * The agent's health at the top of its page, for its owner: score and expiry, the runner, trading
 * through the vault, gas, cover, the next re-rating, and each open problem with what to do.
 */
export function HealthPanel({
  agentId,
  record,
}: {
  agentId: string;
  record: SelfAgentRecord | undefined;
}) {
  const owner = useOwnerSession();
  const session = owner.session?.session;
  const health = useQuery({
    queryKey: ["agent-health", agentId, session],
    queryFn: () => byoaApi.agentHealth(agentId, session!),
    enabled: Boolean(session),
    refetchInterval: 60_000,
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
  });
  const reg = record?.registered ? record : undefined;
  if (!session)
    return (
      <Card title="Health">
        <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4">
          <p className="max-w-xl text-[15px] leading-relaxed text-muted">
            Sign in once (no gas) to see your agent's health: its score, runner, vault trading, gas
            and cover, and anything that needs you.
          </p>
          <Button
            size="sm"
            kind="secondary"
            loading={owner.signingIn}
            onClick={() => void owner.signIn()}
          >
            {owner.signingIn ? "Sign in your wallet…" : "Sign in"}
          </Button>
        </div>
      </Card>
    );
  if (health.isPending) return <Loading what="its health" />;
  // An API without the health endpoint yet: what the agent's record already says.
  const h: AgentHealth | undefined = health.data;
  const vault = h?.vault?.activity ?? reg?.vaultActivity ?? null;
  const gas = h?.gas ?? reg?.agentGas ?? null;
  const coverWithout = h?.coverWithoutVaultTrades ?? reg?.coverWithoutVaultTrades;
  if (!h && !vault && !gas && !coverWithout) return null;
  const score = h ? scoreLine(h.score) : undefined;
  const problems = h?.problems ?? [];
  const serious = problems.filter((p) => p.severity !== "warning").length;
  return (
    <Card
      title="Health"
      actions={
        problems.length ? (
          <Badge tone={serious ? "breach" : "warn"} dot>
            {problems.length} to look at
          </Badge>
        ) : h ? (
          <Badge tone="safe" dot>
            All good
          </Badge>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-5 text-sm">
        {problems.length > 0 && (
          <ul className="flex flex-col gap-4" aria-label="Problems">
            {problems.map((p) => (
              <li
                key={`${p.code}:${p.message}`}
                className={`border-l-2 pl-4 ${p.severity === "warning" ? "border-warn/60" : "border-breach/70"}`}
              >
                <span className="font-medium">{p.message}</span>{" "}
                <FixLink code={messageCode(p)} className="text-xs" />
                {p.action && <span className="mt-0.5 block text-soft">{p.action}</span>}
              </li>
            ))}
          </ul>
        )}
        <CoverWithoutTradesWarning show={coverWithout} />
        <LowGasNotice
          gas={
            gas && !gas.address && h?.vault?.agentKey ? { ...gas, address: h.vault.agentKey } : gas
          }
        />
        <dl className="grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-6 border-b border-line sm:grid-cols-[12rem_minmax(0,1fr)]">
          {score && (
            <Row label="Score">
              <span className={TEXT_TONE[score.tone]}>{score.text}</span>
            </Row>
          )}
          {h && (
            <Row label="Connection">
              <span className={TEXT_TONE[RUNNER_TEXT[h.runner.status].tone]}>
                {RUNNER_TEXT[h.runner.status].label}
              </span>
              {h.runner.status === "offline" && h.runner.lastSeenAt && (
                <span className="text-muted">, last seen {ago(h.runner.lastSeenAt)}</span>
              )}
            </Row>
          )}
          <Row label="Vault trading">
            <VaultTrading activity={vault} />
          </Row>
          {gas && (
            <Row label="Gas">
              <span className={gas.low ? "text-warn" : "text-muted"}>
                {gas.low ? "Low" : "Enough"}
                {gas.estimatedTradesLeft != null &&
                  `, about ${gas.estimatedTradesLeft} trade${gas.estimatedTradesLeft === 1 ? "" : "s"} left`}
              </span>
            </Row>
          )}
          {h?.cover && (
            <Row label="Cover">
              <span className={TEXT_TONE[COVER_TEXT[h.cover.status].tone]}>
                {COVER_TEXT[h.cover.status].label}
              </span>
              {coverTokens(h.cover.amount) && h.cover.status !== "none" && (
                <span className="text-muted">, {coverTokens(h.cover.amount)} tUSDG</span>
              )}
            </Row>
          )}
          {(h?.nextRatingAt || h?.nextRating?.reason) && (
            <Row label="Next re-rating">
              <span className="text-muted">
                {h.nextRatingAt
                  ? when(Math.floor(Date.parse(h.nextRatingAt) / 1000))
                  : h.nextRating?.status === "queued" || h.nextRating?.status === "running"
                    ? `A rating is ${h.nextRating.status}`
                    : h.nextRating?.reason}
              </span>
            </Row>
          )}
        </dl>
      </div>
    </Card>
  );
}
