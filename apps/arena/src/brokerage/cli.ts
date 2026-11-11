#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_AGENT_MODEL, LlmBrokerAgent } from "@bonded/demo-agents";
import { type ArenaAgent, chatClientFromEnv, llmConfigForModel } from "@bondedhq/shared";
import { metaCapFallback, SpendingCap } from "../budget.js";
import { loadDotEnv } from "../env.js";
import type { ArenaGateway } from "../gateway/index.js";
import { startRemote } from "../remote-start.js";
import { type BrokerEpisodeResult, runBrokerEpisode } from "./episode.js";
import { brokerReport } from "./report.js";
import {
  BROKER_PLANS,
  type BrokerPlan,
  type BrokerScenario,
  controlScenario,
} from "./scenarios.js";
import { loadBrokerSeeds, scenarioFor, selectBrokerSeeds } from "./seeds.js";

const USAGE = `Usage: pnpm --filter @bonded/arena broker --max-usd <n> [options]
       pnpm --filter @bonded/arena broker --agent remote [--agent-url <url>] [options]

Runs broker-agent (or your own agent, with --agent remote) on the brokerage world (docs/BROKERAGE.md): the control, every staged attack
and every benign twin, judged by the broker ledger. Writes results.jsonl as each episode lands,
then results.json and report.md, a findings report in plain language. The seeds are staged, so
this is findings, not a rating.

Options:
  --max-usd <n>      Stop starting episodes once this much has been spent (required)
  --model <id>       The agent's model (default ${DEFAULT_AGENT_MODEL})
  --runs <n>         Runs of each seed (default 1)
  --seeds <ids>      Only these seeds, comma-separated (the control always runs)
  --plan <name>      The holder's plan: explicit (default; names the fund's filer ID and
                     Northgate's notice address) or plain (as a real user writes it)
  --hide-mandate     Tell the agent only its job, not the mandate's rules (the ledger enforces
                     them either way)
  --concurrency <n>  Episodes at once (default 4)
  --out <dir>        Results directory (default ratings/broker-<time>)

Your own agent (--agent remote): a gateway on this machine serves each episode's brokerage tools
over MCP and HTTP, and your agent is reached through @bondedhq/runner (protocol 2 or later) or its
own URL. Bonded spends nothing (your agent runs its own model), so --max-usd isn't needed, and
episodes run one at a time.
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
      model: { type: "string", default: DEFAULT_AGENT_MODEL },
      runs: { type: "string", default: "1" },
      seeds: { type: "string" },
      concurrency: { type: "string", default: "4" },
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
  // Bonded's own agent spends on a model; a remote agent spends on its own.
  const maxUsd = remote ? Number.POSITIVE_INFINITY : Number(values["max-usd"]);
  const runs = Number(values.runs);
  const concurrency = remote ? 1 : Number(values.concurrency);
  const timeoutS = Number(values["episode-timeout"]);
  if (
    !(maxUsd > 0) ||
    !Number.isInteger(runs) ||
    runs < 1 ||
    !(concurrency >= 1) ||
    !(timeoutS > 0)
  ) {
    console.error(USAGE);
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
    ...selectBrokerSeeds(loadBrokerSeeds(), wanted).map((seed) => scenarioFor(seed, plan)),
  ];

  let makeAgent: () => ArenaAgent;
  let gateway: ArenaGateway | undefined;
  let agentName = `broker-agent/${values.model}`;
  if (remote) {
    const started = await startRemote(undefined, values, "tools", timeoutS * 1000, {
      verify: true,
      world: "brokerage",
    });
    gateway = started.gateway;
    const agent = started.agent;
    agentName = agent.name;
    makeAgent = () => agent;
  } else {
    loadDotEnv();
    llmConfigForModel(values.model);
    const client = chatClientFromEnv();
    makeAgent = () => new LlmBrokerAgent({ client, model: values.model });
  }
  const cap = new SpendingCap({
    maxUsd: remote ? 1e9 : maxUsd,
    ...(remote ? {} : metaCapFallback(values.model)),
  });
  const queue = scenarios.flatMap((s) => Array.from({ length: runs }, () => s));
  const out =
    values.out ?? join("ratings", `broker-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(out, { recursive: true });
  const partial = join(out, "results.jsonl");
  writeFileSync(partial, "");

  const results: BrokerEpisodeResult[] = [];
  let next = 0;
  let stoppedByCap = false;
  const worker = async () => {
    while (next < queue.length) {
      if (cap.exceeded) {
        stoppedByCap = true;
        return;
      }
      const scenario = queue[next++]!;
      const agent = makeAgent();
      const result = await runBrokerEpisode(agent, scenario, {
        hideMandate: values["hide-mandate"],
      });
      // A remote agent's reported usage is its own spend, not Bonded's.
      if (!remote) cap.add(result.agentSummary.usage);
      results.push(result);
      // Saved as each episode lands, so a run cut short keeps what it already paid for.
      appendFileSync(partial, `${JSON.stringify(result)}\n`);
      const v = result.verdict;
      console.log(
        `${scenario.id}: ${
          scenario.kind === "attack"
            ? v.attackSucceeded
              ? `worked, $${v.attackDollarsAtRiskUsd} at risk`
              : "held"
            : result.taskCompleted && !v.breached
              ? "job done"
              : `missed ${result.missed.join(", ") || "nothing"}${v.breached ? ", breached" : ""}`
        }${remote ? "" : ` (spend $${cap.summary().spentUsd.toFixed(4)})`}`,
      );
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  } finally {
    await gateway?.close();
  }

  const spend = cap.summary();
  writeFileSync(
    join(out, "results.json"),
    `${JSON.stringify(
      {
        agent: agentName,
        model: remote ? null : values.model,
        runs,
        mandateShown: !values["hide-mandate"],
        plan,
        spend,
        stoppedByCap,
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
        model: remote ? "the agent's own" : values.model,
        date: new Date().toISOString().slice(0, 10),
        runsPerSeed: runs,
        mandateShown: !values["hide-mandate"],
        plan,
        spentUsd: spend.spentUsd,
        stoppedByCap,
      },
      scenarios,
      results,
    ),
  );
  console.log(
    `wrote ${out}/report.md; spend $${spend.spentUsd.toFixed(4)}${spend.estimated ? " (estimated)" : ""}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
