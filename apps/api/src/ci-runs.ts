import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { CiRunRecord, Database } from "@bonded/db";
import { Refused, handle } from "./refused.js";
import { RateLimiter } from "./rate-limit.js";
import { PREVIEW_LABEL, type PreviewRatingFlow } from "./previews.js";
import type { DataCaller, DataKeys } from "./data-keys.js";

/**
 * Testing in CI (apps/api/DATA-API.md): a builder's CI rates their agent on every deploy and
 * fails the build when its score drops under a minimum. A run is the preview rating of the
 * builder's own preview (an Agent URL set up and verified once on the Test your agent page),
 * started with a data API key: the same flow as the page's **Start preview rating** (previews.ts),
 * so the same connection check, the same preview caps and the same costs, and nothing beyond them.
 * Pass or fail is the rating's Security score against the minimum, decided here, never by a model.
 *
 * A run moves on when it is read: from its connection check to its rating, and from its rating to
 * passed or failed. CI polls `GET /ci/runs/:id` until `done`. The report is private: only keys of
 * the wallet that owns the preview can read it.
 */

export interface CiRunOptions {
  keys: DataKeys;
  db: Database;
  now: () => number;
  previewRating: PreviewRatingFlow;
  /** Runs one key may start per hour (default 20). The preview caps apply on top. */
  createsPerHour: number;
  /** Reads per key per 10 minutes (default 1,200). */
  readsPerTenMinutes: number;
}

const score = z.number().int().min(0).max(100);
const runInput = z.strictObject({
  /** The preview to rate: the wallet's own, connected by a verified Agent URL. */
  previewId: z.uuid(),
  /** The lowest Security score (0 to 100) that passes. */
  minScore: score,
  /** Optionally, the lowest Task score that passes too. */
  minTaskScore: score.optional(),
  /** What CI calls this run, e.g. a commit or a build number. */
  label: z
    .string()
    .trim()
    .max(120)
    .regex(/^[^\p{Cc}]*$/u)
    .optional(),
});
const listQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  before: z.uuid().optional(),
});

/** A run as CI reads it. `result` is "pass" or "fail" once `done`, and null before. */
export function ciRunView(run: CiRunRecord) {
  const done = run.status !== "checking" && run.status !== "rating";
  return {
    runId: run.id,
    status: run.status,
    done,
    result: run.status === "passed" ? "pass" : run.status === "failed" ? "fail" : null,
    minScore: run.minScore,
    minTaskScore: run.minTaskScore,
    score: run.score,
    taskScore: run.taskScore,
    reason: run.reason,
    label: run.label,
    previewId: run.previewId,
    checkId: run.checkId,
    ratingId: run.ratingId,
    statusUrl: `/ci/runs/${run.id}`,
    reportUrl: `/ci/runs/${run.id}/report`,
    preview: PREVIEW_LABEL,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

/** Whether a finished rating passes: its Security score, and its Task score when one is asked for. */
export function ciVerdict(
  run: Pick<CiRunRecord, "minScore" | "minTaskScore">,
  scores: { score: number; taskScore: number | null },
): { passed: boolean; reason: string } {
  if (scores.score < run.minScore)
    return {
      passed: false,
      reason: `Security score ${scores.score}, under the minimum of ${run.minScore}.`,
    };
  if (run.minTaskScore !== null) {
    if (scores.taskScore === null)
      return {
        passed: false,
        reason: `The Task score wasn't measured, and a minimum of ${run.minTaskScore} was asked for.`,
      };
    if (scores.taskScore < run.minTaskScore)
      return {
        passed: false,
        reason: `Task score ${scores.taskScore}, under the minimum of ${run.minTaskScore}.`,
      };
  }
  return {
    passed: true,
    reason: `Security score ${scores.score}, at or over the minimum of ${run.minScore}.`,
  };
}

export function ciRunRoutes(
  app: Hono,
  options: Partial<CiRunOptions> & Pick<CiRunOptions, "keys" | "db" | "now" | "previewRating">,
) {
  const { keys, db, now, previewRating } = options;
  const store = keys.store;
  const creates = new RateLimiter({
    perClient: options.createsPerHour ?? 20,
    total: 10_000,
    windowMs: 3_600_000,
    now,
  });
  const reads = new RateLimiter({
    perClient: options.readsPerTenMinutes ?? 1200,
    total: 100_000,
    windowMs: 600_000,
    now,
  });
  const reader = async (c: Context) => {
    const caller = await keys.required(c);
    if (!reads.allow(caller.keyId))
      throw new Refused(429, "Too many requests. Try again in a few minutes.");
    await keys.count(caller, "ci");
    return caller;
  };
  /** The caller's wallet's run named in the path, or "not found" for anyone else. */
  const ownRun = async (c: Context, caller: DataCaller) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    const run = id.success ? await store.ciRun(id.data) : undefined;
    if (!run || run.owner !== caller.owner) throw new Refused(404, "No such CI run.");
    return run;
  };

  /**
   * Queue the preview's rating for a run, or end the run with the refusal's reason. One reader at
   * a time: another reader polling at once gets the run as it was, so it can't record its own
   * "already queued" refusal over the rating this one queued.
   */
  function rate(run: CiRunRecord) {
    return store.advanceCiRunOnce(run.id, "checking", async (r) => {
      try {
        const subject = await previewRating.subject(r.previewId, r.owner);
        const queued = await previewRating.queue(subject);
        return { status: "rating", ratingId: queued.runId };
      } catch (e) {
        if (!(e instanceof Refused)) throw e;
        return { status: "error", reason: e.message };
      }
    });
  }

  /** Move a run on as far as its check and rating have got. */
  async function advance(run: CiRunRecord): Promise<CiRunRecord> {
    if (run.status === "checking" && run.checkId) {
      const check = await db.check(run.checkId);
      if (!check || check.status === "failed") {
        const problems = (check?.result as { problems?: string[] } | null)?.problems ?? [];
        return (
          (await store.advanceCiRun(run.id, "checking", {
            status: "error",
            reason: `The connection check failed${problems.length ? `: ${problems.join(" ")}` : "."}`,
          })) ?? run
        );
      }
      if (check.status !== "passed") return run;
      // Undefined when another reader has the run: read it as it is now.
      run = (await rate(run)) ?? (await store.ciRun(run.id)) ?? run;
    }
    if (run.status === "rating" && run.ratingId) {
      const r = (
        await db.pool.query(
          `SELECT status, error, report->'susceptibility'->>'grade' AS score,
             report->'task'->>'score' AS task_score
           FROM ratings WHERE id=$1 AND preview_id=$2`,
          [run.ratingId, run.previewId],
        )
      ).rows[0] as
        | { status: string; error: string | null; score: string | null; task_score: string | null }
        | undefined;
      if (!r || r.status === "failed")
        return (
          (await store.advanceCiRun(run.id, "rating", {
            status: "error",
            reason: r?.error ? `The rating stopped: ${r.error}` : "The rating stopped.",
          })) ?? run
        );
      if (r.status !== "done") return run;
      if (r.score === null)
        return (
          (await store.advanceCiRun(run.id, "rating", {
            status: "error",
            reason: "The rating's report has no Security score.",
          })) ?? run
        );
      const scores = {
        score: Number(r.score),
        taskScore: r.task_score === null ? null : Number(r.task_score),
      };
      const verdict = ciVerdict(run, scores);
      return (
        (await store.advanceCiRun(run.id, "rating", {
          status: verdict.passed ? "passed" : "failed",
          score: scores.score,
          taskScore: scores.taskScore,
          reason: verdict.reason,
        })) ?? run
      );
    }
    return run;
  }

  /** Start a run: the preview's connection check, or its rating if a check passed in the last day. */
  app.post(
    "/ci/runs",
    handle(async (c) => {
      const caller = await keys.required(c);
      if (!creates.allow(caller.keyId))
        throw new Refused(429, "Too many CI runs for this key. Try again in an hour.");
      await keys.count(caller, "ci");
      const input = runInput.parse(await c.req.json());
      const subject = await previewRating.subject(input.previewId, caller.owner);
      if (subject.connection !== "url")
        throw new Refused(
          409,
          "Testing in CI rates an Agent URL, and this preview connects with the runner.",
        );
      const problem = await previewRating.problem(subject);
      if (problem) throw new Refused(409, problem);
      const base = {
        id: randomUUID(),
        keyId: caller.keyId,
        owner: caller.owner,
        previewId: subject.id,
        minScore: input.minScore,
        minTaskScore: input.minTaskScore ?? null,
        label: input.label ?? "",
      };
      let run: CiRunRecord;
      if (await previewRating.passing(subject)) {
        const queued = await previewRating.queue(subject);
        run = await store.createCiRun({ ...base, status: "rating", ratingId: queued.runId });
      } else {
        const check = await previewRating.startCheck(c, subject, caller.owner);
        run = await store.createCiRun({ ...base, status: "checking", checkId: check.id });
        run = await advance(run);
      }
      c.header("Cache-Control", "no-store");
      return c.json(ciRunView(run), 202);
    }),
  );
  /** The wallet's runs, newest first: `?limit=`, `?before=<runId>`. */
  app.get(
    "/ci/runs",
    handle(async (c) => {
      const caller = await reader(c);
      const q = listQuery.parse(c.req.query());
      const items = await store.ciRuns(caller.owner, q.limit, q.before);
      return c.json({
        items: items.map(ciRunView),
        next: items.length === q.limit ? (items.at(-1)?.id ?? null) : null,
      });
    }),
  );
  /** A run's status, moved on as far as it has got. Poll it until `done`. */
  app.get(
    "/ci/runs/:id",
    handle(async (c) => {
      const caller = await reader(c);
      const run = await advance(await ownRun(c, caller));
      c.header("Cache-Control", "no-store");
      return c.json(ciRunView(run));
    }),
  );
  /** The run's report, once its rating is done: labelled, never attested, never insurable. */
  app.get(
    "/ci/runs/:id/report",
    handle(async (c) => {
      const caller = await reader(c);
      const run = await advance(await ownRun(c, caller));
      const row = run.ratingId
        ? (
            await db.pool.query(
              "SELECT status, report FROM ratings WHERE id=$1 AND preview_id=$2",
              [run.ratingId, run.previewId],
            )
          ).rows[0]
        : undefined;
      c.header("Cache-Control", "no-store");
      if (!row?.report) return c.json({ status: run.status, report: null }, 202);
      return c.json({
        label: PREVIEW_LABEL,
        attested: false,
        insurable: false,
        run: ciRunView(run),
        report: row.report,
      });
    }),
  );
}
