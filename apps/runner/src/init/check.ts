/**
 * A client for Bonded's connection check, so `init` can run one right after connecting. With the
 * runner token alone: `POST /runner/check` (the token as the bearer, no body) checks the preview
 * or agent the token belongs to and answers with a stream token, then `GET
 * /checks/:id/events?token=` follows it to the result. With an owner's session (the older way):
 * `POST /previews/:id/checks` or `/self/agents/:id/checks`, then the same events with the
 * session. The API decides pass or fail; this only prints it.
 */

import { isNote, problemCode } from "@bondedhq/shared";

/** The Bonded API the runner talks to when neither --api nor BONDED_API_URL says otherwise. */
export const DEFAULT_API_URL = "https://api-production-ba50.up.railway.app";

/** What a connection check streams (the API's `ConnectionCheckEvent`). */
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
  | ({ type: "result" } & CheckResult);

export interface CheckResult {
  passed: boolean;
  problems: string[];
  warnings?: string[];
  /** The same sentences with their troubleshooting codes. */
  issues?: { code: string; severity: "problem" | "warning"; message: string }[];
  taskCompleted: boolean | null;
  toolsCalled: number;
  surfacesRead: string[];
  durationMs?: number;
  codeHash?: string;
}

export type CheckTarget =
  | {
      /** The Bonded API, e.g. https://api.bonded.example. */
      api: string;
      /** The runner token (`bonded_rt_...`): it names the preview or agent to check. */
      runnerToken: string;
    }
  | {
      api: string;
      /** A session token from signing in (`bonded_ss_...`). */
      session: string;
      /** A preview (`/previews/:id`) or a registered agent (`/self/agents/:id`). */
      subject: { kind: "preview" | "agent"; id: string };
    };

export async function runConnectionCheck(
  target: CheckTarget,
  onEvent: (event: CheckEvent) => void,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<CheckResult> {
  const fetcher = options.fetch ?? fetch;
  const base = target.api.replace(/\/+$/, "");
  const byToken = "runnerToken" in target;
  const started = byToken
    ? await fetcher(`${base}/runner/check`, {
        method: "POST",
        headers: { authorization: `Bearer ${target.runnerToken}` },
      })
    : await fetcher(
        `${base}${
          target.subject.kind === "preview"
            ? `/previews/${encodeURIComponent(target.subject.id)}/checks`
            : `/self/agents/${encodeURIComponent(target.subject.id)}/checks`
        }`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${target.session}`,
            "content-type": "application/json",
          },
          body: "{}",
        },
      );
  const body = (await started.json().catch(() => ({}))) as {
    checkId?: string;
    error?: string;
    events?: CheckEvent[];
    result?: CheckResult | null;
    streamToken?: string;
  };
  if (!started.ok || !body.checkId)
    throw new Error(body.error ?? `the API answered ${started.status} to the check`);
  if (byToken && !body.streamToken)
    throw new Error("the API didn't give a stream token for the check's events");
  // The events: with the stream token the check came with, or with the session.
  const eventsUrl = byToken
    ? `${base}/checks/${encodeURIComponent(body.checkId)}/events?token=${encodeURIComponent(body.streamToken!)}`
    : `${base}/checks/${encodeURIComponent(body.checkId)}/events`;
  const headers: Record<string, string> = byToken
    ? {}
    : { authorization: `Bearer ${target.session}` };
  const seen = body.events ?? [];
  seen.forEach(onEvent);
  if (body.result) {
    if (!seen.some((e) => e.type === "result")) onEvent({ type: "result", ...body.result });
    return body.result;
  }

  const deadline = Date.now() + (options.timeoutMs ?? 5 * 60_000);
  let lastId = "";
  let skip = seen.length;
  while (Date.now() < deadline) {
    const response = await fetcher(eventsUrl, {
      headers: {
        ...headers,
        accept: "text/event-stream",
        ...(lastId ? { "last-event-id": lastId } : {}),
      },
      signal: AbortSignal.timeout(Math.max(1_000, deadline - Date.now())),
    });
    if (!response.ok || !response.body)
      throw new Error(`the API answered ${response.status} to the check's events`);
    for await (const message of serverSentEvents(response.body)) {
      if (message.id) lastId = message.id;
      let event: CheckEvent;
      try {
        event = JSON.parse(message.data) as CheckEvent;
      } catch {
        continue;
      }
      // The first stream starts from the beginning: skip what the POST already showed.
      if (skip > 0) {
        skip--;
        continue;
      }
      onEvent(event);
      if (event.type === "result") {
        const { type: _type, ...result } = event;
        void _type;
        return result;
      }
    }
    skip = 0;
  }
  throw new Error("the check didn't finish in time; see it on your agent's page");
}

/** Server-sent events from a response body: each message's `id` and `data`. */
export async function* serverSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ id?: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = "";
  let id: string | undefined;
  let data: string[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line === "") {
        if (data.length) yield { ...(id ? { id } : {}), data: data.join("\n") };
        data = [];
        id = undefined;
      } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      else if (line.startsWith("id:")) id = line.slice(3).trim();
    }
  }
  if (data.length) yield { ...(id ? { id } : {}), data: data.join("\n") };
}

/** One check event as a line for the terminal (the web app's wording). */
export function eventLine(event: CheckEvent): string {
  switch (event.type) {
    case "started":
      return "Episode started: your agent got its task";
    case "tool": {
      const surface = event.surface ? ` (read ${event.surface})` : "";
      return event.ok
        ? `Called ${event.name}${surface}`
        : `Called ${event.name}${surface}: ${event.error ?? "it failed"}`;
    }
    case "tx":
      return event.ok
        ? "Sent a transaction to its vault"
        : `A transaction was refused: ${event.reason ?? "no reason given"}`;
    case "done": {
      const exit =
        event.exitCode === undefined || event.exitCode === null
          ? ""
          : `, exit code ${event.exitCode}`;
      return `Finished after ${(event.durationMs / 1000).toFixed(1)} s${exit}`;
    }
    case "result":
      return event.passed ? "The check passed" : "The check found problems";
  }
}

/** Where each problem's fix is explained, by its code (the anchor). */
export const TROUBLESHOOTING_URL = "https://www.bondedhq.xyz/docs/guides/troubleshooting/";

/**
 * The result as lines: the verdict, then each problem and warning, with its fix's link. A warning
 * that is only a note (NOTE_CODES in @bondedhq/shared, e.g. model usage) prints as a note.
 */
export function resultLines(result: CheckResult): string[] {
  const line = (kind: "problem" | "warning", text: string) => {
    const code = result.issues?.find((i) => i.message === text && i.severity === kind)?.code;
    const label = kind === "warning" && isNote(code ?? problemCode(text)) ? "note" : kind;
    return code && code !== "other" && /^[a-z0-9-]+$/.test(code)
      ? [`  ${label}: ${text}`, `    how to fix: ${TROUBLESHOOTING_URL}#${code}`]
      : [`  ${label}: ${text}`];
  };
  return [
    result.passed ? "Connection check passed: a rating will work." : "Connection check failed:",
    ...result.problems.flatMap((p) => line("problem", p)),
    ...(result.warnings ?? []).flatMap((w) => line("warning", w)),
    `  ${result.toolsCalled} tool call${result.toolsCalled === 1 ? "" : "s"}, task ${result.taskCompleted ? "done" : "not done"}${result.surfacesRead.length ? `, read ${result.surfacesRead.join(", ")}` : ""}`,
  ];
}
