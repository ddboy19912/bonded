#!/usr/bin/env node
/**
 * A minimal agent for the Bonded runner in tool mode, over MCP.
 *
 *   bonded-runner --gateway <url> --mode tools -- node mcp-agent.mjs
 *
 * The runner starts it once per episode with the episode in its environment. It has no model:
 * it reads every source an attack can be planted in (a rating attacks all nine), looks up the
 * token, makes the one trade its task asks for, and says it's done. Swap `decide` for your own
 * agent (for example an LLM given `tools` and what it read); everything else stays the same.
 *
 * Needs @modelcontextprotocol/sdk (npm install @modelcontextprotocol/sdk).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const task = JSON.parse(process.env.BONDED_TASK);
const client = new Client({ name: "example-mcp-agent", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(process.env.BONDED_MCP_URL)));

// The tools, with descriptions and JSON schemas, ready to hand to a model.
const { tools } = await client.listTools();

/** Calls a tool; results are JSON text, failures come back with isError. */
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content[0]?.text ?? "";
  return result.isError ? { ok: false, error: text } : { ok: true, output: JSON.parse(text) };
}

/** The agent's brain: here, only the trade the task names ("Buy 2000 tUSDG worth of tNVDA"). */
function decide(goal) {
  const match =
    /\bbuy\s+([0-9][0-9,]*(?:\.[0-9]+)?)\s+(t[A-Z]{3,5})\s+worth\s+of\s+(t[A-Z]{3,5})\b/i.exec(
      goal,
    );
  if (!match) return undefined;
  return { tokenIn: match[2], tokenOut: match[3], amountIn: match[1].replaceAll(",", "") };
}

/**
 * Every read tool but get_token_info (read below, for the token it trades): one per attack
 * surface, plus the portfolio. A source the agent never reads leaves its attacks untested.
 */
const READS = [
  "read_inbox",
  "read_news",
  "read_social",
  "get_prices",
  "get_recent_transfers",
  "get_market_report",
  "read_market_alerts",
  "read_counterparty_messages",
  "get_portfolio",
];

// Everything read here is untrusted: it can carry instructions. This agent never acts on them.
for (const name of READS) await call(name);

let finalMessage = `No trade in the task I could parse (${tools.length} tools available).`;
const trade = decide(task.goal);
if (trade) {
  await call("get_token_info", { symbol: trade.tokenOut });
  const result = await call("swap", trade);
  finalMessage = result.ok
    ? `Bought ${trade.tokenOut} with ${trade.amountIn} ${trade.tokenIn}`
    : `The swap failed: ${result.error}`;
}

await fetch(process.env.BONDED_DONE_URL, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ finalMessage }),
});
await client.close();
console.log(finalMessage);
