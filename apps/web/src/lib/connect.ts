import type { RemoteMode } from "@bondedhq/shared";
import { ApiError, type RunnerRecord } from "./api";
import { isLocal } from "../config";
import { SURFACE_LABELS } from "./byoa";
import type {
  AgentUrlInfo,
  CheckEvent,
  CheckSummary,
  CodeHashInfo,
  Connection,
  CostEstimate,
  PreviewRecord,
  PreviewSession,
  RatingProgress,
} from "./byoa-api";

/**
 * How an agent is connected, the same for a preview and an agent on chain, so one set of
 * components (connect, check, rate) serves both. Plain functions, so every state is testable.
 */
export interface ConnectionStatus {
  connection: Connection;
  mode: RemoteMode;
  hasToken: boolean;
  runner: RunnerRecord["runner"];
  /** Why a runner that is there doesn't count. */
  problem: string | null;
  agentUrl: AgentUrlInfo | null;
  lastCheck: CheckSummary | null;
  /**
   * The API's own passing check of exactly this connection, when it says (previews do); when
   * undefined, the last check stands in for it.
   */
  passing?: CheckSummary | null;
  /** The API's word on whether Bonded can reach the agent now, when it gives one. */
  ready?: boolean;
  codeHash: CodeHashInfo | null;
  gatewayUrl: string | null;
}

export function statusFromRunner(
  record: RunnerRecord | undefined,
  mode: RemoteMode,
  declaredCodeHash?: string,
): ConnectionStatus {
  return {
    connection: record?.connection ?? (record?.agentUrl ? "url" : "runner"),
    mode,
    hasToken: Boolean(record?.token),
    runner: record?.runner ?? null,
    problem: record?.problem ?? null,
    agentUrl: record?.agentUrl ?? null,
    lastCheck: record?.lastCheck ?? null,
    codeHash:
      record?.codeHash ??
      (declaredCodeHash ? { value: declaredCodeHash, source: "declared" } : null),
    gatewayUrl: record?.gatewayUrl ?? null,
  };
}

export function statusFromPreview(p: PreviewRecord): ConnectionStatus {
  return {
    connection: p.connection,
    mode: p.mode,
    hasToken: p.hasRunnerToken,
    runner: p.runner,
    problem: p.problem ?? null,
    agentUrl: p.agentUrl,
    lastCheck: p.lastCheck,
    ...(p.passingCheck !== undefined ? { passing: p.passingCheck } : {}),
    ...(p.ready !== undefined ? { ready: p.ready } : {}),
    codeHash: p.codeHash,
    gatewayUrl: p.gatewayUrl,
  };
}

/** Bonded can reach the agent through its chosen connection right now. */
export function isConnected(s: ConnectionStatus, connection = s.connection): boolean {
  if (s.ready !== undefined && connection === s.connection) return s.ready;
  return connection === "url"
    ? Boolean(s.agentUrl?.verifiedAt)
    : s.runner?.connected === true && !s.problem;
}

/** A check that passed, for the current connection, and hasn't expired: a rating may start. */
export function passingCheck(
  s: Pick<ConnectionStatus, "lastCheck" | "connection" | "passing">,
  nowMs = Date.now(),
): CheckSummary | undefined {
  const c = s.passing !== undefined ? s.passing : s.lastCheck;
  if (!c || c.status !== "passed" || c.connection !== s.connection) return undefined;
  const expires = c.expiresAt ? Date.parse(c.expiresAt) : Date.parse(c.createdAt) + 86_400_000;
  return expires > nowMs ? c : undefined;
}

/** "9 h", "25 min", "a minute": how long until a time. */
export function waitFor(untilIso: string, nowMs = Date.now()): string {
  const s = Math.max(0, (Date.parse(untilIso) - nowMs) / 1000);
  if (s < 90) return "a minute";
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

/** Seconds as "about 4 min" or "about 1 h 20 min". */
export function duration(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
  const min = Math.round(seconds / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

/**
 * A refused request in plain words, with when to try again if the API says. Known refusals get
 * the page's own wording; anything else is shown as the API gives it.
 */
export function refusal(error: unknown, nowMs = Date.now()): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const retryAt = typeof error.details.retryAt === "string" ? error.details.retryAt : undefined;
  // The API puts a waiting rating's place in `queue.position` (how many are ahead of it).
  const queue = error.details.queue as { position?: unknown } | undefined;
  const position = typeof queue?.position === "number" ? queue.position : undefined;
  if (error.status === 429 && retryAt) {
    const wait = waitFor(retryAt, nowMs);
    if (/preview/i.test(error.message) && /wallet|today|daily|per day/i.test(error.message))
      return `You've used today's preview; try again in ${wait}.`;
    return `${error.message.replace(/[.;]\s*$/, "")}. Try again in ${wait}.`;
  }
  if (position !== undefined) return queueLine(position);
  return undefined;
}

/** Where a waiting preview stands: `ahead` is how many ratings will run before it. */
export function queueLine(ahead: number): string {
  if (ahead <= 0) return "It's next: it starts in a moment.";
  if (ahead === 1) return "Previews are busy; you're next in line.";
  return `Previews are busy; ${ahead} are ahead of you. It starts on its own.`;
}

/** What to do about a problem the check found. The problem itself is the API's sentence. */
export function problemAdvice(problem: string, connection: Connection): string | undefined {
  const p = problem.toLowerCase();
  if (p.includes("never called a tool"))
    return connection === "url"
      ? "Make sure your handler uses the endpoints in the episode it receives (MCP or HTTP tools), not a fixed address."
      : "Make sure your agent reads BONDED_MCP_URL or BONDED_TOOLS_URL and calls the tools there. The framework snippets above do it in one call.";
  if (p.includes("exited with code") || p.includes("crashed"))
    return "Run your agent command on its own to see the error, fix it, then run the check again.";
  if (p.includes("didn't make the trade") || p.includes("did not make the trade"))
    return "Its task names one trade. Make the swap it names (the swap tool, or a signed execute in chain mode), then call done.";
  if (p.includes("surfaces") && p.includes("untested"))
    return "Read every source (inbox, news, social, prices, transfers, report, alerts, counterparty messages, token info): attack classes your agent never reads score as untested, which lowers the score.";
  if (p.includes("runner isn't connected") || p.includes("runner is not connected"))
    return "Start the runner with the command above and leave it running, then run the check again.";
  if (p.includes("nothing accepted a connection") || p.includes("couldn't reach your url"))
    return "Start your agent, and check that this address reaches it from outside your network.";
  if (p.includes("closed the connection"))
    return "Your server dropped the request: look at its log for an error while answering.";
  if (p.includes("not with json") || p.includes("to the check; it must be 200"))
    return 'Answer the verify request with 200 and JSON { "challenge", "proof", "version"? }, where proof is the hex HMAC-SHA256 of "verify." + the challenge, keyed with your agent secret. createBondedHandler (@bondedhq/sdk/agent-url) or answerAgentUrlVerify does it for you; the guide shows how.';
  if (p.includes("public internet"))
    return "Bonded can only call a public address. For an agent on your machine, use the runner instead.";
  if (p.includes("answered 401") || p.includes("agent secret"))
    return "Check that your agent uses the agent secret you were shown (bonded_as_…) to verify the bonded-signature header. Lost it? Use “Lost the secret? Get a new one” on this page.";
  if (p.includes("didn't answer within") || p.includes("did not answer within"))
    return "Your endpoint must reply within 10 seconds: answer the POST straight away and do the work after replying.";
  if (p.includes("answered 4") || p.includes("answered 5"))
    return "Check the URL and that your server is up. It must answer the episode POST with a 2xx within 10 seconds.";
  if (p.includes("signature"))
    return "Check the bonded-signature header with the agent secret you were shown (HMAC-SHA256 of the timestamp, a dot and the raw body).";
  if (p.includes("timed out") || p.includes("deadline") || p.includes("ran out of time"))
    return "Answer the POST straight away and keep working after replying; call done before the deadline.";
  if (p.includes("tls") || p.includes("certificate"))
    return "Your URL's certificate wasn't accepted. It needs a valid public certificate.";
  if (/\bmodel usage\b|\busage\b/.test(p))
    return "If your agent uses a model, send its usage with done ({ inputTokens, outputTokens, costUsd }) and the estimate shows what a rating costs you. An agent with no model has nothing to send.";
  if (/\bmode\b/.test(p))
    return "Start the runner in the mode you chose here (add --mode chain for chain mode).";
  return undefined;
}

/** One check event as a line of the live timeline. */
export function eventLine(event: CheckEvent): { text: string; ok: boolean | null } {
  switch (event.type) {
    case "started":
      return { text: "Episode started: your agent got its task", ok: null };
    case "tool": {
      const surface = event.surface
        ? ` (read ${SURFACE_LABELS[event.surface] ?? event.surface})`
        : "";
      return event.ok
        ? { text: `Called ${event.name}${surface}`, ok: true }
        : { text: `Called ${event.name}${surface}: ${event.error ?? "it failed"}`, ok: false };
    }
    case "tx":
      return event.ok
        ? { text: "Sent a transaction to its vault", ok: true }
        : { text: `A transaction was refused: ${event.reason ?? "no reason given"}`, ok: false };
    case "done": {
      const exit =
        event.exitCode === undefined || event.exitCode === null
          ? ""
          : event.exitCode === 0
            ? ", exit code 0"
            : `, exit code ${event.exitCode}`;
      return {
        text: `Finished after ${duration(event.durationMs / 1000)}${exit}`,
        ok: event.exitCode ? false : null,
      };
    }
    case "result":
      return event.passed
        ? { text: "The check passed", ok: true }
        : { text: "The check found problems", ok: false };
  }
}

/** The estimate in two lines: time, and the agent's own model cost when it reported usage. */
export function estimateLines(e: CostEstimate): { time: string; cost: string } {
  const time = `About ${duration(e.total.seconds)} for ${e.episodes} episodes (${duration(e.perEpisode.seconds)} and ${e.perEpisode.toolCalls} tool calls each in the check).`;
  const cost =
    e.total.costUsd != null
      ? `Your model costs about $${e.total.costUsd.toFixed(2)} in all ($${(e.perEpisode.costUsd ?? e.total.costUsd / e.episodes).toFixed(3)} an episode). Bonded doesn't pay or limit it.`
      : `${e.note ?? "Your agent didn't report its usage at done, so there's no cost estimate: send usage with done to get one."} Bonded doesn't pay or limit your model calls.`;
  return { time, cost };
}

/** Where the code hash came from, in words. */
export function codeSourceLabel(info: CodeHashInfo): string {
  const detail = info.detail ? ` (${info.detail})` : "";
  const byRunner = ", reported by the runner";
  switch (info.source) {
    case "declared":
      return "you entered it";
    case "flag":
      return `the runner's --code-hash flag${byRunner}`;
    case "env":
      return `BONDED_CODE_HASH on the runner${byRunner}`;
    case "image":
      return `the Docker image digest${detail}${byRunner}`;
    case "git":
      return `the git commit of your agent's folder${detail}${byRunner}`;
    case "git-dirty":
      return `the git commit of your agent's folder${detail}, with uncommitted changes${byRunner}`;
    case "unpinned":
      return `your agent's command and entry file, not pinned to a version (set a git commit or image digest)${byRunner}`;
    case "url":
    case "url-version": // the older name
      return info.detail
        ? `the version your agent reported (${info.detail})`
        : "the version your agent reported";
    default:
      // A source this page doesn't know yet: say who reported it, never that it's verified.
      return (
        info.label ??
        `${String(info.source)}${info.reportedBy === "agent" ? ", reported by your agent" : byRunner}`
      );
  }
}

/** A progress line: "41 of 56 episodes, about 9 min left". */
export function progressText(p: RatingProgress | undefined): string {
  if (!p || (!p.done && !p.total)) return "Waiting for the first episode";
  if (p.total && p.done >= p.total) return `All ${p.total} episodes ran; working out the score`;
  const of = p.total ? ` of ${p.total}` : "";
  const eta = p.etaSeconds == null ? "" : `, about ${duration(p.etaSeconds)} left`;
  return `${p.done}${of} episodes${eta}`;
}

/** An Agent URL must be public https. The API checks again, more strictly, when it connects. */
export function agentUrlError(
  text: string,
  /** The local demo: its API accepts plain http on this machine, so the page does too. */
  options: { allowLoopback?: boolean } = { allowLoopback: isLocal },
): string | null {
  const t = text.trim();
  if (!t) return "Paste your agent's URL.";
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return "That isn't a URL. It looks like https://my-agent.example.com/bonded.";
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
  if (options.allowLoopback && loopback && ["http:", "https:"].includes(url.protocol)) return null;
  if (url.protocol !== "https:") return "It must start with https://.";
  if (url.username || url.password) return "Leave the user name and password out of the URL.";
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.startsWith("[")
  )
    return "Bonded can only call a public address. For an agent on your machine, use the runner instead.";
  return null;
}

/** A webhook must be https; empty clears it. */
export function webhookError(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  try {
    return new URL(t).protocol === "https:" ? null : "It must start with https://.";
  } catch {
    return "That isn't a URL.";
  }
}

export function emailError(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? null : "That doesn't look like an email address.";
}

/**
 * The preview session lives in this tab's session storage, so a reload keeps the user signed in
 * and a new tab asks again. It authorises only this wallet's previews.
 */
const sessionKey = (chainId: number, wallet: string) =>
  `bonded:preview-session:${chainId}:${wallet.toLowerCase()}`;

/** Fired when this tab signs in or out, so every part of the page sees the same session. */
export const SESSION_EVENT = "bonded:session";
const announce = () => {
  try {
    window.dispatchEvent(new Event(SESSION_EVENT));
  } catch {
    // No window (tests without a DOM): nothing to tell.
  }
};

export function saveSession(chainId: number, s: PreviewSession) {
  try {
    sessionStorage.setItem(sessionKey(chainId, s.wallet), JSON.stringify(s));
  } catch {
    // Storage can be off (private windows); the user signs in again next time.
  }
  announce();
}

export function loadSession(
  chainId: number,
  wallet: string | undefined,
  nowMs = Date.now(),
): PreviewSession | undefined {
  if (!wallet) return undefined;
  try {
    const raw = sessionStorage.getItem(sessionKey(chainId, wallet));
    if (!raw) return undefined;
    const s = JSON.parse(raw) as PreviewSession;
    return Date.parse(s.expiresAt) > nowMs ? s : undefined;
  } catch {
    return undefined;
  }
}

export function clearSession(chainId: number, wallet: string) {
  try {
    sessionStorage.removeItem(sessionKey(chainId, wallet));
  } catch {
    // Nothing to clear.
  }
  announce();
}

/** The steps of "Test your agent", in order. */
export const PREVIEW_STEPS = [
  "sign-in",
  "choose",
  "connect",
  "check",
  "start",
  "rating",
  "report",
] as const;
export type PreviewStep = (typeof PREVIEW_STEPS)[number];

/** Which step a preview is on, from what exists. */
export function previewStep(input: {
  signedIn: boolean;
  preview: PreviewRecord | undefined;
  runFinished?: boolean;
  nowMs?: number;
}): PreviewStep {
  const { preview } = input;
  if (!input.signedIn) return "sign-in";
  if (!preview) return "choose";
  if (preview.ratingId) {
    if (input.runFinished || ["done", "failed", "refused", "stopped"].includes(preview.status))
      return "report";
    return "rating";
  }
  if (["refused", "stopped", "failed"].includes(preview.status) && !preview.ratingId)
    return "start";
  const status = statusFromPreview(preview);
  if (passingCheck(status, input.nowMs)) return "start";
  if (isConnected(status)) return "check";
  return "connect";
}

/** The wallet's latest preview before `p` that finished with a score, to compare against. */
export function previewBefore(
  p: PreviewRecord,
  items: PreviewRecord[] | undefined,
): PreviewRecord | undefined {
  return (items ?? [])
    .filter(
      (x) =>
        x.id !== p.id &&
        x.ratingId &&
        x.status === "done" &&
        Date.parse(x.createdAt) < Date.parse(p.createdAt),
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
}
