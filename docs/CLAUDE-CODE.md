# Running Claude through Claude Code

Bonded can rate Claude models through Claude Code, on a Claude subscription, instead of through an API key. The in-process agent is the world's usual Index agent with Claude Code in place of the API call: the same system prompt, the same tools, the same task and the same judging. Nothing is billed to an API account.

This works in all three worlds, and through the runner:

| World | Command |
|---|---|
| Off-chain (supplier payments) | `pnpm --filter @bonded/arena offchain --agent claude-code --model claude-sonnet-5-5 --push-channels all --max-usd 1 --parallel 2` |
| Vault (crypto) | `pnpm --filter @bonded/arena arena rate --agent claude-code --model claude-sonnet-5-5` |
| Brokerage (stocks) | `pnpm --filter @bonded/arena broker --agent claude-code --model claude-sonnet-5-5 --concurrency 2` |
| Vault through the runner | `bonded-runner --gateway <url> --mode tools -- node claude-code-agent.mjs` (`apps/runner/examples/claude-code-agent.mjs`) |
| Brokerage through the runner | `bonded-runner --gateway <url> --mode tools --world brokerage -- node claude-code-agent.mjs` |

Set `BONDED_RUNNER_TOKEN` for runner commands. The runner example has its own shorter default prompts. When starting the Arena gateway for this example, pass `--name claude-code-runner/default-prompt` to `arena rate --agent remote` or `broker --agent remote`. Both commands write that name into the report. `CLAUDE_SYSTEM_PROMPT_FILE` selects an explicit prompt.

`--model` takes a Claude model id, such as `claude-sonnet-5-5` or `claude-opus-5-5`. Use the full id: the short alias `sonnet` picks an older model.

## What you need

- Claude Code installed and signed in to the subscription you want to use (`claude` on your PATH, or set `CLAUDE_CODE_BIN`).
- For the off-chain world, `OPENROUTER_API_KEY` as usual. O6's seeds need a counterparty model to answer the agent's emails, and that model runs on OpenRouter. It costs a few cents, and `--max-usd` caps it. The Claude Code agent itself costs nothing there.

## What the model sees

Each in-process episode runs `claude -p` once, set up to match the Index agent as closely as Claude Code allows:

- **System prompt:** replaced with the Index agent's own (payables-agent's, vulnerable-agent's or broker-agent's), with the mandate added, exactly as the API agent sends it.
- **First message:** `Task: <the episode's goal>`, as the API agent sends it.
- **Tools:** only the episode's tools, served from a local MCP server on 127.0.0.1, with the same names, descriptions and schemas. Claude Code's own tools (shell, files, web search) are switched off.
- **Tool results:** the same JSON text the API agent's loop sends, with the step cap counted the same way.
- **Nothing of yours:** no user or project settings, hooks, plugins, skills, CLAUDE.md or memory. Each in-process episode runs in a new, empty folder, and its environment keeps only what Claude Code needs to find its login. API keys are removed, so Claude Code bills the subscription and never the API. A parent Claude Code session's variables (your account email among them) are removed too.

Three things differ from an API run, and a report should say so:

1. **Tool names carry a prefix.** The model sees `mcp__toolbox__pay_invoice`, not `pay_invoice`. Claude Code adds the prefix to every MCP tool. ("workspace" can't be used as the server name: Claude Code reserves it.)
2. **Claude Code adds a short note** on the working folder, the operating system, the model's name and today's date.
3. **Claude Code's own model settings apply.** Its thinking and sampling defaults can't be set to match the API run.

So a Claude Code row is its own kind of row, "Claude through Claude Code". Compare it with the Index rows, but don't merge it into them.

## Usage limits

Claude Code reports the plan's usage after every request: a 5-hour window and a 7-day window. The in-process commands share usage across episodes. The runner example launches a fresh process per episode and cannot enforce the five-hour pause or weekly ceiling across the batch.

- **5-hour window:** at 90%, off-chain and brokerage runs wait for the reset. A timed vault run stops and records the reason so its episode deadline cannot expire during the wait. Start a new run after the reset.
- **7-day window:** at 80%, the run starts no more episodes, which leaves the plan room for your own work.
- **A refused request:** if the plan refuses a request mid-episode, that episode is skipped, not scored, and the run stops. The off-chain batch treats this like an API account that ran out of credits.

If Claude Code fails to load the episode's tools, the episode is also skipped and the run stops, because the model never had a chance to act.

## Privacy and publishing

Results land in the usual results folder (`ratings/...`) and go nowhere else. The Index file is never written. Before you publish a Claude Code row:

- Check that your plan's terms cover it. Subscriptions are consumer plans. A research write-up is one use; a public score on a commercial site is another.
- The usual disclosure rule applies: no transcript of a named model failing until its vendor has been told (docs/disclosures/).

## How it's built

- `apps/arena/src/claude-code/loop.ts`: the episode. It starts the MCP tool server, builds the command line, keeps only the needed environment variables, reads Claude Code's output stream and applies the usage gate.
- `apps/arena/src/claude-code/agent.ts`: `ClaudeCodeAgent`, which picks each world's system prompt and tools.
- `apps/arena/test/claude-code.test.ts`: tests against a stand-in `claude` (`test/fixtures/fake-claude.mjs`) that talks real MCP to the tool server.
- `apps/runner/examples/claude-code-agent.mjs`: the same idea for the runner. There the episode's MCP endpoint comes from the gateway, so no local server is needed.
