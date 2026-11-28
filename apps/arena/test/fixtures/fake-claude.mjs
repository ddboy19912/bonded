#!/usr/bin/env node
/**
 * A stand-in for `claude -p ... --output-format stream-json` in tests. It reads the MCP config
 * it was given, connects to the episode's tool server like Claude Code does, makes the calls its
 * mode asks for and prints the stream-json events a real run prints.
 *
 * FAKE_MODE: pay (one call), loop (three calls), no-tools (the server refused), limited (the plan
 * is out of usage), crash (exits with no result). FAKE_RECORD: a file to write its argv and env to.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { setInterval } from "node:timers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const mode = process.env.FAKE_MODE ?? "pay";
if (process.env.FAKE_RECORD)
  writeFileSync(
    process.env.FAKE_RECORD,
    JSON.stringify({ args, env: process.env, cwd: process.cwd() }),
  );
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (mode === "stubborn") {
  process.on("SIGTERM", () => {});
  emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
  await new Promise(() => setInterval(() => {}, 60_000));
}
if (mode === "crash") {
  process.stderr.write("boom\n");
  process.exit(3);
}
const config = JSON.parse(readFileSync(flag("--mcp-config"), "utf8"));
const [serverName, server] = Object.entries(config.mcpServers)[0];
if (mode === "no-tools") {
  emit({
    type: "system",
    subtype: "init",
    model: flag("--model"),
    tools: [],
    mcp_server_errors: [{ name: serverName, type: "reserved_name", message: "reserved name" }],
  });
  emit({ type: "result", subtype: "success", is_error: false, result: "No tools.", num_turns: 1 });
  process.exit(0);
}
const client = new Client({ name: "fake-claude", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
const { tools } = await client.listTools();
emit({
  type: "system",
  subtype: "init",
  model: flag("--model"),
  tools: tools.map((t) => `mcp__${serverName}__${t.name}`),
  mcp_servers: [{ name: serverName, status: "connected" }],
});
const results = [];
const calls = mode === "loop" ? 3 : 1;
for (let i = 0; i < calls; i++) {
  const result = await client.callTool({ name: "pay", arguments: { invoice: `INV-${i + 1}` } });
  results.push({ isError: result.isError === true, text: result.content[0]?.text });
}
await client.close();
if (mode === "limited") {
  emit({
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", resetsAt: 2_000_000_000 },
  });
  emit({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "Claude usage limit reached",
  });
  process.exit(1);
}
emit({
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    unifiedWindows: {
      five_hour: { utilization: 0.25, resetsAt: 1_900_000_000 },
      seven_day: { utilization: 0.1 },
    },
  },
});
emit({
  type: "result",
  subtype: "success",
  is_error: false,
  result: ` Paid. ${JSON.stringify(results)} `,
  num_turns: calls + 1,
  usage: {
    input_tokens: 100,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 25,
    output_tokens: 40,
  },
});
