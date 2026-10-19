import { REMOTE_CONTROLS, Sandbox, episodeOutcome, freshHeldOut, rateAgent } from "@bonded/arena";
import { json, previewKey, type Database, type PreviewOutcome } from "@bonded/db";
import type { AgentMode, AttackSpec, ChatClient } from "@bondedhq/shared";
import type { ServiceChain } from "@bonded/keeper";
import type { Hex } from "viem";
import { ratingLibrary } from "./library.js";
import {
  RatingRefused,
  bondedUrlFailure,
  forkBudgetExhausted,
  ratingFailure,
  remoteAgentFor,
  type RemoteAgentFactory,
} from "./remote-agent.js";
import { DbHeldOutLedger } from "./runners.js";
import {
  DEFAULT_REMOTE_POLICY,
  previewRatingPlan,
  type RemoteRatingPolicy,
} from "./remote-policy.js";
import { SECRET_KEY_MISSING, agentUrlContext, type SecretBox } from "./secrets.js";
import type { AgentConnection } from "./connections.js";
import type { Notifier } from "./notifications.js";
import { PREVIEW_LABEL } from "./previews.js";

/**
 * The preview lane (bring your own agent, round 2): a preview is rated like an official rating of
 * an operator-run agent (the published library once, a held-out set made for it alone, 6 controls,
 * the hosted judging rules: exercised trials only, the liveness bars, untested classes priced as
 * such; 90-second episodes, 40 s an episode up to 45 minutes) but it is never attested or posted
 * and can't be used for a quote. Previews take turns with official remote ratings under the same
 * lock, only when none of those is waiting, and one at a time.
 */

export interface PreviewWorkerOptions {
  remote?: RemoteAgentFactory;
  heldOut?: { perClass?: number; llm?: { client: ChatClient; model: string; maxUsd: number } };
  policy?: RemoteRatingPolicy;
  secrets?: SecretBox;
  notifier?: Notifier;
  /** Narrows the attack library (tests only). */
  selectAttacks?: (attacks: AttackSpec[]) => AttackSpec[];
  /** Overrides the time budget (tests only). */
  budgetMs?: number;
  onError?: (error: unknown) => void;
}

/** The remote lane's lock (worker.ts): one remote rating or preview at a time per chain. */
const REMOTE_LANE_LOCK = 7008;

export async function workPreviewOne(
  db: Database,
  chain: ServiceChain,
  rpcUrl: string,
  options: PreviewWorkerOptions = {},
): Promise<boolean> {
  const chainId = chain.deployment.chainId;
  const lock = await db.pool.connect();
  const locked = (
    await lock.query("SELECT pg_try_advisory_lock($2,$1) AS locked", [chainId, REMOTE_LANE_LOCK])
  ).rows[0].locked;
  if (!locked) {
    lock.release();
    return false;
  }
  try {
    const job = await db.takePreviewJob(chainId);
    if (!job) return false;
    await runPreview(db, chain, rpcUrl, job, options);
    return true;
  } finally {
    await lock.query("SELECT pg_advisory_unlock($2,$1)", [chainId, REMOTE_LANE_LOCK]);
    lock.release();
  }
}

async function runPreview(
  db: Database,
  chain: ServiceChain,
  rpcUrl: string,
  job: { id: string; token: string },
  options: PreviewWorkerOptions,
) {
  const policy = options.policy ?? DEFAULT_REMOTE_POLICY;
  let leaseError: unknown;
  const heartbeat = setInterval(() => {
    void db.renew(job).catch((e) => {
      leaseError = e;
    });
  }, 15000);
  const check = async () => {
    if (leaseError) throw leaseError;
    await db.renew(job);
  };
  const row = (
    await db.pool.query(
      `SELECT r.code_hash,r.code_source,v.id AS preview_id,v.owner,v.mode,v.connection
       FROM ratings r JOIN previews v ON v.id=r.preview_id WHERE r.id=$1`,
      [job.id],
    )
  ).rows[0] as {
    code_hash: string | null;
    code_source: string | null;
    preview_id: string;
    owner: string;
    mode: AgentMode;
    connection: "runner" | "url";
  };
  const key = previewKey(row.preview_id);
  let budgetSpentIn: string | undefined;
  let outcome: PreviewOutcome;
  let score: { score: number; securityScore?: number; tier: string } | undefined;
  try {
    // Setting up (the sandbox, the held-out set): "starting", then "running".
    await db.markStarting(job);
    const reach = await reachFor(db, key, row.connection, options.secrets);
    if (row.code_source && row.code_source !== "declared") {
      const now = await db.currentConnection(key, row.connection);
      if (now.code?.hash.toLowerCase() !== String(row.code_hash).toLowerCase())
        throw new RatingRefused(
          "the agent now reports different code than when this preview was queued; run a connection check and rate again",
          true,
        );
    }
    const library = await ratingLibrary(db, chain.deployment.chainId);
    // Like any operator-run agent: the published library and a held-out set made for it alone.
    const selected = options.selectAttacks?.(library.attacks) ?? library.attacks;
    const attacks = selected.filter((a) => !library.unpublished.has(a.id));
    const sandbox = await Sandbox.start({ forkUrl: rpcUrl, forkDeployment: chain.deployment });
    try {
      const agent = remoteAgentFor(
        options.remote,
        {
          agentKey: key,
          chainId: chain.deployment.chainId,
          agentId: key,
          mode: row.mode,
          codeHash: (row.code_hash ?? `0x${"0".repeat(64)}`) as Hex,
          connection: reach,
        },
        sandbox,
      );
      const perClass = options.heldOut?.perClass ?? policy.heldOutPerClass;
      const fresh =
        perClass > 0
          ? await freshHeldOut({
              library: attacks,
              perClass,
              sandbox,
              ledger: new DbHeldOutLedger(db),
              ...(options.heldOut?.llm ? { llm: options.heldOut.llm } : {}),
            })
          : undefined;
      await check();
      await db.markRunning(job);
      const started = Date.now();
      const budget =
        options.budgetMs ??
        previewRatingPlan(policy, {
          publishedAttacks: attacks.length,
          heldOut: fresh?.attacks.length ?? 0,
        }).budgetMs;
      let agentMs = 0;
      const result = await rateAgent(sandbox, {
        agent,
        attacks: [...attacks, ...(fresh?.attacks ?? [])],
        unpublished: new Set((fresh?.attacks ?? []).map((a) => a.id)),
        ...(fresh ? { heldOut: fresh.heldOut } : {}),
        // Its held-out set is its own (each payload used once): the owner's report shows the text.
        revealUnpublished: true,
        ...(row.code_hash ? { codeHash: row.code_hash as Hex } : {}),
        repeats: 1,
        controls: REMOTE_CONTROLS,
        exercise: "exposed",
        attackLiveness: "refuse",
        // Before the first episode: the total, so progress shows 0 of N at once.
        onProgress: async (p) => {
          if (p.done === 0)
            await db.setRatingProgress(job, {
              done: 0,
              total: p.total,
              startedAt: new Date(started),
            });
        },
        onEpisode: async (episode, index, total) => {
          await check();
          await db.setRatingProgress(job, { done: index + 1, total, startedAt: new Date(started) });
          agentMs +=
            (episode.agentSummary as { remote?: { durationMs?: number } }).remote?.durationMs ?? 0;
          const elapsed = Date.now() - started;
          // The same stops as an official rating: the first failed episode, the time budget.
          if (forkBudgetExhausted(episode)) {
            budgetSpentIn = `episode ${index + 1} of ${total}`;
            throw new RatingRefused(
              `stopped: the agent used up its share of fork requests in ${budgetSpentIn}`,
              true,
              { caused: true },
            );
          }
          if (bondedUrlFailure(episode))
            throw new RatingRefused(
              `stopped: Bonded couldn't reach the agent's URL in episode ${index + 1} of ${total}, not because of the agent; it will be retried`,
              false,
            );
          if (episodeOutcome(episode) === "agent_error") {
            const report = (episode.agentSummary.finalMessage ?? "").slice(0, 500);
            throw new RatingRefused(
              `stopped: the agent failed in episode ${index + 1} of ${total}`,
              true,
              report ? { caused: true, report } : { caused: true },
            );
          }
          if (elapsed > budget)
            throw agentMs > elapsed / 2
              ? new RatingRefused(
                  `stopped: the preview ran past its ${Math.round(budget / 60_000)}-minute budget after ${index + 1} of ${total} episodes; the agent took ${Math.round((100 * agentMs) / elapsed)}% of the time`,
                  true,
                  { caused: true },
                )
              : new RatingRefused(
                  `stopped: the preview ran past its time budget after ${index + 1} of ${total} episodes, not because of the agent; it will be retried`,
                  false,
                );
        },
      });
      // Never attested or posted: the report is kept, labelled, for its owner alone.
      const report = {
        ...result.report,
        preview: {
          label: PREVIEW_LABEL,
          attested: false,
          insurable: false,
          codeHash: row.code_hash,
          codeSource: row.code_source,
        },
      };
      await db.withLease(job, (c) =>
        c.query("UPDATE ratings SET report=$2,report_json=$3 WHERE id=$1", [
          job.id,
          json(report),
          `${JSON.stringify(report, null, 2)}\n`,
        ]),
      );
      score = {
        score: result.report.scoring.score,
        securityScore: result.report.susceptibility?.grade,
        tier: String(result.report.scoring.tier),
      };
      if (result.report.stoppedEarly || result.report.episodes.agentErrors)
        throw new RatingRefused("stopped: the agent failed an episode", true, { caused: true });
      outcome = result.refused
        ? { status: "refused", error: `not attested: ${result.refused}` }
        : { status: "done" };
    } finally {
      await sandbox.stop();
    }
  } catch (error) {
    options.onError?.(error);
    const failure = ratingFailure(error, budgetSpentIn);
    outcome = {
      status: "failed",
      error: failure.reason,
      final: failure.final ?? false,
      ...(failure.agentCaused ? { agentCaused: true } : {}),
      ...(failure.agentReport ? { agentReport: failure.agentReport } : {}),
    };
  } finally {
    clearInterval(heartbeat);
  }
  const status = await db.finishPreview(job, outcome);
  if (status !== "queued")
    options.notifier?.notify(row.owner, {
      type:
        outcome.status === "done"
          ? "rating_finished"
          : outcome.status === "refused"
            ? "rating_refused"
            : "rating_failed",
      ratingId: job.id,
      previewId: row.preview_id,
      chainId: chain.deployment.chainId,
      status: outcome.status,
      ...(outcome.status === "done" && score ? score : {}),
      ...(outcome.error ? { reason: outcome.error } : {}),
      label: PREVIEW_LABEL,
      at: new Date().toISOString(),
    });
}

/** How to reach a preview's agent now, or a refusal that says why it can't be. */
async function reachFor(
  db: Database,
  key: string,
  connection: "runner" | "url",
  secrets: SecretBox | undefined,
): Promise<AgentConnection> {
  if (connection === "runner") {
    if (!(await db.runnerIsConnected(key)))
      throw new RatingRefused(
        "the preview's runner is not connected; start it and rate again",
        true,
      );
    return { kind: "runner", key };
  }
  const live = await db.agentUrl(key);
  if (!live?.verifiedAt)
    throw new RatingRefused(
      "the preview's Agent URL isn't verified; verify it and rate again",
      true,
    );
  if (!secrets) throw new RatingRefused(SECRET_KEY_MISSING, true);
  try {
    return {
      kind: "url",
      url: live.url,
      secret: secrets.decrypt(live.ciphertext, agentUrlContext(live.id)),
      registration: key,
    };
  } catch {
    throw new RatingRefused("the Agent URL's secret can't be used; set the Agent URL again", true);
  }
}
