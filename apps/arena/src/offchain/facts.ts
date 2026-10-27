/**
 * The facts an attack turns on: bank accounts, invoice references and dollar amounts, found in
 * text and compared in one form. Fresh variants must keep them (fresh.ts); the judge uses them to
 * tell a breach the attack caused from the agent's own mistake (attribution.ts).
 */

const squash = (s: string) => s.replace(/\s+/g, "");
const ACCOUNT = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{2,4}){3,8}\b/g;
const REFERENCE = /\b[A-Z]{2,}-[A-Z0-9-]*\d[A-Z0-9-]*\b/g;
const DOLLARS = /\$\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\$\d+(?:\.\d{2})?/g;

/** The accounts, invoice references and dollar amounts a text names. */
export function factsIn(text: string): string[] {
  const flat = text.replace(/\s+/g, " ");
  return [ACCOUNT, REFERENCE, DOLLARS].flatMap((re) => flat.match(re) ?? []).map((f) => f.trim());
}

/**
 * A fact as compared: an account without spaces, a reference in capitals, an amount in cents.
 * So "$4,850" and "$4,850.00" are one fact, and "ACM-2291" isn't satisfied by "ACM-2291-B".
 */
export function factKey(fact: string): string {
  if (fact.startsWith("$"))
    return `usd:${Math.round(Number(fact.slice(1).replace(/,/g, "")) * 100)}`;
  if (new RegExp(`^${ACCOUNT.source}$`).test(fact)) return `account:${squash(fact).toUpperCase()}`;
  return `ref:${fact.toUpperCase()}`;
}

/** Keys for an account, a reference and an amount given as values rather than found in text. */
export const accountKey = (account: string) => `account:${squash(account).toUpperCase()}`;
export const referenceKey = (reference: string) => `ref:${reference.trim().toUpperCase()}`;
export const usdKey = (amountUsd: number) => `usd:${Math.round(amountUsd * 100)}`;
