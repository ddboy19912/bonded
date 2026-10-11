import { UNKNOWN_PROBLEM, isNote, problemCode } from "@bondedhq/shared";
import { ApiError } from "./api";

/**
 * Every problem, warning or refusal the app shows links to its entry on the troubleshooting page,
 * by a stable code (an anchor there, built from `troubleshootingList()` in @bondedhq/shared). The
 * API gives the code next to its sentence (`issues[].code` on check results, `problems[].code` in
 * the health panel, `code` on a refusal); a sentence that comes without one is read with the same
 * table the API uses (`problemCode`), so the page and the API never disagree.
 */
export const DOCS_TROUBLESHOOTING = "/docs/guides/troubleshooting/";

/** A sentence from the API, with its code when the API gives one. */
export type ApiMessage = string | { code?: string | null; message: string };

export const messageText = (m: ApiMessage): string => (typeof m === "string" ? m : m.message);

/** The troubleshooting page's anchor for a code. Codes are kebab-case; anything else is dropped. */
export function troubleshootingUrl(code: string): string {
  return `${DOCS_TROUBLESHOOTING}#${encodeURIComponent(code)}`;
}

const SAFE_CODE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A message's code: the API's own when it gives one, else one read from its wording. */
export function messageCode(m: ApiMessage): string | undefined {
  if (typeof m !== "string" && m.code) return linkable(m.code);
  const code = problemCode(messageText(m));
  return code === UNKNOWN_PROBLEM ? undefined : code;
}

/** A code worth linking: a plain anchor, and not the catch-all for unrecognised sentences. */
const linkable = (code: unknown): string | undefined =>
  typeof code === "string" && SAFE_CODE.test(code) && code !== UNKNOWN_PROBLEM ? code : undefined;

/** The code of an API refusal: `{ error, code, details: { code } }`, when its body carries one. */
export function errorCode(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const nested = error.details.details;
  return (
    linkable(error.details.code) ??
    (nested && typeof nested === "object"
      ? linkable((nested as { code?: unknown }).code)
      : undefined)
  );
}

/** A check's problem or warning with its code, as the API lists them in `issues`. */
export interface CheckIssue {
  code: string;
  severity: "problem" | "warning";
  message: string;
}

/**
 * A check result's sentences with their codes: `problems` and `warnings` stay plain sentences in
 * the API's answer, and `issues` carries the same sentences with their codes.
 */
export function withCodes(
  sentences: readonly ApiMessage[] | undefined,
  issues: readonly CheckIssue[] | undefined,
  severity: CheckIssue["severity"],
): ApiMessage[] {
  return (sentences ?? []).map((m) => {
    if (typeof m !== "string") return m;
    const issue = issues?.find((i) => i.message === m && i.severity === severity);
    return issue ? { code: issue.code, message: m } : m;
  });
}

/**
 * The words before a check warning: "Note:" for one that is only a note (NOTE_CODES in
 * @bondedhq/shared, e.g. model usage an agent with no model can't report), else the page's own.
 */
export function warningPrefix(m: ApiMessage, prefix: string): string {
  return isNote(messageCode(m)) ? "Note:" : prefix;
}

/**
 * One line for a check's warnings, which fold away behind it: how many are worth fixing and how
 * many are only notes. `notesOnly` is for toning the line down when nothing needs doing.
 */
export function warningsSummary(warnings: readonly ApiMessage[]): {
  text: string;
  notesOnly: boolean;
} {
  const notes = warnings.filter((w) => isNote(messageCode(w))).length;
  const fixes = warnings.length - notes;
  const parts = [
    ...(fixes
      ? [`${fixes} ${fixes === 1 ? "thing" : "things"} worth fixing before you start`]
      : []),
    ...(notes ? [`${notes} ${notes === 1 ? "note" : "notes"}`] : []),
  ];
  return { text: parts.join(", "), notesOnly: fixes === 0 };
}
