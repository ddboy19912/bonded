import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, useSignMessage } from "wagmi";
import type { RemoteMode } from "@bondedhq/shared";
import { deployment } from "../config";
import { ApiError } from "../lib/api";
import { byoaApi, type Connection, type PreviewRecord, type PreviewSession } from "../lib/byoa-api";
import {
  PREVIEW_STEPS,
  clearSession,
  duration,
  isConnected,
  loadSession,
  passingCheck,
  previewBefore,
  previewStep,
  problemAdvice,
  queueLine,
  refusal,
  saveSession,
  statusFromPreview,
  waitFor,
  type PreviewStep,
} from "../lib/connect";
import { useRatingRun } from "../lib/rating-run";
import {
  messageText,
  warningPrefix,
  warningsSummary,
  type ApiMessage,
} from "../lib/troubleshooting";
import { ProblemText } from "../components/problem";
import { short, when } from "../lib/format";
import { DOCS_BYOA } from "../lib/routes";
import { ConnectButton } from "../components/wallet";
import {
  CONNECTION_TEXT,
  ConnectStep,
  MODE_TEXT,
  ModeChoice,
} from "../components/connection-setup";
import { FrameworkQuestions, useFramework } from "../components/framework-questions";
import { FRAMEWORK_TEXT, connectionFor, hostingFor } from "../lib/frameworks";
import { Collapsible } from "../components/collapsible";
import { ConnectionCheck } from "../components/connection-check";
import { Estimate, NotificationSettingsForm, RatingLive } from "../components/rating-live";
import { PREVIEW_LABEL, PreviewReport } from "../components/preview-report";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorText,
  Loading,
  Note,
  Page,
  Unavailable,
  linkClass,
} from "../components/ui";

const FINISHED = ["done", "failed", "refused", "stopped"];
const PREVIEW_STATUS: Record<PreviewRecord["status"], string> = {
  created: "Connecting",
  checking: "Checking",
  ready: "Ready",
  queued: "Waiting",
  starting: "Setting up",
  running: "Running",
  done: "Done",
  failed: "Failed",
  refused: "Refused",
  stopped: "Stopped",
};

const STEP_TITLES: Record<PreviewStep, string> = {
  "sign-in": "Connect your wallet and sign in",
  choose: "Tell us about your agent",
  connect: "Connect it",
  check: "Check the connection",
  start: "Start the preview rating",
  rating: "Rating",
  report: "Your preview report",
};

/**
 * "Test your agent": a preview rating with nothing to commit. Sign in with a wallet, connect the
 * agent (its URL, or the runner), pass a connection check, then a full rating whose report is
 * labelled as a preview: never on chain, never insurable. "Make it official" leads to onboarding.
 */
export function TestAgent() {
  const { address, isConnected: walletConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const previewId = params.get("preview") ?? undefined;
  const [session, setSession] = useState<PreviewSession | undefined>(() =>
    loadSession(deployment.chainId, address),
  );
  useEffect(() => setSession(loadSession(deployment.chainId, address)), [address]);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<unknown>(null);
  const [expired, setExpired] = useState(false);
  const [connection, setConnection] = useState<Connection>("url");
  const [mode, setMode] = useState<RemoteMode>("tools");
  const [framework, setFramework] = useFramework();
  const [changing, setChanging] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<unknown>(null);

  const allowance = useQuery({
    queryKey: ["preview-allowance", address],
    queryFn: () => byoaApi.previewAllowance(address!),
    enabled: Boolean(address),
    refetchInterval: 60_000,
  });
  const previews = useQuery({
    queryKey: ["previews", session?.session],
    queryFn: () => byoaApi.listPreviews(session!.session),
    enabled: Boolean(session),
  });
  // The preview's live stream: its status, queue place and progress as they change. While it is
  // open, the record is read again only when the status moves on; if it drops, polling takes over.
  const [streaming, setStreaming] = useState(false);
  const preview = useQuery({
    queryKey: ["preview", previewId, session?.session],
    queryFn: () => byoaApi.preview(session!.session, previewId!),
    enabled: Boolean(session && previewId),
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
    // Also in a background tab, so the page moves on (and can notify) while you're elsewhere.
    refetchIntervalInBackground: true,
    refetchInterval: (q) =>
      q.state.data && FINISHED.includes(q.state.data.status)
        ? false
        : // Before a rating the stream doesn't carry the runner's or URL's state: poll for it.
          !q.state.data?.ratingId
          ? 4_000
          : streaming
            ? false
            : 15_000,
  });
  const previewKey = ["preview", previewId, session?.session];
  const over = preview.data ? FINISHED.includes(preview.data.status) : false;
  useEffect(() => {
    if (!session || !previewId || over) return;
    let last = "";
    setStreaming(true);
    const stop = byoaApi.previewEvents(
      session.session,
      previewId,
      (e) => {
        queryClient.setQueryData<PreviewRecord>(previewKey, (old) =>
          old
            ? { ...old, status: e.status, ratingId: e.ratingId, reason: e.reason, queue: e.queue }
            : old,
        );
        const moved = `${e.status}:${e.ratingId}`;
        if (moved !== last) {
          last = moved;
          void preview.refetch();
        }
      },
      () => setStreaming(false),
    );
    return () => {
      stop();
      setStreaming(false);
    };
    // One stream per preview and session; the record's own updates don't restart it.
  }, [session?.session, previewId, over]);
  const run = useRatingRun(preview.data?.ratingId ?? undefined, 5000, session?.session);
  // The list beside the steps follows the open preview's status.
  const openStatus = preview.data?.status;
  const refetchList = previews.refetch;
  useEffect(() => {
    if (openStatus) void refetchList();
  }, [openStatus, refetchList]);

  // A session the API no longer accepts: back to signing in, saying why.
  const authError = [previews.error, preview.error].find(
    (e) => e instanceof ApiError && e.status === 401,
  );
  useEffect(() => {
    if (!authError || !address) return;
    clearSession(deployment.chainId, address);
    setSession(undefined);
    setExpired(true);
  }, [authError, address]);

  const signIn = async () => {
    if (!address) return;
    setSigningIn(true);
    setSignInError(null);
    try {
      const s = await byoaApi.signIn(signMessageAsync, address);
      saveSession(deployment.chainId, s);
      setSession(s);
      setExpired(false);
    } catch (e) {
      setSignInError(e);
    } finally {
      setSigningIn(false);
    }
  };
  const signOut = () => {
    if (address) clearSession(deployment.chainId, address);
    setSession(undefined);
    setParams({});
  };
  const create = async () => {
    if (!session) return;
    setCreating(true);
    setCreateError(null);
    try {
      const p = await byoaApi.createPreview(session.session, { mode, connection });
      // Seeded, so the page goes straight on to connecting without a loading flash.
      queryClient.setQueryData(["preview", p.id, session.session], p);
      setChanging(false);
      setParams({ preview: p.id });
      await previews.refetch();
    } catch (e) {
      setCreateError(e);
    } finally {
      setCreating(false);
    }
  };
  // "Rate again": a new preview with the same choices; its report compares with this one.
  const rateAgain = async (from: PreviewRecord) => {
    setMode(from.mode);
    setConnection(from.connection);
    if (!session) return;
    setCreating(true);
    setCreateError(null);
    try {
      const next = await byoaApi.createPreview(session.session, {
        mode: from.mode,
        connection: from.connection,
      });
      queryClient.setQueryData(["preview", next.id, session.session], next);
      setParams({ preview: next.id });
      await previews.refetch();
    } catch (e) {
      setCreateError(e);
    } finally {
      setCreating(false);
    }
  };
  const startRating = async () => {
    if (!session || !preview.data) return;
    setStarting(true);
    setStartError(null);
    try {
      await byoaApi.startPreviewRating(session.session, preview.data.id);
      await Promise.all([preview.refetch(), allowance.refetch()]);
    } catch (e) {
      setStartError(e);
    } finally {
      setStarting(false);
    }
  };

  const p = preview.data;
  const status = p ? statusFromPreview(p) : undefined;
  const runFinished = run.data?.status === "done" || run.data?.status === "failed";
  const computed: PreviewStep = changing
    ? "choose"
    : previewStep({
        signedIn: Boolean(walletConnected && session),
        preview: previewId ? p : undefined,
        runFinished,
      });
  const step: PreviewStep = computed;
  const at = PREVIEW_STEPS.indexOf(step);
  const stateOf = (s: PreviewStep): StepState =>
    PREVIEW_STEPS.indexOf(s) < at ? "done" : s === step ? "current" : "later";
  const blocked = allowance.data && !allowance.data.allowed;
  const blockedLine = blocked
    ? allowance.data!.retryAt
      ? `${/day|today|wallet/i.test(allowance.data!.reason ?? "") || !allowance.data!.reason ? "You've used today's preview" : allowance.data!.reason!.replace(/[.;]\s*$/, "")}; try again in ${waitFor(allowance.data!.retryAt)}.`
      : (allowance.data!.reason ?? "Previews can't start right now.")
    : undefined;
  const plan = allowance.data?.plan;
  const auth = session ? { session: session.session } : undefined;
  const subject = p ? ({ kind: "preview", id: p.id } as const) : undefined;

  return (
    <Page
      title="Test your agent"
      back={{ to: "/agents", label: "All agents" }}
      intro="See how your agent scores against Bonded's red team. It's free, with no vault, no bond and no tokens: just a wallet to sign in."
    >
      {blockedLine && !p?.ratingId && (
        <Note tone="warn" title={blockedLine}>
          You can still connect your agent and run connection checks now, so it's ready to start
          then.
        </Note>
      )}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        {previewId && session && preview.isPending ? (
          <Card>
            <Loading what="your preview" height="lg" />
          </Card>
        ) : (
          <ol className="flex min-w-0 flex-col gap-4" aria-label="Steps">
            <FlowStep
              n={1}
              title={STEP_TITLES["sign-in"]}
              state={stateOf("sign-in")}
              summary={
                session && (
                  <span className="flex flex-wrap items-center gap-x-3">
                    Signed in as <span className="font-mono">{short(session.wallet)}</span>
                    <button type="button" className={linkClass} onClick={signOut}>
                      Sign out
                    </button>
                  </span>
                )
              }
            >
              {!walletConnected ? (
                <div className="flex flex-col items-start gap-4 text-sm">
                  <p className="text-muted">
                    Your wallet is how Bonded knows the preview is yours. You won't send anything or
                    pay gas.
                  </p>
                  <ConnectButton />
                </div>
              ) : (
                <div className="flex flex-col items-start gap-4 text-sm">
                  {expired && (
                    <p className="text-warn" role="status">
                      Your sign-in expired. Sign in again to carry on where you were.
                    </p>
                  )}
                  <p className="text-muted">
                    One signature, no gas. It proves the wallet is yours; nothing goes on chain.
                  </p>
                  <Button loading={signingIn} onClick={() => void signIn()}>
                    {signingIn ? "Sign in your wallet…" : "Sign in"}
                  </Button>
                  <ErrorText error={signInError} />
                </div>
              )}
            </FlowStep>

            <FlowStep
              n={2}
              title={STEP_TITLES.choose}
              state={stateOf("choose")}
              summary={
                p && (
                  <span className="flex flex-wrap items-center gap-x-3">
                    <span>
                      {framework ? `${FRAMEWORK_TEXT[framework].title}, ` : ""}
                      {CONNECTION_TEXT[p.connection].title.toLowerCase()},{" "}
                      {MODE_TEXT[p.mode].title.toLowerCase()} mode
                    </span>
                    {!p.ratingId && (
                      <button
                        type="button"
                        className={linkClass}
                        onClick={() => {
                          setConnection(p.connection);
                          setMode(p.mode);
                          setChanging(true);
                        }}
                      >
                        Change
                      </button>
                    )}
                  </span>
                )
              }
            >
              <div className="flex flex-col gap-6">
                <FrameworkQuestions
                  flat
                  name="preview"
                  framework={framework}
                  hosting={hostingFor(connection)}
                  onFramework={setFramework}
                  onHosting={(h) => setConnection(connectionFor(h))}
                  advanced={<ModeChoice mode={mode} onMode={setMode} />}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button loading={creating} onClick={() => void create()}>
                    Continue
                  </Button>
                  {changing && (
                    <Button kind="ghost" onClick={() => setChanging(false)}>
                      Keep {p ? "what I had" : "it"}
                    </Button>
                  )}
                </div>
                {changing && p && (
                  <p className="text-xs text-muted">
                    Changing these starts a new preview: you'll connect and check again.
                  </p>
                )}
                <ErrorText error={createError} />
              </div>
            </FlowStep>

            <FlowStep
              n={3}
              title={STEP_TITLES.connect}
              state={stateOf("connect")}
              summary={
                status &&
                (status.connection === "url"
                  ? status.agentUrl && (
                      <span>
                        Verified{" "}
                        <span className="font-mono text-xs break-all">{status.agentUrl.url}</span>
                      </span>
                    )
                  : status.runner?.connected
                    ? "Runner connected"
                    : "Runner offline: start it again before the rating")
              }
              open={stateOf("connect") === "done"}
            >
              {p && status && subject && auth && (
                <ConnectStep
                  key={p.id}
                  framework={framework}
                  subject={subject}
                  auth={auth}
                  status={status}
                  connection={status.connection}
                  onChanged={() => preview.refetch()}
                  autoCreate
                />
              )}
            </FlowStep>

            <FlowStep
              n={4}
              title={STEP_TITLES.check}
              state={stateOf("check")}
              summary={
                status &&
                passingCheck(status) && (
                  <span className="flex flex-col gap-1.5">
                    <span className="text-safe">
                      Passed {when(Math.floor(Date.parse(status.lastCheck!.createdAt) / 1000))}
                    </span>
                    {!!status.lastCheck!.warnings?.length && (
                      <CheckWarnings
                        warnings={status.lastCheck!.warnings}
                        connection={status.connection}
                      />
                    )}
                  </span>
                )
              }
              open={stateOf("check") === "done" && !p?.ratingId}
            >
              {p && status && subject && auth && (
                <ConnectionCheck
                  key={p.id}
                  subject={subject}
                  auth={auth}
                  status={status}
                  ready={isConnected(status)}
                  notReadyReason={
                    status.connection === "url"
                      ? "Verify your URL first."
                      : "Start the runner first: the check runs through it."
                  }
                  onFinished={() => preview.refetch()}
                />
              )}
            </FlowStep>

            <FlowStep
              n={5}
              title={STEP_TITLES.start}
              state={stateOf("start")}
              summary={p?.ratingId ? "Started" : undefined}
            >
              {p && subject && (
                <div className="flex flex-col gap-5 text-sm">
                  <p className="text-muted">
                    Every published attack runs once, plus a set made for this preview alone (one
                    per attack class) and 6 episodes with no attack, shuffled. Each episode gives
                    your agent 90 seconds.
                  </p>
                  <Estimate
                    subject={subject}
                    enabled={Boolean(status && passingCheck(status))}
                    {...(session ? { session: session.session } : {})}
                  />
                  {p.reason && FINISHED.includes(p.status) && !p.ratingId && (
                    <Note tone="warn">{p.reason}</Note>
                  )}
                  {blockedLine && <p className="text-warn">{blockedLine}</p>}
                  {!blocked && (allowance.data?.queued ?? 0) > 0 && (
                    <p className="text-xs text-muted">
                      {queueLine(allowance.data!.queued)} Official ratings go first.
                    </p>
                  )}
                  {status?.connection === "runner" && !status.runner?.connected && (
                    <p className="text-warn">The runner isn't connected. Start it again first.</p>
                  )}
                  <div>
                    <Button
                      size="lg"
                      loading={starting}
                      disabled={
                        Boolean(blocked) ||
                        !status ||
                        !passingCheck(status) ||
                        (status.connection === "runner" && !status.runner?.connected)
                      }
                      onClick={() => void startRating()}
                    >
                      Start preview rating
                    </Button>
                  </div>
                  {refusal(startError) ? (
                    <Note tone="warn">{refusal(startError)}</Note>
                  ) : (
                    <ErrorText error={startError} />
                  )}
                </div>
              )}
            </FlowStep>

            <FlowStep
              n={6}
              title={STEP_TITLES.rating}
              state={stateOf("rating")}
              summary="Finished"
              open={false}
            >
              {p?.ratingId && subject && auth && (
                <div className="flex flex-col gap-6">
                  <RatingLive
                    session={session?.session}
                    statusHint={p.status}
                    runId={p.ratingId}
                    label="Your preview"
                    queueText={p.queue ? queueLine(p.queue.position) : null}
                    onFinished={() => void Promise.all([preview.refetch(), previews.refetch()])}
                  />
                  <NotificationSettingsForm subject={subject} auth={auth} />
                </div>
              )}
            </FlowStep>

            <FlowStep n={7} title={STEP_TITLES.report} state={stateOf("report")}>
              {p && run.data && runFinished ? (
                <PreviewReport
                  preview={p}
                  run={run.data}
                  previous={previewBefore(p, previews.data?.items)}
                  session={session?.session}
                  onRateAgain={() => void rateAgain(p)}
                  rateAgainBusy={creating}
                />
              ) : p && FINISHED.includes(p.status) && p.ratingId ? (
                <Loading what="the report" height="md" />
              ) : null}
            </FlowStep>
          </ol>
        )}

        <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-24">
          <PreviewProblems
            previewId={previewId}
            signedIn={Boolean(session)}
            preview={preview}
            onReset={() => setParams({})}
          />
          <Card title="This is a preview rating">
            <p className="text-sm text-muted">
              A shorter version of an official rating, scored the same way by the same judge
              {plan
                ? `: up to ${plan.episodes} episodes, stopped at ${duration(plan.budgetSeconds)} at the most`
                : ""}
              .
            </p>
            <dl className="mt-4 flex flex-col gap-3 text-sm">
              <div>
                <dt className="font-medium">{PREVIEW_LABEL}</dt>
                <dd className="mt-0.5 text-muted">
                  It isn't signed or posted, and no cover can be bought on it.
                </dd>
              </div>
              <div>
                <dt className="font-medium">Free, a few a day per wallet</dt>
                <dd className="mt-0.5 text-muted">
                  Previews run one at a time, after official ratings.
                </dd>
              </div>
              <div>
                <dt className="font-medium">Your model, your bill</dt>
                <dd className="mt-0.5 text-muted">
                  Bonded runs the attacks; your agent's own model calls are yours.
                </dd>
              </div>
            </dl>
            <p className="mt-4 text-sm">
              <a className={linkClass} href={DOCS_BYOA}>
                The guide
              </a>{" "}
              ·{" "}
              <Link className={linkClass} to="/agents/new">
                Onboard an agent instead
              </Link>
            </p>
          </Card>
          {session && (previews.data?.items.length ?? 0) > 0 && (
            <Card title="Your previews">
              <ul className="divide-y divide-line text-sm">
                {previews.data!.items.map((x) => (
                  <li
                    key={x.id}
                    className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-muted">
                        {when(Math.floor(Date.parse(x.createdAt) / 1000))}
                      </span>
                      <Badge
                        tone={
                          x.status === "done"
                            ? "safe"
                            : FINISHED.includes(x.status)
                              ? "breach"
                              : "neutral"
                        }
                      >
                        {PREVIEW_STATUS[x.status]}
                        {x.status === "done" && x.rating?.score !== undefined
                          ? ` · ${x.rating.score}`
                          : ""}
                      </Badge>
                    </span>
                    {x.id === previewId ? (
                      <span className="text-xs text-muted">Open</span>
                    ) : (
                      <button
                        type="button"
                        className={`${linkClass} text-xs`}
                        onClick={() => (setChanging(false), setParams({ preview: x.id }))}
                      >
                        Open it
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </Page>
  );
}

/** A passed check's warnings, folded behind one line, with "Note:" on the ones that are only notes. */
function CheckWarnings({
  warnings,
  connection,
}: {
  warnings: readonly ApiMessage[];
  connection: Connection;
}) {
  const { text, notesOnly } = warningsSummary(warnings);
  return (
    <Collapsible
      triggerClassName={`text-sm font-normal ${notesOnly ? "text-muted" : "text-warn"}`}
      contentClassName="pt-3"
      summary={text}
    >
      <ul className="flex flex-col gap-3">
        {warnings.map((problem) => (
          <li key={messageText(problem)}>
            <ProblemText
              prefix={warningPrefix(problem, "")}
              message={problem}
              advice={problemAdvice(messageText(problem), connection)}
            />
          </li>
        ))}
      </ul>
    </Collapsible>
  );
}

type StepState = "done" | "current" | "later";

/**
 * One step of the flow, a card each. The current one is open; done ones show a line of what was
 * done (and can be reopened when that helps, e.g. to copy the runner command again); later ones
 * show only their title, so the whole path is visible from the start. Inside a card there are no
 * further boxes: the content sits flat, under the title.
 */
function FlowStep({
  n,
  title,
  state,
  summary,
  open,
  children,
}: {
  n: number;
  title: string;
  state: StepState;
  summary?: ReactNode;
  /** A done step's content stays reachable behind "Show". */
  open?: boolean;
  children: ReactNode;
}) {
  const [show, setShow] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const was = useRef(state);
  // When the flow moves on to this step by itself, bring it into view and move focus to it, so
  // keyboard and screen-reader users land where they're needed. Not on the first render.
  useEffect(() => {
    if (state === "current" && was.current !== "current") {
      heading.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
      heading.current?.focus({ preventScroll: true });
    }
    was.current = state;
  }, [state]);
  return (
    <li
      aria-current={state === "current" ? "step" : undefined}
      className={`panel min-w-0 p-5 sm:p-6 ${state === "later" ? "opacity-55" : ""}`}
    >
      <div className="flex items-center gap-3">
        <span
          className={`flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${state === "done" ? "bg-safe text-paper" : state === "current" ? "btn-brand text-on-brand" : "bg-white/[0.07] text-muted"}`}
          aria-hidden
        >
          {state === "done" ? "✓" : n}
        </span>
        <h2 ref={heading} tabIndex={-1} className="min-w-0 flex-1 text-lg font-bold outline-none">
          <span className="sr-only">
            Step {n}
            {state === "done" ? ", done" : state === "current" ? ", current" : ""}:{" "}
          </span>
          {title}
        </h2>
        {state === "done" && open && (
          <button
            type="button"
            className={`${linkClass} shrink-0 text-sm`}
            aria-expanded={show}
            onClick={() => setShow((v) => !v)}
          >
            {show ? "Hide" : "Show"}
          </button>
        )}
      </div>
      {state === "done" && summary && (
        <div className="mt-2 pl-10 text-sm text-muted">{summary}</div>
      )}
      {(state === "current" || (state === "done" && open && show)) && (
        <div className="mt-5">{children}</div>
      )}
    </li>
  );
}

/** A preview that can't be shown: not found, not this wallet's, or the API down. */
function PreviewProblems({
  previewId,
  signedIn,
  preview,
  onReset,
}: {
  previewId: string | undefined;
  signedIn: boolean;
  preview: { error: unknown; isPending: boolean; refetch: () => unknown; data?: PreviewRecord };
  onReset: () => void;
}) {
  if (!previewId || !signedIn) return null;
  const e = preview.error;
  if (e instanceof ApiError && (e.status === 404 || e.status === 403))
    return (
      <EmptyState
        title="That preview isn't here"
        action={
          <Button size="sm" onClick={onReset}>
            Start a new preview
          </Button>
        }
      >
        It doesn't exist, or it belongs to another wallet.
      </EmptyState>
    );
  if (e && !(e instanceof ApiError && e.status === 401))
    return <Unavailable error={e} onRetry={() => void preview.refetch()} />;
  return null;
}
