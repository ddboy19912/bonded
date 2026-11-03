import { UNKNOWN_PROBLEM, troubleshootingList, type ProblemArea } from "./problems.js";

/**
 * The troubleshooting page (docs/TROUBLESHOOTING.md), built from `PROBLEMS`: one section per
 * code, whose heading is the code itself, so the docs site's anchor for it is `#<code>` (the
 * links the web app and the runner print). `pnpm docs:troubleshooting` writes it; a test fails
 * when the committed page is out of date.
 */

/** Each area's heading, in the order the page lists them. */
export const PROBLEM_AREAS: Readonly<Record<ProblemArea, string>> = {
  "sign-in": "Signing in and signed requests",
  requests: "Limits and requests",
  registration: "Registering an agent",
  connection: "Connecting your agent",
  check: "Connection checks",
  rating: "Ratings",
  cover: "Cover and claims",
  vault: "The vault",
  notifications: "Notifications",
  gate: "The payment gate",
  service: "Bonded's own services",
};

/** Text that Markdown would read as markup (HTML tags), made plain. */
const plain = (text: string) => text.replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function troubleshootingMarkdown(): string {
  const list = troubleshootingList();
  const lines: string[] = [
    "# Troubleshooting",
    "",
    "Every problem, warning and refusal Bonded shows, with what to do about it. Each one has a stable code: the web app's **How to fix this** links, the runner's `how to fix:` lines and the API's `code` fields all point at its section here, whose heading is the code.",
    "",
    "Where a message carries numbers, ids or times, the sentence below is its gist. The API returns the code next to each sentence: `code` beside `error` on a refusal (and in `details.code`), `issues[].code` on a connection check's problems and warnings, `problems[].code` in an agent's health panel, and `code` on an in-app notification.",
    "",
    "This page is generated from `PROBLEMS` in [packages/shared/src/problems.ts](../packages/shared/src/problems.ts) by `pnpm docs:troubleshooting`. Don't edit it by hand: change the list and run the command.",
    "",
  ];
  for (const [area, title] of Object.entries(PROBLEM_AREAS) as [ProblemArea, string][]) {
    const entries = list.filter((p) => p.area === area);
    if (!entries.length) continue;
    lines.push(`## ${title}`, "");
    for (const p of entries)
      lines.push(
        `### ${p.code}`,
        "",
        `**Message:** ${plain(p.sentence)}`,
        "",
        `**What to do:** ${plain(p.fix)}`,
        "",
      );
  }
  lines.push(
    "## Anything else",
    "",
    `### ${UNKNOWN_PROBLEM}`,
    "",
    "**Message:** a sentence this page doesn't list yet. The API gives it the code `other`.",
    "",
    "**What to do:** the sentence says what went wrong in its own words. If it isn't clear, check the status page (Status, at the foot of the web app) and try again; if it keeps happening, open an issue with the message.",
    "",
  );
  return lines.join("\n");
}
