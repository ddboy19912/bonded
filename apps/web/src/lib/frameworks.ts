import { RUNNER_PACKAGE } from "./byoa";
import type { RemoteMode } from "@bondedhq/shared";
import type { Connection } from "./byoa-api";

/**
 * The two questions every connect flow starts with: which framework the agent is built on, and
 * where it runs. Everything after them (the connection, the snippets, the `init` command, the
 * one-line vault change) follows the answers. Plain data, so each answer is testable.
 */
export const FRAMEWORKS = ["eliza", "agentkit", "langchain", "ai-sdk", "mcp", "python"] as const;
export type Framework = (typeof FRAMEWORKS)[number];

export const FRAMEWORK_TEXT: Record<Framework, { title: string; line: string }> = {
  eliza: { title: "ElizaOS", line: "A character file with plugins." },
  agentkit: { title: "Coinbase AgentKit", line: "Action providers and a wallet provider." },
  langchain: { title: "LangChain or LangGraph", line: "Tools passed to an agent or a graph." },
  "ai-sdk": { title: "Vercel AI SDK", line: "Tools passed to generateText or streamText." },
  mcp: {
    title: "Something else (MCP or HTTP)",
    line: "Any agent that can call MCP or HTTP tools.",
  },
  python: { title: "Python", line: "Any Python agent: it calls the tools over HTTP." },
};

/** Each framework's logo, in public/brand/frameworks (sources and licences in its README). */
export const FRAMEWORK_LOGO: Record<Framework, string> = {
  eliza: "/brand/frameworks/eliza.svg",
  agentkit: "/brand/frameworks/agentkit.svg",
  langchain: "/brand/frameworks/langchain.svg",
  "ai-sdk": "/brand/frameworks/ai-sdk.svg",
  mcp: "/brand/frameworks/mcp.svg",
  python: "/brand/frameworks/python.svg",
};

/** Where the agent runs, in the owner's words, and the connection each answer means. */
export type Hosting = "machine" | "online";
export const HOSTING_TEXT: Record<Hosting, { title: string; line: string }> = {
  machine: {
    title: "On my computer or server",
    line: "A small runner next to your agent connects out to Bonded and starts it for each episode. No open ports.",
  },
  online: {
    title: "It's online at a URL",
    line: "Bonded sends each episode to your agent's HTTPS address. Nothing to install.",
  },
};

/** Under "Where do you run it?": the answer that fits when the owner isn't sure. */
export const HOSTING_HINT =
  "Not sure? Choose On my computer or server: it works for any agent you can start from a terminal.";

export const connectionFor = (h: Hosting): Connection => (h === "online" ? "url" : "runner");
export const hostingFor = (c: Connection): Hosting => (c === "url" ? "online" : "machine");

/** The snippet tab that matches each framework (lib/snippets.ts ids). */
export function snippetIdFor(framework: Framework, connection: Connection): string {
  if (framework === "python") return "python";
  if (framework === "mcp") return connection === "url" ? "handler" : "mcp";
  return framework;
}

/** `init` reads package.json: it works for every framework but Python. */
export const initWorks = (framework: Framework) => framework !== "python";

/**
 * Whether the runner step leads with `init`. init sets up a Node project built on a framework it
 * knows (it reads package.json), so it leads only for those. "Something else" can be any language
 * and Python has no package.json: for them the page leads with the plain runner command, which
 * starts any agent command.
 */
export const initLeads = (framework: Framework | undefined) =>
  framework !== "mcp" && framework !== "python";

/**
 * `npx @bondedhq/runner init`, run in the agent's folder (the runner's own command, as Track R
 * ships it). It detects the framework, shows the changes as a diff and asks before writing
 * (`--print` only shows, `--yes` applies). With the runner token and the gateway it then starts
 * the runner and runs the connection check with the token; with `--url` it adds an Agent URL route
 * instead. The token goes in `BONDED_RUNNER_TOKEN`, not `--token`, so it isn't in the process
 * list. `--api` is added only when this page talks to another API than the runner's default.
 * `--mode chain` is added for a chain-mode agent: the runner init starts must act the way the
 * agent is registered, or the connection check rejects it. (`--url` only adds the route, so the
 * mode doesn't change it.)
 */
export function initCommand(input: {
  connection: Connection;
  mode?: RemoteMode | null;
  token?: string | null;
  gatewayUrl?: string | null;
  apiUrl?: string | null;
}): string {
  if (input.connection === "url") return `npx ${RUNNER_PACKAGE} init --url`;
  return [
    ...(input.token ? [`BONDED_RUNNER_TOKEN=${input.token}`] : []),
    `npx ${RUNNER_PACKAGE} init`,
    ...(input.mode === "chain" ? ["--mode chain"] : []),
    ...(input.gatewayUrl ? [`--gateway ${input.gatewayUrl}`] : []),
    ...(input.token && input.apiUrl && input.apiUrl !== RUNNER_DEFAULT_API
      ? [`--api ${input.apiUrl}`]
      : []),
  ].join(" ");
}

/** The API the runner's `init` checks against when it isn't told (`DEFAULT_API_URL` there). */
export const RUNNER_DEFAULT_API = "https://api-production-ba50.up.railway.app";

/** What init does, in a sentence, for the page to say next to the command. */
export const INIT_NOTE =
  "Run it in your agent's folder. It finds your framework, writes `src/bonded.ts` and changes one line, showing the exact diff and asking before writing anything (`--print` only shows it, `--yes` applies it). Add `-- <your agent command>` if it doesn't start with your package manager's start script. It never touches your `.env` values.";

/** What init's `--url` route is, per web framework. */
export const INIT_URL_NOTE =
  'It adds the route for your web framework: `app/api/bonded/route.ts` for Next.js, `app.post("/bonded", bondedNodeHandler)` for Express, `app.post("/bonded", (c) => bondedHandler(c.req.raw))` for Hono, or a small `node:http` server on `BONDED_AGENT_PORT` (8787). The handler reads `BONDED_AGENT_SECRET`.';

/**
 * Keeping the runner up between ratings: the score is renewed only while it is connected. The
 * runner prints a ready-made service file for each.
 */
export const SERVICE_KINDS = [
  {
    id: "systemd",
    label: "systemd (Linux)",
    note: "Prints a unit file. Put the runner token in `bonded-runner.env` (one line, `BONDED_RUNNER_TOKEN=...`, `chmod 600`): the unit reads it from there, never from the file itself. Save the unit under `/etc/systemd/system/`, then run `sudo systemctl enable --now bonded-runner`.",
  },
  {
    id: "pm2",
    label: "pm2",
    note: "Prints a pm2 ecosystem file. Start it with the runner token in your shell (`BONDED_RUNNER_TOKEN=... pm2 start ecosystem.config.cjs`), then run `pm2 save && pm2 startup` so it comes back after a reboot.",
  },
  {
    id: "docker",
    label: "Docker",
    note: "Prints a Dockerfile on top of the runner's image (build that first, see the guide) and a `docker run` line with `--restart unless-stopped`, so Docker starts it again after a crash or a reboot. The token goes in `bonded-runner.env`.",
  },
] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number]["id"];

export function serviceCommand(kind: ServiceKind, gatewayUrl?: string | null): string {
  return `npx ${RUNNER_PACKAGE} service --print ${kind} --gateway ${gatewayUrl ?? "<gateway URL>"} -- <your agent command>`;
}

/**
 * The one change that makes the agent trade through its vault in production, per framework:
 * exactly the line `init` adds (with `src/bonded.ts`, which it writes). The vault itself comes
 * from the environment (VAULT_ENV).
 */
export interface VaultChange {
  framework: Framework;
  /** The import init adds, when it adds one. */
  importLine?: string;
  code: string;
  note: string;
}

export function vaultChange(framework: Framework): VaultChange {
  switch (framework) {
    case "agentkit":
      return {
        framework,
        importLine: 'import { bondedAgentKit } from "./bonded";',
        code: "const agentKit = await bondedAgentKit({ walletProvider, actionProviders });",
        note: "It replaces `AgentKit.from`. With `BONDED_VAULT_ADDRESS` set, your wallet provider signs as the vault's agent key and every transaction becomes `vault.execute`, dry-run first. During a rating the episode's tools are its only actions.",
      };
    case "eliza":
      return {
        framework,
        importLine: 'import { bondedPlugins } from "./bonded";',
        code: "plugins: [...bondedPlugins, ...yourPlugins],",
        note: "In your character. Its swap, transfer and approve actions go through the vault, each dry-run first. During a rating it switches to the episode's tools by itself.",
      };
    case "langchain":
      return {
        framework,
        importLine: 'import { bondedTools } from "./bonded";',
        code: "const tools = await bondedTools(productionTools);",
        note: "With `BONDED_VAULT_ADDRESS` set, the vault's swap, transfer, approve and status tools trade through the mandate, dry-run first. During a rating you get the episode's tools instead.",
      };
    case "ai-sdk":
      return {
        framework,
        importLine: 'import { bondedTools } from "./bonded";',
        code: "const tools = await bondedTools(productionTools);",
        note: "Your tool set object in, the same shape out. With `BONDED_VAULT_ADDRESS` set, the vault's trading tools go through the mandate, dry-run first. During a rating you get the episode's tools instead.",
      };
    case "mcp":
      return {
        framework,
        importLine: 'import { bondedMcpUrl, bondedVault } from "./bonded";',
        code: `new StreamableHTTPClientTransport(new URL(bondedMcpUrl(yourServerUrl)))
// and every production trade through the vault:
await bondedVault.swap({ tokenIn, tokenOut, amountIn });`,
        note: "During a rating the MCP URL becomes the episode's; otherwise it stays yours. Make your agent's trades through `bondedVault`, which dry-runs each one against the mandate.",
      };
    case "python":
      return {
        framework,
        code: `# Send every trade as the vault's execute(target, data), signed by the agent key:
vault.functions.execute(router, swap_calldata).transact({"from": agent_key})`,
        note: "`init` prints instructions for Python: there's no Python SDK yet. Encode each trade's call as usual, then send it through the vault's `execute` from the agent key, never straight to the exchange.",
      };
  }
}

/** The environment the agent needs to trade through its vault in production. */
export function vaultEnv(input: {
  vault?: string | null;
  chainId: number;
  rpcUrl: string;
  router?: string | null;
}): string {
  return [
    `BONDED_VAULT_ADDRESS=${input.vault ?? "0xYourVault"}`,
    "BONDED_AGENT_KEY=0x... # the vault's agent key; keep it secret",
    `BONDED_ROUTER_ADDRESS=${input.router ?? ""} # optional: the exchange your mandate allows`,
    `BONDED_VAULT_CHAIN_ID=${input.chainId}`,
    `BONDED_VAULT_RPC_URL=${input.rpcUrl}`,
  ].join("\n");
}

const STORAGE_KEY = "bonded:framework";

/** The framework this browser last picked: a convenience, so each page doesn't ask again. */
export function rememberedFramework(): Framework | undefined {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return FRAMEWORKS.includes(v as Framework) ? (v as Framework) : undefined;
  } catch {
    return undefined;
  }
}

export function rememberFramework(f: Framework) {
  try {
    localStorage.setItem(STORAGE_KEY, f);
  } catch {
    // Storage can be off; the page asks again next time.
  }
}
