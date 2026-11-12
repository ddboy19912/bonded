#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_AGENT_MODEL, LlmBrokerAgent } from "@bonded/demo-agents";
import {
  type ArenaAgent,
  BROKER_TOOL_PROFILES,
  type BrokerToolProfile,
  chatClientFromEnv,
  llmConfigForModel,
} from "@bondedhq/shared";
import { metaCapFallback, SpendingCap } from "../budget.js";
import { loadDotEnv } from "../env.js";
import { positiveInt } from "../flags.js";
import type { ArenaGateway, RemoteAgent } from "../gateway/index.js";
import { startRemote } from "../remote-start.js";
import { type BrokerEpisodeResult, didNotFinish } from "./episode.js";
import { brokerReport } from "./report.js";
import { type BrokerRun, flagsNotForRemote, runBrokerQueue, UNREACHED_TO_STOP } from "./run.js";
import {
  BROKER_PLANS,
  type BrokerPlan,
  type BrokerScenario,
  controlScenario,
} from "./scenarios.js";
import {
  BROKER_STAGED_SEEDS_DIR,
  loadBrokerSeeds,
  scenarioFor,
  selectBrokerSeeds,
} from "./seeds.js";

const USAGE = `Usage: pnpm --filter @bonded/arena broker --max-usd <n> [options]
       pnpm --filter @bonded/arena broker --agent remote [--agent-url <url>] [options]

Runs broker-agent (or your own agent, with --agent remote) on the brokerage world (docs/BROKERAGE.md): the control, every attack
and every benign twin in the library (and the staged ones, with --staged), judged by the broker
ledger. Writes results.jsonl as each episode lands, then results.json and report.md, a findings
report in plain language. The Index's stock-trading rows come from brokerage-index, not this.

Options:
  --max-usd <n>      Stop starting episodes once this much has been spent (required)
  --model <id>       The agent's model (default ${DEFAULT_AGENT_MODEL})
  --runs <n>         Runs of each seed (default 1)
  --seeds <ids>      Only these seeds, comma-separated (the control always runs)
  --staged           Also run the staged seeds (broker-seeds-staged/), which no rating reads
  --tool-names <n>   Offer the tools under these names: bonded (default, the world's own) or
                     alpaca (Alpaca's Trading MCP names, for an agent built on that server)
  --plan <name>      The holder's plan: explicit (default; names the fund's filer ID and
                     Northgate's notice address) or plain (as a real user writes it)
  --hide-mandate     Tell the agent only its job, not the mandate's rules (the ledger enforces
                     them either way)
  --concurrency <n>  Episodes at once (default 4)
  --out <dir>        Results directory (default ratings/broker-<time>)

Your own agent (--agent remote): a gateway on this machine serves each episode's brokerage tools
over MCP and HTTP, and your agent is reached through its runner (started with --world brokerage)
or its own URL. Bonded spends nothing and episodes run one at a time (your agent runs its own
model), so --max-usd, --model and --concurrency can't be used with it. An episode your agent
doesn't finish is listed as that, never as an attack held, and the run stops after ${UNREACHED_TO_STOP} episodes
in a row that it fails without making a tool call.
  --agent <name>     broker (default) or remote
  --agent-url <url>  Agent URL mode instead of a runner (http to this machine is allowed)
  --agent-secret <s> the secret your agent checks signatures with (or BONDED_AGENT_SECRET;
                     default: a fresh one, printed)
  --runner-token <t> the token your runner connects with (default: a fresh one, printed)
  --gateway-port <n> port for the local gateway (default 8789)
  --gateway-host <h> address to listen on (default 127.0.0.1)
  --public-url <url> the URL your runner and agent reach the gateway at, if not host:port
  --runner-wait <s>  how long to wait for the runner to connect (default 300)
  --episode-timeout <s>  each episode's time limit (default 240)
  --name <name>      the agent's name in the report (default remote/local or remote/url)
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "max-usd": { type: "string" },
      model: { type: "string" },
      runs: { type: "string", default: "1" },
      seeds: { type: "string" },
      staged: { type: "boolean", default: false },
      "tool-names": { type: "string", default: "bonded" },
      concurrency: { type: "string" },
      "hide-mandate": { type: "boolean", default: false },
      plan: { type: "string", default: "explicit" },
      out: { type: "string" },
      agent: { type: "string", default: "broker" },
      "agent-url": { type: "string" },
      "agent-secret": { type: "string" },
      "runner-token": { type: "string" },
      "gateway-port": { type: "string", default: "8789" },
      "gateway-host": { type: "string" },
      "public-url": { type: "string" },
      "runner-wait": { type: "string", default: "300" },
      "episode-timeout": { type: "string", default: "240" },
      name: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values.agent !== "broker" && values.agent !== "remote") {
    console.error("--agent must be broker or remote");
    process.exitCode = 1;
    return;
  }
  const remote = values.agent === "remote";
  if (!remote && (values["agent-url"] || values["runner-token"])) {
    console.error("--agent-url and --runner-token need --agent remote");
    process.exitCode = 1;
    return;
  }
  if (remote && flagsNotForRemote(values).length > 0) {
    console.error(
      `${flagsNotForRemote(values).join(", ")} can't be used with --agent remote: your agent runs its own model, one episode at a time, and Bonded spends nothing`,
    );
    process.exitCode = 1;
    return;
  }
  const model = values.model ?? DEFAULT_AGENT_MODEL;
  // Bonded's own agent spends on a model; a remote agent spends on its own.
  const maxUsd = remote ? Number.POSITIVE_INFINITY : Number(values["max-usd"]);
  const runs = Number(values.runs);
  const concurrency = remote ? 1 : Number(values.concurrency ?? "4");
  if (!(maxUsd > 0) || !Number.isInteger(runs) || runs < 1 || !(concurrency >= 1)) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const timeoutS = positiveInt(values["episode-timeout"], "--episode-timeout");
  const toolProfile = values["tool-names"] as BrokerToolProfile;
  if (!BROKER_TOOL_PROFILES.includes(toolProfile)) {
    console.error(`--tool-names must be one of ${BROKER_TOOL_PROFILES.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  const plan = values.plan as BrokerPlan;
  if (!BROKER_PLANS.includes(plan)) {
    console.error(`--plan must be one of ${BROKER_PLANS.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  // Seeds first: a typo in --seeds stops the run before it needs a key or spends anything.
  const wanted = values.seeds
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const scenarios: BrokerScenario[] = [
    controlScenario(plan),
    ...selectBrokerSeeds(
      [...loadBrokerSeeds(), ...(values.staged ? loadBrokerSeeds(BROKER_STAGED_SEEDS_DIR) : [])],
      wanted,
    ).map((seed) => scenarioFor(seed, plan)),
  ];
  const queue = scenarios.flatMap((s) => Array.from({ length: runs }, () => s));
  const out =
    values.out ?? join("ratings", `broker-${new Date().toISOString().replace(/[:.]/g, "-")}`);

  let makeAgent: () => ArenaAgent;
  let remoteAgent: RemoteAgent | undefined;
  let gateway: ArenaGateway | undefined;
  let run: BrokerRun;
  const cap = remote ? undefined : new SpendingCap({ maxUsd, ...metaCapFallback(model) });
  // The gateway is closed however the run ends, so a failure never leaves its port taken.
  try {
    if (remote) {
      const started = await startRemote(undefined, values, "tools", timeoutS * 1000, {
        verify: true,
        world: "brokerage",
      });
      gateway = started.gateway;
      const agent = started.agent;
      remoteAgent = agent;
      makeAgent = () => agent;
    } else {
      loadDotEnv();
      llmConfigForModel(model);
      const client = chatClientFromEnv();
      makeAgent = () => new LlmBrokerAgent({ client, model });
    }
    mkdirSync(out, { recursive: true });
    const partial = join(out, "results.jsonl");
    writeFileSync(partial, "");
    run = await runBrokerQueue(queue, makeAgent, {
      concurrency,
      hideMandate: values["hide-mandate"],
      toolProfile,
      ...(cap ? { cap } : {}),
      ...(remote ? { stopAfterUnreached: UNREACHED_TO_STOP } : {}),
      onResult: (result, scenario) => {
        // A remote agent's reported usage is its own spend, not Bonded's.
        cap?.add(result.agentSummary.usage);
        // Saved as each episode lands, so a run cut short keeps what it already paid for.
        appendFileSync(partial, `${JSON.stringify(result)}\n`);
        console.log(
          `${scenario.id}: ${episodeLine(result)}${cap ? ` (spend $${cap.summary().spentUsd.toFixed(4)})` : ""}`,
        );
      },
    });
  } finally {
    await gateway?.close();
  }

  const { results, stoppedByCap, stoppedEarly } = run;
  const agentName = remoteAgent?.name ?? `broker-agent/${model}`;
  const spend = cap?.summary();
  // What the outside agent said its own model cost (posted at /done). Reported, never checked.
  const agentReportedUsd = remoteAgent?.episodes.reduce(
    (sum, e) => sum + (e.reportedUsage?.costUsd ?? 0),
    0,
  );
  writeFileSync(
    join(out, "results.json"),
    `${JSON.stringify(
      {
        agent: agentName,
        model: remote ? null : model,
        runs,
        mandateShown: !values["hide-mandate"],
        plan,
        ...(spend ? { spend } : {}),
        ...(agentReportedUsd !== undefined ? { agentReportedUsd } : {}),
        stoppedByCap,
        ...(stoppedEarly !== undefined ? { stoppedEarly } : {}),
        results,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(out, "report.md"),
    brokerReport(
      {
        agent: agentName,
        ...(remote ? {} : { model }),
        date: new Date().toISOString().slice(0, 10),
        runsPerSeed: runs,
        mandateShown: !values["hide-mandate"],
        plan,
        toolProfile,
        spentUsd: spend?.spentUsd ?? 0,
        stoppedByCap,
        ...(stoppedEarly !== undefined ? { stoppedEarly } : {}),
        ...(agentReportedUsd ? { agentReportedUsd } : {}),
      },
      scenarios,
      results,
    ),
  );
  console.log(
    `wrote ${out}/report.md${spend ? `; spend $${spend.spentUsd.toFixed(4)}${spend.estimated ? " (estimated)" : ""}` : ""}`,
  );
  const unfinished = results.filter(didNotFinish).length;
  if (unfinished > 0)
    console.error(
      `${unfinished} of ${results.length} episodes didn't finish (the agent couldn't be reached, failed or ran out of time); the report lists them`,
    );
  if (stoppedEarly !== undefined) {
    console.error(`The run stopped early: ${stoppedEarly}`);
    process.exitCode = 1;
  }
}

/** One episode's outcome, as the run prints it. */
function episodeLine(result: BrokerEpisodeResult): string {
  const v = result.verdict;
  const why = didNotFinish(result)
    ? `: ${(result.agentSummary.finalMessage ?? "the agent failed").slice(0, 200)}`
    : "";
  if (result.kind === "attack") {
    if (v.attackSucceeded) return `worked, $${v.attackDollarsAtRiskUsd} at risk${why}`;
    return didNotFinish(result) ? `didn't finish, so not counted as held${why}` : "held";
  }
  if (result.taskCompleted && !v.breached) return `job done${why}`;
  return `${didNotFinish(result) ? "didn't finish, " : ""}missed ${result.missed.join(", ") || "nothing"}${v.breached ? ", breached" : ""}${why}`;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
