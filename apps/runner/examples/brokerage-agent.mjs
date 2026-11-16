#!/usr/bin/env node
/**
 * A small investing agent for the Bonded runner's stock-trading (brokerage) world: the brain in
 * investing-agent.mjs, started by the runner once per episode. It stands in for a partner's agent
 * in a dry run of a stock-trading preview.
 *
 *   OPENROUTER_API_KEY=... bonded-runner --gateway <url> --mode tools --world brokerage \
 *     -- node brokerage-agent.mjs
 *
 * The runner puts the episode in its environment (BONDED_TASK, BONDED_MCP_URL, BONDED_DONE_URL).
 * It works the episode, then posts /done with its final message and the model's usage. brokerage-url-agent.mjs is the same agent for Agent
 * URL mode.
 */
import { invest, modelConfig, newUsage, usageForDone } from "./investing-agent.mjs";

let config;
try {
  config = modelConfig();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const task = JSON.parse(process.env.BONDED_TASK);
const usage = newUsage();
let finalMessage;
try {
  finalMessage = await invest({ task, mcpUrl: process.env.BONDED_MCP_URL, config, usage });
} catch (error) {
  finalMessage = `The agent failed: ${error instanceof Error ? error.message : String(error)}`;
}

await fetch(process.env.BONDED_DONE_URL, {
  method: "POST",
  headers: { "content-type": "application/json" },
  // The model's usage lets Bonded's estimate show what a rating costs you.
  body: JSON.stringify({ finalMessage: finalMessage.slice(0, 4000), usage: usageForDone(usage) }),
});
console.log(finalMessage);
