import { useState } from "react";
import { byoaApi } from "../lib/byoa-api";
import { sharedReportPath } from "../lib/routes";
import { CopyButton } from "./copy-button";
import { SavePdfButton } from "./save-pdf";
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
  pdfFileName,
}: {
  previewId: string;
  session: string;
  share: { token: string } | null | undefined;
  onChanged: () => unknown;
  /** The PDF's file name; without it there is no "Save as PDF". */
  pdfFileName?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // What this box just did (a token, or null once stopped), until the page's record catches up:
  // a failed re-read never hides a link that exists, or shows one that was turned off.
  const [mine, setMine] = useState<string | null>();
  const token = mine === undefined ? share?.token : mine;
  const run = async (work: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    try {
      setMine(await work());
    } catch (e) {
      setError(e);
      return;
    } finally {
      setBusy(false);
    }
    await Promise.resolve(onChanged()).catch(() => undefined);
  };
  const url = token ? sharedReportUrl(token) : undefined;
  return (
    <section className="mt-12 flex flex-col gap-3 border-t border-line pt-8 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xl font-medium tracking-[-0.03em]">Share this report</p>
        {pdfFileName && <SavePdfButton fileName={pdfFileName} size="sm" />}
      </div>
      {url ? (
        <>
          <p className="max-w-2xl text-muted">
            Anyone with this link can read the report. It doesn't show who you are, your agent's
            address, or its code. It stays off the leaderboard and the Index.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              readOnly
              aria-label="Link to this report"
              value={url}
              onFocus={(e) => e.currentTarget.select()}
              className="h-9 min-w-0 flex-1 basis-56 rounded-full border border-line-strong bg-white/[0.02] px-4 font-mono text-xs text-soft outline-none focus:border-brand-bright"
            />
            <CopyButton text={url} label="Copy link" />
            <Button
              kind="ghost"
              size="sm"
              loading={busy}
              onClick={() =>
                void run(() => byoaApi.unsharePreview(session, previewId).then(() => null))
              }
            >
              Stop sharing
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="max-w-2xl text-muted">
            Make a read-only link to send to someone. It doesn't show who you are, your agent's
            address, or its code, and you can turn it off at any time.
          </p>
          <div className="mt-2">
            <Button
              kind="secondary"
              size="sm"
              loading={busy}
              onClick={() =>
                void run(() => byoaApi.sharePreview(session, previewId).then((r) => r.token))
              }
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
