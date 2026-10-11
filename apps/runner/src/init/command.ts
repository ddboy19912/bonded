import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { AgentMode } from "@bondedhq/shared";
import { codeIdentity } from "../code-hash.js";
import { Runner } from "../runner.js";
import { gatewayUrlProblem } from "../tail.js";
import { appendEnvNames, applyPlan, installCommand, run } from "./apply.js";
import {
  type CheckTarget,
  DEFAULT_API_URL,
  eventLine,
  resultLines,
  runConnectionCheck,
} from "./check.js";
import { detectProject, type Framework, FRAMEWORKS, type Project } from "./detect.js";
import { unifiedDiff } from "./diff.js";
import { frameworkLine, type InitPlan, planInit } from "./plan.js";

export const INIT_USAGE = `Usage: bonded-runner init [folder] [options] [-- <agent command...>]

Run in your agent's folder. Finds its framework, then proposes the changes that connect it to
Bonded, as a diff, and asks before writing anything:
  - the rating hook: while Bonded rates the agent, it uses the episode's tools;
  - trading through your Mandate Vault in production (once BONDED_VAULT_ADDRESS is set).
On yes it writes them and adds @bondedhq/sdk with your package manager.

  --print              print the proposed changes and exit; write nothing
  --yes, -y            apply without asking
  --framework <name>   skip detection: ${FRAMEWORKS.filter((f) => f !== "python").join(", ")}
  --url                also add an Agent URL route (Next.js, Express, Hono, or a node:http server)
  --env                append the new variables' names, with empty values, to .env
  --skip-install       don't add @bondedhq/sdk
  --overwrite-generated
                       rewrite files init wrote before even if you edited them (the diff shows
                       what goes). Without it, an edited file is kept

Connect right after (optional). With a runner token and the gateway, init starts the runner
with the agent command after -- (or your package.json start script) and, once it is connected,
runs a connection check with the runner token and prints its events and result:
  BONDED_RUNNER_TOKEN  your runner token, from your agent's page. Prefer this to --token, which
                       anyone on the machine can read in the process list
  --token <token>      the same, on the command line
  --gateway <url>      the Arena Gateway (or BONDED_GATEWAY_URL)
  --mode tools|chain   default tools
  --api <url>          the Bonded API (or BONDED_API_URL); default ${DEFAULT_API_URL}
  --skip-check         start the runner without running a check
  --session <token>    the older way: check with your session token (or BONDED_SESSION_TOKEN)
  --preview <id> | --agent <id>
                       and the preview or agent to check (needed only with --session)

Example:
  npx @bondedhq/runner init
  BONDED_RUNNER_TOKEN=... npx @bondedhq/runner init --yes --gateway https://arena.example.com -- node agent.js`;

export interface InitIO {
  cwd: string;
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Asks a yes/no question; undefined when there is no terminal to ask in. */
  confirm?: (question: string) => Promise<boolean>;
  /** Runs a command (the package install). */
  run?: (command: string[], cwd: string) => Promise<number>;
  /** Starts the runner and resolves when it stops (tests replace it). */
  connect?: (options: ConnectOptions) => Promise<number>;
}

export interface ConnectOptions {
  gateway: string;
  token: string;
  mode: AgentMode;
  command: string[];
  cwd: string;
  check?: CheckTarget;
  out: (line: string) => void;
  err: (line: string) => void;
}

export async function initCommand(argv: string[], io: InitIO): Promise<number> {
  const dash = argv.indexOf("--");
  const own = dash >= 0 ? argv.slice(0, dash) : argv;
  const command = dash >= 0 ? argv.slice(dash + 1) : [];
  let values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: own,
      allowPositionals: true,
      options: {
        print: { type: "boolean", default: false },
        yes: { type: "boolean", short: "y", default: false },
        framework: { type: "string" },
        url: { type: "boolean", default: false },
        env: { type: "boolean", default: false },
        "skip-install": { type: "boolean", default: false },
        "overwrite-generated": { type: "boolean", default: false },
        token: { type: "string" },
        gateway: { type: "string" },
        mode: { type: "string", default: "tools" },
        api: { type: "string" },
        "skip-check": { type: "boolean", default: false },
        session: { type: "string" },
        preview: { type: "string" },
        agent: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n\n${INIT_USAGE}`);
    return 1;
  }
  if (values.help) {
    io.out(INIT_USAGE);
    return 0;
  }
  if (values.framework && !(FRAMEWORKS as readonly string[]).includes(values.framework)) {
    io.err(`--framework must be one of ${FRAMEWORKS.join(", ")}`);
    return 1;
  }
  const mode = AgentMode.safeParse(values.mode);
  if (!mode.success) {
    io.err("--mode must be tools or chain");
    return 1;
  }
  const root = resolve(io.cwd, positionals[0] ?? ".");
  const project = detectProject(root, values.framework as Framework | undefined);
  const plan = planInit(project, {
    url: values.url,
    overwriteGenerated: values["overwrite-generated"],
  });
  printPlan(project, plan, io.out);

  const install = values["skip-install"] ? [] : plan.install;
  const installCmd = install.length ? installCommand(project.packageManager, install) : undefined;
  const hasWork = plan.changes.length > 0 || installCmd !== undefined || values.env;
  if (values.print) return 0;

  if (hasWork) {
    let yes = values.yes;
    if (!yes) {
      if (!io.confirm) {
        io.out(
          "\nNothing written: not a terminal. Run again with --yes to apply, or --print to only print.",
        );
        return 0;
      }
      const what = [
        plan.changes.length
          ? `write ${plan.changes.length} file${plan.changes.length === 1 ? "" : "s"}`
          : "",
        installCmd ? `run \`${installCmd.join(" ")}\`` : "",
        values.env ? "append the variable names to .env" : "",
      ]
        .filter(Boolean)
        .join(", ");
      yes = await io.confirm(`\n${capitalise(what)}?`);
    }
    if (!yes) {
      io.out("Nothing written.");
      return 0;
    }
    try {
      for (const path of applyPlan(root, plan)) io.out(`wrote ${path}`);
      if (values.env) {
        const added = appendEnvNames(root, plan.env);
        io.out(
          added.length
            ? `added to .env: ${added.join(", ")} (empty: fill them in)`
            : ".env already names them all",
        );
      }
    } catch (error) {
      io.err(error instanceof Error ? error.message : String(error));
      return 1;
    }
    if (installCmd) {
      io.out(`\n$ ${installCmd.join(" ")}`);
      const code = await (io.run ?? run)(installCmd, root);
      if (code !== 0) {
        io.err(
          `\`${installCmd.join(" ")}\` failed (exit ${code}). Run it yourself, then start your agent.`,
        );
        return 1;
      }
    }
  }

  const token = values.token ?? io.env.BONDED_RUNNER_TOKEN;
  const gateway = values.gateway ?? io.env.BONDED_GATEWAY_URL;
  if (!token || !gateway) {
    io.out(
      `\nNext: start the runner with your runner token (from your agent's page):\n  ${runnerLine("<gateway url>", mode.data, agentCommand(project, command).join(" ") || "<your agent command>")}\nthen run a connection check on the page. Or run init again with BONDED_RUNNER_TOKEN and --gateway: it starts the runner and runs the check here.`,
    );
    return 0;
  }
  const problem = gatewayUrlProblem(gateway);
  if (problem) {
    io.err(problem);
    return 1;
  }
  const agent = agentCommand(project, command);
  if (!agent.length) {
    const example = guessedCommand(project) ?? "node agent.js";
    io.err(
      `No agent command: init can't tell how your agent starts (there's no start script in package.json). Put it after --, e.g. \`-- ${example}\`, or start the runner yourself:\n  ${runnerLine(gateway, mode.data, guessedCommand(project) ?? "<your agent command>")}`,
    );
    return 1;
  }
  if (values.token)
    io.err(
      "Note: a token given with --token shows in the process list. Next time, set BONDED_RUNNER_TOKEN instead.",
    );
  const api = (values.api ?? io.env.BONDED_API_URL ?? DEFAULT_API_URL).trim();
  const apiProblem = apiUrlProblem(api);
  if (apiProblem) {
    io.err(apiProblem);
    return 1;
  }
  const session = values.session ?? io.env.BONDED_SESSION_TOKEN;
  const subject = values.preview
    ? { kind: "preview" as const, id: values.preview }
    : values.agent
      ? { kind: "agent" as const, id: values.agent }
      : undefined;
  // The runner token names what to check; a session and a subject is the older way, still read.
  const check: CheckTarget | undefined = values["skip-check"]
    ? undefined
    : session && subject
      ? { api, session, subject }
      : { api, runnerToken: token };
  return (io.connect ?? connect)({
    gateway,
    token,
    mode: mode.data,
    command: agent,
    cwd: root,
    ...(check ? { check } : {}),
    out: io.out,
    err: io.err,
  });
}

/** Why an API URL can't be used: it must be https, except on this machine. */
export function apiUrlProblem(api: string): string | undefined {
  let url: URL;
  try {
    url = new URL(api);
  } catch {
    return `--api must be a URL, e.g. ${DEFAULT_API_URL}`;
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "https:" || (url.protocol === "http:" && local)) return undefined;
  return "--api must be https (plain http only on localhost)";
}

/** The runner's own command line, with the token left for the owner to fill in. */
function runnerLine(gateway: string, mode: AgentMode, command: string): string {
  return `BONDED_RUNNER_TOKEN=... npx @bondedhq/runner --gateway ${gateway} --mode ${mode} -- ${command}`;
}

/**
 * A likely start command, only to show as an example (never run): `node <file>` when the folder
 * has a single JavaScript file at its top level, like a copied example agent.
 */
function guessedCommand(project: Project): string | undefined {
  const top = project.sources.filter((f) => !f.includes("/") && /\.(m?js)$/.test(f));
  return top.length === 1 ? `node ${top[0]}` : undefined;
}

/** The agent's command: what came after --, else the package.json start script. */
export function agentCommand(project: Project, given: string[]): string[] {
  if (given.length) return given;
  if (project.scripts.start) return [project.packageManager, "run", "start"];
  return [];
}

function printPlan(project: Project, plan: InitPlan, out: (line: string) => void): void {
  out(`Framework: ${frameworkLine(project)}`);
  out(`Package manager: ${project.packageManager}${project.typescript ? ", TypeScript" : ""}`);
  if (plan.changes.length) {
    out("\nProposed changes:\n");
    for (const c of plan.changes) {
      out(`# ${c.path}${c.before === undefined ? " (new file)" : ""}: ${c.why}`);
      out(unifiedDiff(c.path, c.before, c.after).trimEnd());
      out("");
    }
  } else out(plan.ready ? `\n${plan.ready}` : "\nNo file changes needed.");
  if (plan.install.length) out(`Adds: ${plan.install.join(" ")}`);
  if (plan.manual.length) {
    out("\nBy hand (init didn't change these, to be safe):");
    for (const m of plan.manual) out(m.includes("\n") ? m : `  - ${m}`);
  }
  if (plan.notes.length) {
    out("\nGood to know:");
    for (const n of plan.notes) out(`  - ${n}`);
  }
  if (plan.env.length) out(`\nVariables: ${plan.env.join(", ")}`);
}

/** Starts the runner; with a check target, runs a connection check once it is connected. */
async function connect(options: ConnectOptions): Promise<number> {
  const log = (line: string) => options.err(`[bonded-runner] ${line}`);
  const code = codeIdentity({ command: options.command, cwd: options.cwd });
  log(`code hash ${code.codeHash} (${code.codeSource}: ${code.detail})`);
  let checked = false;
  let failed = false;
  const runner: Runner = new Runner({
    code,
    gateway: options.gateway,
    token: options.token,
    mode: options.mode,
    command: options.command,
    cwd: options.cwd,
    log,
    onConnect: () => {
      if (checked) return;
      checked = true;
      if (!options.check) {
        options.out(
          "\nConnected. Run a connection check on your agent's page; leave this running for your rating (Ctrl-C stops it).",
        );
        return;
      }
      options.out("\nConnected. Running a connection check...");
      runConnectionCheck(options.check, (event) => options.out(`  ${eventLine(event)}`)).then(
        (result) => {
          for (const line of resultLines(result)) options.out(line);
          if (result.passed)
            options.out("Leave the runner running for your rating (Ctrl-C stops it).");
          else {
            failed = true;
            void runner.stop();
          }
        },
        (error: unknown) => {
          options.err(
            `The connection check couldn't run: ${error instanceof Error ? error.message : String(error)}`,
          );
          options.out("The runner is still connected: run the check on your agent's page.");
        },
      );
    },
  });
  const stop = () => void runner.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const result = await runner.start();
  if (result.code !== 0) log(result.reason);
  return failed ? 1 : result.code;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Asks on the terminal; undefined when stdin isn't one. */
export function terminalConfirm(): InitIO["confirm"] {
  if (!process.stdin.isTTY) return undefined;
  return async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(`${question} [y/N] `);
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  };
}
