#!/usr/bin/env node
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { AgentMode, EpisodeWorld } from "@bondedhq/shared";
import { codeIdentity } from "./code-hash.js";
import { initCommand, terminalConfirm } from "./init/command.js";
import { serviceCommand } from "./service.js";
import { Runner } from "./runner.js";
import { gatewayUrlProblem } from "./tail.js";

const USAGE = `Usage: bonded-runner --gateway <url> [--token <runner token>] [options] -- <agent command...>
       bonded-runner init [folder] [--print | --yes] [--url] ...   connect your agent's code (--help)
       bonded-runner service --print systemd|pm2|docker ...        keep the runner running (--help)

Connects your agent to the Bonded Arena so it can be rated where it runs. For each episode the
Arena sends, the runner starts your agent command with the episode in its environment
(BONDED_MCP_URL, BONDED_TOOLS_URL, BONDED_TASK, ...) and stops it when the episode ends.

  --gateway <url>     the Arena Gateway, e.g. https://arena.example.com (or BONDED_GATEWAY_URL);
                      https, or plain http to localhost only
  --token <token>     your runner token (or BONDED_RUNNER_TOKEN, which keeps it out of your
                      shell history and process list)
  --mode <mode>       tools (default): reads and trades are tool calls over MCP or HTTP
                      chain: reads are tool calls; trades are transactions your agent signs and
                      sends to its vault through BONDED_RPC_URL
  --world <world>     vault (default): your agent trades on chain from a Mandate Vault
                      brokerage: your agent manages a simulated brokerage account, in tools mode
                      (BONDED_WORLD=brokerage, no vault variables). The runner takes episodes of
                      this world only, so your agent is never started for the other one
  --tee-url <url>     your agent's TEE endpoint; the runner fetches its evidence for each episode
  --code-hash <0x..>  the code version you are rating (or BONDED_CODE_HASH). Without it the runner
                      works one out: BONDED_IMAGE_DIGEST, else the git commit of your agent's
                      folder (labelled dirty with uncommitted changes), else a hash of the
                      command and its entry file (labelled unpinned)
  --quiet             don't copy the agent's output to this terminal
  --version           print the runner's version

Example:
  BONDED_RUNNER_TOKEN=... bonded-runner --gateway https://arena.example.com -- node my-agent.js`;

async function main(): Promise<number> {
  const sub = process.argv[2];
  if (sub === "init")
    return initCommand(process.argv.slice(3), {
      cwd: process.cwd(),
      env: process.env,
      out: (line) => console.log(line),
      err: (line) => console.error(line),
      confirm: terminalConfirm(),
    });
  if (sub === "service")
    return serviceCommand(process.argv.slice(3), {
      cwd: process.cwd(),
      env: process.env,
      out: (text) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`),
      err: (text) => console.error(text),
    });
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      gateway: { type: "string" },
      token: { type: "string" },
      mode: { type: "string", default: "tools" },
      world: { type: "string", default: "vault" },
      "tee-url": { type: "string" },
      "code-hash": { type: "string" },
      quiet: { type: "boolean", default: false },
      version: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  const version = (createRequire(import.meta.url)("../package.json") as { version: string })
    .version;
  if (values.version) {
    console.log(version);
    return 0;
  }
  const gateway = values.gateway ?? process.env.BONDED_GATEWAY_URL;
  const token = values.token ?? process.env.BONDED_RUNNER_TOKEN;
  const mode = AgentMode.safeParse(values.mode);
  const world = EpisodeWorld.safeParse(values.world);
  const worldFitsMode = !world.success || world.data === "vault" || values.mode === "tools";
  if (
    values.help ||
    !gateway ||
    !token ||
    !mode.success ||
    !world.success ||
    !worldFitsMode ||
    positionals.length === 0
  ) {
    console.log(USAGE);
    if (!values.help) {
      const missing = [
        !gateway && "--gateway",
        !token && "--token",
        !mode.success && "--mode tools|chain",
        !world.success && "--world vault|brokerage",
        !worldFitsMode && "--mode tools (the brokerage world has no chain mode)",
        positionals.length === 0 && "an agent command after --",
      ].filter(Boolean);
      console.error(`\nMissing or invalid: ${missing.join(", ")}`);
    }
    return values.help ? 0 : 1;
  }
  const problem = gatewayUrlProblem(gateway);
  if (problem) {
    console.error(problem);
    return 1;
  }
  const code = codeIdentity({
    command: positionals,
    ...(values["code-hash"] ? { flag: values["code-hash"] } : {}),
  });
  console.error(
    `[bonded-runner] code hash ${code.codeHash} (${code.codeSource}: ${code.detail}${code.codeSource === "git-dirty" ? ", with uncommitted changes" : ""})`,
  );
  const runner = new Runner({
    code,
    gateway,
    token,
    mode: mode.data,
    world: world.data,
    command: positionals,
    echo: !values.quiet,
    version,
    ...(values["tee-url"] ? { teeUrl: values["tee-url"] } : {}),
    log: (line) => console.error(`[bonded-runner] ${line}`),
  });
  const stop = () => void runner.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const result = await runner.start();
  if (result.code !== 0) console.error(`[bonded-runner] ${result.reason}`);
  return result.code;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
