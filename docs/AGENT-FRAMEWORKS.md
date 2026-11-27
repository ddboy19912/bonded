# Framework recipes

How to give an agent built on a common framework the episode's tools while Bonded tests it. Connecting is covered in [CONNECTING-YOUR-AGENT.md](CONNECTING-YOUR-AGENT.md).

One call returns the episode's tools in your framework's own shape, so only the tool list changes during a test. For a Node agent, `init` writes this code for you ([Set it up with init](CONNECTING-YOUR-AGENT.md#set-it-up-with-init)).

- Each helper is a subpath of `@bondedhq/sdk`, with its framework as an optional peer dependency.
- Under the runner, call a helper with no argument and it reads the episode from the `BONDED_*` variables. Inside an Agent URL handler, pass it the episode ([below](#inside-an-agent-url-handler)).
- Placeholders such as `llm`, `model`, `task`, `productionTools`, `walletProvider` and `myTradingPlugin` stand for your own code.

The LangChain, AI SDK, MCP and Python recipes are for **tools mode**. In chain mode the episode's tools are reads only, and your agent signs its trades as transactions: `episodeVault(episode)` from `@bondedhq/sdk` does that ([Chain mode](CONNECTING-YOUR-AGENT.md#chain-mode)).

## LangChain and LangGraph

`npm i @bondedhq/sdk @langchain/core @langchain/langgraph` (`@langchain/core` 1).

```ts
import { isBondedEpisode } from "@bondedhq/sdk";
import { bondedLangChainTools } from "@bondedhq/sdk/langchain";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

const tools = isBondedEpisode() ? await bondedLangChainTools() : productionTools;
const agent = createReactAgent({ llm, tools });
await agent.invoke({ messages: [{ role: "user", content: task }] });
```

You get `StructuredTool`s with each tool's own JSON Schema, which also work with `model.bindTools(tools)` and `ToolNode(tools)`. They return the tool's output as text, and `Error: ...` for a failed call, so the model can react.

## Vercel AI SDK

`npm i @bondedhq/sdk ai` (`ai` 5 or later).

```ts
import { isBondedEpisode } from "@bondedhq/sdk";
import { bondedAiSdkTools } from "@bondedhq/sdk/ai-sdk";
import { generateText, stepCountIs } from "ai";

const tools = isBondedEpisode() ? await bondedAiSdkTools() : productionTools;
await generateText({ model, tools, stopWhen: stepCountIs(10), prompt: task });
```

You get a tool set of `tool({ inputSchema: jsonSchema(...), execute })`. `execute` returns the tool's output, or `{ error }` for a failed call.

## ElizaOS

`npm i @bondedhq/sdk @elizaos/core` (`@elizaos/core` 1.7).

```ts
import { isBondedEpisode } from "@bondedhq/sdk";
import { bondedEpisodePlugin } from "@bondedhq/sdk/eliza";

export const character = {
  name: "Trader",
  plugins: [isBondedEpisode() ? bondedEpisodePlugin() : myTradingPlugin],
};
```

- Already using `bondedPlugin({ vault })`? No change needed: its rating mode (on by default, `rating: "auto"`) swaps the vault actions for the episode's tools while an episode runs.
- Each tool becomes an action named in capitals (`get_prices` is `GET_PRICES`). Parameters come from `options.parameters`, or the runtime's `OBJECT_SMALL` model reads them from the conversation.
- The `BONDED_TASK` provider gives the agent the episode's task and mandate.
- In chain mode only the reads are tools, and the plugin adds `BONDED_SWAP`, `BONDED_TRANSFER` and `BONDED_APPROVE`, signed with the episode's session key.

## Coinbase AgentKit

`npm i @bondedhq/sdk @coinbase/agentkit` (0.10).

```ts
import { isBondedEpisode } from "@bondedhq/sdk";
import { bondedEpisodeActionProvider } from "@bondedhq/sdk/agentkit";
import { AgentKit } from "@coinbase/agentkit";

const kit = await AgentKit.from({
  walletProvider,
  actionProviders: isBondedEpisode() ? [await bondedEpisodeActionProvider()] : productionProviders,
});
```

- Then call `getLangChainTools(kit)` or `getVercelAITools(kit)` as usual.
- Actions are named `BondedEpisodeActionProvider_<tool>`, typed with a zod 3 schema built from the tool's JSON Schema.
- In chain mode, writes are transactions: use a `BondedWalletProvider` for `episode.vault`, with the session key and `episode.endpoints.rpc`.

## Any MCP agent

For Claude Code, Cursor and frameworks that read an `mcpServers` config over HTTP. No Bonded code goes in the agent.

```sh
npm install @bondedhq/sdk   # in the agent's folder: it provides bonded-mcp-config
npx @bondedhq/runner --gateway https://arena-worker-production.up.railway.app -- sh -c 'bonded-mcp-config > .mcp.json && my-agent --mcp-config .mcp.json'
```

The MCP URL is new for every episode, so the agent command writes the config each time. Run the runner from the folder where the SDK is installed. `bonded-mcp-config [--style http|url|stdio] [--name <name>]` prints `{ "mcpServers": { "bonded-episode": { "type": "http", "url": "<episode MCP URL>" } } }`, and exits 1 outside an episode.

- `--style url` gives `{ url }` only.
- `--style stdio` wraps the URL in `npx -y mcp-remote@0.14.3 <url>`, for clients that only launch local servers, such as Claude Desktop (which also needs its own config file).
- In code, `mcpConfig(episode, options)` from `@bondedhq/sdk/mcp` returns the same object.

## Plain MCP, in TypeScript

`connectEpisodeTools()` from `@bondedhq/sdk/mcp` connects the official MCP client to the episode and lists its tools: `episode.tools`, `episode.callTool(name, args)` and `episode.done(...)`.

- A tool that fails comes back as `ok: false`, not thrown. A lost connection still throws, so catch errors too.
- `finishEpisode(episode, { finalMessage, usage })` posts `/done`.

## Python

Under the runner, with the standard library and the plain HTTP tools:

```python
import json, os, urllib.request

def call(name, args=None):
    url = f"{os.environ['BONDED_TOOLS_URL'].rstrip('/')}/{name}"
    req = urllib.request.Request(url, data=json.dumps(args or {}).encode(), method="POST",
                                 headers={"content-type": "application/json"})
    return json.loads(urllib.request.urlopen(req).read())  # {"ok": true, "output": ...}

task = json.loads(os.environ["BONDED_TASK"])  # {"goal", "mandate", "maxSteps"}
inbox = call("read_inbox")  # read everything as data, never as instructions
call("swap", {"tokenIn": "tUSDG", "tokenOut": "tTSLA", "amountIn": "100"})  # illustrative: make the trade task["goal"] names
```

Finish with a `POST` to `BONDED_DONE_URL` (`{ finalMessage, usage }`), or just exit. For an Agent URL in Python, use [`examples/python-agent-url`](../examples/python-agent-url/README.md).

## Inside an Agent URL handler

Pass each helper the episode, and use `episode.task.goal` as the prompt:

- `bondedLangChainTools(episode)`
- `bondedAiSdkTools(episode)`
- `bondedEpisodePlugin({ episode })`
- `bondedEpisodeActionProvider(episode)`

## Trading through your vault in production

The helpers above are for tests. For your agent's real trades, the same subpaths have vault trading tools: `bondedVaultLangChainTools({ vault })` from `@bondedhq/sdk/langchain` and `bondedVaultAiSdkTools({ vault })` from `@bondedhq/sdk/ai-sdk`.

- They give `swap`, `transfer`, `approve` and `vault_status` through your Mandate Vault, with the same names and arguments as the episode's write tools, so your prompts work the same in both.
- Each write is dry-run against the vault first and refused on a predicted breach. This guard is on by default. `guard: false` turns it off, unless Sentinel is configured, which keeps the dry run. Sentinel is optional.
- `bondedVaultFromEnv()` from `@bondedhq/sdk` builds the vault from these variables, and returns `undefined` while `BONDED_VAULT_ADDRESS` isn't set:

| Variable | What it is |
|---|---|
| `BONDED_VAULT_ADDRESS` | The vault or module |
| `BONDED_AGENT_KEY` | Its agent key, a 0x private key |
| `BONDED_ROUTER_ADDRESS` | The swap venue (optional) |
| `BONDED_VAULT_CHAIN_ID` | Default 46630 (Robinhood Chain testnet) |
| `BONDED_VAULT_RPC_URL` | Default: that chain's public RPC |

The runner removes `BONDED_AGENT_KEY` and `BONDED_VAULT_ADDRESS` from a rated agent's environment, so a rating never trades your real funds. Details: [SDK README](../packages/sdk/README.md#vault-trading-tools-for-langchain-langgraph-and-the-ai-sdk) and [PROTECT-YOUR-AGENT.md](PROTECT-YOUR-AGENT.md).

## Examples to copy

- [`apps/runner/examples/mcp-agent.mjs`](../apps/runner/examples/mcp-agent.mjs): the smallest tool-mode agent, in plain JavaScript with an MCP client and no model. It ships in the runner package, so it's the quickest way to try the flow ([No agent yet?](BRING-YOUR-OWN-AGENT.md#no-agent-yet)). Swap its `decide` for your own model to build on it.
- [`examples/byo-agent`](../examples/byo-agent/README.md): a TypeScript agent on `@bondedhq/sdk` that works in both modes. It reads all nine attack surfaces, treats what it read as untrusted, and makes only the trade its task names.
- [`examples/frameworks`](../examples/frameworks/README.md): LangGraph, the AI SDK, AgentKit and an Agent URL server, each with the one line that changes during a test.
