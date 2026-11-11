import type { RemoteMode } from "@bondedhq/shared";
import { apiUrl, deployment } from "../config";
import { request, type RunnerRecord } from "./api";
import { byoaMessage, type ByoaAction } from "./byoa-messages";
import { createRunnerToken, requestRating, revokeRunnerToken, type Signer } from "./self-serve";
import { withCodes, type ApiMessage, type CheckIssue } from "./troubleshooting";
import type { RatingCompare } from "./report-actions";
import type { SuggestedMandate } from "./bond-cover";
import type { AgentHealth, InboxPage, ServiceStatus, VaultActivityRecord } from "./health";

/**
 * The API calls behind "Test your agent", Agent URL mode, connection checks, progress, cost
 * estimates and notifications (bring your own agent, round 2). Each call is one function on
 * `byoaApi`, so tests can replace any of them with a fixture.
 *
 * A preview belongs to a wallet: the owner signs in once (`signIn`) and the session it returns
 * authorises that wallet's preview calls. An agent registered on chain is acted on as today:
 * each write is signed by its owner's wallet.
 */

/** How Bonded reaches the agent: the runner next to it, or a POST to its HTTPS Agent URL. */
export type Connection = "runner" | "url";
export const CONNECTIONS: readonly Connection[] = ["url", "runner"];

/** What a connection belongs to: a preview (no vault, no bond), or an agent on chain. */
export type Subject = { kind: "preview"; id: string } | { kind: "agent"; agentId: string };

/**
 * How a request is authorised: the wallet's session (one sign-in covers previews and the owner's
 * agents), or for an agent on chain the owner's wallet signing each request. With both, the
 * session is used where the API accepts one and the wallet signs the rest (runner tokens).
 */
export type Auth = { session: string; sign?: Signer } | { session?: string; sign: Signer };

/** Where the code hash a rating records came from (the runner's `codeSource`, or the URL). */
export type CodeSource =
  | "declared"
  | "flag"
  | "env"
  | "image"
  | "git"
  | "git-dirty"
  | "unpinned"
  | "url"
  /** The older name of "url", still read. */
  | "url-version";

export interface CodeHashInfo {
  value: string;
  source: CodeSource | string;
  /** E.g. the commit, the image digest or the URL's version string. */
  detail?: string | null;
  /** Who says so: Bonded never verifies it, it is declared or reported. */
  reportedBy?: "owner" | "runner" | "agent";
  /** The API's own words for that, e.g. "reported by the runner". */
  label?: string;
}

/** A registered Agent URL. Its secret is shown once, when it is registered, and never again. */
export interface AgentUrlInfo {
  /** Only in the owner's own view: public views say only that one is set. */
  url?: string;
  configured?: boolean;
  verified?: boolean;
  verifiedAt: string | null;
  version: string | null;
}

/** POST …/agent-url: Bonded challenged the URL and it answered. */
export interface AgentUrlRegistered extends AgentUrlInfo {
  url: string;
  /** Signs every call Bonded makes to the URL (`bonded_as_…`). Shown once. */
  secret: string;
  codeHash: CodeHashInfo | null;
  /** Why it isn't verified yet, when the URL was saved before its agent had the secret. */
  problem?: string | null;
}

export interface CheckSummary {
  /** Only in the owner's own view. */
  id?: string;
  status: "running" | "passed" | "failed";
  createdAt: string;
  connection: Connection;
  /** A passing check lets a rating start until then (24 hours). */
  expiresAt?: string | null;
  /** Why it failed: a check passes only with none. Each with its code, where the API gives one. */
  problems?: ApiMessage[];
  /** Advice only: a passing check can still carry these. */
  warnings?: ApiMessage[];
  /** The same sentences with their troubleshooting codes. */
  issues?: CheckIssue[];
}

/** What the agent reported using at `/done` (optional, never trusted). */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

/** One event of a connection check, as GET /checks/:id/events streams them. */
export type CheckEvent =
  | { type: "started" }
  | { type: "tool"; name: string; surface?: string | null; ok: boolean; error?: string }
  | { type: "tx"; ok: boolean; reason?: string }
  | {
      type: "done";
      exitCode?: number | null;
      durationMs: number;
      stdoutTail?: string;
      stderrTail?: string;
    }
  | {
      type: "result";
      /** True exactly when there are no problems. */
      passed: boolean;
      problems: ApiMessage[];
      /** Advice only, never a reason to fail (e.g. surfaces it didn't read). */
      warnings?: ApiMessage[];
      /** The problems and warnings with their troubleshooting codes. */
      issues?: CheckIssue[];
      taskCompleted: boolean;
      toolsCalled: number;
      surfacesRead: string[];
      usage?: Usage | null;
      durationMs?: number;
      /** The code hash the runner or the URL reported for this check. */
      code?: { hash: string; source: CodeSource | string; version?: string | null } | null;
    };

export type CheckResult = Extract<CheckEvent, { type: "result" }>;

/** GET /checks/:id: the check so far (for a page opened after it started, or a lost stream). */
export interface CheckRecord {
  id: string;
  status: CheckSummary["status"];
  events: CheckEvent[];
  result?: Omit<CheckResult, "type"> | null;
}

/** GET …/estimate: a rating's time and cost, extrapolated from the passing check. */
export interface CostEstimate {
  episodes: number;
  perEpisode: { toolCalls: number; seconds: number; costUsd?: number | null };
  total: { seconds: number; costUsd?: number | null };
  basis: string;
  /** The agent reported its model usage at done; without it the estimate is time only. */
  usageReported?: boolean;
  /** The API's own sentence on how far to trust it. */
  note?: string;
}

/** A rating's progress: counts and time only, never verdicts, until it finishes. */
export interface RatingProgress {
  done: number;
  total: number | null;
  etaSeconds: number | null;
  /** When its setup started. */
  startedAt: string | null;
  /** The rating's status, where the stream gives it ("starting": setting up the sandbox). */
  status?: string;
}

/** GET /previews/:id/events: the preview's state as it changes. */
export interface PreviewEvent {
  status: PreviewStatus;
  ratingId: string | null;
  reason: string | null;
  queue: { position: number } | null;
  progress: RatingProgress | null;
}

/** Where a finished, failed or refused rating is announced. Shown masked; never the secret. */
export interface NotificationSettings {
  webhook: { url: string } | null;
  email: string | null;
  /** This deployment can send email (an email provider is configured). */
  emailAvailable: boolean;
  /** This deployment can sign webhooks (its secret key is set). */
  webhookAvailable?: boolean;
  /** The notification types the owner turned off (snake_case, e.g. "low_gas"). */
  muted?: string[];
  /** Every notification type there is, in the same names. */
  types?: string[];
}

export type PreviewStatus =
  | "created"
  | "checking"
  | "ready"
  | "queued"
  | "starting"
  | "running"
  | "done"
  | "failed"
  | "refused"
  | "stopped";

/** The world a preview tests the agent on: the on-chain vault, or a simulated brokerage account. */
export type PreviewWorld = "vault" | "brokerage";

/** One attack in a brokerage preview's findings (`brokerageFindings` in @bonded/arena). */
export interface BrokerageAttackFinding {
  id: string;
  attackClass: string;
  className: string;
  title: string;
  ran: number;
  notRun: number;
  met: number;
  worked: number;
  steeredUsd: number;
  atRiskUsd: number;
  example?: {
    orders: { side: string; symbol: string; amountUsd: number; priceUsd: number }[];
    withdrawals: { account: string; amountUsd: number; linked: boolean }[];
    breaches: string[][];
    approvals: { side: string; symbol: string; amountUsd: number; reason: string }[];
    finalMessage?: string;
  };
}

/** A brokerage preview's findings: no score, its attacks are staged. */
export interface BrokerageFindings {
  world: "brokerage";
  staged: true;
  plan: string;
  mandateShown: boolean;
  episodes: { total: number; ran: number; notRun: number };
  attacks: {
    ran: number;
    worked: number;
    seedsWorked: number;
    seedsRan: number;
    seedsTotal: number;
    steeredUsd: number;
    atRiskUsd: number;
    approvedThenWorked: number;
  };
  job: { ran: number; done: number };
  perAttack: BrokerageAttackFinding[];
  perJob: {
    id: string;
    kind: string;
    title: string;
    ran: number;
    notRun: number;
    done: number;
    missed: string[];
  }[];
  /** Fewer than half of the episodes count: the findings say nothing. */
  inconclusive: boolean;
  /** What the numbers assume, in plain sentences, shown next to them. */
  assumptions?: string[];
}

/** What a brokerage preview's run stores as its report. */
export interface BrokerageReport {
  world: "brokerage";
  findings: BrokerageFindings;
  preview?: { label: string; attested: false; insurable: false };
}

export interface PreviewRecord {
  id: string;
  chainId: number;
  owner: string;
  mode: RemoteMode;
  /** Vault when absent (previews made before the brokerage world). */
  world?: PreviewWorld;
  connection: Connection;
  status: PreviewStatus;
  createdAt: string;
  agentUrl: AgentUrlInfo | null;
  codeHash: CodeHashInfo | null;
  /** Its rating, once one started (the `ratings` row, kind "preview"). */
  ratingId: string | null;
  /** The runner token exists (never the token itself). */
  hasRunnerToken: boolean;
  runner: RunnerRecord["runner"];
  /** Why a runner that is there doesn't count (e.g. the other mode). */
  problem?: string | null;
  gatewayUrl: string | null;
  lastCheck: CheckSummary | null;
  /** The passing check of exactly this connection (mode, credential, code), if any. */
  passingCheck?: CheckSummary | null;
  /** Bonded can reach the agent now. */
  ready?: boolean;
  /** The code hash the owner declared, if any (the rest is reported). */
  declaredCodeHash?: string | null;
  /** Waiting to start: how many previews or official ratings are ahead of it. */
  queue?: { position: number } | null;
  /** Why it was refused or stopped, in a sentence. */
  reason?: string | null;
  /** Its rating's status, and its score once it is over. */
  rating?: {
    runId: string;
    status: string;
    score?: number;
    tier?: string;
    /** A stock-trading preview's headline, in place of a score. */
    findings?: Pick<BrokerageFindings, "attacks" | "job" | "episodes">;
  } | null;
  /** What "Make it official" fills in. Null for a brokerage preview, which has no official rating yet. */
  upgrade?: null | {
    mode: RemoteMode;
    connection: Connection;
    agentUrl: string | null;
    codeHash: string | null;
    reportedCode: { hash: string; source: string } | null;
    previewId: string;
  };
  expectedRating?: { episodes: number; budgetSeconds: number };
  label?: string;
}

/** GET /previews/allowance: whether this wallet can start a preview now, and if not, when. */
export interface PreviewAllowance {
  allowed: boolean;
  /** In a sentence, when not allowed. */
  reason?: string | null;
  /** When the wallet's daily preview comes back, or the global cap resets. */
  retryAt?: string | null;
  /** Previews and official ratings ahead in the queue right now. */
  queued: number;
  /** What a preview runs, for the page to say before it starts. */
  plan?: { episodes: number; budgetSeconds: number } | null;
}

/** The signed-in wallet's preview session. */
export interface PreviewSession {
  session: string;
  wallet: string;
  expiresAt: string;
}

const now = () => Math.floor(Date.now() / 1000);

/**
 * A check (summary or result) with each problem and warning carrying its code: the API keeps
 * `problems` and `warnings` as plain sentences and puts the codes in `issues`.
 */
export function codedCheck<
  T extends { problems?: ApiMessage[]; warnings?: ApiMessage[]; issues?: CheckIssue[] },
>(check: T): T;
export function codedCheck<
  T extends { problems?: ApiMessage[]; warnings?: ApiMessage[]; issues?: CheckIssue[] },
>(check: T | null | undefined): T | null | undefined;
export function codedCheck<
  T extends { problems?: ApiMessage[]; warnings?: ApiMessage[]; issues?: CheckIssue[] },
>(check: T | null | undefined): T | null | undefined {
  if (!check || !check.issues?.length) return check;
  return {
    ...check,
    ...(check.problems ? { problems: withCodes(check.problems, check.issues, "problem") } : {}),
    ...(check.warnings ? { warnings: withCodes(check.warnings, check.issues, "warning") } : {}),
  };
}

const codedEvent = (e: CheckEvent): CheckEvent => (e.type === "result" ? codedCheck(e) : e);

/** A preview with its checks' sentences coded. */
const codedPreview = (p: PreviewRecord): PreviewRecord => ({
  ...p,
  lastCheck: codedCheck(p.lastCheck) ?? null,
  ...(p.passingCheck !== undefined ? { passingCheck: codedCheck(p.passingCheck) ?? null } : {}),
});

/** The API path of a subject's own endpoints. */
export function subjectPath(subject: Subject): string {
  return subject.kind === "preview"
    ? `/previews/${encodeURIComponent(subject.id)}`
    : `/self/agents/${subject.agentId}`;
}

/** Headers and body fields for an authorised write: a session, or a fresh wallet signature. */
async function authorise(
  subject: Subject,
  auth: Auth,
  action: ByoaAction,
  fields: Record<string, string> = {},
): Promise<{ headers: Record<string, string>; signed: Record<string, unknown> }> {
  if (auth.session) return { headers: { Authorization: `Bearer ${auth.session}` }, signed: {} };
  if (subject.kind !== "agent" || !auth.sign)
    throw new Error("Your sign-in has ended. Sign in again to carry on.");
  const timestamp = now();
  const signature = await auth.sign({
    message: byoaMessage({
      action,
      chainId: deployment.chainId,
      agentId: subject.agentId,
      fields,
      timestamp,
    }),
  });
  return { headers: {}, signed: { timestamp, signature } };
}

async function write<T>(
  method: "POST" | "PUT" | "DELETE",
  path: string,
  subject: Subject,
  auth: Auth,
  action: ByoaAction,
  body: Record<string, unknown> = {},
  fields: Record<string, string> = {},
): Promise<T> {
  const { headers, signed } = await authorise(subject, auth, action, fields);
  return request<T>(path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ ...body, ...signed }),
  });
}

const bearer = (session: string) => ({ headers: { Authorization: `Bearer ${session}` } });
const maybeBearer = (session?: string) => (session ? bearer(session) : undefined);

/**
 * Follow a server-sent event stream. Returns a function that closes it. Each `data:` line is
 * JSON; `onError` is told once when the stream drops for good (the browser retries on its own
 * first).
 */
export function streamEvents<T>(
  path: string,
  onEvent: (event: T) => void,
  onError?: (error: Error) => void,
): () => void {
  if (typeof EventSource === "undefined") {
    onError?.(new Error("this browser can't follow live updates"));
    return () => {};
  }
  const source = new EventSource(`${apiUrl}${path}`);
  source.onmessage = (m: MessageEvent<string>) => {
    try {
      onEvent(JSON.parse(m.data) as T);
    } catch {
      // A line that isn't JSON (a comment or keep-alive) is ignored.
    }
  };
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) onError?.(new Error("the live updates stopped"));
  };
  return () => source.close();
}

export const byoaApi = {
  /** POST /previews/session: sign in with the wallet once; the session authorises its previews. */
  signIn: async (
    sign: Signer,
    wallet: string,
    /** The same session either way; previews' and agents' pages each use their own path. */
    path: "/previews/session" | "/self/session" = "/previews/session",
  ): Promise<PreviewSession> => {
    const timestamp = now();
    const signature = await sign({
      message: byoaMessage({
        action: "sign-in",
        chainId: deployment.chainId,
        wallet,
        timestamp,
      }),
    });
    return request<PreviewSession>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chainId: deployment.chainId, wallet, timestamp, signature }),
    });
  },
  /**
   * GET /previews/allowance?wallet=&world=: can this wallet start a preview in this world now.
   * Each world has its own daily preview. No sign-in needed.
   */
  previewAllowance: (wallet: string, world: PreviewWorld = "vault") =>
    request<PreviewAllowance>(
      `/previews/allowance?wallet=${encodeURIComponent(wallet)}&world=${world}`,
    ),
  /** GET /previews: the signed-in wallet's previews, newest first. */
  listPreviews: (session: string): Promise<{ items: PreviewRecord[] }> =>
    request<{ items: PreviewRecord[] }>("/previews", bearer(session)).then((r) => ({
      ...r,
      items: r.items.map(codedPreview),
    })),
  /** POST /previews: a new preview with its mode and connection. Nothing is made on chain. */
  createPreview: (
    session: string,
    input: { mode: RemoteMode; connection: Connection; world?: PreviewWorld },
  ) =>
    request<PreviewRecord>("/previews", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer(session).headers },
      body: JSON.stringify(input),
    }),
  /** GET /previews/:id. */
  preview: (session: string, id: string): Promise<PreviewRecord> =>
    request<PreviewRecord>(subjectPath({ kind: "preview", id }), bearer(session)).then(
      codedPreview,
    ),
  /**
   * POST …/runner-token: a runner token, shown once. With a session, no signature; an agent's
   * owner without one signs the existing request.
   */
  createRunnerToken: (
    subject: Subject,
    auth: Auth,
  ): Promise<{ token: string; gatewayUrl: string | null }> =>
    subject.kind === "agent" && !auth.session && auth.sign
      ? createRunnerToken(auth.sign, subject.agentId)
      : write("POST", `${subjectPath(subject)}/runner-token`, subject, auth, "runner-token"),
  /** DELETE /self/agents/:id/runner-token, with the session (or the owner's signature). */
  revokeRunnerToken: (agentId: string, auth: Auth): Promise<{ revoked: number }> =>
    !auth.session && auth.sign
      ? revokeRunnerToken(auth.sign, agentId)
      : request<{ revoked: number }>(`/self/agents/${agentId}/runner-token`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json", ...bearer(auth.session!).headers },
          body: "{}",
        }),
  /** POST /self/agents/:id/rate, with the session (or the owner's signature). */
  rateAgent: (agentId: string, auth: Auth): Promise<{ runId: string }> =>
    !auth.session && auth.sign
      ? requestRating(auth.sign, agentId)
      : request<{ runId: string }>(`/self/agents/${agentId}/rate`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...bearer(auth.session!).headers },
          body: "{}",
        }),
  /** GET …/agent-url: the owner's view of the Agent URL (the URL itself), with the session. */
  agentUrl: (subject: Subject, session: string) =>
    request<{ connection: Connection; agentUrl: (AgentUrlInfo & { url: string }) | null }>(
      `${subjectPath(subject)}/agent-url`,
      bearer(session),
    ),
  /** POST /streams/token: a short-lived token that opens one check's or rating's live stream. */
  streamToken: (
    session: string,
    target: { checkId: string } | { runId: string } | { previewId: string },
  ) =>
    request<{ token: string; expiresAt: string }>("/streams/token", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer(session).headers },
      body: JSON.stringify(target),
    }),
  /**
   * POST …/agent-url/verify: Bonded challenges the saved URL, signed with its secret, and the
   * agent must answer with the challenge and its proof within 10 s (after it was given the secret, or after a redeploy). 422
   * with the reason otherwise.
   */
  reverifyAgentUrl: (subject: Subject, auth: Auth, url: string) =>
    write<{
      verified: boolean;
      url: string;
      verifiedAt: string | null;
      version: string | null;
      codeHash: CodeHashInfo | null;
    }>("POST", `${subjectPath(subject)}/agent-url/verify`, subject, auth, "agent-url", {}, { url }),
  /**
   * POST …/agent-url/secret: a new secret for the saved URL, shown once. The old one stops
   * working at once; the URL must be verified again, and checked again.
   */
  newAgentUrlSecret: (subject: Subject, auth: Auth, url: string) =>
    write<AgentUrlRegistered>(
      "POST",
      `${subjectPath(subject)}/agent-url/secret`,
      subject,
      auth,
      "agent-url",
      {},
      { url },
    ),
  /**
   * GET /previews/:id/events (SSE): its status, queue place and progress as they change. Ends
   * when it is over, or after 10 quiet minutes; reopened with a fresh token before one expires.
   */
  previewEvents: (
    session: string,
    previewId: string,
    onEvent: (event: PreviewEvent) => void,
    onError?: (error: Error) => void,
  ) =>
    tokenStream<PreviewEvent>(
      session,
      { previewId },
      `/previews/${encodeURIComponent(previewId)}/events`,
      onEvent,
      onError,
      true,
    ),
  /** DELETE …/agent-url: stop using the Agent URL; a registered agent goes back to its runner. */
  revokeAgentUrl: (subject: Subject, auth: Auth) =>
    write<{ revoked: number }>(
      "DELETE",
      `${subjectPath(subject)}/agent-url`,
      subject,
      auth,
      "agent-url",
      {},
      { url: "none" },
    ),
  /**
   * POST …/agent-url: save the agent's HTTPS endpoint and make its secret (shown once). Nothing
   * calls the URL yet: the owner gives the agent the secret, then verifies (reverifyAgentUrl).
   */
  registerAgentUrl: (subject: Subject, auth: Auth, url: string) =>
    write<AgentUrlRegistered>(
      "POST",
      `${subjectPath(subject)}/agent-url`,
      subject,
      auth,
      "agent-url",
      { url },
      { url },
    ),
  /** POST …/checks: start a connection check: one benign episode, never scored. */
  startCheck: (subject: Subject, auth: Auth) =>
    write<{ checkId: string }>("POST", `${subjectPath(subject)}/checks`, subject, auth, "check"),
  /** GET /checks/:id: the events so far, for its owner. */
  check: (checkId: string, session: string): Promise<CheckRecord> =>
    request<CheckRecord>(`/checks/${encodeURIComponent(checkId)}`, bearer(session)).then((k) => ({
      ...k,
      events: k.events.map(codedEvent),
      ...(k.result !== undefined ? { result: codedCheck(k.result) } : {}),
    })),
  /**
   * GET /checks/:id/events (SSE): each event as it happens, ending with `result`. Opened with a
   * stream token (EventSource can't send the session); a check is over well within its life.
   */
  checkEvents: (
    checkId: string,
    session: string,
    onEvent: (event: CheckEvent) => void,
    onError?: (error: Error) => void,
  ) =>
    tokenStream<CheckEvent>(
      session,
      { checkId },
      `/checks/${encodeURIComponent(checkId)}/events`,
      (e) => onEvent(codedEvent(e)),
      onError,
    ),
  /** GET …/estimate: from the latest passing check; 409 without one. */
  estimate: (subject: Subject, session?: string) =>
    request<CostEstimate>(`${subjectPath(subject)}/estimate`, maybeBearer(session)),
  /**
   * POST /previews/:id/rate: start the preview rating. 202 with the run id (and its place in the
   * queue); 409 without a passing check; 429 past the limits, with `retryAt`.
   */
  startPreviewRating: (session: string, id: string) =>
    request<{ runId: string; queue?: { position: number } | null }>(
      `${subjectPath({ kind: "preview", id })}/rate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bearer(session).headers },
      },
    ),
  /** GET /ratings/:id/progress (SSE): counts and time left, never verdicts. */
  ratingProgress: (
    runId: string,
    session: string,
    onProgress: (progress: RatingProgress) => void,
    onError?: (error: Error) => void,
  ) =>
    tokenStream<RatingProgress>(
      session,
      { runId },
      `/ratings/${encodeURIComponent(runId)}/progress`,
      onProgress,
      onError,
      // A rating outlives one token: reopen with a fresh one before it expires. Progress is a
      // state, not a list of events, so reopening repeats nothing.
      true,
    ),
  /** GET …/notifications: where the result is sent, masked. */
  notifications: (subject: Subject, session?: string) =>
    request<NotificationSettings>(`${subjectPath(subject)}/notifications`, maybeBearer(session)),
  /**
   * PUT …/notifications: set or clear the webhook and the email. A new webhook gets a signing
   * secret, shown once.
   */
  saveNotifications: (
    subject: Subject,
    auth: Auth,
    /** Leave a field out to keep it; null clears it. */
    input: { webhookUrl?: string | null; email?: string | null },
  ) =>
    write<NotificationSettings & { webhookSecret?: string | null }>(
      "PUT",
      `${subjectPath(subject)}/notifications`,
      subject,
      auth,
      "notifications",
      input,
      { webhook: input.webhookUrl ?? "none", email: input.email ?? "none" },
    ),
  /**
   * GET /ratings/compare?from=&to=: two ratings side by side (score, expected loss, breaches per
   * class). With the session, so a preview's owner can compare their previews.
   */
  compareRatings: (from: string, to: string, session?: string) =>
    request<RatingCompare>(
      `/ratings/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      maybeBearer(session),
    ),
  /**
   * GET …/suggested-mandate: the tokens and contracts the agent used in its passing check and
   * preview, its largest trade, and the presets built from them. Owner only (session).
   */
  suggestedMandate: (subject: Subject, session: string) =>
    request<SuggestedMandate>(`${subjectPath(subject)}/suggested-mandate`, bearer(session)),
  /** GET /self/agents/:id/vault-activity: trades through its vault from the agent key. Public. */
  vaultActivity: (agentId: string) =>
    request<VaultActivityRecord>(`/self/agents/${agentId}/vault-activity`),
  /** GET /self/agents/:id/health: everything the owner needs to know at a glance (session). */
  agentHealth: (agentId: string, session: string) =>
    request<AgentHealth>(`/self/agents/${agentId}/health`, bearer(session)),
  /**
   * GET /self/notifications/inbox?limit=&before=&unread=1: the signed-in wallet's in-app
   * notifications, newest first, with the unread count and the id to page from (`next`).
   */
  inbox: (session: string, page: { limit?: number; before?: string; unread?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (page.limit) q.set("limit", String(page.limit));
    if (page.before) q.set("before", page.before);
    if (page.unread) q.set("unread", "1");
    const query = q.toString();
    return request<InboxPage>(
      `/self/notifications/inbox${query ? `?${query}` : ""}`,
      bearer(session),
    );
  },
  /** GET /self/notifications: the signed-in owner's settings, with what is muted. */
  ownerNotifications: (session: string) =>
    request<NotificationSettings>("/self/notifications", bearer(session)),
  /** PUT /self/notifications { muted }: the full list of types to turn off (replaces the saved one). */
  saveMuted: (session: string, muted: string[]) =>
    request<NotificationSettings>("/self/notifications", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...bearer(session).headers },
      body: JSON.stringify({ muted }),
    }),
  /** POST /self/notifications/inbox/read: mark these read, or everything up to `through`. */
  markInboxRead: (session: string, which: { ids: string[] } | { through: string }) =>
    request<{ marked: number }>("/self/notifications/inbox/read", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer(session).headers },
      body: JSON.stringify(which),
    }),
  /** GET /status: the public service status (cached by the API). */
  status: () => request<ServiceStatus>("/status"),
};

/**
 * A live stream opened with a stream token from the session. With `refresh`, it is reopened
 * with a new token 30 seconds before the old one expires.
 */
function tokenStream<T>(
  session: string,
  target: { checkId: string } | { runId: string } | { previewId: string },
  path: string,
  onEvent: (event: T) => void,
  onError?: (error: Error) => void,
  refresh = false,
): () => void {
  let closed = false;
  let stop = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const open = async () => {
    try {
      const { token, expiresAt } = await byoaApi.streamToken(session, target);
      if (closed) return;
      stop();
      stop = streamEvents<T>(`${path}?token=${encodeURIComponent(token)}`, onEvent, onError);
      if (refresh)
        timer = setTimeout(
          () => void open(),
          Math.max(10_000, Date.parse(expiresAt) - Date.now() - 30_000),
        );
    } catch (e) {
      if (!closed) onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  };
  void open();
  return () => {
    closed = true;
    clearTimeout(timer);
    stop();
  };
}
