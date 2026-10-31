import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useSignMessage } from "wagmi";
import { REMOTE_KIND, SELF_SERVE_KIND_LABELS, type SelfServeKind } from "@bondedhq/shared";
import { deployment } from "../config";
import { api } from "../lib/api";
import { recallAgent } from "../lib/onboarding";
import { registerForRatings, requestRating } from "../lib/self-serve";
import { when } from "../lib/format";
import { useRatingRun } from "../lib/rating-run";
import { Badge, Button, Card, ErrorText, linkClass } from "./ui";
import { ConnectAgent } from "./connect-agent";

/**
 * The agent owner's controls on its profile: register it for self-serve ratings if needed, ask
 * for a rating, and follow the rating as it runs. Shown only to the agent's owner.
 */
export function OwnerTools({
  agentId,
  owner,
  scoreExpired = false,
}: {
  agentId: string;
  owner?: string;
  /** The agent has a score and it has expired. */
  scoreExpired?: boolean;
}) {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [runId, setRunId] = useState<string>();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const isOwner = Boolean(address && owner && address.toLowerCase() === owner.toLowerCase());
  const self = useQuery({
    queryKey: ["self-agent", agentId],
    queryFn: () => api.selfAgent(agentId),
  });
  const run = useRatingRun(runId);
  // Anyone can see an operator-run agent's runner and declared code; only its owner acts on it.
  if (!isOwner)
    return self.data?.registered && self.data.kind === REMOTE_KIND ? (
      <ConnectAgent
        key={`${deployment.chainId}:${agentId}`}
        agentId={agentId}
        record={self.data}
        scoreExpired={scoreExpired}
        readOnly
        {...(owner ? { registryOwner: owner } : {})}
      />
    ) : null;
  const remembered = recallAgent(deployment.chainId, agentId);
  const record = self.data;

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  const register = () =>
    act(async () => {
      if (!remembered) return;
      await registerForRatings(signMessageAsync, agentId, remembered);
      await self.refetch();
    });
  const rate = () =>
    act(async () => {
      const { runId: id } = await requestRating(signMessageAsync, agentId);
      setRunId(id);
      await self.refetch();
    });

  // The owner's own agent has its own panel: runner token, runner, rating.
  if (record?.registered && record.kind === REMOTE_KIND)
    return (
      <ConnectAgent
        key={`${deployment.chainId}:${agentId}`}
        agentId={agentId}
        record={record}
        scoreExpired={scoreExpired}
        onRated={() => void self.refetch()}
        {...(owner ? { registryOwner: owner } : {})}
      />
    );
  const waiting =
    record?.registered && record.nextRatingAt && new Date(record.nextRatingAt) > new Date();
  return (
    <Card title="Your agent">
      {self.isPending ? (
        <p className="text-sm text-muted">Checking its registration…</p>
      ) : record?.registered && record.source === "operator" ? (
        <p className="text-sm text-muted">This agent is rated by Bonded's operator.</p>
      ) : record?.registered ? (
        <div className="flex flex-col gap-3 text-sm">
          <p>
            Rated as:{" "}
            <span className="font-medium">
              {SELF_SERVE_KIND_LABELS[record.kind as SelfServeKind] ?? record.kind}
            </span>
            {record.sentinel && (
              <>
                , with the <span className="font-medium">live guard</span> on
              </>
            )}
            , against this agent's vault and mandate. A rating runs every attack in the library five
            times in a sandbox, then posts the signed score on chain. It takes a few minutes.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={busy || Boolean(waiting)} onClick={rate}>
              {busy ? "Sign in your wallet…" : "Rate this agent"}
            </Button>
            {waiting && (
              <span className="text-xs text-muted">
                One rating an hour per agent; next from{" "}
                {when(Date.parse(record.nextRatingAt!) / 1000)}.
              </span>
            )}
          </div>
          {runId && (
            <p>
              Rating{" "}
              <Badge
                tone={
                  run.data?.status === "failed"
                    ? "breach"
                    : run.data?.status === "done"
                      ? "safe"
                      : "neutral"
                }
              >
                {run.data?.status ?? "queued"}
              </Badge>{" "}
              {run.data?.status === "done" ? (
                "The new score is above."
              ) : run.data?.status === "failed" ? (
                (run.data.error ?? "The rating failed.")
              ) : (
                <>
                  Watch the attacks live in the{" "}
                  <Link to="/arena" className={linkClass}>
                    live attacks
                  </Link>
                  .
                </>
              )}
            </p>
          )}
        </div>
      ) : remembered ? (
        <div className="flex flex-col gap-3 text-sm">
          <p>
            This agent isn't registered for ratings yet. Register it as{" "}
            <span className="font-medium">
              {remembered.kind === REMOTE_KIND
                ? "your own agent"
                : SELF_SERVE_KIND_LABELS[remembered.kind]}
            </span>
            {remembered.sentinel ? ", with the live guard on" : ""}, with the mandate of vault{" "}
            <span className="font-mono">{remembered.vault}</span>.
          </p>
          <div>
            <Button disabled={busy} onClick={register}>
              {busy ? "Sign in your wallet…" : "Register for ratings"}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted">
          This agent isn't registered for ratings, and this browser doesn't have its mandate. Agents
          onboarded from{" "}
          <Link to="/agents/new" className={linkClass}>
            Onboard an agent
          </Link>{" "}
          are registered automatically.
        </p>
      )}
      <ErrorText error={error} />
    </Card>
  );
}
