import { formatUnits, parseUnits } from "viem";
import { tierForScore } from "@bondedhq/shared";
import { USD_DECIMALS, explorerUrl } from "../config";

/** Format a 6-decimal base-asset amount as dollars, e.g. 1234567890n → "1,234.57". */
export function usd(amount: bigint, maxFractionDigits = 2): string {
  const [whole = "0", fraction = ""] = formatUnits(amount, USD_DECIMALS).split(".");
  const negative = whole.startsWith("-");
  const digits = negative ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = fraction.padEnd(maxFractionDigits, "0").slice(0, maxFractionDigits);
  return `${negative ? "-" : ""}${grouped}${maxFractionDigits > 0 ? `.${cents}` : ""}`;
}

/**
 * Parse a dollar amount typed by a user into 6-decimal base units. Returns null for anything
 * that is not a positive number with at most 6 decimals, so a form can refuse it.
 */
export function parseUsd(input: string): bigint | null {
  const value = input.trim().replaceAll(",", "");
  if (!/^\d+(\.\d{1,6})?$/.test(value)) return null;
  const amount = parseUnits(value, USD_DECIMALS);
  return amount > 0n ? amount : null;
}

/** Basis points as a percentage, e.g. 434 → "4.34%". */
export function bps(value: number | bigint): string {
  return `${(Number(value) / 100).toFixed(2)}%`;
}

/** 0x1234…abcd */
export function short(value: string, chars = 4): string {
  return value.length <= 2 + chars * 2
    ? value
    : `${value.slice(0, 2 + chars)}…${value.slice(-chars)}`;
}

export const txUrl = (hash: string) => `${explorerUrl}/tx/${hash}`;
export const addressUrl = (address: string) => `${explorerUrl}/address/${address}`;

/**
 * Unix seconds as a local date and time with the month spelled out ("2 Nov 2026, 16:55"), so
 * readers in different countries can't misread day and month; 0 means "never".
 */
export function when(seconds: number | bigint, locale?: string): string {
  const s = Number(seconds);
  return s === 0
    ? "never"
    : new Date(s * 1000).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

/** Unix seconds as a short day ("26 Oct"), with the year only when it isn't this year. */
export function day(seconds: number | bigint, now = Date.now(), locale = "en-GB"): string {
  const d = new Date(Number(seconds) * 1000);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * How long ago an ISO time was, short enough for a list row: "just now", "45s ago", "3m ago",
 * "2h ago", "4d ago"; older than a week, the date itself.
 */
export function ago(iso: string, now = Date.now(), locale?: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3_600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3_600)}h ago`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  return new Date(t).toLocaleDateString(locale, { dateStyle: "medium" });
}

/** An ISO time as a local date and time, like `when` ("7 Oct 2026, 15:58:12"), with seconds. */
export function at(iso: string, locale?: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t)
    ? ""
    : new Date(t).toLocaleString(locale, { dateStyle: "medium", timeStyle: "medium" });
}

/** A length of time in the largest whole unit, e.g. 604800 → "7 days", 5400 → "90 minutes". */
export function duration(seconds: number | bigint): string {
  const s = Number(seconds);
  const unit = (n: number, name: string) => `${n} ${name}${n === 1 ? "" : "s"}`;
  if (s > 0 && s % 86_400 === 0) return unit(s / 86_400, "day");
  if (s > 0 && s % 3_600 === 0) return unit(s / 3_600, "hour");
  if (s % 60 === 0) return unit(s / 60, "minute");
  return unit(s, "second");
}

/** Tier letter for a registry score, or "unrated" when the agent has no score yet. */
export function tierOf(score: number, issuedAt: number | bigint): string {
  return Number(issuedAt) === 0 ? "unrated" : tierForScore(score).tier;
}

export const BREACH_TYPES = [
  "T1 unauthorized target",
  "T1 unauthorized approval",
  "T1 unauthorized transfer",
  "T1 unexplained outflow",
  "T2 limit",
  "T3 asset",
] as const;

export const POLICY_STATUS = [
  "none",
  "active",
  "cancelled",
  "expired",
  "lapsed",
  "exhausted",
] as const;
