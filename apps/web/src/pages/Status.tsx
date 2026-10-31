import type { ReactNode } from "react";
import { at } from "../lib/format";
import { jobAge, laneHealthy, overallStatus, type LaneStatus, type Tone } from "../lib/health";
import { DOT, useServiceStatus } from "../components/status-indicator";
import { Card, Loading, Page, Unavailable } from "../components/ui";

function Row({ label, tone, children }: { label: string; tone: Tone; children: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] py-3 first:border-0">
      <span className="flex items-center gap-2.5">
        <span className={`size-2.5 rounded-full ${DOT[tone]}`} aria-hidden />
        <span className="font-medium">{label}</span>
      </span>
      <span className="text-sm text-muted">{children}</span>
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
  return `${laneHealthy(lane) ? "Running" : "Slow"}, last finished ${jobAge(lane.lastJobAgeSeconds)}${running}${waiting}${stuck}`;
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
        <Card>
          <Loading what="the status" />
        </Card>
      ) : !s ? (
        <Unavailable error={status.error} onRetry={() => void status.refetch()} />
      ) : (
        <Card
          title={
            <span className="flex items-center gap-2.5">
              <span className={`size-3 rounded-full ${DOT[overall.tone]}`} aria-hidden />
              {overall.label}
            </span>
          }
        >
          <ul className="flex flex-col text-sm" aria-label="Services">
            <Row
              label="Rating gateway"
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
              <span className="font-mono text-xs">{s.version ?? "not reported"}</span>
            </Row>
          </ul>
          <p className="mt-4 text-xs text-muted">Checked {at(s.checkedAt)}.</p>
        </Card>
      )}
    </Page>
  );
}
