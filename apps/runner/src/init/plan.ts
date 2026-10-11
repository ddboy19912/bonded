import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { FRAMEWORK_NAMES, type Framework, INIT_MARKER, type Project } from "./detect.js";

/** One file `init` would write: new (no `before`) or changed. Paths relative to the project. */
export interface FileChange {
  path: string;
  before?: string;
  after: string;
  /** What it is for, in a sentence. */
  why: string;
}

/** Everything `init` proposes for a project. Nothing is written until it is applied. */
export interface InitPlan {
  framework: Framework;
  changes: FileChange[];
  /** What `init` could not change safely: do it by hand (each a sentence or a code line). */
  manual: string[];
  /** Things to know (not to do now). */
  notes: string[];
  /** Variables the new code reads, for `.env` (names only). */
  env: string[];
  /** The packages to add, when they aren't there yet. */
  install: string[];
  /**
   * Set when the agent already works with a rating as it is (`Project.episodeReady`): why, in a
   * sentence. Then init proposes nothing.
   */
  ready?: string;
}

export interface PlanOptions {
  /** Also add an Agent URL route for the project's web framework. */
  url?: boolean;
  /**
   * Rewrite files init wrote before even when they were edited since (the diff shows what goes).
   * Off by default: an edited file is kept.
   */
  overwriteGenerated?: boolean;
}

/**
 * The first line of every file `init` writes, so a second run knows the file is init's. It is
 * rewritten only while it still holds exactly what init would write (or with --overwrite-generated).
 */
export const MARKER = INIT_MARKER;
/** The guide on the docs site (generated from docs/BRING-YOUR-OWN-AGENT.md). */
const GUIDE = "https://bonded-nu.vercel.app/docs/guides/bring-your-own-agent/";

/** The production vault's variables (`bondedVaultFromEnv` in @bondedhq/sdk). */
export const VAULT_ENV = ["BONDED_VAULT_ADDRESS", "BONDED_AGENT_KEY", "BONDED_ROUTER_ADDRESS"];

export function planInit(project: Project, options: PlanOptions = {}): InitPlan {
  const plan: InitPlan = {
    framework: project.framework,
    changes: [],
    manual: [],
    notes: [],
    env: [],
    install: project.hasSdk || project.framework === "python" ? [] : ["@bondedhq/sdk"],
  };
  const files = new Files(project, options);

  if (project.framework === "python") {
    pythonPlan(plan);
    return plan;
  }

  // Already wired to the episode (like this package's example agents): the rating hook would only
  // wrap what it reads already, so init proposes nothing. An Agent URL route is still added on ask.
  if (project.episodeReady && !options.url) {
    plan.install = [];
    plan.ready = `Already set up to be rated: ${project.episodeReady}, so it uses the episode's tools while Bonded rates it. Nothing to change for rating.`;
    plan.notes.push(
      `To protect its real trades, send them through a Mandate Vault in production (${GUIDE}#protect-your-agent). init adds nothing for that here, so your code stays as it is.`,
    );
    return plan;
  }

  // src/bonded.ts, unless the project has its own file by that name: then the first free one
  // of bonded-agent.ts, bonded-agent-2.ts, ..., so every import below names a file init wrote.
  const helper = files.freeHelperPath("bonded", "bonded-agent");
  if (helper !== files.helperPath("bonded"))
    plan.notes.push(
      `${files.helperPath("bonded")} is your own file, so init's helper is ${helper}; everything init adds imports from there.`,
    );
  const ts = project.typescript;
  switch (project.framework) {
    case "langchain":
    case "ai-sdk":
      files.write(
        plan,
        helper,
        toolsHelper(project.framework, ts),
        "the rating hook and the vault tools",
      );
      toolsEdit(plan, files, helper);
      plan.notes.push(
        "In production, take your own swap, transfer and approve tools out of the list, so every trade goes through the vault.",
      );
      break;
    case "agentkit":
      files.write(
        plan,
        helper,
        agentKitHelper(ts),
        "the rating hook and the vault wallet provider",
      );
      agentKitEdit(plan, files, helper);
      break;
    case "eliza":
      files.write(plan, helper, elizaHelper(ts), "the rating hook and the vault plugin");
      elizaEdit(plan, files, helper);
      break;
    case "mcp":
      files.write(plan, helper, mcpHelper(ts), "the rating hook and the guarded vault");
      mcpEdit(plan, files, helper);
      plan.notes.push(
        "In production, send trades through `bondedVault` (exported from the new file): `await bondedVault.swap({ tokenIn, tokenOut, amountIn })`. Each is dry-run against the vault first.",
      );
      break;
    case "unknown":
      files.write(plan, helper, unknownHelper(ts), "the rating check and the guarded vault");
      plan.manual.push(
        `While Bonded rates your agent (\`isBondedEpisode()\`), read and trade through the episode's tools: the MCP server at BONDED_MCP_URL, or plain HTTP at BONDED_TOOLS_URL (see ${GUIDE}#use-your-framework).`,
        "In production, send trades through `bondedVault` from the new file: `await bondedVault.swap({ tokenIn, tokenOut, amountIn })`.",
      );
      break;
  }
  plan.env.push(...VAULT_ENV);
  plan.notes.push(
    "The vault's variables (BONDED_VAULT_ADDRESS, BONDED_AGENT_KEY, BONDED_ROUTER_ADDRESS, and BONDED_VAULT_RPC_URL / BONDED_VAULT_CHAIN_ID off Robinhood Chain testnet) are read in production only. Until BONDED_VAULT_ADDRESS is set the agent runs as before; while it is rated it never touches them.",
  );
  if (options.url) urlPlan(plan, files, project, helper);
  return plan;
}

// ---------------------------------------------------------------------------------------------
// Files: reading the project, writing new files and safe edits.

class Files {
  private readonly pending = new Map<string, string>();
  constructor(
    readonly project: Project,
    private readonly options: PlanOptions = {},
  ) {}

  /** The text of a project file as it will be after the changes so far. */
  read(path: string): string | undefined {
    if (this.pending.has(path)) return this.pending.get(path);
    const abs = join(this.project.root, path);
    return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
  }

  /** `src/bonded.ts` (or .js, or .mjs for a CommonJS package: the SDK is ESM only). */
  helperPath(name: string): string {
    const ext = this.project.typescript ? "ts" : this.project.esm ? "js" : "mjs";
    return posix.join(this.project.sourceDir, `${name}.${ext}`);
  }

  /**
   * The path for a new helper: `preferred` when it is free or init's own, else the first free
   * (or init's own) of `fallback`, `fallback-2`, `fallback-3`, ...
   */
  freeHelperPath(preferred: string, fallback: string): string {
    const usable = (path: string) => {
      const text = this.read(path);
      return text === undefined || text.startsWith(MARKER);
    };
    const first = this.helperPath(preferred);
    if (usable(first)) return first;
    for (let n = 1; ; n++) {
      const path = this.helperPath(n === 1 ? fallback : `${fallback}-${n}`);
      if (usable(path)) return path;
    }
  }

  /**
   * Proposes a new file, or rewrites one `init` wrote before while it is unchanged. Someone
   * else's file is left alone, and so is init's own once it was edited (unless
   * --overwrite-generated): init can't tell an edit from an older template, so it keeps both.
   */
  write(plan: InitPlan, path: string, text: string, why: string): boolean {
    const before = this.read(path);
    if (before !== undefined && !before.startsWith(MARKER)) {
      plan.manual.push(
        `${path} already exists and wasn't written by init, so it was left alone. The file init would write is printed with --print; add it under another name.`,
      );
      return false;
    }
    if (before !== undefined && before !== text && !this.options.overwriteGenerated) {
      plan.notes.push(
        `Kept your edited file ${path}: it differs from what init writes now. To replace it, run init again with --overwrite-generated (the diff shows what would go).`,
      );
      return true;
    }
    this.change(plan, path, text, why);
    return true;
  }

  /** Records a change to `path` (merging with earlier changes to the same file). */
  change(plan: InitPlan, path: string, after: string, why: string): void {
    const existing = plan.changes.find((c) => c.path === path);
    if (existing) {
      existing.after = after;
      if (!existing.why.includes(why)) existing.why += `; ${why}`;
    } else {
      const before = this.read(path);
      if (before === after) return;
      plan.changes.push({ path, ...(before !== undefined ? { before } : {}), after, why });
    }
    this.pending.set(path, after);
  }

  /** Source files whose text matches, as they are now. */
  matching(pattern: RegExp): { path: string; text: string }[] {
    return this.project.sources
      .map((path) => ({ path, text: this.read(path) ?? "" }))
      .filter((f) => pattern.test(f.text));
  }

  /** Whether a source file can take an `import` line: TypeScript, or JS that is an ES module. */
  isModule(path: string): boolean {
    if (/\.(ts|tsx|mts)$/.test(path)) return true;
    if (/\.mjs$/.test(path)) return true;
    if (/\.(js|jsx)$/.test(path)) return this.project.esm;
    return false;
  }

  /** The import specifier for `target` from `from`, as this project writes relative imports. */
  specifier(from: string, target: string): string {
    let rel = posix.relative(posix.dirname(from), target);
    if (!rel.startsWith(".")) rel = `./${rel}`;
    if (/\.(ts|tsx|mts)$/.test(target))
      return rel.replace(/\.(ts|tsx|mts)$/, this.project.importExtension);
    return rel;
  }
}

/** Adds an import after the file's existing imports (or at the top), unless it is there already. */
export function addImport(text: string, statement: string, specifier: string): string {
  if (text.includes(`"${specifier}"`) || text.includes(`'${specifier}'`)) return text;
  const lines = text.split("\n");
  let insertAt = 0;
  let i = 0;
  if (lines[0]?.startsWith("#!")) insertAt = i = 1;
  while (i < lines.length && /^\s*["']use [a-z ]+["'];?\s*$/.test(lines[i]!)) insertAt = ++i;
  let inComment = false;
  for (; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (inComment) {
      if (line.includes("*/")) inComment = false;
      continue;
    }
    if (line === "" || line.startsWith("//")) continue;
    if (line.startsWith("/*")) {
      inComment = !line.includes("*/");
      continue;
    }
    if (!/^import[\s{*"']/.test(line)) break;
    // An import, possibly over several lines: it ends at its module specifier.
    let j = i;
    while (j < lines.length && !/(from\s*)?["'][^"']+["']\s*;?\s*$/.test(lines[j]!)) j++;
    i = j;
    insertAt = j + 1;
  }
  lines.splice(insertAt, 0, statement);
  return lines.join("\n");
}

/**
 * Whether code on `index` may `await`: at the top level of an ES module, or inside a block opened
 * by an `async` function. Decided from indentation, so it is conservative.
 */
function canAwait(lines: string[], index: number, module: boolean): boolean {
  const indent = (s: string) => /^\s*/.exec(s)![0].length;
  const own = indent(lines[index]!);
  if (own === 0) return module;
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    if (indent(line) < own) return /\basync\b/.test(line);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// The edits, one per framework. Each changes one line, or adds one, and only when it is sure.

const TOOLS_LINE = /^(\s*)(export\s+)?(const|let|var)\s+(tools)(\s*:\s*[^=]+?)?\s*=\s*(.+?);?\s*$/;

/** LangChain and the AI SDK: `const tools = X;` becomes `const tools = await bondedTools(X);`. */
function toolsEdit(plan: InitPlan, files: Files, helper: string): void {
  const call = "const tools = await bondedTools(productionTools);";
  const candidates: { path: string; index: number; match: RegExpExecArray }[] = [];
  for (const file of files.matching(/\btools\b/)) {
    if (file.path === helper) continue;
    file.text.split("\n").forEach((line, index) => {
      const match = TOOLS_LINE.exec(line);
      if (match && !match[6]!.includes("bondedTools") && balanced(match[6]!))
        candidates.push({ path: file.path, index, match });
    });
  }
  const done = files.matching(/\bbondedTools\(/).filter((f) => f.path !== helper);
  if (done.length) {
    plan.notes.push(`${done[0]!.path} already calls bondedTools: no change needed there.`);
    return;
  }
  const only = candidates.length === 1 ? candidates[0]! : undefined;
  if (!only || !files.isModule(only.path)) {
    plan.manual.push(
      `Where your agent gets its tools, wrap them: ${call} (import { bondedTools } from the new ${helper}).${candidates.length > 1 ? ` init found ${candidates.length} \`const tools = ...\` lines and didn't guess which one.` : ""}`,
    );
    return;
  }
  const text = files.read(only.path)!;
  const lines = text.split("\n");
  if (!canAwait(lines, only.index, files.isModule(only.path))) {
    plan.manual.push(
      `In ${only.path} line ${only.index + 1}, wrap the tools: ${call} The line isn't in an async function, so init didn't change it.`,
    );
    return;
  }
  const [, indent, exported, keyword, name, type, value] = only.match;
  lines[only.index] =
    `${indent}${exported ?? ""}${keyword} ${name}${type ?? ""} = await bondedTools(${value});`;
  const specifier = files.specifier(only.path, helper);
  files.change(
    plan,
    only.path,
    addImport(lines.join("\n"), `import { bondedTools } from "${specifier}";`, specifier),
    "the episode's tools while rated, the vault's tools in production",
  );
}

/** AgentKit: `AgentKit.from(` becomes `bondedAgentKit(`. */
function agentKitEdit(plan: InitPlan, files: Files, helper: string): void {
  const call = "const agentKit = await bondedAgentKit({ walletProvider, actionProviders });";
  if (files.matching(/\bbondedAgentKit\(/).some((f) => f.path !== helper)) {
    plan.notes.push("Your code already calls bondedAgentKit: no change needed there.");
    return;
  }
  const found = files
    .matching(/\bAgentKit\.from\(/)
    .filter((f) => f.path !== helper)
    .map((f) => ({ ...f, count: f.text.match(/\bAgentKit\.from\(/g)!.length }));
  const only = found.length === 1 && found[0]!.count === 1 ? found[0]! : undefined;
  if (!only || !files.isModule(only.path)) {
    plan.manual.push(
      `Build your AgentKit with bondedAgentKit instead of AgentKit.from: ${call} (import { bondedAgentKit } from the new ${helper}).`,
    );
    return;
  }
  const specifier = files.specifier(only.path, helper);
  files.change(
    plan,
    only.path,
    addImport(
      only.text.replace(/\bAgentKit\.from\(/, "bondedAgentKit("),
      `import { bondedAgentKit } from "${specifier}";`,
      specifier,
    ),
    "the episode's tools while rated, every transaction through the vault in production",
  );
}

/** ElizaOS: `...bondedPlugins` goes first in the project agent's `plugins: [`. */
function elizaEdit(plan: InitPlan, files: Files, helper: string): void {
  const line = "plugins: [...bondedPlugins, ...yourPlugins],";
  if (files.matching(/\bbondedPlugins\b/).some((f) => f.path !== helper)) {
    plan.notes.push("Your code already uses bondedPlugins: no change needed there.");
    return;
  }
  const agents = files
    .matching(/\bProjectAgent\b/)
    .filter((f) => f.path !== helper)
    .map((f) => ({ ...f, count: f.text.match(/^\s*plugins\s*:\s*\[/gm)?.length ?? 0 }));
  const only = agents.length === 1 && agents[0]!.count === 1 ? agents[0]! : undefined;
  if (!only || !files.isModule(only.path)) {
    plan.manual.push(
      `Add Bonded's plugin to your agent's plugins (the ProjectAgent's, or the plugins you pass the runtime; not the character's plugin names): ${line} (import { bondedPlugins } from the new ${helper}).`,
    );
    return;
  }
  const specifier = files.specifier(only.path, helper);
  const lines = only.text.split("\n");
  const index = lines.findIndex((l) => /^\s*plugins\s*:\s*\[/.test(l));
  const [, open, rest] = /^(\s*plugins\s*:\s*\[)(.*)$/.exec(lines[index]!)!;
  if (rest!.trim() === "") {
    // The list continues on the next lines: Bonded's goes first, on its own line.
    const indent = /^\s*/.exec(lines[index + 1] ?? "")![0] || `${/^\s*/.exec(open!)![0]}  `;
    lines.splice(index + 1, 0, `${indent}...bondedPlugins,`);
  } else
    lines[index] = rest!.trimStart().startsWith("]")
      ? `${open}...bondedPlugins${rest!.trimStart()}`
      : `${open}...bondedPlugins, ${rest!.trimStart()}`;
  files.change(
    plan,
    only.path,
    addImport(lines.join("\n"), `import { bondedPlugins } from "${specifier}";`, specifier),
    "the episode's tools while rated, vault actions in production",
  );
}

/** A plain MCP client: `new URL(X)` in its HTTP transport becomes `new URL(bondedMcpUrl(X))`. */
function mcpEdit(plan: InitPlan, files: Files, helper: string): void {
  const transport = /new (StreamableHTTPClientTransport|SSEClientTransport)\(\s*new URL\(/;
  const call = "new StreamableHTTPClientTransport(new URL(bondedMcpUrl(yourServerUrl)))";
  if (files.matching(/\bbondedMcpUrl\(/).some((f) => f.path !== helper)) {
    plan.notes.push("Your code already uses bondedMcpUrl: no change needed there.");
    return;
  }
  const found = files.matching(transport).filter((f) => f.path !== helper);
  const only = found.length === 1 ? found[0]! : undefined;
  const lines = only?.text.split("\n") ?? [];
  const index = lines.findIndex((l) => transport.test(l));
  const edited = index >= 0 ? wrapUrlArgument(lines[index]!) : undefined;
  if (
    !only ||
    !files.isModule(only.path) ||
    !edited ||
    lines.filter((l) => transport.test(l)).length !== 1
  ) {
    plan.manual.push(
      `Point your MCP client at the episode while Bonded rates it: ${call} (import { bondedMcpUrl } from the new ${helper}).`,
    );
    return;
  }
  lines[index] = edited;
  const specifier = files.specifier(only.path, helper);
  files.change(
    plan,
    only.path,
    addImport(lines.join("\n"), `import { bondedMcpUrl } from "${specifier}";`, specifier),
    "the episode's MCP server while rated",
  );
}

/** `...new URL(X)...` to `...new URL(bondedMcpUrl(X))...`, when X's parentheses close on the line. */
function wrapUrlArgument(line: string): string | undefined {
  const open = line.search(/new URL\(/) + "new URL(".length;
  let depth = 1;
  for (let i = open; i < line.length; i++) {
    if (line[i] === "(") depth++;
    else if (line[i] === ")" && --depth === 0) {
      const arg = line.slice(open, i).trim();
      if (!arg || arg.includes(",")) return undefined;
      return `${line.slice(0, open)}bondedMcpUrl(${arg})${line.slice(i)}`;
    }
  }
  return undefined;
}

/** Brackets and quotes in a one-line expression are closed (so it doesn't continue below). */
function balanced(expression: string): boolean {
  let depth = 0;
  let quote: string | undefined;
  for (const ch of expression) {
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch) && --depth < 0) return false;
  }
  return depth === 0 && quote === undefined && !/[,=+\-*/&|?:]\s*$/.test(expression);
}

// ---------------------------------------------------------------------------------------------
// Agent URL routes.

function urlPlan(plan: InitPlan, files: Files, project: Project, helper: string): void {
  const ts = project.typescript;
  const handlerFile = files.freeHelperPath("bonded-agent-url", "bonded-agent-url");
  files.write(
    plan,
    handlerFile,
    agentUrlHandler(project, handlerFile, files.specifier(handlerFile, helper), ts),
    "the Agent URL handler",
  );
  plan.env.push("BONDED_AGENT_SECRET");
  const route = (path: string, text: string, why: string) => files.write(plan, path, text, why);
  let endpoint = "/bonded";
  switch (project.web) {
    case "next-app": {
      const path = `${project.nextAppDir}/api/bonded/route.${ts ? "ts" : "js"}`;
      route(
        path,
        nextAppRoute(files.specifier(path, handlerFile), project.nextMajor ?? 0, ts),
        "the Next.js route",
      );
      endpoint = "/api/bonded";
      break;
    }
    case "next-pages": {
      const pages = existsSync(join(project.root, "src/pages")) ? "src/pages" : "pages";
      const path = `${pages}/api/bonded.${ts ? "ts" : "js"}`;
      route(path, nextPagesRoute(files.specifier(path, handlerFile)), "the Next.js API route");
      endpoint = "/api/bonded";
      break;
    }
    case "express":
    case "hono":
      mountRoute(plan, files, project.web, handlerFile);
      break;
    case "node-http": {
      const path = files.helperPath("bonded-server");
      route(
        path,
        nodeServer(files.specifier(path, handlerFile)),
        "a small server for the Agent URL",
      );
      plan.env.push("BONDED_AGENT_PORT");
      plan.manual.push(
        `Run ${path} next to your agent (it listens on BONDED_AGENT_PORT, default 8787) and put it behind HTTPS.`,
      );
      break;
    }
  }
  plan.manual.push(
    `Fill in onEpisode in ${handlerFile}: run your agent on episode.task.goal with the episode's tools.`,
  );
  plan.notes.push(
    `Next: deploy, then on your agent's page set the Agent URL to https://<your host>${endpoint}, put the agent secret Bonded shows you in BONDED_AGENT_SECRET, press Verify, then run a connection check.`,
  );
}

const MOUNT: Record<
  "express" | "hono",
  { app: RegExp; line: (app: string) => string; name: string }
> = {
  express: {
    app: /^(\s*)(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*express\(\s*\)\s*;?\s*$/,
    line: (app) =>
      `${app}.post("/bonded", bondedNodeHandler); // Bonded's Agent URL: before any body parser`,
    name: "bondedNodeHandler",
  },
  hono: {
    app: /^(\s*)(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*new Hono(?:<[^>]*>)?\(\s*\)\s*;?\s*$/,
    line: (app) => `${app}.post("/bonded", (c) => bondedHandler(c.req.raw)); // Bonded's Agent URL`,
    name: "bondedHandler",
  },
};

/** Express or Hono: one route line right after `const app = express()` / `new Hono()`. */
function mountRoute(
  plan: InitPlan,
  files: Files,
  web: "express" | "hono",
  handlerFile: string,
): void {
  const m = MOUNT[web];
  const found = files
    .matching(/./)
    .filter((f) => f.path !== handlerFile)
    .flatMap((f) =>
      f.text.split("\n").flatMap((line, index) => {
        const match = m.app.exec(line);
        return match ? [{ ...f, index, indent: match[1]!, app: match[2]! }] : [];
      }),
    );
  const only = found.length === 1 ? found[0]! : undefined;
  if (!only || !files.isModule(only.path) || only.text.includes(m.name)) {
    if (only?.text.includes(m.name)) return;
    plan.manual.push(
      `Mount the Agent URL route on your app: ${m.line("app")} (import { ${m.name} } from the new ${handlerFile}).`,
    );
    return;
  }
  const lines = only.text.split("\n");
  lines.splice(only.index + 1, 0, `${only.indent}${m.line(only.app)}`);
  const specifier = files.specifier(only.path, handlerFile);
  files.change(
    plan,
    only.path,
    addImport(lines.join("\n"), `import { ${m.name} } from "${specifier}";`, specifier),
    "the Agent URL route",
  );
}

// ---------------------------------------------------------------------------------------------
// Templates. Each new file starts with MARKER.

const header = (what: string) => `${MARKER}: ${what}. Edit it freely.\n// Guide: ${GUIDE}\n`;

/** Above every helper's production branch: why it is never reached while rated. */
const RATED_COMMENT =
  "// While Bonded rates the agent, the production vault is never built, even if a .env file put its\n// variables back: rated trades go through the episode's tools only.\n";

function toolsHelper(framework: "langchain" | "ai-sdk", ts: boolean): string {
  const lc = framework === "langchain";
  const sub = lc ? "langchain" : "ai-sdk";
  const episodeFn = lc ? "bondedLangChainTools" : "bondedAiSdkTools";
  const vaultFn = lc ? "bondedVaultLangChainTools" : "bondedVaultAiSdkTools";
  const sig = ts
    ? lc
      ? "export async function bondedTools<T>(productionTools: T[], episode?: BondedEpisode): Promise<T[]> {"
      : "export async function bondedTools<T extends object>(\n  productionTools: T,\n  episode?: BondedEpisode,\n): Promise<T> {"
    : "export async function bondedTools(productionTools, episode) {";
  const asT = ts ? (lc ? " as unknown as T[]" : " as unknown as T") : "";
  const combine = lc
    ? `[...productionTools, ...(${vaultFn}({ vault })${asT})]`
    : `{ ...productionTools, ...${vaultFn}({ vault }) }${ts ? " as T" : ""}`;
  return `${header("Bonded's rating hook and Mandate Vault tools")}import { ${ts ? "type BondedEpisode, " : ""}bondedVaultFromEnv, isBondedEpisode } from "@bondedhq/sdk";
import { ${episodeFn}, ${vaultFn} } from "@bondedhq/sdk/${sub}";

/**
 * Your agent's tools, by where it runs:
 * - while Bonded rates it (under the runner, or with the \`episode\` an Agent URL handler gets):
 *   the episode's tools, so it is rated with the code it runs in production;
 * - in production with BONDED_VAULT_ADDRESS set: your tools plus swap, transfer, approve and
 *   vault_status through your Mandate Vault, each dry-run first and refused on a predicted breach;
 * - otherwise: your tools, unchanged.
 */
${sig}
  if (episode || isBondedEpisode()) return (await ${episodeFn}(episode))${asT};
  const vault = bondedVaultFromEnv();
  if (!vault) return productionTools;
  return ${combine};
}
`;
}

function agentKitHelper(ts: boolean): string {
  const sig = ts
    ? "export async function bondedAgentKit(\n  options: NonNullable<Parameters<typeof AgentKit.from>[0]>,\n  episode?: BondedEpisode,\n): Promise<AgentKit> {"
    : "export async function bondedAgentKit(options, episode) {";
  return `${header("Bonded's rating hook and Mandate Vault wallet provider")}import { AgentKit, EvmWalletProvider } from "@coinbase/agentkit";
import { ${ts ? "type BondedEpisode, " : ""}isBondedEpisode } from "@bondedhq/sdk";
import { BondedWalletProvider, bondedEpisodeActionProvider } from "@bondedhq/sdk/agentkit";

/**
 * \`AgentKit.from\`, with Bonded:
 * - while Bonded rates the agent (under the runner, or with the \`episode\` an Agent URL handler
 *   gets): the episode's tools are its only actions, so it is rated with the code it runs;
 * - in production with BONDED_VAULT_ADDRESS set: your wallet provider signs as the vault's agent
 *   key and every transaction becomes vault.execute(to, data), dry-run first;
 * - otherwise: AgentKit.from(options), unchanged.
 */
${sig}
  if (episode || isBondedEpisode())
    return AgentKit.from({ ...options, actionProviders: [await bondedEpisodeActionProvider(episode)] });
  const vault = process.env.BONDED_VAULT_ADDRESS;
  if (!vault || !(options.walletProvider instanceof EvmWalletProvider)) return AgentKit.from(options);
  const walletProvider = await BondedWalletProvider.create({
    wallet: options.walletProvider,
    vault: vault${ts ? " as `0x${string}`" : ""},
    guard: true,
  });
  return AgentKit.from({ ...options, walletProvider });
}
`;
}

function elizaHelper(ts: boolean): string {
  void ts;
  return `${header("Bonded's rating hook and Mandate Vault plugin")}import { bondedVaultFromEnv, isBondedEpisode } from "@bondedhq/sdk";
import { bondedEpisodePlugin, bondedPlugin } from "@bondedhq/sdk/eliza";

${RATED_COMMENT}const rated = isBondedEpisode();
const vault = rated ? undefined : bondedVaultFromEnv();

/**
 * Bonded's plugin, for your agent's plugins:
 * - while Bonded rates the agent: the episode's tools;
 * - in production with BONDED_VAULT_ADDRESS set: BONDED_SWAP, BONDED_TRANSFER and BONDED_APPROVE
 *   through your Mandate Vault (each dry-run first) and the BONDED_VAULT provider;
 * - otherwise: nothing.
 */
export const bondedPlugins = rated
  ? [bondedEpisodePlugin()]
  : vault
    ? [bondedPlugin({ vault })]
    : [];
`;
}

function mcpHelper(ts: boolean): string {
  return `${header("Bonded's rating hook and guarded Mandate Vault")}import { bondedVaultFromEnv, guarded, isBondedEpisode } from "@bondedhq/sdk";

/** The MCP server to use: the episode's while Bonded rates the agent, yours otherwise. */
export function bondedMcpUrl(productionUrl${ts ? ": string | URL" : ""})${ts ? ": string | URL" : ""} {
  return isBondedEpisode() ? process.env.BONDED_MCP_URL${ts ? "!" : ""} : productionUrl;
}

${RATED_COMMENT}const vault = isBondedEpisode() ? undefined : bondedVaultFromEnv();

/**
 * In production with BONDED_VAULT_ADDRESS set: your Mandate Vault, every write dry-run first and
 * refused on a predicted breach. Trade with \`await bondedVault.swap({ tokenIn, tokenOut, amountIn })\`.
 * Undefined while Bonded rates the agent.
 */
export const bondedVault = vault ? guarded(vault) : undefined;
`;
}

function unknownHelper(ts: boolean): string {
  void ts;
  return `${header("Bonded's rating check and guarded Mandate Vault")}import { bondedVaultFromEnv, guarded, isBondedEpisode } from "@bondedhq/sdk";

/** True while Bonded rates the agent: use the episode's tools (BONDED_MCP_URL, BONDED_TOOLS_URL) then. */
export const rated = isBondedEpisode();

${RATED_COMMENT}const vault = rated ? undefined : bondedVaultFromEnv();

/**
 * In production with BONDED_VAULT_ADDRESS set: your Mandate Vault, every write dry-run first and
 * refused on a predicted breach. Trade with \`await bondedVault.swap({ tokenIn, tokenOut, amountIn })\`.
 * Undefined while Bonded rates the agent.
 */
export const bondedVault = vault ? guarded(vault) : undefined;
`;
}

const EPISODE_HINT: Record<Framework, string[]> = {
  langchain: [
    "const tools = await bondedTools(productionTools, episode); // from HELPER",
    "const agent = createReactAgent({ llm, tools }); await agent.invoke(...);",
  ],
  "ai-sdk": [
    "const tools = await bondedTools(productionTools, episode); // from HELPER",
    "const result = await generateText({ model, tools, prompt: episode.task.goal, abortSignal: signal });",
  ],
  agentkit: [
    "const kit = await bondedAgentKit({ walletProvider, actionProviders }, episode); // from HELPER",
  ],
  eliza: [
    "bondedEpisodePlugin({ episode }) from @bondedhq/sdk/eliza is the runtime's plugin for it",
  ],
  mcp: ["const tools = await connectEpisodeTools(episode); // from @bondedhq/sdk/mcp"],
  python: [],
  unknown: ["const tools = await connectEpisodeTools(episode); // from @bondedhq/sdk/mcp"],
};

function agentUrlHandler(project: Project, path: string, helper: string, ts: boolean): string {
  return `${header("Bonded's Agent URL handler")}import { ${ts ? "type BondedHandler, " : ""}createBondedHandler } from "@bondedhq/sdk/agent-url";

let handler${ts ? ": BondedHandler | undefined" : ""};

/**
 * Bonded calls this once per episode, signed with your agent secret (BONDED_AGENT_SECRET). It
 * answers Bonded's verify challenge, acknowledges an episode at once and runs onEpisode in the
 * background, and posts /done when onEpisode resolves.
 */
export const bondedHandler${ts ? ": BondedHandler" : ""} = (request, context) => {
  handler ??= createBondedHandler({
    secret: process.env.BONDED_AGENT_SECRET ?? "",
    ...(process.env.GIT_SHA ? { version: process.env.GIT_SHA } : {}),
    async onEpisode(episode, { signal }) {
      // Run your agent on episode.task.goal with the episode's tools, and stop when signal aborts:
${EPISODE_HINT[project.framework].map((l) => `      //   ${l.replace("HELPER", helper)}\n`).join("")}      // Return { finalMessage, usage } when it has finished.
      void signal;
      throw new Error("Connect your agent in ${path} (onEpisode) to be rated over its Agent URL");
    },
  });
  return handler(request, context);
};
`;
}

function nextAppRoute(specifier: string, nextMajor: number, ts: boolean): string {
  const after = nextMajor >= 15;
  return `${header("Bonded's Agent URL route")}${after ? 'import { after } from "next/server";\n' : ""}import { bondedHandler } from "${specifier}";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request${ts ? ": Request" : ""}) {
  return bondedHandler(request${after ? ", { waitUntil: (work) => after(work) }" : ""});
}
`;
}

function nextPagesRoute(specifier: string): string {
  return `${header("Bonded's Agent URL route")}import { toNodeHandler } from "@bondedhq/sdk/agent-url";
import { bondedHandler } from "${specifier}";

// The signature covers the raw body: Next.js must not parse it.
export const config = { api: { bodyParser: false } };

export default toNodeHandler(bondedHandler);
`;
}

function nodeServer(specifier: string): string {
  return `${header("a small server for Bonded's Agent URL")}import { createServer } from "node:http";
import { toNodeHandler } from "@bondedhq/sdk/agent-url";
import { bondedHandler } from "${specifier}";

const port = Number(process.env.BONDED_AGENT_PORT ?? 8787);
createServer(toNodeHandler(bondedHandler)).listen(port, () =>
  console.log(\`Bonded Agent URL listening on http://localhost:\${port}/\`),
);
`;
}

function pythonPlan(plan: InitPlan): void {
  plan.manual.push(
    "Python: there is no Bonded package to install. While Bonded rates the agent (BONDED_EPISODE_ID is set), call the episode's tools over plain HTTP:",
    [
      "    import json, os, urllib.request",
      "    def call(name, args=None):",
      "        url = f\"{os.environ['BONDED_TOOLS_URL'].rstrip('/')}/{name}\"",
      '        req = urllib.request.Request(url, data=json.dumps(args or {}).encode(), method="POST", headers={"content-type": "application/json"})',
      "        return json.loads(urllib.request.urlopen(req).read())",
    ].join("\n"),
    `In production, every trade is MandateVault.execute(target, data) sent from the vault's agent key (web3.py works). For an Agent URL, see https://github.com/ddboy19912/bonded/tree/main/examples/python-agent-url.`,
  );
}

/** What the plan does, framework by framework, in a line: for the summary. */
export function frameworkLine(project: Project): string {
  return `${FRAMEWORK_NAMES[project.framework]} (${project.evidence})`;
}
