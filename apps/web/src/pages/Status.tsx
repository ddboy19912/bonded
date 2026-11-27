import type { ReactNode } from "react";
import { at } from "../lib/format";
import { jobAge, laneHealthy, overallStatus, type LaneStatus, type Tone } from "../lib/health";
import { DOT, useServiceStatus } from "../components/status-indicator";
import { Loading, Page, Section, Unavailable } from "../components/ui";

/** The overall verdict's colour, for the headline. */
const WORD: Record<Tone, string> = {
  safe: "text-ink",
  warn: "text-warn",
  breach: "text-breach",
  neutral: "text-soft",
};

function Row({ label, tone, children }: { label: string; tone: Tone; children: ReactNode }) {
  return (
    <li className="grid gap-x-8 gap-y-1.5 py-5 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] sm:items-baseline">
      <span className="flex items-center gap-3">
        <span className={`size-2 shrink-0 rounded-full ${DOT[tone]}`} aria-hidden />
        <span className="text-[17px] font-medium tracking-[-0.01em]">{label}</span>
      </span>
      <span className="pl-5 text-[15px] text-soft sm:pl-0">{children}</span>
    </li>
  );
}

/**
 * A lane in words: running or slow, when it last finished a job, what is being worked on now
 * (and since when), what is waiting, and whether a job looks stuck.
 */
export function laneText(lane: LaneStatus): string {
  const stale = lane.staleRunning ?? 0;
  const running = lane.running
    ? ` · ${lane.running} running${
        lane.oldestRunningSeconds != null ? ` · started ${jobAge(lane.oldestRunningSeconds)}` : ""
      }`
    : "";
  const waiting = lane.queued ? `; ${lane.queued} waiting` : "";
  const stuck = stale ? ` · ${stale === 1 ? "a job looks stuck" : `${stale} jobs look stuck`}` : "";
  const last =
    lane.lastJobAgeSeconds === null
      ? "no jobs yet"
      : `last finished ${jobAge(lane.lastJobAgeSeconds)}`;
  return `${laneHealthy(lane) ? "Running" : "Slow"}, ${last}${running}${waiting}${stuck}`;
}

/** Whether Bonded's services are up: the gateway, the check and rating lanes, the preview queue. */
export function Status() {
  const status = useServiceStatus();
  const s = status.data;
  const overall = overallStatus(s, status.isError);
  return (
    <Page
      title="Status"
      eyebrow="Service"
      intro="Whether Bonded can connect, check and rate agents right now. It updates every minute."
    >
      {status.isPending ? (
        <Loading what="the status" height="md" />
      ) : !s ? (
        <Unavailable error={status.error} onRetry={() => void status.refetch()} />
      ) : (
        <Section
          label="Right now"
          title={
            <span className={`inline-flex items-center gap-4 ${WORD[overall.tone]}`}>
              <span
                className={`size-3.5 shrink-0 rounded-full sm:size-4 ${DOT[overall.tone]}`}
                aria-hidden
              />
              {overall.label}
            </span>
          }
          intro={`Checked ${at(s.checkedAt)}.`}
        >
          <ul
            className="flex flex-col divide-y divide-line border-y border-line"
            aria-label="Services"
          >
            <Row
              label="Arena Gateway"
              tone={s.gateway.up === null ? "neutral" : s.gateway.up ? "safe" : "breach"}
            >
              {s.gateway.up === null
                ? "Not set up on this deployment"
                : s.gateway.up
                  ? "Up: runners and Agent URLs can connect"
                  : "Down: nothing can connect"}
            </Row>
            <Row label="Connection checks" tone={laneHealthy(s.lanes.check) ? "safe" : "warn"}>
              {laneText(s.lanes.check)}
            </Row>
            <Row
              label="Ratings of your own agents"
              tone={laneHealthy(s.lanes.remote) ? "safe" : "warn"}
            >
              {laneText(s.lanes.remote)}
            </Row>
            <Row label="Preview queue" tone="neutral">
              {s.previewQueue === 0
                ? "Empty: a preview starts right away"
                : `${s.previewQueue} waiting`}
            </Row>
            <Row label="Version" tone="neutral">
              <span className="font-mono text-[13px]">{s.version ?? "not reported"}</span>
            </Row>
          </ul>
        </Section>
      )}
    </Page>
  );
}
