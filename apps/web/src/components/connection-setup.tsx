import { useEffect, useRef, useState } from "react";
import type { RemoteMode } from "@bondedhq/shared";
import { runnerCommand, runnerDockerCommand, runnerView } from "../lib/byoa";
import { byoaApi, type Auth, type Connection, type Subject } from "../lib/byoa-api";
import {
  agentUrlError,
  codeSourceLabel,
  isConnected,
  problemAdvice,
  type ConnectionStatus,
} from "../lib/connect";
import { snippets } from "../lib/snippets";
import {
  HOSTING_HINT,
  HOSTING_TEXT,
  initLeads,
  snippetIdFor,
  type Framework,
} from "../lib/frameworks";
import { errorCode, messageCode } from "../lib/troubleshooting";
import { InitCommand, KeepRunning } from "./framework-questions";
import { FixLink } from "./problem";
import { when } from "../lib/format";
import { DOCS_BYOA } from "../lib/routes";
import { ApiError } from "../lib/api";
import { Badge, Button, Choice, ErrorText, Input, linkClass } from "./ui";
import { InlineCode } from "./code-block";
import { Collapsible } from "./collapsible";
import { CopyBlock, SecretOnce, Tabs } from "./copy";

/** The one-line explanations of each choice, shared by every place that offers them. */
export const CONNECTION_TEXT: Record<Connection, { title: string; line: string }> = {
  url: HOSTING_TEXT.online,
  runner: HOSTING_TEXT.machine,
};
export const MODE_TEXT: Record<RemoteMode, { title: string; line: string }> = {
  tools: {
    title: "Tools",
    line: "It reads and trades through tool calls (MCP or HTTP). The easiest to connect.",
  },
  chain: {
    title: "Chain",
    line: "It reads through tools and signs its own transactions to its vault, as in production.",
  },
};

/** How the agent runs (URL or runner) and how it acts (tools or chain). */
export function ConnectionChoice({
  connection,
  mode,
  onConnection,
  onMode,
  name = "connect",
}: {
  connection: Connection;
  mode: RemoteMode;
  onConnection: (c: Connection) => void;
  /** Omit to hide the mode choice (it's fixed, e.g. by the agent's registration). */
  onMode?: (m: RemoteMode) => void;
  name?: string;
}) {
  return (
    <div className="flex flex-col gap-5 text-sm">
      <fieldset className="flex flex-col gap-2">
        <legend className="font-medium">Where do you run it?</legend>
        <p className="mb-2 text-xs text-muted">{HOSTING_HINT}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {(["url", "runner"] as const).map((c) => (
            <Choice
              key={c}
              name={`${name}-connection`}
              checked={connection === c}
              onChange={() => onConnection(c)}
              title={CONNECTION_TEXT[c].title}
            >
              {CONNECTION_TEXT[c].line}
            </Choice>
          ))}
        </div>
      </fieldset>
      {onMode && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 font-medium">How it acts</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {(["tools", "chain"] as const).map((m) => (
              <Choice
                key={m}
                name={`${name}-mode`}
                checked={mode === m}
                onChange={() => onMode(m)}
                title={MODE_TEXT[m].title}
              >
                {MODE_TEXT[m].line}
              </Choice>
            ))}
          </div>
        </fieldset>
      )}
    </div>
  );
}

/** Tools or chain mode: most agents use tools, so it waits under Advanced. */
export function ModeChoice({
  mode,
  onMode,
  name = "mode",
}: {
  mode: RemoteMode;
  onMode: (m: RemoteMode) => void;
  name?: string;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 font-medium">How it acts</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {(["tools", "chain"] as const).map((m) => (
          <Choice
            key={m}
            name={name}
            checked={mode === m}
            onChange={() => onMode(m)}
            title={MODE_TEXT[m].title}
          >
            {MODE_TEXT[m].line}
          </Choice>
        ))}
      </div>
    </fieldset>
  );
}

/** What to put in place of the agent command, under the runner command. */
function CommandNote({ example = false }: { example?: boolean }) {
  return (
    <>
      Replace <InlineCode>&lt;your agent command&gt;</InlineCode> with how you start your agent,
      e.g. <InlineCode>node agent.js</InlineCode> or <InlineCode>python agent.py</InlineCode>.
      {example && (
        <>
          {" "}
          The runner needs Node 22 or later, whatever your agent is written in. No agent yet?{" "}
          <a className={linkClass} href={`${DOCS_BYOA}#no-agent-yet`}>
            Try the example agent
          </a>
          .
        </>
      )}
    </>
  );
}

/** Whether a write signs in the wallet (an agent on chain) or uses the preview's session. */
const signs = (auth: Auth) => "sign" in auth;

/**
 * The runner: make its token (shown once, prefilled into the commands), copy the command, and see
 * the runner connect. With a preview session the token is made straight away, no signature.
 */
export function ConnectRunner({
  subject,
  auth,
  status,
  onChanged,
  teeUrl,
  autoCreate = false,
  showBadge = true,
  framework,
}: {
  subject: Subject;
  auth: Auth;
  status: ConnectionStatus;
  onChanged: () => unknown;
  teeUrl?: string | null;
  framework?: Framework | undefined;
  /** Make the token as soon as this shows (previews: it costs no signature). */
  autoCreate?: boolean;
  /** Off where the runner's state already shows nearby. */
  showBadge?: boolean;
}) {
  const [token, setToken] = useState<{ value: string; gatewayUrl: string | null }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const made = useRef(false);
  const view = runnerView({
    token: status.hasToken || token ? { id: "", createdAt: "" } : null,
    runner: status.runner,
    lastSkip: null,
    gatewayUrl: status.gatewayUrl,
  });
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const t = await byoaApi.createRunnerToken(subject, auth);
      setToken({ value: t.token, gatewayUrl: t.gatewayUrl });
      await onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (autoCreate && !status.hasToken && !made.current) {
      made.current = true;
      void create();
    }
    // Only once, when the step first shows.
  }, [autoCreate]);
  const gatewayUrl = token?.gatewayUrl ?? status.gatewayUrl ?? "<gateway URL>";
  const input = token && {
    gatewayUrl,
    token: token.value,
    mode: status.mode,
    teeUrl: teeUrl ?? null,
  };
  const connected = isConnected(status, "runner");
  const initIsPrimary = initLeads(framework) && !input?.teeUrl;
  return (
    <div className="flex flex-col gap-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted">
          Run this where your agent runs. It starts your agent once per episode, with the episode's
          addresses in its environment.
        </p>
        {showBadge && (
          <Badge tone={view.tone} dot>
            Runner {view.label}
          </Badge>
        )}
      </div>
      {input ? (
        <>
          {initLeads(framework) && (
            <InitCommand
              framework={framework}
              connection="runner"
              mode={input.mode}
              teeUrl={input.teeUrl}
              token={input.token}
              gatewayUrl={input.gatewayUrl}
            />
          )}
          {/* Init leads unless the agent is bound to a TEE (init can't pass the TEE's URL on). Then,
              and for a framework init can't read, the runner command is the one to use, so it is
              shown, not folded away. */}
          {!initIsPrimary && (
            <CopyBlock
              label={
                input.teeUrl
                  ? "Start the runner, with your agent's TEE"
                  : "Start the runner with your agent's command"
              }
              text={runnerCommand(input)}
              note={<CommandNote example={!initLeads(framework)} />}
            />
          )}
          <Collapsible
            className="border-t border-line pt-4"
            contentClassName="pt-4"
            summary="Other ways to start the runner"
          >
            <div className="flex flex-col gap-4">
              {initIsPrimary && (
                <CopyBlock
                  label="Or start the runner yourself (Node)"
                  text={runnerCommand(input)}
                  note={<CommandNote />}
                />
              )}
              <CopyBlock
                label="With Docker"
                text={runnerDockerCommand(input)}
                note="Build your agent into an image FROM the runner's image first (see the guide)."
              />
            </div>
          </Collapsible>
          <p className="text-xs text-warn">
            The token is in these commands and won't be shown again. Copy them now.
          </p>
        </>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-muted">
            {status.hasToken
              ? "A runner token exists, but it's only shown once. If you didn't keep the command, make a new token: the old one stops working."
              : busy
                ? "Making your runner token…"
                : "The command needs a runner token, which says which agent the runner is for."}
          </p>
          <div>
            <Button size="sm" loading={busy} onClick={() => void create()}>
              {busy && signs(auth)
                ? "Sign in your wallet…"
                : status.hasToken
                  ? "Make a new token"
                  : "Create a runner token"}
            </Button>
          </div>
        </div>
      )}
      <p className="text-xs text-muted" aria-live="polite">
        {status.problem ??
          (connected
            ? view.hint
            : status.runner && !status.runner.connected
              ? `The runner was last seen ${when(Math.floor(Date.parse(status.runner.lastHeartbeatAt) / 1000))}. Start it again.`
              : input || status.hasToken
                ? "Waiting for the runner to connect. This updates on its own."
                : null)}
      </p>
      <ErrorText error={error} />
      <Snippets
        connection="runner"
        mode={status.mode}
        gatewayUrl={token?.gatewayUrl ?? status.gatewayUrl}
        framework={framework}
      />
      <KeepRunning gatewayUrl={token?.gatewayUrl ?? status.gatewayUrl} />
    </div>
  );
}

/**
 * Agent URL, in two steps: save the address (Bonded makes the agent's secret, shown once), give
 * the agent the secret, then verify: Bonded sends a signed challenge, and the agent answers with
 * it and a proof made with the secret.
 */
export function ConnectUrl({
  subject,
  auth,
  status,
  onChanged,
  initialUrl,
  framework,
}: {
  subject: Subject;
  auth: Auth;
  status: ConnectionStatus;
  onChanged: () => unknown;
  initialUrl?: string;
  framework?: Framework | undefined;
}) {
  const [url, setUrl] = useState(status.agentUrl?.url ?? initialUrl ?? "");
  const [touched, setTouched] = useState(false);
  const saved = status.agentUrl;
  const [editing, setEditing] = useState(!saved);
  const [busy, setBusy] = useState<"save" | "verify" | "secret">();
  const [error, setError] = useState<unknown>(null);
  // The secret, from this page's own save: it is never shown again.
  const [secret, setSecret] = useState<string>();
  const [verified, setVerified] = useState<{
    version: string | null;
    codeHash: ConnectionStatus["codeHash"];
  }>();
  const invalid = agentUrlError(url);
  const save = async () => {
    setTouched(true);
    if (invalid) return;
    setBusy("save");
    setError(null);
    try {
      const r = await byoaApi.registerAgentUrl(subject, auth, url.trim());
      setSecret(r.secret);
      setVerified(undefined);
      setEditing(false);
      await onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(undefined);
    }
  };
  const verify = async () => {
    const target = saved?.url ?? url.trim();
    setBusy("verify");
    setError(null);
    try {
      const r = await byoaApi.reverifyAgentUrl(subject, auth, target);
      setVerified({ version: r.version, codeHash: r.codeHash });
      await onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(undefined);
    }
  };
  // A new secret for the saved URL: the old one stops working at once, so it needs verifying (and
  // checking) again.
  const renew = async () => {
    const target = saved?.url ?? url.trim();
    setBusy("secret");
    setError(null);
    try {
      const r = await byoaApi.newAgentUrlSecret(subject, auth, target);
      setSecret(r.secret);
      setVerified(undefined);
      setRenewed(true);
      await onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(undefined);
    }
  };
  const [renewed, setRenewed] = useState(false);
  const failure = error instanceof ApiError && error.status < 500 ? error.message : undefined;
  const advice = failure ? problemAdvice(failure, "url") : undefined;
  // After a new secret the URL must be verified again, whatever the record said before.
  const isVerified = Boolean(verified) || (!renewed && Boolean(saved?.verifiedAt));
  const codeHash = verified?.codeHash ?? status.codeHash;
  const version = verified?.version ?? saved?.version ?? null;
  const shownUrl = saved?.url ?? (secret ? url.trim() : undefined);
  const signing = Boolean(busy) && !auth.session;
  return (
    <div className="flex flex-col gap-4 text-sm">
      {editing ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Input
            label="Your agent's URL"
            hint="Public https. Bonded POSTs each episode here, signed with your agent's secret."
            value={url}
            onChange={setUrl}
            placeholder="https://my-agent.example.com/bonded"
            error={url || touched ? invalid : null}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              size="sm"
              loading={busy === "save"}
              disabled={Boolean(url) && Boolean(invalid)}
            >
              {busy === "save" && signing ? "Sign in your wallet…" : "Save and get its secret"}
            </Button>
            {saved && (
              <Button size="sm" kind="ghost" onClick={() => setEditing(false)}>
                Keep the current URL
              </Button>
            )}
          </div>
          <p className="text-xs text-muted">
            Saving calls nothing yet. Next you give your agent its secret, then Bonded checks the
            URL is yours.{saved ? " Saving a new URL makes a new secret." : ""}
          </p>
        </form>
      ) : isVerified ? (
        <div className="flex flex-col gap-3 border-l-2 border-safe/60 pl-4">
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone="safe" dot>
              Verified
            </Badge>
            {shownUrl && <span className="font-mono text-xs break-all">{shownUrl}</span>}
          </p>
          <p className="text-xs text-soft">
            It answered the challenge
            {saved?.verifiedAt && !verified
              ? ` ${when(Math.floor(Date.parse(saved.verifiedAt) / 1000))}`
              : ""}
            {version ? `, reporting version ${version}` : ", without a version"}.
            {codeHash && ` Code hash from ${codeSourceLabel(codeHash)}.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              kind="secondary"
              loading={busy === "verify"}
              onClick={() => void verify()}
            >
              {busy === "verify" && signing ? "Sign in your wallet…" : "Verify again"}
            </Button>
            <Button size="sm" kind="ghost" onClick={() => setEditing(true)}>
              Change the URL
            </Button>
          </div>
          <NewSecret busy={busy === "secret"} signing={signing} onConfirm={() => void renew()} />
        </div>
      ) : (
        <div className="flex flex-col gap-3 border-l-2 border-warn/60 pl-4">
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone="warn" dot>
              Saved, not verified yet
            </Badge>
            {shownUrl && <span className="font-mono text-xs break-all">{shownUrl}</span>}
          </p>
          {secret ? (
            <>
              <p className="font-semibold">1. Add this secret to your agent</p>
              <SecretOnce label="Your agent secret" value={secret}>
                Set it as <InlineCode>BONDED_AGENT_SECRET</InlineCode> where your agent runs (the
                handler below reads it from there), then restart or redeploy it. It checks that each
                call really comes from Bonded.
              </SecretOnce>
              <p className="font-semibold">2. Verify</p>
            </>
          ) : (
            <p className="text-xs text-soft">
              Your agent needs the secret you were shown when you saved this URL. It isn't shown
              again; if you no longer have it, get a new one below.
            </p>
          )}
          <p className="text-xs text-soft">
            Bonded sends <InlineCode>{'{ "type": "verify", "challenge": "…" }'}</InlineCode>, signed
            with the secret; within 10 seconds your agent answers 200 with the challenge and its{" "}
            <InlineCode>proof</InlineCode> (HMAC-SHA256 of{" "}
            <InlineCode>"verify." + challenge</InlineCode>, keyed with the secret). The handler
            below does both.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" loading={busy === "verify"} onClick={() => void verify()}>
              {busy === "verify" && signing ? "Sign in your wallet…" : "Verify it now"}
            </Button>
            <Button size="sm" kind="ghost" onClick={() => setEditing(true)}>
              Change the URL
            </Button>
          </div>
          {!secret && (
            <NewSecret busy={busy === "secret"} signing={signing} onConfirm={() => void renew()} />
          )}
        </div>
      )}
      {failure ? (
        <div role="alert" className="border-l-2 border-breach/70 pl-4">
          <p className="font-semibold">{failure}</p>
          {advice && <p className="mt-1 text-soft">{advice}</p>}
          <p className="mt-1 flex flex-wrap gap-x-3 text-xs">
            <FixLink code={errorCode(error) ?? messageCode(failure)} />
            <a className={linkClass} href={DOCS_BYOA}>
              The guide: Agent URL mode
            </a>
          </p>
        </div>
      ) : (
        <ErrorText error={error} />
      )}
      {!isVerified && <InitCommand framework={framework} connection="url" mode={status.mode} />}
      <Snippets connection="url" mode={status.mode} framework={framework} />
    </div>
  );
}

/** "Get a new secret", with what it costs said first: the old one stops at once. */
function NewSecret({
  busy,
  signing,
  onConfirm,
}: {
  busy: boolean;
  signing: boolean;
  onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <div>
        <button type="button" className={`${linkClass} text-xs`} onClick={() => setAsking(true)}>
          Lost the secret? Get a new one
        </button>
      </div>
    );
  return (
    <div role="alert" className="flex flex-col gap-2 border-l-2 border-breach/70 pl-4 text-xs">
      <p>
        The current secret stops working at once: until your agent has the new one, it can't answer
        Bonded. Then verify the URL and run a connection check again.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" kind="danger" loading={busy} onClick={onConfirm}>
          {busy && signing ? "Sign in your wallet…" : "Make a new secret"}
        </Button>
        <Button size="sm" kind="ghost" onClick={() => setAsking(false)}>
          Keep the current one
        </Button>
      </div>
    </div>
  );
}

/** Framework snippets in tabs: the episode's tools in one call, per framework. */
export function Snippets({
  connection,
  mode,
  gatewayUrl,
  framework,
}: {
  connection: Connection;
  mode: RemoteMode;
  gatewayUrl?: string | null;
  /** The owner's framework: its tab is the one shown first. */
  framework?: Framework | undefined;
}) {
  const list = snippets(connection, mode, gatewayUrl);
  const preferred = framework ? snippetIdFor(framework, connection) : undefined;
  const [picked, setSelected] = useState<string>();
  const selected = picked ?? (list.some((s) => s.id === preferred) ? preferred! : list[0]!.id);
  const current = list.find((s) => s.id === selected) ?? list[0]!;
  return (
    <Collapsible
      className="border-t border-line pt-4"
      contentClassName="pt-4"
      summary={
        connection === "url"
          ? "Code for your agent: the handler and frameworks"
          : "Code for your agent, by framework"
      }
    >
      <div>
        <Tabs
          label="Framework"
          tabs={list.map((s) => ({ id: s.id, label: s.label }))}
          selected={current.id}
          onSelect={setSelected}
        >
          <div className="flex flex-col gap-3">
            {current.install && <CopyBlock label="Install" text={current.install} />}
            <CopyBlock
              label={current.label}
              text={current.code}
              note={current.note}
              language={current.language}
            />
          </div>
        </Tabs>
        <p className="mt-3 text-xs text-muted">
          More in the{" "}
          <a className={linkClass} href={DOCS_BYOA}>
            guide
          </a>
          .
        </p>
      </div>
    </Collapsible>
  );
}

/** Connect through whichever connection is chosen. */
export function ConnectStep(props: {
  subject: Subject;
  auth: Auth;
  status: ConnectionStatus;
  connection: Connection;
  onChanged: () => unknown;
  teeUrl?: string | null;
  autoCreate?: boolean;
  showBadge?: boolean;
  /** A URL to start the form with (e.g. carried over from a preview). */
  initialUrl?: string;
  framework?: Framework | undefined;
}) {
  // Keyed by what it connects, so a token or secret made for one agent never shows on another.
  const k =
    props.subject.kind === "agent"
      ? `agent:${props.subject.agentId}`
      : `preview:${props.subject.id}`;
  return props.connection === "url" ? (
    <ConnectUrl
      key={k}
      subject={props.subject}
      auth={props.auth}
      status={props.status}
      onChanged={props.onChanged}
      framework={props.framework}
      {...(props.initialUrl ? { initialUrl: props.initialUrl } : {})}
    />
  ) : (
    <ConnectRunner
      key={k}
      subject={props.subject}
      auth={props.auth}
      status={props.status}
      onChanged={props.onChanged}
      framework={props.framework}
      {...(props.teeUrl !== undefined ? { teeUrl: props.teeUrl } : {})}
      {...(props.autoCreate !== undefined ? { autoCreate: props.autoCreate } : {})}
      {...(props.showBadge !== undefined ? { showBadge: props.showBadge } : {})}
    />
  );
}
