import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { byoaApi, type Auth, type RatingProgress, type Subject } from "../lib/byoa-api";
import { emailError, estimateLines, progressText, webhookError } from "../lib/connect";
import { ratingFailure } from "../lib/byoa";
import { useRatingRun } from "../lib/rating-run";
import { ApiError } from "../lib/api";
import { Badge, Button, ErrorText, Input, Skeleton } from "./ui";
import { InlineCode } from "./code-block";
import { Collapsible } from "./collapsible";
import { SecretOnce } from "./copy";

const STATUS_LABELS: Record<string, string> = {
  queued: "Waiting",
  starting: "Setting up",
  running: "Running",
  done: "Done",
  failed: "Stopped",
};

/** What a rating will take, from the passing check, shown before it starts. */
export function Estimate({
  subject,
  enabled,
  session,
}: {
  subject: Subject;
  enabled: boolean;
  /** The owner's session: the API shows an estimate only to the owner. */
  session?: string;
}) {
  const estimate = useQuery({
    queryKey: ["estimate", subject, session],
    queryFn: () => byoaApi.estimate(subject, session),
    enabled,
    retry: false,
  });
  if (!enabled) return null;
  return (
    <div className="flex min-h-[4.5rem] flex-col gap-1.5 text-sm">
      {estimate.isPending ? (
        <>
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-2/3" />
        </>
      ) : estimate.data ? (
        <>
          <p>{estimateLines(estimate.data).time}</p>
          <p className="text-muted">{estimateLines(estimate.data).cost}</p>
          <p className="text-xs text-muted">
            An estimate, from your last connection check. Attacked episodes can take longer.
          </p>
        </>
      ) : (
        <p className="text-muted">
          {estimate.error instanceof ApiError && estimate.error.status === 409
            ? "The estimate comes from a passing connection check."
            : "The estimate isn't available right now; the rating can still start."}
        </p>
      )}
    </div>
  );
}

/** The browser's own notification, while this tab is open: ask once, then tell on finish. */
export function useBrowserNotification() {
  const supported = typeof window !== "undefined" && "Notification" in window;
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    supported ? Notification.permission : "unsupported",
  );
  const ask = async () => {
    if (!supported) return;
    setPermission(await Notification.requestPermission());
  };
  const notify = (title: string, body: string) => {
    if (
      supported &&
      Notification.permission === "granted" &&
      document.visibilityState !== "visible"
    )
      new Notification(title, { body, icon: "/brand/bonded-symbol-blue.svg" });
  };
  return { permission, ask, notify };
}

/**
 * A rating as it runs: how many episodes are done, of how many, and the time left. No verdicts
 * until it finishes: an operator watching live could otherwise tell which episodes are attacks.
 */
export function RatingLive({
  runId,
  label,
  queueText,
  doneText = "Finished.",
  onFinished,
  session,
  statusHint,
}: {
  /** A fresher status from elsewhere (the preview's own stream), while the run is read less often. */
  statusHint?: string;
  /** The owner's session: a preview's run and every live stream are shown only to its owner. */
  session?: string;
  runId: string;
  label: string;
  /** What to say once it's done, e.g. where the result is. */
  doneText?: string;
  /** Where it waits in line, before it starts. */
  queueText?: string | null;
  onFinished?: (status: "done" | "failed") => void;
}) {
  const run = useRatingRun(runId, 5000, session);
  const [live, setLive] = useState<RatingProgress>();
  const runStatus = run.data?.status;
  const finished = runStatus === "done" || runStatus === "failed";
  // The live stream says first when it moves on (queued, starting, running).
  const order = ["queued", "starting", "running"];
  const fresher = [live?.status, statusHint, runStatus]
    .filter((s): s is string => Boolean(s))
    .sort((a, b) => order.indexOf(b) - order.indexOf(a))[0];
  const status = finished ? runStatus : fresher;
  const { permission, ask, notify } = useBrowserNotification();
  const told = useRef(false);
  useEffect(() => {
    if (finished || !session) return;
    return byoaApi.ratingProgress(runId, session, setLive, () => {});
  }, [runId, finished, session]);
  useEffect(() => {
    if (!finished || told.current) return;
    told.current = true;
    const over = runStatus === "done" ? "done" : "failed";
    notify(
      over === "done" ? `${label} finished` : `${label} stopped`,
      over === "done" ? "Your report is ready." : (run.data?.error ?? "Open Bonded to see why."),
    );
    onFinished?.(over);
    // Once per run.
  }, [finished]);
  const p: RatingProgress | undefined =
    live ?? (run.data?.progress ? { ...run.data.progress, startedAt: null } : undefined);
  const pct = p?.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={status === "failed" ? "breach" : status === "done" ? "safe" : "neutral"} dot>
          {STATUS_LABELS[status ?? "queued"] ?? status}
        </Badge>
        <span aria-live="polite">
          {status === "done"
            ? doneText
            : status === "failed"
              ? run.data
                ? ratingFailure(run.data)
                : "It stopped."
              : status === "queued" || !status
                ? (queueText ?? "Waiting to start.")
                : status === "starting"
                  ? "Setting up the sandbox: a fresh chain, its vault and the attacks made for this rating."
                  : progressText(p)}
        </span>
      </div>
      {!finished && (
        <>
          <div
            role="progressbar"
            aria-label={`${label} progress`}
            aria-valuemin={0}
            aria-valuemax={p?.total ?? 100}
            aria-valuenow={p?.done ?? 0}
            className="h-2 overflow-hidden rounded-full bg-white/[0.06]"
          >
            <div
              className="h-full rounded-full bg-gradient-to-r from-brand to-held transition-[width] duration-700"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-xs text-muted">
            Results appear when it finishes, so a live agent can't tell which episodes are attacks.
            You can close this page; it keeps going.
          </p>
          {permission === "default" && (
            <div>
              <Button size="sm" kind="secondary" onClick={() => void ask()}>
                Tell me when it's done
              </Button>
            </div>
          )}
          {permission === "granted" && (
            <p className="text-xs text-muted">This tab will notify you when it finishes.</p>
          )}
          {permission === "denied" && (
            <p className="text-xs text-muted">
              Notifications are blocked for this site in your browser. Use a webhook or email below
              instead.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** A webhook and (if this deployment sends email) an address, told when a rating ends. */
export function NotificationSettingsForm({ subject, auth }: { subject: Subject; auth: Auth }) {
  const current = useQuery({
    queryKey: ["notifications", subject, auth.session],
    queryFn: () => byoaApi.notifications(subject, auth.session),
    retry: false,
  });
  const [webhook, setWebhook] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState<{ secret?: string | null }>();
  const problems = [webhookError(webhook), emailError(email)].filter(Boolean);
  const save = async (clear = false) => {
    setBusy(true);
    setError(null);
    try {
      // Only what changed: the current values are shown masked, so they can't be sent back.
      const r = await byoaApi.saveNotifications(
        subject,
        auth,
        clear
          ? { webhookUrl: null, email: null }
          : {
              ...(webhook.trim() ? { webhookUrl: webhook.trim() } : {}),
              ...(email.trim() ? { email: email.trim() } : {}),
            },
      );
      setSaved({ secret: r.webhookSecret ?? null });
      setWebhook("");
      setEmail("");
      await current.refetch();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const emailOn = current.data?.emailAvailable === true;
  const hookOn = current.data?.webhookAvailable !== false;
  return (
    <Collapsible
      className="border-t border-line pt-4 text-sm"
      contentClassName="pt-4"
      summary={`Get told when it finishes, by webhook${emailOn ? " or email" : ""}`}
    >
      <div className="flex flex-col gap-4">
        {current.data && (current.data.webhook || current.data.email) ? (
          <p className="text-muted">
            Now:{" "}
            {[
              current.data.webhook && `webhook ${current.data.webhook.url}`,
              current.data.email && `email ${current.data.email}`,
            ]
              .filter(Boolean)
              .join(", ")}
            .
          </p>
        ) : current.isPending ? (
          <Skeleton className="h-4 w-1/2" />
        ) : (
          <p className="text-muted">Nothing set. It's optional: the result shows here too.</p>
        )}
        {hookOn ? (
          <Input
            label="Webhook URL"
            hint="Bonded POSTs { type: 'rating_finished', … } here, signed like Agent URL calls."
            value={webhook}
            onChange={setWebhook}
            placeholder={current.data?.webhook?.url ?? "https://…"}
            error={webhookError(webhook)}
          />
        ) : (
          <p className="text-xs text-muted">Webhooks aren't set up on this deployment.</p>
        )}
        {emailOn ? (
          <Input
            label="Email"
            value={email}
            onChange={setEmail}
            placeholder={current.data?.email ?? "you@example.com"}
            error={emailError(email)}
            mono={false}
          />
        ) : (
          current.data && (
            <p className="text-xs text-muted">
              Email isn't set up on this deployment; use a webhook.
            </p>
          )
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            loading={busy}
            disabled={problems.length > 0 || (!webhook.trim() && !email.trim())}
            onClick={() => void save()}
          >
            {busy && "sign" in auth ? "Sign in your wallet…" : "Save"}
          </Button>
          {(current.data?.webhook || current.data?.email) && (
            <Button size="sm" kind="ghost" disabled={busy} onClick={() => void save(true)}>
              Turn off
            </Button>
          )}
        </div>
        {saved && !saved.secret && (
          <p className="text-xs text-safe" role="status">
            Saved.
          </p>
        )}
        {saved?.secret && (
          <SecretOnce label="Your webhook secret" value={saved.secret}>
            Check the <InlineCode>bonded-signature</InlineCode> header of each webhook call with it.
          </SecretOnce>
        )}
        <ErrorText error={error} />
      </div>
    </Collapsible>
  );
}
