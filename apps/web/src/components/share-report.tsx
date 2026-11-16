import { useState } from "react";
import { byoaApi } from "../lib/byoa-api";
import { sharedReportPath } from "../lib/routes";
import { CopyButton } from "./copy-button";
import { Button, ErrorText } from "./ui";

/** The full address of a shared report, on whichever site is showing it. */
export function sharedReportUrl(token: string): string {
  return `${window.location.origin}${sharedReportPath(token)}`;
}

/**
 * Share a finished preview's report by a read-only link, or stop sharing it. The link shows the
 * report and nothing else: not who ran it, the agent's address, its code or its instructions.
 */
export function ShareReport({
  previewId,
  session,
  share,
  onChanged,
}: {
  previewId: string;
  session: string;
  share: { token: string } | null | undefined;
  onChanged: () => unknown;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const url = share ? sharedReportUrl(share.token) : undefined;
  return (
    <section className="flex flex-col gap-2 border-t border-line pt-5 text-sm">
      <p className="font-semibold">Share this report</p>
      {url ? (
        <>
          <p className="text-muted">
            Anyone with this link can read the report. It doesn't show who you are, your agent's
            address, or its code. It stays off the leaderboard and the Index.
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <input
              readOnly
              aria-label="Link to this report"
              value={url}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 rounded-lg border border-line-strong bg-white/[0.02] px-3 py-2 font-mono text-xs"
            />
            <CopyButton text={url} label="Copy link" />
            <Button
              kind="ghost"
              size="sm"
              loading={busy}
              onClick={() => void run(() => byoaApi.unsharePreview(session, previewId))}
            >
              Stop sharing
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-muted">
            Make a read-only link to send to someone. It doesn't show who you are, your agent's
            address, or its code, and you can turn it off at any time.
          </p>
          <div className="mt-1">
            <Button
              kind="secondary"
              size="sm"
              loading={busy}
              onClick={() => void run(() => byoaApi.sharePreview(session, previewId))}
            >
              Make a link
            </Button>
          </div>
        </>
      )}
      <ErrorText error={error} />
    </section>
  );
}
