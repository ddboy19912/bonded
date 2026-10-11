import { useState, type ReactNode } from "react";
import type { RemoteMode } from "@bondedhq/shared";
import type { Connection } from "../lib/byoa-api";
import {
  FRAMEWORKS,
  FRAMEWORK_LOGO,
  FRAMEWORK_TEXT,
  HOSTING_HINT,
  HOSTING_TEXT,
  INIT_NOTE,
  INIT_URL_NOTE,
  SERVICE_KINDS,
  initCommand,
  initWorks,
  rememberFramework,
  rememberedFramework,
  serviceCommand,
  vaultChange,
  vaultEnv,
  type Framework,
  type Hosting,
} from "../lib/frameworks";
import { DOCS_BYOA } from "../lib/routes";
import { apiUrl, robinhoodTestnet, rpcUrl } from "../config";
import { Card, Choice, linkClass } from "./ui";
import { InlineCode } from "./code-block";
import { Collapsible } from "./collapsible";
import { CopyBlock, Tabs } from "./copy";

/**
 * A framework's logo, drawn in the surrounding text colour: the file's shape is used as a mask, so
 * every logo sits quietly in the page's palette instead of bringing its own colours.
 */
export function FrameworkLogo({
  framework,
  size = "size-4",
}: {
  framework: Framework;
  size?: string;
}) {
  const url = `url(${FRAMEWORK_LOGO[framework]})`;
  return (
    <span
      aria-hidden
      className={`inline-block ${size} shrink-0 bg-current`}
      style={{
        mask: `${url} center / contain no-repeat`,
        WebkitMask: `${url} center / contain no-repeat`,
      }}
    />
  );
}

/** What differs between the two layouts: classes, and how one framework option is drawn. */
const LAYOUT = {
  /** Chips for the framework and a plain list for where it runs, with no box per option. */
  flat: {
    root: "gap-7",
    fieldset: "",
    frameworkLegend: "mb-3",
    frameworks: "flex flex-wrap gap-2",
    hostingHint: "mt-1 text-muted",
    hostings: "mt-1 divide-y divide-line",
    advanced: "border-t border-line pt-4",
  },
  /** A bordered card for each option. */
  boxed: {
    root: "gap-5",
    fieldset: "flex flex-col gap-2",
    frameworkLegend: "mb-2",
    frameworks: "grid gap-2 sm:grid-cols-2",
    hostingHint: "mb-2 text-xs text-muted",
    hostings: "grid gap-2 sm:grid-cols-2",
    advanced: "rounded-2xl border border-line-strong p-4",
  },
} as const;

/**
 * The two questions every connect flow starts with: the framework, and where the agent runs.
 * Anything else (mode, code hash, TEE) is under "Advanced", passed in as `advanced`. One flow, in
 * two layouts (`flat`, or boxed): the questions, their copy, the remembered framework, the hosting
 * hint and the Advanced disclosure are the same in both.
 */
export function FrameworkQuestions({
  framework,
  hosting,
  onFramework,
  onHosting,
  name = "byoa",
  advanced,
  advancedOpen,
  onAdvancedToggle,
  flat = false,
}: {
  framework: Framework | undefined;
  hosting: Hosting;
  onFramework: (f: Framework) => void;
  onHosting: (h: Hosting) => void;
  name?: string;
  advanced?: ReactNode;
  advancedOpen?: boolean;
  onAdvancedToggle?: (open: boolean) => void;
  flat?: boolean;
}) {
  const L = flat ? LAYOUT.flat : LAYOUT.boxed;
  const pick = (f: Framework) => {
    rememberFramework(f);
    onFramework(f);
  };
  const frameworkTitle = (f: Framework) => (
    <span className={flat ? "flex items-center gap-2.5" : "inline-flex items-center gap-2.5"}>
      <FrameworkLogo framework={f} />
      {FRAMEWORK_TEXT[f].title}
    </span>
  );
  return (
    <div className={`flex flex-col text-sm ${L.root}`}>
      <fieldset className={L.fieldset}>
        <legend className={`${L.frameworkLegend} font-medium`}>
          Which framework is your agent built on?
        </legend>
        <div className={L.frameworks}>
          {FRAMEWORKS.map((f) =>
            flat ? (
              <label
                key={f}
                className={`flex cursor-pointer items-center rounded-full border px-4 py-2 text-sm transition has-focus-visible:ring-2 has-focus-visible:ring-accent ${framework === f ? "border-accent/60 bg-accent-soft text-ink" : "border-line-strong text-muted hover:text-ink"}`}
              >
                <input
                  type="radio"
                  name={`${name}-framework`}
                  className="sr-only"
                  checked={framework === f}
                  onChange={() => pick(f)}
                />
                {frameworkTitle(f)}
              </label>
            ) : (
              <Choice
                key={f}
                name={`${name}-framework`}
                checked={framework === f}
                onChange={() => pick(f)}
                title={frameworkTitle(f)}
              >
                {FRAMEWORK_TEXT[f].line}
              </Choice>
            ),
          )}
        </div>
        {/* The chips carry no description of their own; the picked one's line sits under them. */}
        {flat && framework && <p className="mt-3 text-muted">{FRAMEWORK_TEXT[framework].line}</p>}
      </fieldset>
      <fieldset className={L.fieldset}>
        <legend className="font-medium">Where do you run it?</legend>
        <p className={L.hostingHint}>{HOSTING_HINT}</p>
        <div className={L.hostings}>
          {(["machine", "online"] as const).map((h) => (
            <Choice
              key={h}
              flat={flat}
              name={`${name}-hosting`}
              checked={hosting === h}
              onChange={() => onHosting(h)}
              title={HOSTING_TEXT[h].title}
            >
              {HOSTING_TEXT[h].line}
            </Choice>
          ))}
        </div>
      </fieldset>
      {advanced && (
        <Collapsible
          {...(advancedOpen !== undefined ? { open: advancedOpen } : {})}
          {...(onAdvancedToggle ? { onOpenChange: onAdvancedToggle } : {})}
          className={L.advanced}
          triggerClassName="text-sm font-medium"
          contentClassName="pt-4"
          summary="Advanced (optional)"
        >
          <div className="flex flex-col gap-4">{advanced}</div>
        </Collapsible>
      )}
    </div>
  );
}

/** The framework picked last in this browser, or the first one, as a starting answer. */
export function useFramework(initial?: Framework) {
  return useState<Framework | undefined>(() => initial ?? rememberedFramework());
}

/**
 * The fastest way in: `npx @bondedhq/runner init` in the agent's folder, with the token and the
 * gateway filled in when the page has them. For Python, which init can't read, the snippet below.
 */
export function InitCommand({
  framework,
  connection,
  mode,
  teeUrl,
  token,
  gatewayUrl,
}: {
  framework: Framework | undefined;
  connection: Connection;
  /** How the agent is registered to act: init's runner must act the same way. */
  mode?: RemoteMode | null;
  /** A TEE-bound agent's TEE: init can't pass it to the runner, so it isn't offered. */
  teeUrl?: string | null;
  token?: string | null;
  gatewayUrl?: string | null;
}) {
  if (connection === "runner" && teeUrl)
    return (
      <p className="text-xs text-muted">
        Your agent is bound to a TEE ({teeUrl}). init can't pass the TEE's URL to the runner, so
        TEE-bound agents use the runner command shown below: it carries{" "}
        <InlineCode>--tee-url</InlineCode>
        {mode === "chain" ? (
          <>
            {" "}
            and <InlineCode>--mode chain</InlineCode>
          </>
        ) : null}
        .
      </p>
    );
  if (framework && !initWorks(framework))
    return (
      <p className="text-xs text-muted">
        For a Python agent init only prints instructions: use the Python code below. It needs no
        package.
      </p>
    );
  return (
    <CopyBlock
      label={
        connection === "url"
          ? "Fastest: add the Agent URL route with init"
          : "Fastest: set it up with init"
      }
      text={initCommand({
        connection,
        mode: mode ?? null,
        token: token ?? null,
        gatewayUrl: gatewayUrl ?? null,
        apiUrl,
      })}
      note={
        connection === "url"
          ? `${INIT_NOTE} ${INIT_URL_NOTE}`
          : token
            ? `${INIT_NOTE} With your token in it, init then starts the runner and runs the connection check for you, printing what it finds.`
            : INIT_NOTE
      }
    />
  );
}

/** Keeping the runner up, so the score is renewed: a service file for each way. */
export function KeepRunning({ gatewayUrl }: { gatewayUrl?: string | null }) {
  const [selected, setSelected] = useState<string>(SERVICE_KINDS[0].id);
  const current = SERVICE_KINDS.find((k) => k.id === selected) ?? SERVICE_KINDS[0];
  return (
    <Collapsible
      className="border-t border-line pt-4"
      contentClassName="pt-3"
      summary="Keep it running"
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-muted">
          Your score is renewed only while the runner is connected, and Bonded tells you when it has
          been offline. Run it as a background service so it comes back after a crash or a reboot.
        </p>
        <Tabs
          label="Service"
          tabs={SERVICE_KINDS.map((k) => ({ id: k.id, label: k.label }))}
          selected={current.id}
          onSelect={setSelected}
        >
          <CopyBlock
            label={current.label}
            text={serviceCommand(current.id, gatewayUrl)}
            note={`${current.note} Replace <your agent command> with how you start your agent.`}
          />
        </Tabs>
      </div>
    </Collapsible>
  );
}

/**
 * "Use your vault" on the agent's page: the one change that makes the agent trade through its
 * vault in production, for its framework, or `init`, which proposes the same change.
 */
export function UseYourVault({ vault }: { vault?: string | null }) {
  const [framework, setFramework] = useFramework();
  const change = framework ? vaultChange(framework) : undefined;
  return (
    <Card
      title="Use your vault"
      description="The rating tests your agent; the vault protects its real trades. Point your agent's trades at the vault, so the mandate checks every one and cover can pay for a breach."
    >
      <div className="flex flex-col gap-4 text-sm">
        <fieldset>
          <legend className="mb-2 font-medium">Which framework is your agent built on?</legend>
          <div className="flex flex-wrap gap-2">
            {FRAMEWORKS.map((f) => (
              <label
                key={f}
                className={`flex cursor-pointer items-center rounded-full border px-3.5 py-1.5 text-xs has-focus-visible:ring-2 has-focus-visible:ring-accent ${framework === f ? "border-accent/60 bg-accent-soft text-ink" : "border-line-strong text-muted"}`}
              >
                <input
                  type="radio"
                  name="vault-framework"
                  className="sr-only"
                  checked={framework === f}
                  onChange={() => {
                    rememberFramework(f);
                    setFramework(f);
                  }}
                />
                <span className="flex items-center gap-2">
                  <FrameworkLogo framework={f} />
                  {FRAMEWORK_TEXT[f].title}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {change ? (
          <>
            {initWorks(change.framework) ? (
              <CopyBlock
                label="Easiest: let init make the change"
                text={initCommand({ connection: "runner" })}
                note="In your agent's folder. It writes `src/bonded.ts` (the rating hook and the vault in one file), adds the import and changes the one line below, showing the diff and asking before writing."
              />
            ) : null}
            <CopyBlock
              label={change.importLine ? "The change init makes" : "By hand"}
              text={change.importLine ? `${change.importLine}\n\n${change.code}` : change.code}
              note={change.note}
              language={change.framework === "python" ? "python" : "ts"}
            />
            <CopyBlock
              label="Then set these where your agent runs"
              text={vaultEnv({ vault, chainId: robinhoodTestnet.id, rpcUrl })}
              note="The agent key is the one the vault was created with: only it can trade through the vault. Never commit it."
            />
          </>
        ) : (
          <p className="text-muted">Pick a framework to see the change.</p>
        )}
        <p className="text-xs text-muted">
          Your agent's key pays the gas for each trade, so keep a little test ETH on it.{" "}
          <a className={linkClass} href={`${DOCS_BYOA}#protect-your-agent`}>
            More in the guide
          </a>
        </p>
      </div>
    </Card>
  );
}
