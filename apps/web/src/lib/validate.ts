import { isAddress } from "viem";
import { parseAmount } from "./onboarding";
import { parseUsd } from "./format";

/**
 * Field checks the forms run as the user types, so a mistake shows next to its field instead of
 * after a submit or a failed transaction. Each returns the message to show, or null. The
 * onboarding page still runs `validateOnboarding` as the final gate before any transaction.
 */

/** A mandate limit: a positive whole number of dollars (the mandate schema's rule). */
export function limitError(text: string): string | null {
  const t = text.trim();
  if (!t) return "Enter a limit in whole dollars.";
  if (!/^\d+$/.test(t)) return "Whole dollars only, no commas or cents.";
  if (Number(t) <= 0) return "Must be more than 0.";
  return null;
}

/** The daily limit: valid on its own, and at least the per-trade limit. */
export function dailyLimitError(daily: string, perTrade: string): string | null {
  const own = limitError(daily);
  if (own) return own;
  if (!limitError(perTrade) && Number(daily) < Number(perTrade))
    return "Must be at least the per-trade limit.";
  return null;
}

/**
 * A mandate percentage (drawdown, slippage): at most two decimals, since it goes on chain in
 * basis points, from `min` to 100.
 */
export function percentError(text: string, { min }: { min: number }): string | null {
  const t = text.trim();
  if (!t) return "Enter a percentage.";
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return "A percentage with at most 2 decimals, e.g. 3 or 0.5.";
  const n = Number(t);
  if (n < min) return min > 0 ? "Must be more than 0." : "Can't be negative.";
  if (n > 100) return "At most 100%.";
  return null;
}

/** An address; an empty optional field is fine (it has a default). */
export function addressError(text: string, optional = false): string | null {
  const t = text.trim();
  if (!t) return optional ? null : "Enter an address.";
  return isAddress(t) ? null : "Not an address: 0x followed by 40 hex characters.";
}

export function descriptionError(text: string): string | null {
  if (!text.trim()) return "Write a short description; it's part of the mandate.";
  if (text.length > 1000) return `At most 1,000 characters (this is ${text.length}).`;
  return null;
}

/** A tUSDG amount that may be 0 (onboarding's bond and deposit). */
export function amountOrZeroError(text: string): string | null {
  return parseAmount(text) === null ? "A tUSDG amount with at most 6 decimals, or 0." : null;
}

/** A positive tUSDG amount, optionally at most `max` (in base units). */
export function positiveAmountError(
  text: string,
  max?: { value: bigint; message: string },
): string | null {
  if (!text.trim()) return null;
  const v = parseUsd(text);
  if (v === null || v === 0n) return "Enter a positive amount with at most 6 decimals.";
  if (max && v > max.value) return max.message;
  return null;
}

/**
 * The mandate fields as typed: each wrong one as "Field: what is wrong". The onboarding gate reads
 * the parsed form, where an empty percentage is a valid 0, so this is what catches a field that is
 * blank or malformed before it can become a different number.
 */
export function mandateFieldProblems(f: {
  maxTx: string;
  maxDaily: string;
  drawdown: string;
  slippage: string;
  refund: string;
  description: string;
}): string[] {
  const rows: [string, string | null][] = [
    ["Per-trade limit", limitError(f.maxTx)],
    ["Daily limit", dailyLimitError(f.maxDaily, f.maxTx)],
    ["Maximum drawdown", percentError(f.drawdown, { min: 0.01 })],
    ["Maximum slippage", percentError(f.slippage, { min: 0 })],
    ["Refund address", addressError(f.refund, true)],
    ["Description", descriptionError(f.description)],
  ];
  return rows.flatMap(([name, error]) => (error ? [`${name}: ${error}`] : []));
}
