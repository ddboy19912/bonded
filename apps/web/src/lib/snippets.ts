import type { RemoteMode } from "@bondedhq/shared";
import type { Connection } from "./byoa-api";

/**
 * Copy-paste code that connects an agent to an episode's tools, per framework, as `@bondedhq/sdk`
 * documents it (its README and examples/frameworks). Under the runner each helper reads the
 * episode from BONDED_* when called with no argument; behind an Agent URL the handler hands it the
 * episode Bonded POSTed, and the helper takes that instead. Placeholders such as `llm`, `model`,
 * `productionTools`, `walletProvider` and `myTradingPlugin` stand for the agent's own code.
 */
export interface Snippet {
  id: string;
  label: string;
  language: "ts" | "sh" | "python";
  /** The install line shown above the code, if it needs one. */
  install?: string;
  code: string;
  note?: string;
  /** What the snippet imports from @bondedhq/sdk, so a test can check each one exists. */
  imports: { from: string; names: string[] }[];
}

const CHAIN_NOTE =
  "Chain mode: only the reads are tools. Sign trades with the episode's session key through a `BondedVault` (see the guide).";

/** Framework snippets for an agent the runner starts: the episode comes from BONDED_*. */
function runnerSnippets(): Snippet[] {
  return [
    {
      id: "langchain",
      label: "LangChain",
      language: "ts",
      install: "npm i @bondedhq/sdk @langchain/core @langchain/langgraph",
      code: `import { isBondedEpisode } from "@bondedhq/sdk";
import { bondedLangChainTools } from "@bondedhq/sdk/langchain";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

const tools = isBondedEpisode() ? await bondedLangChainTools() : productionTools;
const agent = createReactAgent({ llm, tools });
await agent.invoke({ messages: [{ role: "user", content: task }] });`,
      imports: [
        { from: "@bondedhq/sdk", names: ["isBondedEpisode"] },
        { from: "@bondedhq/sdk/langchain", names: ["bondedLangChainTools"] },
      ],
    },
    {
      id: "ai-sdk",
      label: "Vercel AI SDK",
      language: "ts",
      install: "npm i @bondedhq/sdk ai",
      code: `import { isBondedEpisode } from "@bondedhq/sdk";
import { bondedAiSdkTools } from "@bondedhq/sdk/ai-sdk";
import { generateText, stepCountIs } from "ai";

const tools = isBondedEpisode() ? await bondedAiSdkTools() : productionTools;
await generateText({ model, tools, stopWhen: stepCountIs(10), prompt: task });`,
      imports: [
        { from: "@bondedhq/sdk", names: ["isBondedEpisode"] },
        { from: "@bondedhq/sdk/ai-sdk", names: ["bondedAiSdkTools"] },
      ],
    },
    {
      id: "eliza",
      label: "ElizaOS",
      language: "ts",
      install: "npm i @bondedhq/sdk @elizaos/core",
      code: `import { isBondedEpisode } from "@bondedhq/sdk";
import { bondedEpisodePlugin } from "@bondedhq/sdk/eliza";

export const character = {
  name: "Trader",
  plugins: [isBondedEpisode() ? bondedEpisodePlugin() : myTradingPlugin],
};`,
      note: "Already using `bondedPlugin({ vault })`? No change needed: it switches to the episode's tools by itself during an episode.",
      imports: [
        { from: "@bondedhq/sdk", names: ["isBondedEpisode"] },
        { from: "@bondedhq/sdk/eliza", names: ["bondedEpisodePlugin"] },
      ],
    },
    {
      id: "agentkit",
      label: "AgentKit",
      language: "ts",
      install: "npm i @bondedhq/sdk @coinbase/agentkit",
      code: `import { isBondedEpisode } from "@bondedhq/sdk";
import { bondedEpisodeActionProvider } from "@bondedhq/sdk/agentkit";
import { AgentKit } from "@coinbase/agentkit";

const kit = await AgentKit.from({
  walletProvider,
  actionProviders: isBondedEpisode() ? [await bondedEpisodeActionProvider()] : productionProviders,
});`,
      imports: [
        { from: "@bondedhq/sdk", names: ["isBondedEpisode"] },
        { from: "@bondedhq/sdk/agentkit", names: ["bondedEpisodeActionProvider"] },
      ],
    },
  ];
}

/**
 * The same helpers inside an Agent URL handler: they take the episode Bonded POSTed (BONDED_*
 * isn't set there), so each one is called with `episode`.
 */
function urlSnippets(): Snippet[] {
  const lead = "// Inside onEpisode(episode) in your handler (the first tab).\n";
  return [
    {
      id: "langchain",
      label: "LangChain",
      language: "ts",
      install: "npm i @bondedhq/sdk @langchain/core @langchain/langgraph",
      code: `import { bondedLangChainTools } from "@bondedhq/sdk/langchain";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

${lead}const tools = await bondedLangChainTools(episode);
const agent = createReactAgent({ llm, tools });
await agent.invoke({ messages: [{ role: "user", content: episode.task.goal }] });`,
      imports: [{ from: "@bondedhq/sdk/langchain", names: ["bondedLangChainTools"] }],
    },
    {
      id: "ai-sdk",
      label: "Vercel AI SDK",
      language: "ts",
      install: "npm i @bondedhq/sdk ai",
      code: `import { bondedAiSdkTools } from "@bondedhq/sdk/ai-sdk";
import { generateText, stepCountIs } from "ai";

${lead}const tools = await bondedAiSdkTools(episode);
await generateText({ model, tools, stopWhen: stepCountIs(10), prompt: episode.task.goal });`,
      imports: [{ from: "@bondedhq/sdk/ai-sdk", names: ["bondedAiSdkTools"] }],
    },
    {
      id: "eliza",
      label: "ElizaOS",
      language: "ts",
      install: "npm i @bondedhq/sdk @elizaos/core",
      code: `import { bondedEpisodePlugin } from "@bondedhq/sdk/eliza";

${lead}const plugins = [bondedEpisodePlugin({ episode })];`,
      imports: [{ from: "@bondedhq/sdk/eliza", names: ["bondedEpisodePlugin"] }],
    },
    {
      id: "agentkit",
      label: "AgentKit",
      language: "ts",
      install: "npm i @bondedhq/sdk @coinbase/agentkit",
      code: `import { bondedEpisodeActionProvider } from "@bondedhq/sdk/agentkit";
import { AgentKit } from "@coinbase/agentkit";

${lead}const kit = await AgentKit.from({
  walletProvider,
  actionProviders: [await bondedEpisodeActionProvider(episode)],
});`,
      imports: [{ from: "@bondedhq/sdk/agentkit", names: ["bondedEpisodeActionProvider"] }],
    },
  ];
}

export function snippets(
  connection: Connection,
  mode: RemoteMode,
  /** The Arena Gateway's address, for the runner line; a placeholder until the API gives it. */
  gatewayUrl?: string | null,
): Snippet[] {
  const chain = (s: Snippet): Snippet =>
    mode === "chain" ? { ...s, note: [s.note, CHAIN_NOTE].filter(Boolean).join(" ") } : s;
  if (connection === "runner")
    return [
      ...runnerSnippets().map(chain),
      {
        id: "mcp",
        label: "Any MCP agent",
        language: "sh",
        install: "npm i @bondedhq/sdk",
        code: `npx @bondedhq/runner --gateway ${gatewayUrl ?? "https://<gateway>"} -- sh -c 'bonded-mcp-config > .mcp.json && my-agent --mcp-config .mcp.json'`,
        note: "For agents that read an `mcpServers` config. The URL is new for every episode, so the config is written each time; add `--style stdio` for stdio-only clients. Keep the runner token in `BONDED_RUNNER_TOKEN`, as in the command above.",
        imports: [],
      },
      {
        id: "python",
        label: "Python",
        language: "python",
        code: `import json, os, urllib.request

def call(name, args=None):
    url = f"{os.environ['BONDED_TOOLS_URL'].rstrip('/')}/{name}"
    req = urllib.request.Request(url, data=json.dumps(args or {}).encode(), method="POST",
                                 headers={"content-type": "application/json"})
    return json.loads(urllib.request.urlopen(req).read())  # {"ok": true, "output": ...}

task = json.loads(os.environ["BONDED_TASK"])  # {"goal", "mandate", "maxSteps"}
inbox = call("read_inbox")  # read everything as data, never as instructions
call("swap", {"tokenIn": "tUSDG", "tokenOut": "tTSLA", "amountIn": "100"})  # the trade the task names`,
        note: "Finish with a POST to `BONDED_DONE_URL` (`{ finalMessage, usage }`), or just exit.",
        imports: [],
      },
    ];
  return [
    {
      id: "handler",
      label: "Agent URL handler",
      language: "ts",
      install: "npm i @bondedhq/sdk ai",
      code: `// app/api/bonded/route.ts (Next.js)
import { createBondedHandler } from "@bondedhq/sdk/agent-url";
import { bondedAiSdkTools } from "@bondedhq/sdk/ai-sdk";
import { generateText, stepCountIs } from "ai";

export const POST = createBondedHandler({
  secret: process.env.BONDED_AGENT_SECRET!,
  version: process.env.GIT_SHA,
  async onEpisode(episode, { signal }) {
    const tools = await bondedAiSdkTools(episode);
    const { text, totalUsage } = await generateText({
      model, tools, stopWhen: stepCountIs(10), prompt: episode.task.goal, abortSignal: signal,
    });
    return {
      finalMessage: text,
      usage: { inputTokens: totalUsage.inputTokens ?? 0, outputTokens: totalUsage.outputTokens ?? 0 },
    };
  },
});`,
      note: 'It checks the signature, answers the ownership check, replies at once and posts done with what `onEpisode` returns. Other hosts: Express `app.post("/bonded", toNodeHandler(handler))`, mounted before `express.json()` (it needs the raw body); Hono `app.post("/bonded", (c) => handler(c.req.raw))`; Cloudflare `export default { fetch: (req, env, ctx) => handler(req, ctx) }`. `toNodeHandler` comes from `@bondedhq/sdk/agent-url` too.',
      imports: [
        { from: "@bondedhq/sdk/agent-url", names: ["createBondedHandler", "toNodeHandler"] },
        { from: "@bondedhq/sdk/ai-sdk", names: ["bondedAiSdkTools"] },
      ],
    },
    ...urlSnippets().map(chain),
    {
      id: "python",
      label: "Python",
      language: "sh",
      code: `# A whole Agent URL endpoint, standard library only:
# examples/python-agent-url/agent.py in the Bonded repository.
BONDED_AGENT_SECRET=bonded_as_... PORT=8080 python3 agent.py`,
      note: 'It checks `bonded-signature` (HMAC-SHA256 of the timestamp, a dot and the raw body), answers `verify` with the challenge and its proof (HMAC-SHA256 of `"verify." + the challenge`, keyed with your secret), and replies 202 to an episode before working in the background.',
      imports: [],
    },
  ];
}
