import { ago } from "./format";
import { ethText } from "./wallet-help";

/**
 * An agent's health at a glance (launch items 4.2, 4.3, 4.5, 6.1, 6.2 and 7.2), as the API's
 * health, vault-activity, notifications and status endpoints give it, and the lines the page
 * shows for each. Plain functions, so each state is testable.
 */

/** Trades through the vault (or module) from the agent key, from the keeper's index. */
export interface VaultActivity {
  firstTradeAt: string | null;
  lastTradeAt: string | null;
  trades24h: number;
  trades7d?: number;
  total?: number;
  lastTxHash: string | null;
}

/**
 * The agent key's gas: it pays for its own `execute` calls. `GET /self/agents/:id` and
 * `…/vault-activity` give `balanceWei`; the health panel gives the same as `balance` (wei, a
 * decimal string) with the key's `address`.
 */
export interface AgentGas {
  address?: string | null;
  balanceWei?: string;
  balance?: string;
  balanceEth?: number;
  low: boolean;
  /** Trades the balance pays for at today's gas price; null when the price is unknown. */
  estimatedTradesLeft?: number | null;
  /** Where the per-trade gas comes from: the agent's own recent trades, or an assumed typical one. */
  basis?: "measured" | "assumed";
  gasPerTrade?: string;
}

/** The balance in wei, whichever field the endpoint used. */
export const gasWei = (g: AgentGas): string | undefined => g.balanceWei ?? g.balance;

/** The cover on the vault, as the chain has it. Amounts in base-asset units (6 decimals). */
export interface ChainCover {
  policyId: string;
  status: string;
  active: boolean;
  coverAmount: string;
  remainingCover: string;
  endsAt: string;
  paidUntil: string;
  pastDueSince: string | null;
  lapsesAt: string | null;
}

/** GET /self/agents/:id/vault-activity (public chain data). */
export interface VaultActivityRecord extends VaultActivity {
  vault: string;
  agentKey: string | null;
  frozen: boolean | null;
  coverWithoutVaultTrades: boolean;
  agentGas: AgentGas | null;
  cover: ChainCover | null;
}

/** "bonded": one of Bonded's own designs, run in the Arena, so there is nothing to connect. */
export type RunnerHealth = "connected" | "offline" | "never" | "url" | "bonded";
export type CoverHealth = "active" | "none" | "past-due" | "grace" | "lapsed";

/** A problem in a sentence, with its code and what to do about it. */
export interface HealthProblem {
  code: string;
  severity: "problem" | "warning";
  message: string;
  action?: string;
}

/** GET /self/agents/:id/health (session). */
export interface AgentHealth {
  agentId?: string;
  score: {
    value: number;
    tier: string;
    expiresAt: string;
    valid: boolean;
    status?: "current" | "expiring" | "expired";
    issuedAt?: string;
    runId?: string;
    txHash?: string;
  } | null;
  runner: {
    status: RunnerHealth;
    lastSeenAt?: string | null;
    verified?: boolean;
    version?: string | null;
    mode?: string | null;
  };
  vault: {
    address: string;
    protection?: string;
    agentKey: string | null;
    frozen: boolean | null;
    activity: VaultActivity;
  } | null;
  gas: AgentGas | null;
  cover: (Partial<ChainCover> & { status: CoverHealth; amount?: string | null }) | null;
  nextRatingAt: string | null;
  nextRating?: { status: string; at: string | null; reason: string | null };
  /** Active cover but no trade through the vault in the last 7 days (or ever). */
  coverWithoutVaultTrades?: boolean;
  problems: HealthProblem[];
  /** No open problem (warnings can remain). */
  ok?: boolean;
}

/** A cover amount from the chain (6 decimals) in whole tokens, for a line of text. */
export function coverTokens(amount: string | number | null | undefined): string | undefined {
  if (amount === null || amount === undefined) return undefined;
  if (typeof amount === "number") return amount.toLocaleString("en-US");
  try {
    return (Number(BigInt(amount)) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });
  } catch {
    return undefined;
  }
}

export type Tone = "safe" | "warn" | "breach" | "neutral";

/** How the vault's trading reads. */
export function vaultTradingLine(
  a: VaultActivity | null | undefined,
  nowMs = Date.now(),
): { text: string; tone: Tone } {
  if (!a) return { text: "Not known yet.", tone: "neutral" };
  if (!a.lastTradeAt)
    return {
      text: "No trade through the vault yet. Until your agent trades through it, the mandate doesn't protect anything.",
      tone: "warn",
    };
  const recent = Date.parse(a.lastTradeAt) > nowMs - 7 * 86_400_000;
  const day = a.trades24h
    ? `${a.trades24h} trade${a.trades24h === 1 ? "" : "s"} in the last 24 hours`
    : "none in the last 24 hours";
  return {
    text: `Last trade through the vault ${ago(a.lastTradeAt, nowMs)}; ${day}.`,
    tone: recent ? "safe" : "warn",
  };
}

export const COVER_WITHOUT_TRADES =
  "This agent has cover, but it hasn't traded through its vault in the last 7 days. Cover pays only for what goes through the vault: if your agent trades from another wallet, those trades aren't covered.";

/** The low-gas notice, or undefined when there's enough. */
export function gasNotice(gas: AgentGas | null | undefined): string | undefined {
  if (!gas?.low) return undefined;
  const wei = gasWei(gas);
  let balance = "little ETH";
  try {
    if (wei !== undefined) balance = ethText(BigInt(wei));
  } catch {
    balance = wei ?? balance;
  }
  // Say what the estimate rests on: the agent's own trades, or an assumed typical trade.
  const basis =
    gas.basis === "measured"
      ? " (from its recent trades)"
      : gas.basis === "assumed"
        ? " (assuming a typical trade's gas)"
        : "";
  const left =
    gas.estimatedTradesLeft != null
      ? ` That's enough for about ${gas.estimatedTradesLeft} more trade${gas.estimatedTradesLeft === 1 ? "" : "s"}${basis}.`
      : "";
  return `Your agent's key is low on gas: it has ${balance}, and it pays the gas for every trade through the vault.${left}`;
}

export const RUNNER_TEXT: Record<RunnerHealth, { label: string; tone: Tone }> = {
  connected: { label: "Runner connected", tone: "safe" },
  offline: { label: "Runner offline", tone: "warn" },
  never: { label: "Runner never connected", tone: "neutral" },
  url: { label: "Agent URL", tone: "safe" },
  bonded: { label: "Run by Bonded", tone: "safe" },
};

export const COVER_TEXT: Record<CoverHealth, { label: string; tone: Tone }> = {
  active: { label: "Cover active", tone: "safe" },
  none: { label: "No cover", tone: "neutral" },
  "past-due": { label: "Premium past due", tone: "warn" },
  grace: { label: "Cover in grace period", tone: "warn" },
  lapsed: { label: "Cover lapsed", tone: "breach" },
};

/** The score's line: valid until when, expiring soon, or expired. */
export function scoreLine(
  s: AgentHealth["score"],
  nowMs = Date.now(),
): { text: string; tone: Tone } {
  if (!s) return { text: "Not rated yet", tone: "neutral" };
  const left = Date.parse(s.expiresAt) - nowMs;
  if (s.status === "expired" || left <= 0)
    return { text: `Score ${s.value} expired`, tone: "breach" };
  // Valid only when not superseded by a stopped rating.
  if (!s.valid) return { text: `Score ${s.value} superseded`, tone: "breach" };
  const days = Math.floor(left / 86_400_000);
  if (days < 7)
    return {
      text: `Score ${s.value} (${s.tier}) expires in ${days === 0 ? "less than a day" : `${days} day${days === 1 ? "" : "s"}`}`,
      tone: "warn",
    };
  return { text: `Score ${s.value} (${s.tier}), valid for ${days} more days`, tone: "safe" };
}

/** GET /self/notifications/inbox (session): one of the owner's in-app notifications. */
export interface InboxItem {
  id: string;
  /** The type in kebab-case, e.g. score-expiring, runner-offline, breach-recorded, low-gas. */
  kind: string;
  /** The type as the settings name it (snake_case), e.g. low_gas: what `muted` lists. */
  type?: string;
  /** Its troubleshooting entry, when it has one. */
  code?: string | null;
  /** The title, in a sentence. */
  message: string;
  /** What to do about it. */
  action?: string | null;
  createdAt: string;
  agentId?: string | null;
  previewId?: string | null;
  subject?: string | null;
  read?: boolean;
}

/** A page of the inbox: newest first, the unread count and the id to page on from. */
export interface InboxPage {
  items: InboxItem[];
  unread?: number;
  next?: string | null;
}

/**
 * The words to show for a notification: a title with a capital, and the "what to do" line under
 * it, unless that only says the title again. The API reuses an email subject for a rating's title
 * ("your preview rating finished") next to the full sentence ("Your preview rating finished with
 * a score of 35 (B)."), so when the sentence starts with the title it becomes the title.
 */
export function inboxLines(i: Pick<InboxItem, "message" | "action">): {
  title: string;
  detail?: string;
} {
  const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  const bare = (t: string) =>
    t
      .trim()
      .replace(/[.\s]+$/, "")
      .toLowerCase();
  const title = capital(i.message.trim());
  const action = i.action?.trim();
  if (!action || bare(action) === bare(title)) return { title };
  if (bare(action).startsWith(bare(title))) return { title: capital(action) };
  return { title, detail: action };
}

const SEEN_KEY = "bonded:inbox-seen";

/** When this browser last opened the inbox: what's newer counts as unread. */
export function inboxSeenAt(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

export function markInboxSeen(nowMs = Date.now()) {
  try {
    localStorage.setItem(SEEN_KEY, String(nowMs));
  } catch {
    // Storage off: everything stays unread, which is harmless.
  }
}

/**
 * Unread notifications: the API's own count when it gives one, else from each item's `read`, else
 * newer than this browser's last visit.
 */
export function unreadCount(page: InboxPage | InboxItem[], seenAt = inboxSeenAt()): number {
  const items = Array.isArray(page) ? page : page.items;
  if (!Array.isArray(page) && typeof page.unread === "number") return page.unread;
  return items.filter((i) => (i.read !== undefined ? !i.read : Date.parse(i.createdAt) > seenAt))
    .length;
}

/** One lane of work: connection checks, or remote ratings and previews. */
export interface LaneStatus {
  healthy: boolean;
  queued?: number;
  oldestQueuedSeconds?: number | null;
  lastJobAgeSeconds: number | null;
  /** Jobs being worked on now, and how long ago the oldest of them started. */
  running?: number;
  oldestRunningSeconds?: number | null;
  /** Running jobs whose lease expired: probably stuck. Any makes the lane unhealthy. */
  staleRunning?: number;
}

/** A lane is healthy only if the API says so and none of its running jobs looks stuck. */
export const laneHealthy = (lane: LaneStatus) => lane.healthy && !(lane.staleRunning ?? 0);

/** GET /status (public, cached). */
export interface ServiceStatus {
  /** Everything up and both lanes healthy. */
  ok?: boolean;
  checkedAt: string;
  version: string | null;
  api?: { up: boolean };
  /** `up` is null when this deployment has no gateway configured (nothing to ask). */
  gateway: { configured?: boolean; up: boolean | null };
  lanes: { check: LaneStatus; remote: LaneStatus };
  previewQueue: number;
}

/** The overall state, for the small indicator. */
export function overallStatus(
  s: ServiceStatus | undefined,
  failed: boolean,
): {
  label: string;
  tone: Tone;
} {
  if (failed) return { label: "Status unknown", tone: "neutral" };
  if (!s) return { label: "Checking status", tone: "neutral" };
  if (s.gateway.up === false) return { label: "Ratings are down", tone: "breach" };
  if ((s.lanes.check.staleRunning ?? 0) > 0 || (s.lanes.remote.staleRunning ?? 0) > 0)
    return { label: "A job looks stuck", tone: "warn" };
  if (!laneHealthy(s.lanes.check) || !laneHealthy(s.lanes.remote))
    return { label: "Ratings are slow", tone: "warn" };
  return { label: "All systems normal", tone: "safe" };
}

/** "3 min ago", "never": how long since a lane last finished a job. */
export function jobAge(seconds: number | null): string {
  if (seconds === null) return "no job yet";
  if (seconds < 90) return "under 2 min ago";
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}
