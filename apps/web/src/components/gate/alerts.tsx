import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { emailError, webhookError } from "../../lib/connect";
import { gateApi, type GateAlertSettings } from "../../lib/gate";
import { SecretOnce } from "../copy";
import { ErrorText, Loading, Unavailable, linkClass } from "../ui";
import { ConfirmButton, Facts, Submit, TextField, useAction } from "./common";

const isSlack = (url: string) => url.startsWith("https://hooks.slack.com");

/** Set the webhook and the email. A new webhook's secret is shown once, except for Slack's. */
function AlertsForm({ settings, session }: { settings: GateAlertSettings; session: string }) {
  const queryClient = useQueryClient();
  const action = useAction();
  const [webhook, setWebhook] = useState("");
  const [email, setEmail] = useState("");
  const [secret, setSecret] = useState<string>();
  const hook = webhook.trim();
  const address = email.trim();
  const ready = (hook || address) && !webhookError(webhook) && !emailError(email);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        void action.run(async () => {
          // Only what changed: the current values are shown masked, so they can't be sent back.
          const saved = await gateApi.saveAlertSettings(session, {
            ...(hook ? { webhookUrl: hook } : {}),
            ...(address ? { email: address } : {}),
          });
          setSecret(hook && !isSlack(hook) ? saved.webhookSecret : undefined);
          setWebhook("");
          setEmail("");
          await queryClient.invalidateQueries({ queryKey: ["gate-alerts", session] });
        });
      }}
    >
      {settings.webhookAvailable && (
        <TextField
          label="Slack or webhook URL"
          value={webhook}
          onChange={setWebhook}
          placeholder={settings.webhook?.url ?? "https://hooks.slack.com/services/…"}
          hint="Paste a Slack incoming webhook, or any HTTPS address."
          error={webhookError(webhook)}
        />
      )}
      {settings.emailAvailable && (
        <TextField
          label="Email"
          value={email}
          onChange={setEmail}
          placeholder={settings.email ?? "you@example.com"}
          error={emailError(email)}
          mono={false}
        />
      )}
      <ErrorText error={action.error} />
      <div>
        <Submit busy={action.busy} disabled={!ready}>
          Save
        </Submit>
      </div>
      {secret && (
        <SecretOnce label="Your webhook secret" value={secret}>
          Check the bonded-signature header of each call with it.
        </SecretOnce>
      )}
    </form>
  );
}

/** Where alerts go: always the inbox, and Slack, a webhook or email if the owner adds them. */
export function Alerts({ session }: { session: string }) {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ["gate-alerts", session],
    queryFn: () => gateApi.alertSettings(session),
    retry: false,
  });
  if (settings.error)
    return <Unavailable error={settings.error} onRetry={() => void settings.refetch()} />;
  if (!settings.data) return <Loading what="your alerts" />;
  const s = settings.data;
  const canSave = s.webhookAvailable || s.emailAvailable;
  return (
    <div className="grid gap-x-16 gap-y-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <section aria-label="Add alerts" className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          Every breach shows in your{" "}
          <Link className={linkClass} to="/inbox">
            inbox
          </Link>
          . Send alerts somewhere else too.
        </p>
        {canSave && <AlertsForm settings={s} session={session} />}
        {!s.emailAvailable && <p className="text-xs text-muted">Email alerts aren't on yet.</p>}
      </section>
      <section aria-label="Where alerts go" className="flex flex-col gap-3">
        <Facts
          items={[
            ["Inbox", "On"],
            [
              s.webhook && isSlack(s.webhook.url) ? "Slack" : "Webhook",
              s.webhook ? "On" : "Not set",
            ],
            ["Email", s.email ?? "Not set"],
          ]}
        />
        <p className="text-xs text-muted">These apply to all your accounts and agents.</p>
        {(s.webhook || s.email) && (
          <div>
            <ConfirmButton
              label="Turn these off"
              variant="outline"
              title="Turn these alerts off?"
              description="Your inbox stays on."
              confirm="Turn off"
              act={() => gateApi.saveAlertSettings(session, { webhookUrl: null, email: null })}
              then={() => queryClient.invalidateQueries({ queryKey: ["gate-alerts", session] })}
            />
          </div>
        )}
      </section>
    </div>
  );
}
