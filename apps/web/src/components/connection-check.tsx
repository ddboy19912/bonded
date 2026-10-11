import { useEffect, useRef, useState } from "react";
import { SURFACE_LABELS } from "../lib/byoa";
import {
  byoaApi,
  type Auth,
  type CheckEvent,
  type CheckResult,
  type Connection,
  type Subject,
} from "../lib/byoa-api";
import {
  codeSourceLabel,
  eventLine,
  passingCheck,
  problemAdvice,
  type ConnectionStatus,
} from "../lib/connect";
import { when } from "../lib/format";
import { messageText, warningPrefix, type ApiMessage } from "../lib/troubleshooting";
import { Collapsible } from "./collapsible";
import { Button, ErrorText, Spinner } from "./ui";
import { ProblemText } from "./problem";

/** All nine attack surfaces: the check says how many of them the agent read. */
const SURFACES = Object.keys(SURFACE_LABELS).length;

/**
 * The connection check: one benign episode, never scored, watched live. A timeline of what the
 * agent does as it happens, then a clear pass or fail, each problem as a sentence with what to do
 * about it. A passing check is needed before a rating can start.
 */
export function ConnectionCheck({
  subject,
  auth,
  status,
  ready,
  notReadyReason,
  onFinished,
}: {
  subject: Subject;
  auth: Auth;
  status: ConnectionStatus;
  /** The connection is up, so a check can run. */
  ready: boolean;
  notReadyReason?: string;
  onFinished: () => unknown;
}) {
  const [checkId, setCheckId] = useState<string>();
  const [events, setEvents] = useState<CheckEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const stop = useRef<() => void>(() => {});
  const poll = useRef<ReturnType<typeof setInterval>>(undefined);
  const finishedFor = useRef<string | undefined>(undefined);
  useEffect(
    () => () => {
      stop.current();
      clearInterval(poll.current);
    },
    [],
  );

  const result = events.find((e): e is CheckResult => e.type === "result");
  const running = Boolean(checkId) && !result;

  useEffect(() => {
    if (!result || !checkId || finishedFor.current === checkId) return;
    finishedFor.current = checkId;
    stop.current();
    clearInterval(poll.current);
    void onFinished();
  }, [result, checkId, onFinished]);

  const follow = (id: string) => {
    const session = auth.session;
    if (!session) return;
    stop.current = byoaApi.checkEvents(
      id,
      session,
      (event) => setEvents((list) => [...list, event]),
      // The stream dropped: read the check instead, every 2 seconds, until it has a result.
      () => {
        clearInterval(poll.current);
        poll.current = setInterval(() => {
          byoaApi
            .check(id, session)
            .then((record) => setEvents(record.events))
            .catch(() => {});
        }, 2000);
      },
    );
  };

  const start = async () => {
    stop.current();
    clearInterval(poll.current);
    setBusy(true);
    setError(null);
    setEvents([]);
    setCheckId(undefined);
    try {
      const { checkId: id } = await byoaApi.startCheck(subject, auth);
      setCheckId(id);
      follow(id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const valid = passingCheck(status);
  const last = !checkId ? status.lastCheck : null;
  const done = events.find((e) => e.type === "done");
  return (
    <div className="flex flex-col gap-4 text-sm">
      <p className="text-muted">
        One practice episode with no attack in it, never scored. It must pass before a rating can
        start, and takes up to 2 minutes.
      </p>

      {last && (
        <p className={last.status === "passed" && valid ? "text-safe" : "text-muted"}>
          {last.status === "passed"
            ? valid
              ? `The last check passed ${when(Math.floor(Date.parse(last.createdAt) / 1000))}. It's good for 24 hours.`
              : "The last check passed over 24 hours ago: run it again before rating."
            : last.status === "failed"
              ? `The last check failed ${when(Math.floor(Date.parse(last.createdAt) / 1000))}${last.problems?.length ? `: ${last.problems.map(messageText).join(" ")}` : "."}`
              : "A check is running."}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          loading={busy}
          disabled={!ready || running || !auth.session}
          onClick={() => void start()}
          kind={checkId || last ? "secondary" : "primary"}
        >
          {busy && "sign" in auth
            ? "Sign in your wallet…"
            : checkId || last
              ? "Run the check again"
              : "Run the connection check"}
        </Button>
        {!auth.session ? (
          <span className="text-xs text-muted">
            Sign in first: the check is shown live to you only.
          </span>
        ) : (
          !ready && notReadyReason && <span className="text-xs text-muted">{notReadyReason}</span>
        )}
      </div>
      <ErrorText error={error} />

      {checkId && (
        <section aria-label="Connection check" className="flex min-h-40 flex-col gap-3">
          <ol
            className="flex flex-col gap-1.5 rounded-xl bg-black/30 p-4 font-mono text-xs"
            aria-live="polite"
          >
            {events.length === 0 && (
              <li className="flex items-center gap-2 text-muted">
                <Spinner /> Starting the episode…
              </li>
            )}
            {events
              .filter((e) => e.type !== "result")
              .map((e, i) => {
                const line = eventLine(e);
                return (
                  <li key={i} className="flex gap-2">
                    <span
                      aria-hidden
                      className={
                        line.ok === false ? "text-breach" : line.ok ? "text-safe" : "text-muted"
                      }
                    >
                      {line.ok === false ? "✕" : line.ok ? "✓" : "•"}
                    </span>
                    <span className={line.ok === false ? "text-breach" : "text-soft"}>
                      {line.text}
                    </span>
                  </li>
                );
              })}
            {running && events.length > 0 && (
              <li className="flex items-center gap-2 text-muted">
                <Spinner /> Watching…
              </li>
            )}
          </ol>
          {result && <CheckVerdict result={result} connection={status.connection} />}
          {done?.type === "done" &&
            result &&
            !result.passed &&
            (done.stdoutTail || done.stderrTail) && (
              <Collapsible
                defaultOpen
                className="border-t border-line pt-4"
                triggerClassName="text-xs font-semibold"
                contentClassName="pt-0"
                summary="Its output, as reported (the last 4 KB)"
              >
                {done.stderrTail && <Tail label="stderr" text={done.stderrTail} />}
                {done.stdoutTail && <Tail label="stdout" text={done.stdoutTail} />}
              </Collapsible>
            )}
        </section>
      )}
    </div>
  );
}

function Tail({ label, text }: { label: string; text: string }) {
  return (
    <div className="mt-3 flex flex-col gap-1">
      <span className="text-xs text-muted">{label}</span>
      <pre className="max-h-48 overflow-auto rounded-xl bg-black/40 p-3 font-mono text-[11px] break-all whitespace-pre-wrap text-soft">
        {text}
      </pre>
    </div>
  );
}

/** Pass or fail, in words. */
export function CheckVerdict({
  result,
  connection,
}: {
  result: CheckResult;
  connection: Connection;
}) {
  const read = result.surfacesRead.length;
  const summary = `It called ${result.toolsCalled} tool${result.toolsCalled === 1 ? "" : "s"}, read ${read} of ${SURFACES} sources, and ${result.taskCompleted ? "did its task" : "didn't do its task"}.`;
  if (result.passed)
    return (
      <div role="status" className="border-l-2 border-safe/60 pl-4">
        <p className="font-semibold text-safe">Passed: your agent is connected.</p>
        <p className="mt-1 text-soft">{summary}</p>
        <Warnings warnings={result.warnings} connection={connection} />
        {result.code && (
          <p className="mt-2 text-xs text-soft">
            Code hash from{" "}
            {codeSourceLabel({
              value: result.code.hash,
              source: result.code.source,
              detail: result.code.version ?? null,
            })}
            .
          </p>
        )}
      </div>
    );
  return (
    <div role="alert" className="border-l-2 border-breach/70 pl-4">
      <p className="font-semibold text-breach">
        It didn't pass. Fix these, then run the check again.
      </p>
      <ul className="mt-2 flex flex-col gap-2.5">
        {result.problems.map((p) => (
          <li key={messageText(p)}>
            <ProblemText message={p} advice={problemAdvice(messageText(p), connection)} />
          </li>
        ))}
      </ul>
      <Warnings warnings={result.warnings} connection={connection} />
      <p className="mt-2 text-xs text-soft">{summary}</p>
    </div>
  );
}

/** Advice that doesn't fail the check, e.g. sources it never read, and notes. */
function Warnings({ warnings, connection }: { warnings?: ApiMessage[]; connection: Connection }) {
  if (!warnings?.length) return null;
  return (
    <ul className="mt-2 flex flex-col gap-1 text-soft">
      {warnings.map((w) => (
        <li key={messageText(w)}>
          <ProblemText
            prefix={warningPrefix(w, "Worth fixing:")}
            message={w}
            advice={problemAdvice(messageText(w), connection)}
          />
        </li>
      ))}
    </ul>
  );
}
