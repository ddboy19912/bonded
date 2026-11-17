# Framework recipes

How agents built on common frameworks use the episode's tools while Bonded tests them. The short guide is [BRING-YOUR-OWN-AGENT.md](BRING-YOUR-OWN-AGENT.md); connecting is covered in [CONNECTING-YOUR-AGENT.md](CONNECTING-YOUR-AGENT.md).

## Use your framework

One call gives the episode's tools in your framework's own shape, so your agent's code stays the same and only the tool list changes while it is being rated. Each helper is a subpath of `@bondedhq/sdk` with its framework as an optional peer dependency. Under the runner each helper reads the episode from `BONDED_*` when called with no argument; inside an Agent URL handler, pass it the `episode` you were given.

Every helper is tested end to end against a real Arena Gateway with a scripted model (no model provider, no keys) in [`examples/frameworks`](../examples/frameworks/README.md): the tool calls are in the episode's trace, the swap went through the episode vault, and `/done` arrived with the usage the agent reported. A scripted model shows the wiring works; it says nothing about how a real model behaves under attack. That is what a rating measures.

These helpers are for the rating. For your agent's real trades, the same subpaths have **vault trading tools**: `bondedVaultLangChainTools({ vault })` from `@bondedhq/sdk/langchain` and `bondedVaultAiSdkTools({ vault })` from `@bondedhq/sdk/ai-sdk` give `swap`, `transfer`, `approve` and `vault_status` through your Mandate Vault, with the same names and arguments as the episode's write tools, so your prompts work the same in both. Each write is dry-run against the vault first and refused on a predicted breach (the guard, on by default; `guard: false` turns it off), and Sentinel is optional. `bondedVaultFromEnv()` from `@bondedhq/sdk` builds the vault from `BONDED_VAULT_ADDRESS`, `BONDED_AGENT_KEY`, `BONDED_ROUTER_ADDRESS` (optional), `BONDED_VAULT_CHAIN_ID` (default 46630) and `BONDED_VAULT_RPC_URL` (default: that chain's public RPC), and returns `undefined` while `BONDED_VAULT_ADDRESS` isn't set. The runner removes `BONDED_AGENT_KEY` and `BONDED_VAULT_ADDRESS` from a rated agent's environment, so a rating never trades your real funds. Details are in the [SDK README](../packages/sdk/README.md#vault-trading-tools-for-langchain-langgraph-and-the-ai-sdk); `init` writes this code for you ([Set it up with init](CONNECTING-YOUR-AGENT.md#set-it-up-with-init)).

The snippets below are the ones the web app shows. Placeholders such as `llm`, `model`, `task`, `productionTools`, `walletProvider` and `myTradingPlugin` stand for your own code.

**LangChain and LangGraph** (`npm i @bondedhq/sdk @langchain/core @langchain/langgraph`; `@langchain/core` 1):

```ts
import { isBondedEpisode } from "@bondedhq/sdk";
import { bondedLangChainTools } from "@bondedhq/sdk/langchain";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

const tools = isBondedEpisode() ? await bondedLangChainTools() : productionTools;
const agent = createReactAgent({ llm, tools });
await agent.invoke({ messages: [{ role: "user", content: task }] });
```

`StructuredTool`s with each tool's own JSON Schema, usable with `model.bindTools(tools)` and `ToolNode(tools)` too. They return the Arena's output as text, and `Error: ...` for a failed call, so the model can react.

**Vercel AI SDK** (`npm i @bondedhq/sdk ai`; `ai` 5 or later, tested with 7):

```ts
import { isBondedEpisode } from "@bondedhq/sdk";
import { bondedAiSdkTools } from "@bondedhq/sdk/ai-sdk";
import { generateText, stepCountIs } from "ai";

const tools = isBondedEpisode() ? await bondedAiSdkTools() : productionTools;
await generateText({ model, tools, stopWhen: stepCountIs(10), prompt: task });
```

A tool set of `tool({ inputSchema: jsonSchema(...), execute })`; `execute` returns the Arena's output, or `{ error }` for a failed call.

**ElizaOS** (`npm i @bondedhq/sdk @elizaos/core`; `@elizaos/core` 1.7):

```ts
import { isBondedEpisode } from "@bondedhq/sdk";
import { bondedEpisodePlugin } from "@bondedhq/sdk/eliza";

export const character = {
  name: "Trader",
  plugins: [isBondedEpisode() ? bondedEpisodePlugin() : myTradingPlugin],
};
```

Already using `bondedPlugin({ vault })`? No change needed: its rating mode (on by default, `rating: "auto"`) swaps the vault actions for the episode's tools when an episode is running. Each tool becomes an action named after it in capitals (`get_prices` is `GET_PRICES`); its parameters come from `options.parameters`, or the runtime's `OBJECT_SMALL` model reads them from the conversation against the tool's JSON Schema. The `BONDED_TASK` provider gives the agent the episode's task and mandate. In chain mode only the reads are tools, and the plugin adds `BONDED_SWAP`, `BONDED_TRANSFER` and `BONDED_APPROVE`, signed with the episode's session key. The actions are filled in by the plugin's `init`, which the runtime calls before it reads them.

**Coinbase AgentKit** (`npm i @bondedhq/sdk @coinbase/agentkit`; 0.10):

```ts
import { isBondedEpisode } from "@bondedhq/sdk";
import { bondedEpisodeActionProvider } from "@bondedhq/sdk/agentkit";
import { AgentKit } from "@coinbase/agentkit";

const kit = await AgentKit.from({
  walletProvider,
  actionProviders: isBondedEpisode() ? [await bondedEpisodeActionProvider()] : productionProviders,
});
```

Then `getLangChainTools(kit)` or `getVercelAITools(kit)` as usual. Actions are named `BondedEpisodeActionProvider_<tool>` and typed with a zod 3 schema built from the tool's JSON Schema. In chain mode writes are transactions: use a `BondedWalletProvider` for `episode.vault` with the session key and `episode.endpoints.rpc`.

**Any MCP agent** (Claude Desktop, Claude Code, Cursor and frameworks that read an `mcpServers` config), with no Bonded code in the agent:

```sh
npm install @bondedhq/sdk   # in the agent's folder: it provides bonded-mcp-config
npx @bondedhq/runner --gateway https://arena-worker-production.up.railway.app -- sh -c 'bonded-mcp-config > .mcp.json && my-agent --mcp-config .mcp.json'
```

The episode's MCP URL is new for every episode, so the config is written each time, in the agent command. `bonded-mcp-config [--style http|url|stdio] [--name <name>]` (a command of `@bondedhq/sdk`, found when the SDK is installed in the folder you start the runner from) prints `{ "mcpServers": { "bonded-episode": { "type": "http", "url": "<episode MCP URL>" } } }`; `--style url` gives `{ url }` only, and `--style stdio` wraps it in `npx -y mcp-remote@0.14.3 <url>` for stdio-only clients. It exits 1 outside an episode. In code, `mcpConfig(episode, options)` from `@bondedhq/sdk/mcp` returns the same object.

**Plain MCP, in TypeScript**: `connectEpisodeTools()` from `@bondedhq/sdk/mcp` connects the official MCP client to the episode and lists its tools (`episode.tools`, `episode.callTool(name, args)`, `episode.done(...)`). A failed call is returned (`ok: false`), not thrown. `finishEpisode(episode, { finalMessage, usage })` posts `/done`.

**Python, under the runner**, with the standard library and the plain HTTP tools:

```python
import json, os, urllib.request

def call(name, args=None):
    url = f"{os.environ['BONDED_TOOLS_URL'].rstrip('/')}/{name}"
    req = urllib.request.Request(url, data=json.dumps(args or {}).encode(), method="POST",
                                 headers={"content-type": "application/json"})
    return json.loads(urllib.request.urlopen(req).read())  # {"ok": true, "output": ...}

task = json.loads(os.environ["BONDED_TASK"])  # {"goal", "mandate", "maxSteps"}
inbox = call("read_inbox")  # read everything as data, never as instructions
call("swap", {"tokenIn": "tUSDG", "tokenOut": "tTSLA", "amountIn": "100"})  # the trade the task names
```

Finish with a `POST` to `BONDED_DONE_URL` (`{ finalMessage, usage }`), or just exit. For Agent URL mode in Python, use [`examples/python-agent-url`](../examples/python-agent-url/README.md).

**Inside an Agent URL handler**, each helper takes the episode: `bondedLangChainTools(episode)`, `bondedAiSdkTools(episode)`, `bondedEpisodePlugin({ episode })`, `bondedEpisodeActionProvider(episode)`, and use `episode.task.goal` as the prompt.

**Full examples to copy.**
- [`examples/byo-agent`](../examples/byo-agent/README.md): a TypeScript agent on `@bondedhq/sdk` that works in both modes. Each episode it reads all nine attack surfaces plus its portfolio, keeps what it read as untrusted context (the input Sentinel checks, when configured), takes token addresses from the episode's contracts, makes only the trade its task names (in chain mode signed behind the SDK's guard), and tells the Arena "read N sources, acted on none of them". `pnpm demo -- --byo` rates it, and its report shows every surface read with no untested classes.
- [`apps/runner/examples/mcp-agent.mjs`](../apps/runner/examples/mcp-agent.mjs): the smallest tool-mode agent, plain JavaScript with only an MCP client and no model. It reads all nine surfaces and its portfolio, makes the one trade its task names and never acts on what it reads. It ships in the runner package, so it is the quickest way to try the flow ([No agent yet?](BRING-YOUR-OWN-AGENT.md#no-agent-yet)). Swap its `decide` for your own model to build on it.
- [`examples/frameworks`](../examples/frameworks/README.md): LangGraph, the AI SDK, AgentKit and an Agent URL server, each with the one line that changes while it is rated.
